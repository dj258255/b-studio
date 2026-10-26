import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EDGE_IMAGE } from '../edge-config';
import { SandboxError } from '../errors';
import { defaultEvaluationAssetRoot, evaluationAssetCopies } from './evaluation-assets';
import { computeGitMask, findMissingMasks, selectEvaluationAssetVolumes, type InspectedMount, type MaskVolume } from './git-mask';
import { assertSandboxId } from '../sandbox-id';

const execFileAsync = promisify(execFile);

/**
 * 세션 터미널(이슈 #673): 에이전트 CLI를 호스트가 아니라 컨테이너 안에서 돌리고, 화면의 터미널을 그 CLI에 붙인다.
 *
 * 호스트에서 도는 CLI는 경로 검사로 다 가둘 수 없었다(ADR-168: 검사와 사용 사이에 경로를 링크로 바꿔치기할 수 있다).
 * 컨테이너 안에서는 작업 복사본만 보이고, 링크가 밖을 가리켜도 컨테이너의 파일로 풀린다. `.git`은 서비스 컨테이너와 같은
 * 방식으로 막는다(ADR-158: 읽기 전용, 상태 폴더는 빈 폴더). CLI의 홈 폴더는 이름 있는 볼륨에 두어 로그인과 설치가 남는다.
 *
 * 가상 터미널은 컨테이너 안에서 `script`로 만든다. 호스트와는 `docker exec -i`의 파이프로 잇는다 — 호스트에 네이티브
 * 모듈(node-pty)을 두지 않고, 다른 도커 호출과 같은 방식(CLI)을 쓴다. 크기는 다른 exec에서 `stty`로 바꾼다.
 */

/** 플랫폼 이미지(edge·부하 러너와 같다). node와 npm, bash, script(bsdutils)가 들어 있다 */
export const AGENT_IMAGE = EDGE_IMAGE;
export const AGENT_SERVICE = 'b-studio-agent';
/** 컨테이너 안에서 작업 복사본이 보이는 자리. 폴더 열기로 만든 서비스 컨테이너와 같다(ADR-088) */
export const AGENT_WORKSPACE = '/workspace';
/**
 * CLI의 홈 폴더를 두는 볼륨. 세션이 바뀌어도 로그인과 설치한 CLI가 남게 하되, **프로젝트마다 따로** 둔다.
 * 홈 폴더에는 로그인 정보와 CLI의 설정(훅), 셸 설정, 설치한 실행 파일이 있다. 모든 세션이 하나를 같이 쓰면 한 프로젝트의
 * 터미널에서 바꿔 둔 것이 다른 프로젝트의 세션에 그대로 따라간다. 대가는 프로젝트마다 로그인을 한 번씩 하는 것이다.
 */
export const AGENT_HOME_VOLUME_PREFIX = 'b-studio-agent-home';
export function agentHomeVolume(projectId: string): string {
  // 볼륨 이름에 쓸 수 있는 글자만 남긴다. 서로 다른 id가 같은 이름이 되지 않게 걸러 낸 글자가 있으면 길이를 덧붙인다
  const safe = projectId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  if (!safe) throw new SandboxError('프로젝트 id가 비어 있어 에이전트 홈 볼륨을 정할 수 없습니다');
  return `${AGENT_HOME_VOLUME_PREFIX}-${safe}${safe === projectId ? '' : `-${projectId.length}`}`;
}
/** 컨테이너에 설치할 CLI의 판. 고정해 둔다 — 터미널을 열 때마다 "지금 최신"을 받으면 무엇이 깔리는지 알 수 없다. 올릴 때는 가두기를 다시 확인한다(ADR-168) */
export const AGENT_CLI_PACKAGE = '@anthropic-ai/claude-code@2.1.296';
const AGENT_HOME = '/home/node';
const NPM_PREFIX = `${AGENT_HOME}/.npm-global`;
const AGENT_PATH = `${NPM_PREFIX}/bin:${AGENT_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/**
 * 관문 설정(이슈 #673 2단계): 컨테이너 안의 CLI가 요청의 시작·쓰기 직전·턴의 끝에 호스트의 b-studio를 부르게 한다.
 *
 * CLI의 관리 설정 자리(`/etc/claude-code`)에 읽기 전용으로 붙인다. 이 자리의 설정은 사용자·프로젝트 설정보다 앞서고
 * 컨테이너 안에서는 바꿀 수 없어서, `claude`를 어떻게 띄우든(감싸개 없이 실행 파일을 직접 불러도) 훅이 붙는다.
 *
 * 관문의 주소와 토큰도 같은 자리의 파일에 둔다. 환경 변수로 넘기지 않는다 — CLI는 사용자 설정(홈 폴더의 settings.json)의
 * `env`로 자기 환경을 덮어쓰고, 홈 폴더는 에이전트가 쓸 수 있다. 환경 변수에 두면 에이전트가 주소를 지워 훅을 헛돌게 할 수 있다
 * (실측: 그 자리에 다른 주소를 적자 CLI가 그대로 썼다). 파일은 세션마다 따로 두고 세션이 멈추면 지운다.
 *
 * 훅은 판정이 아니라 통로다. 훅이 불리지 않으면 검증이 돌지 않고, 검증이 돌지 않으면 체크포인트가 생기지 않는다.
 * 체크포인트는 호스트만 만든다(컨테이너에서 `.git`은 읽기 전용이다).
 */
export const AGENT_GATEWAY_TARGET = '/etc/claude-code';
/** 컨테이너에서 호스트를 부르는 이름. Docker Desktop과 colima가 호스트의 루프백으로 이어 준다 */
export const AGENT_GATEWAY_HOST = 'host.docker.internal';
/** 컨테이너 안의 CLI가 부를 호스트의 두 서버: 훅을 받는 곳과 b-studio 도구(MCP)를 내주는 곳 */
export interface AgentGatewayAddress {
  hookUrl: string;
  hookToken: string;
  mcpUrl: string;
  mcpToken: string;
}
/** 훅의 종류(스크립트의 인자이자 관문의 경로) → 기다리는 시간(초) */
export const AGENT_HOOK_EVENTS = {
  /** 대화가 시작될 때. 이 작업 폴더가 무엇인지 알리는 글을 받는다 */
  'session-start': 15,
  /** 사용자가 요청을 보냈을 때. 실행 한 건이 시작된다 */
  prompt: 60,
  /** 파일을 바꿀 수 있는 도구를 쓰기 직전. 샌드박스가 켜지고 변경 전 기준을 잡을 때까지 기다린다 */
  'pre-tool': 1800,
  /** 턴이 끝날 때. 검증 게이트가 돈다(한 번이 수 분 걸릴 수 있다) */
  stop: 3600,
  /** CLI가 끝날 때. 열려 있던 실행을 닫는다 */
  'session-end': 10,
  /** CLI가 사람을 기다릴 때(확인 창·되묻기·입력 대기). 실행이 사람을 기다린다는 표시를 남긴다(B7). 판정을 바꾸지 않는다 */
  notification: 15,
  /**
   * 지켜보기만 하는 훅(#920): 읽기 도구의 쓰기 직전, 도구의 끝, 서브에이전트의 시작·끝, 할 일의 생김·끝남.
   * CLI가 기다리지 않게 따로(async) 돈다. 화면의 "지금 하는 일"에만 쓴다
   */
  activity: 5,
  /** 상태 줄(#920). 문맥 창을 관문에 알리고 사용자의 원래 상태 줄을 이어 부른다. 상태 줄은 짧게 끝나야 한다 */
  statusline: 3,
} as const;
export type AgentHookEvent = keyof typeof AGENT_HOOK_EVENTS;
/**
 * 사람을 기다림을 알리는 알림의 종류(B7). CLI의 `Notification` 훅 matcher는 입력의 `notification_type`을 본다.
 * `permission_prompt`(권한 확인)·`elicitation_dialog`(되묻기)·`agent_needs_input`(입력 필요)·`idle_prompt`(입력 대기)를 받는다.
 * input 대기는 실행이 열려 있을 때만 사람이 볼 일이라, 거르는 규칙은 세션 쪽에서 한 번 더 본다
 */
export const AGENT_NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog|agent_needs_input|idle_prompt';
/** 터미널을 열기 전에 컨테이너에서 관문에 닿는지 묻는 일이 기다리는 시간(초) */
const AGENT_PING_SECONDS = 5;
/**
 * 파일을 바꾸지 않는 내장 도구. 이것들만 쓰기 직전의 훅을 건너뛴다(호출마다 훅 프로세스가 뜨므로 읽기까지 걸면 느려진다).
 * 거꾸로 "바꾸는 도구"를 나열하지 않는다 — CLI에 새 도구가 생기거나 이름이 바뀌면, 나열에서 빠진 도구로 바꾼 파일은
 * 변경 전 기준 없이 바뀐다. 모르는 도구는 바꾸는 도구로 본다
 */
export const AGENT_READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'Agent', 'Task'] as const;
/** 쓰기 직전의 훅을 거는 도구 이름의 패턴: 읽기 도구가 아닌 모든 것 */
export const AGENT_WRITE_TOOL_MATCHER = `^(?!(?:${AGENT_READ_TOOLS.join('|')})$).+`;
/** 읽기 도구에만 거는 패턴(#920). 쓰기 직전의 훅과 겹치지 않는다 — 한 도구에는 둘 중 하나만 걸린다 */
export const AGENT_READ_TOOL_MATCHER = `^(?:${AGENT_READ_TOOLS.join('|')})$`;
/** 사용자의 원래 상태 줄 명령을 적어 두는 관문 파일(#920). 이 컴퓨터 방식에서 원래 명령이 있을 때만 둔다 */
export const STATUSLINE_FILE = 'statusline.json';
export const HOOK_SCRIPT_NAME = 'b-studio-hook.mjs';
export const GATEWAY_FILE_NAME = 'b-studio-gateway.json';
/** 훅을 돌릴 node. 이름으로 찾지 않는다 — 터미널의 PATH는 홈 폴더의 실행 파일 자리가 앞에 있어, 거기에 같은 이름을 두면 훅이 바뀐다 */
const HOOK_NODE = '/usr/local/bin/node';
const MCP_SERVER = 'b-studio';

/**
 * 훅 명령이 실행하는 스크립트(컨테이너 안의 node). 훅의 입력(JSON)을 관문에 그대로 보내고 답을 그대로 출력한다.
 * 관문의 주소와 토큰은 자기 옆의 파일에서 읽는다(읽기 전용으로 붙은 자리라 컨테이너 안에서 바꿀 수 없다).
 *
 * 관문에 닿지 못하거나, 관문이 오류로 답하거나, 주소를 읽지 못하면:
 *  - 쓰기 직전: 도구를 거절한다. 변경 전 기준을 잡지 못한 채 바뀌게 두면 그 변경이 나중에 잡는 기준에 섞여 들어간다
 *  - 요청의 시작: 막지 않고 사용자에게 알린다
 *  - 턴의 끝과 그 밖: 막지 않는다(막으면 CLI가 끝나지 않는다). 검증이 돌지 않았으므로 체크포인트는 생기지 않는다
 * `ping`은 훅이 아니라 터미널을 열기 전에 호스트가 "컨테이너에서 관문에 닿는가"를 묻는 데 쓴다(닿으면 0으로 끝난다).
 * fetch를 쓰지 않는다 — 응답 머리를 기다리는 기본 상한(5분)이 게이트 한 번보다 짧을 수 있다.
 */
/**
 * 읽기만 요청의 표시. 요청 글이 이것으로 시작하면 그 실행에서는 파일을 바꾸거나 명령을 돌리는 도구를 모두 거절한다(이슈 #689).
 * 표시를 알아보는 곳은 여기 하나다 — 서버(sessions.ts)와 컨테이너 안의 훅 스크립트가 같은 규칙을 쓴다. 둘이 다르게 읽으면
 * 한쪽은 읽기만으로 알고 다른 쪽은 아닌 요청이 생긴다
 */
export const AGENT_READ_ONLY_MARK = '[읽기만]';
/** 표시 앞에 있어도 되는 것: 빈칸과 눈에 보이지 않는 글자(폭 없는 빈칸, 방향 제어, BOM). 눈에는 표시로 시작하는 글이 표시로 읽히게 한다 */
const READ_ONLY_LEADING = String.raw`^[\s\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069]+`;

/**
 * 여러 줄로 붙여 넣은 요청을 claude가 감싸는 표시. 여는 표시 뒤와 닫는 표시 앞의 줄바꿈 하나도 표시와 함께 지운다 —
 * 사람이 글을 치다가 붙여 넣으면 감싸개가 글 중간에 올 수 있고, 여러 번 붙여 넣으면 감싸개도 여러 개다.
 * 서버와 컨테이너 안의 훅 스크립트가 같은 규칙을 써야 한다(둘이 다르게 읽으면 한쪽만 감싸개를 벗긴다).
 */
const PASTED_OPEN = String.raw`<pasted_content(?:\s+id="[^"]*")?>\r?\n?`;
const PASTED_CLOSE = String.raw`\r?\n?</pasted_content(?:\s+id="[^"]*")?>`;

/** 붙여 넣은 요청의 감싸개 표시만 지우고 안의 글은 남긴다. 표시가 없으면 그대로 돌려준다 */
export function unwrapPastedPrompt(prompt: string): string {
  return prompt.replace(new RegExp(PASTED_OPEN, 'g'), '').replace(new RegExp(PASTED_CLOSE, 'g'), '');
}

/** 조합형(NFD)으로 들어온 한글도 같은 글로 본다 */
export function isReadOnlyPrompt(prompt: string): boolean {
  return unwrapPastedPrompt(prompt).normalize('NFC').replace(new RegExp(READ_ONLY_LEADING), '').startsWith(AGENT_READ_ONLY_MARK);
}

export const AGENT_HOOK_SCRIPT = `// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const TIMEOUT_SECONDS = ${JSON.stringify({ ...AGENT_HOOK_EVENTS, ping: AGENT_PING_SECONDS + 3 })};
const event = process.argv[2] ?? '';

function finish(output) {
  if (output !== undefined) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// 읽기만 요청인가. 서버와 같은 규칙이다(isReadOnlyPrompt) — 붙여 넣은 요청의 감싸개를 먼저 벗긴다
function readOnlyPrompt() {
  try {
    const prompt = JSON.parse(body.toString('utf8')).prompt;
    if (typeof prompt !== 'string') return false;
    const unwrapped = prompt.replace(new RegExp(${JSON.stringify(PASTED_OPEN)}, 'g'), '').replace(new RegExp(${JSON.stringify(PASTED_CLOSE)}, 'g'), '');
    return unwrapped.normalize('NFC').replace(new RegExp(${JSON.stringify(READ_ONLY_LEADING)}), '').startsWith(${JSON.stringify(AGENT_READ_ONLY_MARK)});
  } catch {
    return false;
  }
}

function unreachable(why) {
  if (event === 'ping') process.exit(1);
  // 읽기만 요청은 등록하지 못하면 보내지 않는다. 그냥 보내면 서버는 이 요청이 읽기만인 줄 모르고, 뒤따르는 쓰기 도구를 보통 요청의 것으로 받아 준다
  if (event === 'prompt' && readOnlyPrompt()) finish({ decision: 'block', reason: '[b-studio] 읽기만 요청을 등록하지 못해 보내지 않았습니다(' + why + '). 다시 보내 주세요.' });
  if (event === 'prompt') finish({ systemMessage: '[b-studio] 관문에 닿지 못했습니다(' + why + '). 이 요청의 변경은 검증되지 않고 체크포인트도 생기지 않습니다.' });
  if (event === 'pre-tool') finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[b-studio] 관문에 닿지 못해(' + why + ') 파일을 바꿀 수 있는 도구를 막았습니다. 변경 전 기준을 잡을 수 없습니다.' } });
  finish();
}

if (!Object.hasOwn(TIMEOUT_SECONDS, event)) finish();
// 입력을 먼저 읽는다. 관문에 닿지 못했을 때도 요청 글을 보고 판단할 것이 있다(읽기만 요청)
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);

let base;
let token;
try {
  const address = JSON.parse(readFileSync(new URL('./${GATEWAY_FILE_NAME}', import.meta.url), 'utf8'));
  base = address.url;
  token = address.token;
} catch {
  // 아래에서 주소가 없는 것으로 다룬다
}
// 상태 줄(#920): 입력을 관문에 알리고(닿지 못해도 상관없다) 옆 파일에 적힌 사용자의 원래 상태 줄을 같은 입력으로 불러 그 출력을 낸다
if (event === 'statusline') {
  await new Promise((resolve) => {
    if (typeof base !== 'string' || typeof token !== 'string' || !base || !token) return resolve();
    try {
      const notice = http.request(new URL(base + '/statusline'), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer ' + token } }, (response) => {
        response.resume();
        response.on('end', resolve);
        response.on('error', resolve);
      });
      notice.setTimeout(1000, () => notice.destroy());
      notice.on('error', resolve);
      notice.end(body);
    } catch {
      resolve();
    }
  });
  let command;
  try {
    command = JSON.parse(readFileSync(new URL('./${STATUSLINE_FILE}', import.meta.url), 'utf8')).command;
  } catch {
    // 원래 상태 줄이 없다
  }
  if (typeof command !== 'string' || !command.trim()) process.exit(0);
  const line = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'] });
  line.on('error', () => process.exit(0));
  line.on('exit', (code) => process.exit(code ?? 0));
  line.stdin.on('error', () => {});
  line.stdin.end(body);
  // 원래 상태 줄이 끝나면(exit) 끝난다. 그때까지 아래의 훅 처리로 내려가지 않는다
  await new Promise(() => {});
} else if (typeof base !== 'string' || typeof token !== 'string' || !base || !token) unreachable('관문의 주소를 읽지 못했습니다');

let url;
try {
  url = new URL(base + '/' + event);
} catch {
  unreachable('관문의 주소를 읽지 못했습니다');
}
if (event !== 'statusline') send();

function send() {
const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer ' + token } }, (response) => {
  const parts = [];
  response.on('data', (part) => parts.push(part));
  response.on('error', () => unreachable('응답이 끊겼습니다'));
  response.on('end', () => {
    if (response.statusCode !== 200) unreachable('HTTP ' + response.statusCode);
    try {
      finish(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch {
      unreachable('응답을 읽지 못했습니다');
    }
  });
});
// 훅의 상한보다 조금 먼저 끊는다. CLI가 훅을 죽이기 전에 스스로 끝나야 출력이 남는다
request.setTimeout(Math.max(1, TIMEOUT_SECONDS[event] - 3) * 1000, () => request.destroy(new Error('시간 초과')));
request.on('error', (error) => unreachable(error.code ?? error.message));
request.end(body);
}
`;

/**
 * Codex CLI용 훅 스크립트(#825). AGENT_HOOK_SCRIPT와 같고, 관문 주소 파일을 자기 옆이 아니라 감싸개가 넘긴
 * `B_STUDIO_GATEWAY_DIR`(세션의 관문 폴더)에서 읽는다. Codex는 훅 명령 글의 해시로 사용자의 신뢰를 기억하므로,
 * 훅 명령이 세션마다 같은 경로(관문 루트의 이 스크립트)를 가리켜야 세션마다 다시 믿게 하지 않는다.
 * 넘겨받은 폴더는 이 스크립트가 놓인 폴더(관문 루트)의 바로 아래 폴더일 때만 쓴다(링크를 푼 진짜 경로로 견준다)
 */
/** Codex 감싸개가 세션의 관문 폴더를 훅 스크립트에 알리는 환경 변수 */
export const CODEX_GATEWAY_DIR_ENV = 'B_STUDIO_GATEWAY_DIR';
/** 관문 루트에 두는 Codex 훅 스크립트의 이름(모든 세션이 같이 쓴다) */
export const CODEX_HOOK_SCRIPT_NAME = 'b-studio-codex-hook.mjs';
const BESIDE_ADDRESS_LINE = `  const address = JSON.parse(readFileSync(new URL('./${GATEWAY_FILE_NAME}', import.meta.url), 'utf8'));`;
export const CODEX_HOOK_SCRIPT = AGENT_HOOK_SCRIPT.replace(
  "import { readFileSync } from 'node:fs';",
  "import { readFileSync, realpathSync } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';",
).replace(
  BESIDE_ADDRESS_LINE,
  [
    '  const root = realpathSync(path.dirname(fileURLToPath(import.meta.url)));',
    `  const dir = realpathSync(process.env.${CODEX_GATEWAY_DIR_ENV} ?? '');`,
    "  if (path.dirname(dir) !== root) throw new Error('관문 폴더가 관문 루트 아래가 아닙니다');",
    `  const address = JSON.parse(readFileSync(path.join(dir, '${GATEWAY_FILE_NAME}'), 'utf8'));`,
  ].join('\n'),
);
/**
 * Codex의 읽기 도구. 쓰기 직전 훅이 기다리지 않고 바로 통과시킨다. Codex의 훅 matcher는 앞보기를 못 쓰는 정규식이라
 * "읽기 도구가 아닌 모든 것"을 matcher로 걸 수 없다 — 모든 도구에 훅을 걸고 관문이 여기서 거른다. 모르는 도구는 바꾸는 도구로 본다
 */
export const CODEX_READ_TOOLS = ['view_image', 'web_search', 'tool_search', 'request_user_input', 'update_plan', 'get_goal', 'create_goal', 'update_goal', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] as const;

/**
 * Codex `apply_patch`의 패치 본문에서 바꾸는 파일 경로를 모두 꺼낸다(추가·고침·지움·옮길 곳). 패치 형식:
 * `*** Add File: <경로>`, `*** Update File: <경로>`, `*** Delete File: <경로>`, `*** Move to: <경로>`
 */
export function applyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match && match[1]!.trim()) paths.push(match[1]!.trim());
  }
  return paths;
}

/**
 * 터미널의 CLI가 모델 요청마다 쓴 양을 관문으로 보내게 하는 환경 변수(#726).
 * 관문의 훅 서버가 받는 자리(`/v1/logs`)로, 훅과 같은 주소·토큰을 쓴다.
 * 요청 글·도구 내용을 싣는 설정(`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` 등)은 켜지 않는다 — 쓰는 양만 본다.
 * 내보내기 주기를 1초로 두어 짧은 실행(답만 한 턴)도 CLI가 끝나기 전에 보낸다
 */
export function agentTelemetryEnv(address: Pick<AgentGatewayAddress, 'hookUrl' | 'hookToken'>): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${address.hookUrl}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${address.hookToken}`,
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
  };
}

/** CLI의 관리 설정. 훅과 b-studio 도구의 사용 허락, 그 밖에 텔레메트리 설정을 적는다 */
export function agentManagedSettings(address: Pick<AgentGatewayAddress, 'hookUrl' | 'hookToken'>): Record<string, unknown> {
  return gatewaySettings((event) => `${HOOK_NODE} ${AGENT_GATEWAY_TARGET}/${HOOK_SCRIPT_NAME} ${event}`, address);
}

/**
 * 훅과 b-studio 도구의 사용 허락을 적은 CLI 설정. 훅 명령을 어떻게 부를지만 자리마다 다르다
 * (컨테이너: 관리 설정 자리의 스크립트, 이 컴퓨터: 세션의 관문 폴더에 둔 스크립트 — host-terminal.ts)
 * 주소와 토큰은 텔레메트리를 관문으로 보내는 env에만 들어간다(이 파일은 600으로 쓴다)
 */
export function gatewaySettings(hookCommand: (event: AgentHookEvent) => string, address: Pick<AgentGatewayAddress, 'hookUrl' | 'hookToken'>): Record<string, unknown> {
  const hook = (event: AgentHookEvent) => ({ type: 'command', command: hookCommand(event), timeout: AGENT_HOOK_EVENTS[event] });
  // 지켜보기만 하는 훅(#920). CLI는 기다리지 않고 다음 일을 한다(async). 답도 읽지 않는다
  const observe = (event: AgentHookEvent) => ({ ...hook(event), async: true });
  return {
    // b-studio 도구는 서비스 컨테이너 안에서 돌고 b-studio의 실행 정책을 거친다. 호출마다 묻지 않게 한다
    permissions: { allow: [`mcp__${MCP_SERVER}`] },
    // 훅을 통째로 끄지 못하게 여기서 값을 정해 둔다. 컨테이너에서는 사용자 설정(에이전트가 쓸 수 있는 홈 폴더)이,
    // 이 컴퓨터에서는 작업 복사본의 프로젝트 설정(.claude/settings.json)이 에이전트가 쓸 수 있는 자리다.
    // 값을 주지 않은 실행 인자 설정은 프로젝트 설정의 disableAllHooks: true에 진다(CLI 2.1.296에서 실측, 트러블슈팅 145)
    disableAllHooks: false,
    // CLI의 사용자 설정(env)이 이 값을 덮어쓰지 못하게 관리 설정에서 정해 둔다. 훅과 같은 이유다
    env: agentTelemetryEnv(address),
    hooks: {
      SessionStart: [{ hooks: [hook('session-start')] }],
      UserPromptSubmit: [{ hooks: [hook('prompt')] }],
      PreToolUse: [
        { matcher: AGENT_WRITE_TOOL_MATCHER, hooks: [hook('pre-tool')] },
        // 읽기 도구는 기다리지 않고 지켜보기만 한다(#920). 화면의 "지금 하는 일"과 할 일 목록(TodoWrite)에 쓴다
        { matcher: AGENT_READ_TOOL_MATCHER, hooks: [observe('activity')] },
      ],
      Stop: [{ hooks: [hook('stop')] }],
      SessionEnd: [{ hooks: [hook('session-end')] }],
      // 사람을 기다리는 창이 뜨면 알린다(B7). matcher는 입력의 notification_type을 본다
      Notification: [{ matcher: AGENT_NOTIFICATION_MATCHER, hooks: [hook('notification')] }],
      // 권한 확인 창이 뜨는 그 순간 알린다(#920). Notification의 permission_prompt는 몇 초 늦게 온다. 답은 주지 않는다
      PermissionRequest: [{ hooks: [observe('notification')] }],
      // 지켜보기만 하는 훅(#920): 도구의 끝, 서브에이전트, 할 일
      PostToolUse: [{ hooks: [observe('activity')] }],
      PostToolUseFailure: [{ hooks: [observe('activity')] }],
      SubagentStart: [{ hooks: [observe('activity')] }],
      SubagentStop: [{ hooks: [observe('activity')] }],
      TaskCreated: [{ hooks: [observe('activity')] }],
      TaskCompleted: [{ hooks: [observe('activity')] }],
    },
    // 문맥 창을 아는 곳은 상태 줄의 입력뿐이다(#920). 훅 스크립트가 받아 관문에 알리고, 사용자의 원래 상태 줄이 있으면 이어 부른다
    statusLine: { type: 'command', command: hookCommand('statusline') },
  };
}

/** CLI의 관리 MCP 설정. 주소와 토큰을 그대로 적는다(환경 변수로 풀게 두면 사용자 설정의 env가 덮어쓴다) */
export function agentManagedMcp(address: AgentGatewayAddress): Record<string, unknown> {
  return { mcpServers: { [MCP_SERVER]: { type: 'http', url: address.mcpUrl, headers: { Authorization: `Bearer ${address.mcpToken}` } } } };
}

/** 관문 설정 파일의 이름 → 내용 */
export function agentGatewayFiles(address: AgentGatewayAddress): Record<string, string> {
  return {
    'managed-settings.json': `${JSON.stringify(agentManagedSettings(address), null, 2)}\n`,
    'managed-mcp.json': `${JSON.stringify(agentManagedMcp(address), null, 2)}\n`,
    [HOOK_SCRIPT_NAME]: AGENT_HOOK_SCRIPT,
    [GATEWAY_FILE_NAME]: `${JSON.stringify({ url: address.hookUrl, token: address.hookToken })}\n`,
  };
}

/** 관문 설정을 두는 호스트 폴더의 상위 폴더. 기본 ~/.cache/b-studio/agent-gateway */
export function defaultAgentGatewayRoot(): string {
  return path.resolve(process.env.B_STUDIO_AGENT_GATEWAY_DIR ?? path.join(homedir(), '.cache/b-studio/agent-gateway'));
}

export function gatewayDirFor(sandboxId: string, root: string): string {
  const safe = sandboxId.replace(/[^A-Za-z0-9_.-]/g, '-');
  if (!safe || safe === '.' || safe === '..') throw new SandboxError('샌드박스 id로 관문 설정 폴더를 정할 수 없습니다', sandboxId);
  return path.join(root, safe);
}

/**
 * 세션의 관문 설정 파일을 호스트에 쓰고 그 폴더를 돌려준다. 토큰이 들어 있으므로 이 사용자만 읽을 수 있게 둔다.
 * 부를 때마다 다시 쓴다 — 스튜디오를 다시 띄우면 주소와 토큰이 바뀌고, 떠 있는 컨테이너는 같은 폴더를 붙인 채다
 */
export async function writeAgentGatewayConfig(sandboxId: string, address: AgentGatewayAddress, root: string = defaultAgentGatewayRoot()): Promise<string> {
  const dir = gatewayDirFor(sandboxId, root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(agentGatewayFiles(address))) {
    const target = path.join(dir, name);
    if ((await readFile(target, 'utf8').catch(() => undefined)) === content) continue;
    // 같은 폴더에 임시 이름으로 쓰고 옮긴다. 읽는 쪽(컨테이너 안의 CLI)이 반쯤 쓰인 파일을 보지 않는다
    const staged = `${target}.${process.pid}.tmp`;
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, target);
  }
  return realpath(dir);
}

/** 세션이 멈출 때 그 세션의 관문 설정을 지운다. 이 코드가 쓴 파일만 지우고, 폴더는 비었을 때만 지운다 */
export async function removeAgentGatewayConfig(sandboxId: string, root: string = defaultAgentGatewayRoot()): Promise<void> {
  const dir = gatewayDirFor(sandboxId, root);
  for (const name of ['managed-settings.json', 'managed-mcp.json', HOOK_SCRIPT_NAME, GATEWAY_FILE_NAME]) await rm(path.join(dir, name), { force: true }).catch(() => {});
  await rmdir(dir).catch(() => {});
}

/** 터미널 크기의 허용 범위. 숫자가 아닌 값이 셸 명령에 들어가지 않게 정수로 좁힌다 */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

/**
 * 터미널을 열면 도는 명령. CLI가 없으면 홈 볼륨에 설치하고(처음 한 번), CLI를 띄우고, CLI에서 나오면 셸로 남는다.
 * 환경 변수로 넘겨 `sh -c "$변수"`로 실행한다. 명령 글을 따옴표 안에 끼워 넣지 않는다.
 */
export const AGENT_TERMINAL_COMMAND = [
  // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
  'trap : INT',
  'if ! command -v claude >/dev/null 2>&1; then',
  '  printf "%s\\n" "[b-studio] 이 컨테이너에 claude CLI를 설치합니다(처음 한 번)."',
  `  npm install --global --no-fund --no-audit ${AGENT_CLI_PACKAGE} || printf "%s\\n" "[b-studio] 설치하지 못했습니다. 네트워크를 확인하고 npm install -g ${AGENT_CLI_PACKAGE} 를 다시 실행하세요."`,
  'fi',
  'if command -v claude >/dev/null 2>&1; then claude; fi',
  'printf "%s\\n" "[b-studio] claude에서 나왔습니다. 다시 띄우려면 claude 를 입력하세요."',
  // 로그인 셸(-l)로 띄우지 않는다. 로그인 셸은 /etc/profile을 읽어 PATH를 기본값으로 되돌리고, 그러면 홈 볼륨에 설치한
  // claude를 찾지 못한다(안내대로 claude를 치면 "command not found"였다)
  'exec bash',
].join('\n');

export interface AgentContainerPlan {
  /** 컨테이너 이름 */
  name: string;
  /** 이 컨테이너가 속한 샌드박스. 샌드박스를 정리할 때 라벨로 함께 찾는다 */
  sandboxId: string;
  /** 작업 복사본(호스트 절대 경로) */
  projectRoot: string;
  /** `.git`을 막는 마운트(읽기 전용, 상태 폴더는 빈 폴더). computeGitMask가 계산한다 */
  masks: readonly MaskVolume[];
  /** CLI의 홈 폴더를 둘 볼륨(agentHomeVolume) */
  homeVolume: string;
  /** 관문 설정을 둔 호스트 폴더(writeAgentGatewayConfig). 주면 CLI의 관리 설정 자리에 읽기 전용으로 붙인다 */
  gatewayDir?: string;
  image?: string;
}

/** 세션 하나에 컨테이너 하나. 이름에 쓸 수 없는 글자는 뺀다 */
export function agentContainerName(sandboxId: string): string {
  return `${sandboxId.replace(/[^A-Za-z0-9_.-]/g, '-')}-agent`;
}

/**
 * CLI용 컨테이너를 띄우는 `docker run` 인자. 컨테이너는 아무것도 하지 않고 떠 있고(sleep), 터미널은 exec로 붙는다.
 *  - 보이는 호스트 폴더는 작업 복사본 하나다. `.git`은 읽기 전용으로 덮는다
 *  - 루트 파일 시스템은 읽기 전용. 쓸 수 있는 곳은 작업 복사본, 홈 볼륨, /tmp
 *  - 권한을 모두 내려놓고 root가 아닌 사용자로 돈다
 * 나가는 통신은 막지 않는다(CLI가 모델과 로그인 서버에 닿아야 한다). edge 프록시 뒤로 옮기는 것은 다음 단계다(#673)
 */
export function agentRunArgs(plan: AgentContainerPlan): string[] {
  const mount = (volume: MaskVolume): string => `type=bind,source=${volume.source},target=${volume.target},readonly`;
  for (const value of [plan.projectRoot, plan.homeVolume, ...(plan.gatewayDir ? [plan.gatewayDir] : []), ...plan.masks.flatMap((volume) => [volume.source, volume.target])]) {
    // --mount의 값은 쉼표로 나뉜다. 쉼표가 든 경로를 그대로 넣으면 다른 옵션으로 읽힌다
    if (value.includes(',')) throw new SandboxError('경로에 쉼표가 있어 에이전트 컨테이너에 연결할 수 없습니다', value);
  }
  return [
    'run',
    '--detach',
    '--init',
    '--name', plan.name,
    '--label', `b-studio.sandbox=${plan.sandboxId}`,
    '--label', `b-studio.service=${AGENT_SERVICE}`,
    '--hostname', AGENT_SERVICE,
    '--user', 'node',
    '--workdir', AGENT_WORKSPACE,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', '2g',
    '--mount', `type=bind,source=${plan.projectRoot},target=${AGENT_WORKSPACE}`,
    ...plan.masks.flatMap((volume) => ['--mount', mount(volume)]),
    '--mount', `type=volume,source=${plan.homeVolume},target=${AGENT_HOME}`,
    ...(plan.gatewayDir ? ['--mount', `type=bind,source=${plan.gatewayDir},target=${AGENT_GATEWAY_TARGET},readonly`] : []),
    '--env', `HOME=${AGENT_HOME}`,
    '--env', `NPM_CONFIG_PREFIX=${NPM_PREFIX}`,
    '--env', `PATH=${AGENT_PATH}`,
    '--env', 'LANG=C.UTF-8',
    plan.image ?? AGENT_IMAGE,
    'sleep', 'infinity',
  ];
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** 크기를 허용 범위의 정수로 맞춘다. 숫자가 아니면 기본값을 쓴다 */
export function clampTerminalSize(size: { cols?: unknown; rows?: unknown }): TerminalSize {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, number));
  };
  return { cols: clamp(size.cols, MIN_COLS, MAX_COLS, 100), rows: clamp(size.rows, MIN_ROWS, MAX_ROWS, 30) };
}

/** 터미널 id는 컨테이너 안의 파일 이름에 들어간다. 정해진 글자만 받는다 */
function assertTerminalId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new SandboxError('터미널 id가 올바르지 않습니다', id);
}

const ttyFile = (id: string): string => `/tmp/b-studio-tty-${id}`;

/**
 * 컨테이너 안에 가상 터미널을 만들고 그 안에서 명령을 돌리는 `docker exec` 인자.
 * `script`가 가상 터미널을 만들고 표준 입출력(파이프)과 잇는다. 터미널의 장치 이름을 파일에 적어 두어 크기를 바꿀 때 쓴다.
 * 명령과 크기는 환경 변수로 넘긴다(인자의 글에 끼워 넣지 않는다)
 */
export function agentTerminalArgs(name: string, { id, size, command = AGENT_TERMINAL_COMMAND }: { id: string; size: TerminalSize; command?: string }): string[] {
  assertTerminalId(id);
  const { cols, rows } = clampTerminalSize(size);
  return [
    'exec',
    '--interactive',
    '--workdir', AGENT_WORKSPACE,
    '--env', 'TERM=xterm-256color',
    '--env', 'COLORTERM=truecolor',
    '--env', `B_STUDIO_TTY_FILE=${ttyFile(id)}`,
    '--env', `B_STUDIO_TTY_SIZE=rows ${rows} cols ${cols}`,
    '--env', `B_STUDIO_TERMINAL_COMMAND=${command}`,
    name,
    'script', '--quiet', '--flush', '--command', 'stty $B_STUDIO_TTY_SIZE; tty > "$B_STUDIO_TTY_FILE"; exec sh -c "$B_STUDIO_TERMINAL_COMMAND"', '/dev/null',
  ];
}

/** 열려 있는 터미널의 크기를 바꾸는 `docker exec` 인자. 크기가 바뀌면 터미널이 그 안의 프로그램에 알린다(SIGWINCH) */
export function agentResizeArgs(name: string, id: string, size: TerminalSize): string[] {
  assertTerminalId(id);
  const { cols, rows } = clampTerminalSize(size);
  return ['exec', '--env', `B_STUDIO_TTY_FILE=${ttyFile(id)}`, name, 'sh', '-c', `stty -F "$(cat "$B_STUDIO_TTY_FILE")" rows ${rows} cols ${cols}`];
}

export interface AgentContainerOptions {
  /** 홈 볼륨을 나누는 단위(프로젝트 id) */
  projectId: string;
  /** 관문 설정을 둔 호스트 폴더. 주면 CLI의 관리 설정 자리에 붙이고, 붙었는지를 띄운 뒤에 확인한다 */
  gatewayDir?: string;
  /**
   * 세션 프로젝트가 선언한 평가 자산(studio.yaml workflow.evaluationAssets). 작업 복사본이 아니라 b-studio가 가진 복사본(#745)을
   * 작업 복사본 위에 읽기 전용으로 덮는다. 선언이 바뀌면 다음에 컨테이너를 만들 때부터 반영된다 — 떠 있는 컨테이너의 마운트가
   * 선언과 다르면 지우고 새로 띄운다. 게이트의 지문 견줌은 그대로 남는다(이 컴퓨터 방식의 호스트 셸은 컨테이너 밖이라
   * 이 마운트로 막지 못한다 — 지문 견줌이 맡는다)
   */
  evaluationAssets?: readonly string[];
  /** 복사본을 두는 호스트 폴더(샌드박스 제공자와 같아야 한다). 기본 ~/.cache/b-studio/evaluation-assets */
  evaluationAssetRoot?: string;
  dockerBin?: string;
  image?: string;
}

/**
 * 세션의 CLI용 컨테이너가 떠 있게 한다. 이미 떠 있으면 그대로 쓰고, 멈춰 있으면 지우고 새로 띄운다.
 * 띄운 뒤에는 설정이 아니라 결과를 본다: 실제 마운트에서 `.git`이 읽기 전용으로 덮였는지 확인하고, 아니면 지우고 던진다.
 * 확인하기 전에는 누구도 이 컨테이너에서 명령을 돌리지 않는다(이름을 돌려주지 않는다)
 */
export async function ensureAgentContainer(
  sandboxId: string,
  projectRoot: string,
  { projectId, gatewayDir, evaluationAssets, evaluationAssetRoot, dockerBin = 'docker', image }: AgentContainerOptions,
): Promise<string> {
  const name = agentContainerName(sandboxId);
  const docker = (args: string[]) => execFileAsync(dockerBin, args, { cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024 });
  const root = await realpath(projectRoot);
  // 서비스 컨테이너와 같은 복사본 자리를 본다(#745). 여기서는 만들지 않는다 — 샌드박스를 만들 때 이미 만들어 두었다
  const copies = evaluationAssetCopies(evaluationAssets ?? [], evaluationAssetRoot ?? defaultEvaluationAssetRoot(), sandboxId);
  const masks = (await computeGitMask(root, { services: { [AGENT_SERVICE]: { volumes: [{ type: 'bind', source: root, target: AGENT_WORKSPACE }] } } }, { evaluationAssets: copies }))[AGENT_SERVICE] ?? [];
  // 사후 확인의 기대는 계획(마스크에 적은 target·원본)에서 가져온다 — 실제 마운트에서 계산하지 않는다
  const evaluationAssetPlan = { [AGENT_SERVICE]: await selectEvaluationAssetVolumes(masks, copies) };

  // 설정이 다른 컨테이너(관문 없이 띄운 것, 다른 판의 설정을 붙인 것)는 다시 쓰지 않고 새로 띄운다
  const ready = async ({ mounts, tmpfs }: InspectedContainer): Promise<boolean> =>
    (await masksInPlace(root, mounts, tmpfs, evaluationAssetPlan)) && gatewayInPlace(gatewayDir, mounts);
  const existing = await inspect(dockerBin, name);
  // 스튜디오가 검사 도중에 죽었다 다시 뜨면 컨테이너가 멈춘 채(State.Paused) 남아 있다. 그대로 내주면 아무 명령도 돌지 않는다
  if (existing?.paused) {
    await docker(['unpause', name]).then(
      () => {
        existing.paused = false;
      },
      () => {},
    );
  }
  if (existing?.running && !existing.paused && (await ready(existing))) return name;
  if (existing) await docker(['rm', '--force', name]).catch(() => {});

  try {
    await docker(agentRunArgs({ name, sandboxId, projectRoot: root, masks, homeVolume: agentHomeVolume(projectId), gatewayDir, image }));
  } catch (error) {
    throw new SandboxError('에이전트 컨테이너를 띄우지 못했습니다', describe(error), { platform: true });
  }
  const started = await inspect(dockerBin, name);
  if (!started?.running || !(await ready(started))) {
    await docker(['rm', '--force', name]).catch(() => {});
    throw new SandboxError('에이전트 컨테이너의 .git 보호와 관문 설정을 확인하지 못해 컨테이너를 지웠습니다', started ? `마운트 ${started.mounts.length}개` : '컨테이너가 뜨지 않았습니다', { platform: true });
  }
  return name;
}

/**
 * 컨테이너 안에서 관문에 닿는가. 훅과 같은 스크립트로, 컨테이너가 읽는 바로 그 설정 파일의 주소와 토큰으로 묻는다.
 * 닿지 못하는 도커 환경(컨테이너가 호스트의 루프백에 닿지 못하는 리눅스 엔진 등)에서는 터미널을 열지 않으려고 먼저 묻는다
 */
export async function probeAgentGateway(name: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<boolean> {
  const args = ['exec', name, HOOK_NODE, `${AGENT_GATEWAY_TARGET}/${HOOK_SCRIPT_NAME}`, 'ping'];
  return execFileAsync(dockerBin, args, { cwd: tmpdir(), timeout: (AGENT_PING_SECONDS + 10) * 1000 }).then(
    () => true,
    () => false,
  );
}

/**
 * 에이전트 컨테이너를 지우는 명령. 스튜디오가 종료 신호를 받았을 때는 기다릴 수 없어, 떼어 놓은 프로세스로 이 명령을 돌린다.
 * 에이전트 컨테이너는 compose 프로젝트에 속하지 않아 샌드박스를 내리는 명령(compose down)으로는 지워지지 않는다
 */
export function agentCleanupCommand(sandboxId: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): { command: string; args: string[] } {
  // 저장된 값으로 무언가를 지우기 전에 형식을 본다. 아니면 이름이 "-agent"로 끝나는 남의 컨테이너를 가리킬 수 있다
  assertSandboxId(sandboxId);
  return { command: dockerBin, args: ['rm', '--force', agentContainerName(sandboxId)] };
}

/** 세션을 정리할 때 부른다. 없으면 아무 일도 하지 않는다 */
export async function removeAgentContainer(sandboxId: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<void> {
  await execFileAsync(dockerBin, ['rm', '--force', agentContainerName(sandboxId)], { cwd: tmpdir() }).catch(() => {});
}

/**
 * 에이전트 컨테이너를 멈춘다(`docker pause`). 검증 게이트가 검사 시작·끝에 작업 복사본의 지문을 견주는 동안(이슈 #765),
 * 컨테이너 안에서 도는 CLI와 그 백그라운드 셸이 파일을 바꾸지 못하게 한다. Stop 훅은 이 컨테이너 안에서 응답을 기다리므로
 * 함께 멈춘다. 멈추지 못하면 던진다 — 부르는 쪽이 게이트를 돌리지 않는 쪽으로 판단한다
 */
export async function pauseAgentContainer(sandboxId: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<void> {
  try {
    await execFileAsync(dockerBin, ['pause', agentContainerName(sandboxId)], { cwd: tmpdir() });
  } catch (error) {
    throw new SandboxError('에이전트 컨테이너를 멈추지 못했습니다', describe(error));
  }
}

/** 멈춘 에이전트 컨테이너를 다시 움직이게 한다(`docker unpause`). 실패하면 던진다 */
export async function unpauseAgentContainer(sandboxId: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<void> {
  try {
    await execFileAsync(dockerBin, ['unpause', agentContainerName(sandboxId)], { cwd: tmpdir() });
  } catch (error) {
    throw new SandboxError('에이전트 컨테이너를 다시 움직이지 못했습니다', describe(error));
  }
}

interface InspectedContainer {
  running: boolean;
  /** 검사 동안 멈춘 채 남았는가(State.Paused). 그대로 쓰면 아무 명령도 돌지 않는다 */
  paused: boolean;
  mounts: InspectedMount[];
  tmpfs: Record<string, string>;
}

async function masksInPlace(
  projectRoot: string,
  mounts: readonly InspectedMount[],
  tmpfs: Readonly<Record<string, string>>,
  evaluationAssetPlan: Readonly<Record<string, readonly MaskVolume[]>>,
): Promise<boolean> {
  return (await findMissingMasks(projectRoot, mounts, {}, { evaluationAssetPlan, service: AGENT_SERVICE, tmpfs })).length === 0;
}

/** 관문 설정이 정한 대로 붙어 있는가: 주었으면 그 폴더가 읽기 전용으로, 주지 않았으면 그 자리에 아무것도 없어야 한다 */
function gatewayInPlace(gatewayDir: string | undefined, mounts: readonly InspectedMount[]): boolean {
  const mounted = mounts.filter((mount) => mount.Destination === AGENT_GATEWAY_TARGET);
  if (gatewayDir === undefined) return mounted.length === 0;
  // Docker Desktop은 호스트 경로 앞에 자기 접두어(/host_mnt)를 붙여 알려 주기도 한다(실측: 같은 컨테이너에서 이 마운트만 붙었다).
  // 그래서 끝이 같은지로 본다. 폴더는 세션마다 따로라 다른 세션의 설정과는 끝이 다르다
  const source = mounted[0]?.Source ?? '';
  return mounted.length === 1 && (source === gatewayDir || source.endsWith(gatewayDir)) && mounted[0]!.RW === false;
}

async function inspect(dockerBin: string, name: string): Promise<InspectedContainer | undefined> {
  try {
    const { stdout } = await execFileAsync(dockerBin, ['inspect', '--type', 'container', name], { cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024 });
    const [container] = JSON.parse(stdout) as Array<{ State?: { Running?: boolean; Paused?: boolean }; Mounts?: InspectedMount[]; HostConfig?: { Tmpfs?: Record<string, string> | null } }>;
    return container ? { running: container.State?.Running === true, paused: container.State?.Paused === true, mounts: container.Mounts ?? [], tmpfs: container.HostConfig?.Tmpfs ?? {} } : undefined;
  } catch {
    return undefined;
  }
}

/** 열린 터미널 하나. 출력은 바이트 그대로 준다(화면 제어 문자가 섞여 있어 글자로 바꾸지 않는다) */
export interface AgentTerminal {
  readonly id: string;
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null) => void): void;
  close(): void;
}

/** 프로세스를 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnTerminal = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/** 컨테이너 안에 가상 터미널을 열고 기본 명령(CLI)을 띄운다. 컨테이너는 ensureAgentContainer가 확인한 것이어야 한다 */
export function openAgentTerminal(
  name: string,
  { id, size, command, dockerBin = 'docker', spawnProcess = (bin, args) => spawn(bin, args, { cwd: tmpdir() }) }: { id: string; size: TerminalSize; command?: string; dockerBin?: string; spawnProcess?: SpawnTerminal },
): AgentTerminal {
  const child = spawnProcess(dockerBin, agentTerminalArgs(name, { id, size, command }));
  // 닫힌 뒤에 들어온 입력으로 프로세스 전체가 죽지 않게 한다
  child.stdin.on('error', () => {});
  return {
    id,
    write(data) {
      if (child.stdin.writable) child.stdin.write(data);
    },
    async resize(next) {
      await execFileAsync(dockerBin, agentResizeArgs(name, id, next), { cwd: tmpdir() }).catch(() => {});
    },
    onData(listener) {
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
    },
    onExit(listener) {
      child.once('close', (code) => listener(code));
    },
    close() {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n').slice(-3).join(' / ');
  return error instanceof Error ? error.message : String(error);
}

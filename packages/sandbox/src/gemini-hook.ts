import { AGENT_HOOK_EVENTS, GATEWAY_FILE_NAME } from './docker/agent-terminal';
import { envCodeLoadRules } from './env-risk';
import { GEMINI_ENV_BASELINE_ENV, GEMINI_ENV_NAMES_ENV, GEMINI_SELF_SET_ENVS, GEMINI_UNSET_ENVS } from './gemini-envs';

/**
 * Gemini CLI의 설정 훅(`GEMINI_CLI_HOME/.gemini/settings.json`의 `hooks`)이 부르는 명령 파일(ADR-242, 실험).
 * Claude Code 터미널의 훅 스크립트(AGENT_HOOK_SCRIPT)와 같은 관문 통로를 부르므로 판정 코드는 같다: 쓰기 범위·보호 경로, 쓰기 뒤 기록, 턴 끝 게이트, 요청 받기.
 * 이 파일이 하는 일은 관문의 답(Claude의 꼴)을 Gemini의 훅 출력 꼴(`decision: deny`, `reason`, `systemMessage`)로 옮기는 것이다.
 *
 * 근거는 0.71.1에 든 소스다(`hookRunner.executeCommandHook`, `hookAggregator`, `hookSystem`, `coreToolHookTriggers`; 실제로 띄워 보지는 않았다):
 * - 훅 명령은 표준 입력으로 JSON을 받고, 종료 코드 0이면 표준 출력(없으면 표준 오류)을 JSON으로 읽는다. 종료 코드 1은 경고(허용), 2 이상은 표준 오류의 글이 있어야 거절이 된다
 *   (글이 비어 있으면 **출력이 없는 것으로 읽혀 허용**이다). 시간 초과(`timeout`, 밀리초)·실행 실패·신호로 죽음은 모두 **열리는 쪽**(도구가 실행된다)이다.
 *   그래서 막는 훅(요청 받기·쓰기 직전)은 어떤 예외가 나도 종료 코드 0과 `decision: deny` JSON을 내고, 설정의 명령에도 `|| { 글 >&2; exit 2; }`를 붙여 이 파일이 실행되지 못한 경우도 거절로 만든다.
 * - 턴 끝(`AfterAgent`)은 `decision: deny`(별칭 `block`)와 `reason`으로 이어가게 하고, 그 사유는 같은 대화의 새 요청으로 간다(`stop_hook_active`가 참이 된다).
 *   그 새 요청은 `BeforeAgent`를 다시 거치므로 서버는 게이트 사유를 새 요청으로 열지 않는다(요청 받기 판정).
 * 응답은 **허용 목록**으로 읽는다: 관문이 실제로 내는 꼴만 알아보고 나머지는 이상한 응답이다.
 * 훅의 대화 id(`session_id`)는 서버에 보내지 않는다: `--resume`이 이 id를 받는지 확인하지 못했다.
 *
 * 이 글에는 백틱과 `${`를 쓰지 않는다(템플릿 문자열로 담겨 있다). 의존성 없이 node 내장만 쓴다(관문 폴더에는 node_modules가 없다).
 */

/** 관문 폴더 안의 훅 명령 파일 이름. Rust 관문 파일 목록(GATEWAY_FILE_NAMES)과 같아야 한다 */
export const GEMINI_HOOK_NAME = 'b-studio-gemini-hook.mjs';
/** 관문 폴더 안의 Gemini 설정 파일 이름(감싸개가 `GEMINI_CLI_HOME/.gemini/settings.json`으로 복사한다). Rust 관문 파일 목록과 같아야 한다 */
export const GEMINI_SETTINGS_NAME = 'gemini-settings.json';
/** 감싸개가 CLI에 알리는 Gemini의 홈(`GEMINI_CLI_HOME`). 관문 폴더 안의 이 이름의 폴더다 */
export const GEMINI_HOME_DIR = 'gemini-home';

/** 훅 종류(이 파일의 인자) → 관문 경로 */
export const GEMINI_HOOK_EVENTS = ['session-start', 'prompt', 'pre-tool', 'post-tool', 'stop', 'notification', 'session-end'] as const;
export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];

/** 훅 종류별 기다리는 시간(초). 관문의 훅 통로와 같다 */
export function geminiHookSeconds(event: GeminiHookEvent): number {
  switch (event) {
    case 'post-tool':
      return AGENT_HOOK_EVENTS.activity;
    default:
      return AGENT_HOOK_EVENTS[event];
  }
}

export const GEMINI_HOOK = String.raw`// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_SECONDS = __B_STUDIO_TIMEOUTS__;
const ADDRESS_FILE = __B_STUDIO_ADDRESS_FILE__;
const ENV_RISKY = __B_STUDIO_ENV_RISKY__;
const ENV_BASELINE_ENV = __B_STUDIO_ENV_BASELINE_ENV__;
const ENV_NAMES_ENV = __B_STUDIO_ENV_NAMES_ENV__;
// 시간 상한은 낮추기만 할 수 있다(시험이 쓴다). 낮추면 더 막을 뿐이다
const TIMEOUT_CAP_MS = Number(process.env.B_STUDIO_HOOK_TIMEOUT_MS);
const event = process.argv[2] ?? '';
const REASON_HEAD = '[b-studio] 관문에 닿지 못해(';

const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const why = (error) => (error instanceof Error && error.message ? error.message : String(error));

// 출력을 내고 끝낸다. 종료 코드는 늘 0이다(0이 아니면 Gemini는 출력의 거절을 읽지 않을 수 있다)
function finish(output) {
  process.stdout.write(JSON.stringify(output), () => process.exit(0));
}

// 이 훅이 막는 쪽인가: 요청 받기·쓰기 직전. 막지 못하면 열리는 쪽이다
function deny(reason) {
  finish({ decision: 'deny', reason });
}

// 관문의 주소와 토큰. 부를 때마다 읽는다(글에 박지 않는다). 루프백 http가 아니면 받지 않는다
function readAddress() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ADDRESS_FILE);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!isPlain(parsed) || !nonEmpty(parsed.url) || !nonEmpty(parsed.token)) throw new Error('주소 파일이 이상합니다');
  const url = new URL(parsed.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '') throw new Error('관문 주소가 루프백 http가 아닙니다');
  return { base: url.origin, token: parsed.token };
}

// 관문에 한 번 보낸다. 성공(200)이고 JSON으로 읽힌 것만 값으로 돌려주고, 나머지는 모두 던진다
function post(route, payload) {
  return new Promise((resolve, reject) => {
    let address;
    let body;
    let seconds;
    try {
      seconds = TIMEOUT_SECONDS[event];
      if (!(seconds > 0)) throw new Error('모르는 훅 종류입니다');
      address = readAddress();
      body = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // 훅의 상한보다 조금 먼저 끊는다
    let limitMs = Math.max(1, seconds - 3) * 1000;
    if (Number.isFinite(TIMEOUT_CAP_MS) && TIMEOUT_CAP_MS > 0) limitMs = Math.min(limitMs, TIMEOUT_CAP_MS);
    let settled = false;
    let timer;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    let request;
    try {
      request = http.request(address.base + '/' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer ' + address.token } }, (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.on('error', () => done(reject, new Error('응답이 끊겼습니다')));
        response.on('end', () => {
          if (response.statusCode !== 200) return done(reject, new Error('HTTP ' + response.statusCode));
          try {
            done(resolve, JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch {
            done(reject, new Error('응답을 읽지 못했습니다'));
          }
        });
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    timer = setTimeout(() => {
      done(reject, new Error('시간 초과'));
      request.destroy();
    }, limitMs);
    request.on('error', (error) => done(reject, new Error(error && error.code ? error.code : '연결하지 못했습니다')));
    request.end(body);
  });
}

// 관문의 답 읽기: 알아보는 꼴만 받는다. 모르는 꼴은 던진다(이상한 응답)
function readMessageOnly(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  for (const key of Object.keys(answer)) if (key !== 'systemMessage') throw new Error('모르는 응답입니다');
  if (answer.systemMessage !== undefined && typeof answer.systemMessage !== 'string') throw new Error('모르는 응답입니다');
  return answer.systemMessage;
}

function contextOf(answer, name) {
  const output = answer.hookSpecificOutput;
  if (Object.keys(answer).length !== 1 || !isPlain(output) || output.hookEventName !== name || !nonEmpty(output.additionalContext)) throw new Error('모르는 응답입니다');
  return output.additionalContext;
}

function readPreTool(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  const output = answer.hookSpecificOutput;
  if (output === undefined) return { message: readMessageOnly(answer) };
  if (Object.keys(answer).length !== 1 || !isPlain(output) || output.hookEventName !== 'PreToolUse' || output.permissionDecision !== 'deny' || !nonEmpty(output.permissionDecisionReason)) throw new Error('모르는 응답입니다');
  return { deny: output.permissionDecisionReason };
}

function readBlock(answer) {
  if (Object.keys(answer).length !== 2 || answer.decision !== 'block' || !nonEmpty(answer.reason)) throw new Error('모르는 응답입니다');
  return answer.reason;
}

function readPrompt(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  if (answer.decision !== undefined) return { blocked: readBlock(answer) };
  if (answer.hookSpecificOutput !== undefined) return { note: contextOf(answer, 'UserPromptSubmit') };
  readMessageOnly(answer);
  return {};
}

function readStop(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  if (answer.decision !== undefined) return { feedback: readBlock(answer) };
  return { message: readMessageOnly(answer) };
}

function readSessionStart(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  if (answer.hookSpecificOutput !== undefined) return { note: contextOf(answer, 'SessionStart') };
  readMessageOnly(answer);
  return {};
}

const withMessage = (message) => (nonEmpty(message) ? { systemMessage: message } : {});
const cwdOf = (input) => (nonEmpty(input.cwd) ? { cwd: input.cwd } : {});

// 환경 이름이 설정·믿음·샌드박스 변수이거나 코드 적재·설정 자리 변수(공통 목록 env-risk.ts)인가. 대소문자를 접어 견준다. Gemini가 스스로 다시 띄우며 정하는 이름은 정확한 이름으로만 뺀다
function riskyEnvName(name) {
  const upper = name.toUpperCase();
  if (ENV_RISKY.own.includes(upper)) return true;
  if (ENV_RISKY.selfSet.includes(upper) || ENV_RISKY.allowed.includes(upper)) return false;
  return ENV_RISKY.exact.includes(upper) || ENV_RISKY.prefixes.some((prefix) => upper.startsWith(prefix)) || ENV_RISKY.suffixes.some((suffix) => upper.endsWith(suffix));
}

// CLI 프로세스 안의 환경 다시 확인(#1475). 설정의 훅 명령이 bash로 Gemini의 환경 **이름만**(값이 아니다)을 넘기고(ENV_NAMES_ENV), 감싸개가 띄우기 직전에 남긴 이름 목록(ENV_BASELINE_ENV)과 견준다.
// 기준에 없는 설정·믿음·샌드박스 변수(Gemini가 시작할 때 작업 폴더의 .env에서 넣은 것)가 있으면 그 이름을 돌려준다. 어느 쪽 목록이든 없으면 모르는 것이라 그 변수의 이름을 돌려준다(막는다)
function introducedRiskyEnv() {
  const baseline = process.env[ENV_BASELINE_ENV];
  const names = process.env[ENV_NAMES_ENV];
  if (typeof baseline !== 'string' || baseline.trim() === '') return ENV_BASELINE_ENV;
  if (typeof names !== 'string' || names.trim() === '') return ENV_NAMES_ENV;
  const known = new Set(baseline.split(/\s+/).filter((name) => name !== ''));
  for (const name of names.split(/\s+/)) if (name !== '' && !known.has(name) && riskyEnvName(name)) return name;
  return undefined;
}
const ENV_REASON_HEAD = '[b-studio] Gemini의 환경에 시작한 뒤 새로 생긴 설정·샌드박스 변수(';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    input = undefined;
  }
  const readable = isPlain(input);
  if (!readable) input = {};
  // 환경을 확인하지 못했거나 위험한 이름이 새로 생겼다. 막는 훅은 막고, 세션 시작 신호는 보내지 않는다(신호가 없으면 서버가 훅이 붙지 않은 것으로 보고 터미널을 닫는다)
  const envBad = introducedRiskyEnv();
  const envReason = envBad === undefined ? undefined : ENV_REASON_HEAD + envBad + ')가 있어 막았습니다. 작업 폴더의 .env나 셸 환경에서 지운 뒤 터미널을 다시 여세요.';
  if (envReason !== undefined && event === 'session-start') return finish({});
  if (envReason !== undefined && (event === 'pre-tool' || event === 'prompt')) return deny(envReason);

  if (event === 'pre-tool') {
    // 본문을 읽지 못하면 도구 이름 없이 판정하게 되므로 막는다
    if (!readable || !nonEmpty(input.tool_name)) return deny('[b-studio] 도구 호출의 본문을 읽지 못해 파일을 바꿀 수 있는 도구를 막았습니다. 다시 시도해 주세요.');
    try {
      const answer = readPreTool(await post('pre-tool', { hook_event_name: 'PreToolUse', tool_name: input.tool_name, tool_input: input.tool_input, ...cwdOf(input) }));
      if (answer.deny) return deny(answer.deny);
      return finish(withMessage(answer.message));
    } catch (error) {
      return deny(REASON_HEAD + why(error) + ') 파일을 바꿀 수 있는 도구를 막았습니다. 변경 전 기준을 잡을 수 없습니다.');
    }
  }

  if (event === 'prompt') {
    if (!readable || typeof input.prompt !== 'string') return deny('[b-studio] 요청의 본문을 읽지 못해 보내지 않았습니다. 다시 보내 주세요.');
    try {
      const answer = readPrompt(await post('prompt', { hook_event_name: 'UserPromptSubmit', prompt: input.prompt, ...cwdOf(input) }));
      if (answer.blocked) return deny(answer.blocked);
      if (answer.note) return finish({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: answer.note } });
      return finish({});
    } catch (error) {
      return deny(REASON_HEAD + why(error) + ') 요청을 보내지 않았습니다. 다시 보내 주세요.');
    }
  }

  if (event === 'stop') {
    // 이미 한 번 이어가게 한 턴(stop_hook_active)이면 닿지 못해도 더 이어가지 않는다: 끝없이 돌지 않게. 이때는 사용자에게 알린다
    const again = readable && input.stop_hook_active === true;
    try {
      const last = typeof input.prompt_response === 'string' ? input.prompt_response : '';
      const answer = readStop(await post('stop', { hook_event_name: 'Stop', last_assistant_message: last, stop_hook_active: again, ...cwdOf(input) }));
      if (answer.feedback) return deny(answer.feedback);
      return finish(withMessage(answer.message));
    } catch (error) {
      // 검증이 돌지 않았다. 체크포인트는 생기지 않는다. 처음에는 에이전트에게 알려 다시 끝내게 한다(관문이 돌아올 수 있다)
      const text = REASON_HEAD + why(error) + ') 이번 변경을 검증하지 못했습니다. 체크포인트가 생기지 않았습니다.';
      if (!again) return deny(text + ' 같은 변경을 다시 보여 주며 턴을 끝내세요.');
      return finish({ systemMessage: text });
    }
  }

  // 아래는 알리기만 하는 통로다. 닿지 못해도 판정은 그대로라 빈 답을 낸다
  try {
    if (event === 'session-start') {
      const answer = readSessionStart(await post('session-start', { hook_event_name: 'SessionStart', ...(nonEmpty(input.source) ? { source: input.source } : {}), ...cwdOf(input) }));
      if (answer.note) return finish({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: answer.note } });
    } else if (event === 'post-tool') {
      const failed = isPlain(input.tool_response) && input.tool_response.error !== undefined && input.tool_response.error !== null;
      await post('activity', { hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: input.tool_name, tool_input: input.tool_input, ...(failed ? { error: '도구 실행이 실패했습니다' } : {}), ...cwdOf(input) });
    } else if (event === 'notification') {
      await post('notification', { hook_event_name: 'Notification', notification_type: 'permission_prompt', ...(typeof input.message === 'string' ? { message: input.message } : {}), ...cwdOf(input) });
    } else if (event === 'session-end') {
      // /clear는 같은 CLI의 새 대화다(곧이어 SessionStart가 온다). CLI의 끝이 아니라 알리지 않는다
      if (input.reason !== 'clear') await post('session-end', { hook_event_name: 'SessionEnd', ...(nonEmpty(input.reason) ? { reason: input.reason } : {}), ...cwdOf(input) });
    }
  } catch {
    // 알리기만 한다
  }
  return finish({});
}

try {
  await main();
} catch (error) {
  // 어떤 예외든 막는 훅은 막고 나머지는 빈 답이다
  if (event === 'pre-tool') deny(REASON_HEAD + why(error) + ') 파일을 바꿀 수 있는 도구를 막았습니다.');
  else if (event === 'prompt') deny(REASON_HEAD + why(error) + ') 요청을 보내지 않았습니다. 다시 보내 주세요.');
  else finish({});
}
`
  .replace('__B_STUDIO_TIMEOUTS__', () => JSON.stringify({ ...AGENT_HOOK_EVENTS, 'post-tool': AGENT_HOOK_EVENTS.activity }))
  .replace('__B_STUDIO_ADDRESS_FILE__', () => JSON.stringify(GATEWAY_FILE_NAME))
  .replace('__B_STUDIO_ENV_RISKY__', () => JSON.stringify({ ...envCodeLoadRules(), own: [...GEMINI_UNSET_ENVS, 'GEMINI_CLI_HOME'].map((name) => name.toUpperCase()), selfSet: GEMINI_SELF_SET_ENVS }))
  .replace('__B_STUDIO_ENV_BASELINE_ENV__', () => JSON.stringify(GEMINI_ENV_BASELINE_ENV))
  .replace('__B_STUDIO_ENV_NAMES_ENV__', () => JSON.stringify(GEMINI_ENV_NAMES_ENV));

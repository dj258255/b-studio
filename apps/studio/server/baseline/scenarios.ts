import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BaselineSnapshot, DiskState, Driver, DockerScenario, WorldOptions } from './harness';

/**
 * 게이트 판정 표(4f-plan.md "먼저 고정할 판정 표")의 행마다 시나리오 하나. 모두 `/api/sessions/[id]/messages` 경로(stream-json 러너 + 가짜 CLI)로 몬다.
 * 시나리오는 서버가 어떤 구현이든(Node, 나중의 Rust) HTTP·SSE·디스크로만 관찰한다.
 */
export interface Scenario {
  name: string;
  /** 무엇을 고정하는가(판정 표의 행) */
  covers: string;
  options: WorldOptions;
  /** 사진에 내용을 남길 작업 복사본의 파일 */
  files?: string[];
  run: (ctx: ScenarioContext) => Promise<void>;
  /**
   * 사진과 별개로 "옳은 동작"을 말하는 기대. 사진은 지금 값을 고정할 뿐 옳은지는 말하지 않으므로, 결함을 고친 시나리오는 여기에 기대를 적는다.
   * 어긋난 것을 사람이 읽을 글로 돌려준다(비면 통과)
   */
  check?: (snapshot: BaselineSnapshot) => string[];
}

/**
 * 터미널 CLI 흉내(세션 터미널 경로). 진짜 CLI가 훅을 부르는 순서대로 같은 훅 스크립트를 부르고, 파일은 시험이 직접 쓴다(호스트 방식의 CLI는 작업 복사본에 직접 쓴다).
 * 훅 입력의 모양은 진짜 Claude Code의 훅 입력을 보고 흉내 낸 것이다 — 진짜 CLI와 같은지는 이 장치가 보장하지 않는다
 */
export interface FakeCli {
  /** 사용자가 요청을 보냄(UserPromptSubmit 훅) */
  prompt: (text: string) => Promise<Record<string, unknown>>;
  /** 도구로 파일을 씀: 쓰기 직전 훅이 거절하면 쓰지 않는다. 훅의 답을 돌려준다 */
  write: (relativePath: string, content: string) => Promise<Record<string, unknown>>;
  /** 훅을 건너뛰고 파일을 바꿈(셸 명령이나 훅이 없는 CLI가 한 변경) */
  writeBypassingHook: (relativePath: string, content: string) => Promise<void>;
  /** 턴이 끝남(Stop 훅). 게이트가 도는 동안 기다려, 훅의 답(피드백이면 decision: block)을 돌려준다 */
  stop: (text: string) => Promise<Record<string, unknown>>;
}

export interface ScenarioContext {
  /** 세션 터미널(실험 기능)을 열고 CLI가 떴다고 알린다(SessionStart 훅). 터미널 시나리오(`options.terminal`)에서만 쓴다 */
  cli: (sessionId: string) => Promise<FakeCli>;
  driver: Driver;
  /** 세션을 만든다(POST /api/sessions). 만든 세션 id를 돌려주고 이벤트를 구독한다 */
  start: (body?: Record<string, unknown>) => Promise<string>;
  /** 만든 세션의 작업 복사본(세션 폴더) 경로 */
  workDir: () => string;
  /** 메시지를 보내고 그 실행이 끝날 때까지 기다린다. 끝난 `run_finished` 이벤트를 돌려준다 */
  send: (sessionId: string, text: string, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const edit = (content: string, file = 'app/hello.txt') => ({ tool: 'write_file', input: { path: file, content } });

/** 선언한 test 단계 하나를 가진 프로젝트. 가짜 docker의 `compose exec`이 종료 코드를 정한다 */
const WITH_TEST: WorldOptions['files'] = {
  'studio.yaml': `version: 1
name: demo
workflow:
  required: [implement, test, checkpoint]
  tests:
    - { name: app-test, service: app, command: [sh, -c, "true"] }
services:
  app:
    source: managed
    template: nextjs
    path: app
    port: 3000
    preview: browser
    ready: { path: /, timeoutSeconds: 20 }
`,
};

const failExec = (times?: number): DockerScenario['rules'] => [{ when: ['compose', 'exec', 'true'], ...(times ? { times } : {}), reply: { exit: 1, stdout: 'FAIL app-test\n' } }];

export const scenarios: Scenario[] = [
  {
    name: 'pass-checkpoint',
    covers: '체크포인트 남김: 러너 done + 게이트 통과 + 지문 같음',
    options: { claude: { turns: [[edit('바뀜\n'), { text: '고쳤습니다.' }]] } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'ask-no-change',
    covers: '읽기만(intent ask): 게이트도 체크포인트도 없다',
    options: { claude: { turns: [[{ text: '파일은 app/hello.txt입니다.' }]] } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, '어떤 파일이 있나요?', { intent: 'ask' });
    },
  },
  {
    name: 'gate-fail-then-pass',
    covers: '게이트 실패 한 번 뒤 다시 확인해 통과: 두 번째 턴이 고친 내용으로 체크포인트',
    options: {
      files: WITH_TEST,
      claude: { turns: [[edit('틀림\n'), { text: '첫 시도입니다.' }], [edit('맞음\n'), { text: '고쳤습니다.' }]] },
      docker: { rules: failExec(1) },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'gate-exhausted-revert',
    covers: '게이트가 끝까지 실패(exhausted): 체크포인트 없이 되돌린다',
    options: {
      files: WITH_TEST,
      claude: { turns: [[edit('틀림1\n'), { text: '첫 시도.' }], [edit('틀림2\n'), { text: '둘째.' }], [edit('틀림3\n'), { text: '셋째.' }], [edit('틀림4\n'), { text: '넷째.' }]] },
      docker: { rules: failExec() },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'cancel-revert',
    covers: '취소: 실행이 바꾼 파일을 되돌리고 체크포인트를 남기지 않는다',
    options: { claude: { turns: [[edit('취소될 내용\n'), { hang: true }]] } },
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      const id = await start();
      const sent = await driver.call('send', 'POST', `/api/sessions/${id}/messages`, { text: 'hello.txt를 고쳐 주세요' });
      const runId = (sent.body as { runId: string }).runId;
      await driver.waitFor('쓰기 결과', (event) => event.type === 'agent' && (event.event as { type?: string }).type === 'tool_result');
      await driver.call('cancel', 'POST', `/api/sessions/${id}/runs/${runId}/cancel`);
      await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === runId);
    },
  },
  {
    name: 'platform-failure',
    covers: '되돌리지도 남기지도 않음: 도커 쪽(platform) 실패면 변경은 작업 복사본에 남는다',
    options: {
      claude: { turns: [[edit('플랫폼 실패 중\n'), { text: '고쳤습니다.' }]] },
      // 파일 반영 확인(docker run)이 도커에 닿지 못한 것처럼 실패한다
      docker: { rules: [{ when: ['run', '--rm'], reply: { exit: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' } }] },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'cli-no-result',
    covers: '실패: CLI가 결과 없이 끝남(ADR-194 결정 3)',
    options: { claude: { turns: [[edit('결과 없음\n')]], noResult: true } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'mcp-not-connected',
    covers: '실패: MCP 서버가 connected가 아님(ADR-194 결정 8)',
    options: { claude: { turns: [[edit('연결 안 됨\n')]], invocations: [{ initExtra: { mcp_servers: [{ name: 'b-studio', status: 'failed' }] } }] } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'policy-violation-boot',
    covers: '도커 정책 순서: 정책 위반이 든 inspect면 컨테이너를 지우고 시작하지 않는다(ready 안 나감)',
    options: {
      claude: { turns: [[edit('위반\n'), { text: '고쳤습니다.' }]] },
      docker: { rules: [{ when: ['inspect'], inspectPatch: { app: { HostConfig: { Privileged: true } } } }] },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'protected-path',
    covers: '보호 경로: 쓰기 단계에서 거절된 변경은 체크포인트에 들어가지 않는다',
    options: {
      files: {
        'studio.yaml': `version: 1
name: demo
workflow:
  required: [implement, checkpoint]
  protectedPaths: [.env]
services:
  app:
    source: managed
    template: nextjs
    path: app
    port: 3000
    preview: browser
    ready: { path: /, timeoutSeconds: 20 }
`,
      },
      claude: { turns: [[{ tool: 'write_file', input: { path: '.env', content: 'SECRET=1\n' } }, { text: '썼습니다.' }]] },
    },
    files: ['.env', 'app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, '.env를 만들어 주세요');
    },
  },
  {
    name: 'max-turns-pass',
    covers: '턴 상한: CLI가 error_max_turns로 끝나도 게이트를 다시 확인해 통과하면 done + Workflow-Incomplete',
    options: {
      claude: { turns: [[edit('상한 전\n'), { text: '여기까지.' }]], result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] } },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'max-turns-fail',
    covers: '턴 상한: 게이트를 다시 확인해도 통과하지 못하면 실패로 끝내 되돌린다',
    options: {
      files: WITH_TEST,
      claude: { turns: [[edit('상한 전 틀림\n'), { text: '여기까지.' }]], result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] } },
      docker: { rules: failExec() },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'question-stop',
    covers: '질문 멈춤: 바뀐 것이 없으면 게이트 없이 awaiting_input',
    options: { claude: { turns: [[{ tool: 'ask_user', input: { question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true } }]] } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, '화면을 만들어 주세요');
    },
  },
  {
    name: 'local-workspace-platform-failure',
    covers: '내 폴더(local) 방식 + 플랫폼 실패: 복사본 방식과 달리 되돌린다',
    options: {
      claude: { turns: [[edit('내 폴더 플랫폼 실패\n'), { text: '고쳤습니다.' }]] },
      docker: { rules: [{ when: ['run', '--rm'], reply: { exit: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' } }] },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start({ workspace: 'local' });
      await send(id, 'hello.txt를 고쳐 주세요');
    },
  },
  {
    name: 'staged-mismatch-revert',
    covers: '지문 불일치 되돌림(StagedMismatchError): 게이트가 통과시킨 뒤 커밋 전에 내용이 바뀌면 체크포인트 없이 되돌린다',
    // CLI가 입력을 닫아도 끝나지 않아(hangAfterEof) 게이트 통과 뒤 CLI가 정리되는 몇 초 동안 파일을 바꿀 수 있다 — 경쟁이 아니라 창이 길다
    options: { claude: { turns: [[edit('검증한 내용\n'), { text: '고쳤습니다.' }]], invocations: [{ hangAfterEof: true }] } },
    files: ['app/hello.txt'],
    run: async ({ start, driver, workDir }) => {
      const id = await start();
      const sent = await driver.call('send', 'POST', `/api/sessions/${id}/messages`, { text: 'hello.txt를 고쳐 주세요' });
      const runId = (sent.body as { runId: string }).runId;
      await driver.waitFor('gate_done', (event) => event.type === 'agent' && event.runId === runId && (event.event as { type?: string; ok?: boolean }).type === 'gate_done');
      await writeFile(path.join(workDir(), 'app/hello.txt'), '검증한 뒤에 바뀜\n');
      await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === runId, 60_000);
    },
  },
  {
    name: 'question-after-passing-edit',
    covers: '질문 멈춤은 questionRunPassedGate일 때만 체크포인트: 질문 전에 쓴 파일이 게이트를 통과하면 남긴다',
    options: { claude: { turns: [[edit('질문 전 수정\n'), { tool: 'ask_user', input: { question: '다음은 무엇을 할까요?', options: ['A', 'B'], allowOther: false } }]] } },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고치고 다음을 물어봐 주세요');
    },
  },
  {
    name: 'question-after-failing-edit',
    covers: '질문 멈춤: 질문 전에 쓴 파일이 게이트를 통과하지 못하면 체크포인트도 되돌림도 하지 않는다(다음 요청이 이어서 다룬다)',
    options: {
      files: WITH_TEST,
      claude: { turns: [[edit('질문 전 틀린 수정\n'), { tool: 'ask_user', input: { question: '다음은 무엇을 할까요?', options: ['A', 'B'], allowOther: false } }]] },
      docker: { rules: failExec() },
    },
    files: ['app/hello.txt'],
    run: async ({ start, send }) => {
      const id = await start();
      await send(id, 'hello.txt를 고치고 다음을 물어봐 주세요');
    },
  },
];

// ── 세션 터미널 경로(실험 기능): 지원 경로가 무엇인지는 D0에서 사람이 정한다. 둘 다 고정해 둔다 ──
const terminalOptions = (more: WorldOptions = {}): WorldOptions => ({ terminal: true, ...more });

export const terminalScenarios: Scenario[] = [
  {
    name: 'terminal-pass-checkpoint',
    covers: '터미널 Stop 훅: 게이트 통과 + 지문 같음이면 체크포인트를 남기고 훅이 통과 알림을 준다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '터미널 수정\n');
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'terminal-gate-feedback-then-pass',
    covers: '터미널 Stop 훅: 게이트 실패는 훅 응답(decision: block)으로 CLI에 돌려주고, 고친 뒤 다시 확인해 통과하면 체크포인트',
    options: terminalOptions({ files: WITH_TEST, docker: { rules: failExec(1) } }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '틀림\n');
      await claude.stop('첫 시도입니다.');
      await claude.write('app/hello.txt', '맞음\n');
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'terminal-attempts-exhausted',
    covers: '터미널 Stop 훅: TERMINAL_MAX_VERIFY_ATTEMPTS(3)번 통과하지 못하면 실행을 실패로 닫고 되돌린다',
    options: terminalOptions({ files: WITH_TEST, docker: { rules: failExec() } }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '틀림1\n');
      await claude.stop('첫 시도.');
      await claude.write('app/hello.txt', '틀림2\n');
      await claude.stop('둘째.');
      await claude.write('app/hello.txt', '틀림3\n');
      await claude.stop('셋째.');
    },
  },
  {
    name: 'terminal-no-change',
    covers: '터미널 Stop 훅: 바뀐 것이 없으면 게이트 없이 답만 한 턴으로 끝낸다(샌드박스를 켜지 않는다)',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('어떤 파일이 있나요?');
      await claude.stop('app/hello.txt가 있습니다.');
    },
  },
  {
    name: 'terminal-read-only-denies-writes',
    covers: '터미널 읽기만 요청: 쓰기 직전 훅이 거절하고, 바뀐 것이 없으면 답만 한 턴으로 끝낸다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('[읽기만] hello.txt를 설명해 주세요');
      await claude.write('app/hello.txt', '거절될 내용\n');
      await claude.stop('설명입니다.');
    },
  },
  {
    name: 'terminal-read-only-bypass-reverted-when-sandbox-off',
    covers: '터미널 읽기만 요청: 훅을 우회해 파일이 바뀌면 실패로 닫고, 샌드박스를 한 번도 켜지 않은 세션이어도 작업 복사본을 되돌린다(트러블슈팅 185)',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('[읽기만] hello.txt를 설명해 주세요');
      await claude.writeBypassingHook('app/hello.txt', '우회한 변경\n');
      await claude.stop('설명입니다.');
    },
    check: (snapshot) => {
      const problems: string[] = [];
      const disk = snapshot.disk as DiskState;
      if (disk.status.length > 0) problems.push(`작업 복사본에 변경이 남았다: ${disk.status.join(', ')}`);
      if (disk.files['app/hello.txt'] !== '안녕\n') problems.push(`app/hello.txt가 원래 내용이 아니다: ${JSON.stringify(disk.files['app/hello.txt'])}`);
      const text = JSON.stringify([snapshot.http, snapshot.events]);
      // 한 글이 되돌렸다는 말과 되돌리지 못했다는 말을 함께 하지 않는다
      if (text.includes('되돌렸습니다') && text.includes('되돌리지 못했습니다')) problems.push('글이 되돌렸다는 말과 되돌리지 못했다는 말을 함께 한다');
      if (text.includes('[b-studio] [b-studio]')) problems.push('알림 글의 앞머리가 두 번 붙었다');
      return problems;
    },
  },
  {
    name: 'terminal-sandbox-boot-fails-denies-write',
    covers: '터미널 쓰기 직전 훅: 샌드박스를 준비하지 못하면 변경 전 기준을 잡을 수 없어 쓰기를 거절한다',
    options: terminalOptions({ docker: { rules: [{ when: ['compose', 'build'], reply: { exit: 1, stderr: 'build failed: base image not found\n' } }] } }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '거절될 내용\n');
      await claude.stop('못 고쳤습니다.');
    },
  },
];

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, type BaselineSnapshot, type DiskState, type Driver, type DockerScenario, type WorldOptions } from './harness';

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
  /** `ignore`면 파일 변경 알림의 개수를 사진에 남기지 않는다(왔는지만). 이유는 `withoutFileRevisionCount` */
  fileRevisionCount?: 'ignore';
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
  /** 그 밖의 훅(Notification, SessionEnd, StopFailure …)을 부른다. 대화 id·작업 폴더·기록 경로는 채워 준다 */
  hook: (step: string, event: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface ScenarioContext {
  /** 세션 터미널(실험 기능)을 열고 CLI가 떴다고 알린다(SessionStart 훅). 터미널 시나리오(`options.terminal`)에서만 쓴다 */
  cli: (sessionId: string) => Promise<FakeCli>;
  driver: Driver;
  /** 세션을 만든다(POST /api/sessions). 만든 세션 id를 돌려주고 이벤트를 구독한다 */
  start: (body?: Record<string, unknown>) => Promise<string>;
  /**
   * 첫 요청을 함께 보내 세션을 만든다(POST /api/sessions의 route + terminal). 서버가 터미널을 열고 첫 요청을 CLI 실행 인자로 넘기므로, CLI 흉내가 시작·요청 훅을 부른다.
   * `body`는 route·backend·request·intent 같은 요청 본문. 세션 id와 CLI 흉내를 돌려준다. `silent`면 CLI 흉내가 훅을 부르지 않는다(CLI가 응하지 않는 경우)
   */
  startRouted: (body: Record<string, unknown>, options?: { silent?: boolean }) => Promise<{ id: string; claude: FakeCli | undefined }>;
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
  // 아래 넷은 채팅 경로의 같은 이름(terminal- 없는) 시나리오를 터미널 경로로 옮긴 것이다. 채팅 경로를 지울 때 채팅판만 지운다(#1353)
  {
    name: 'terminal-cancel-revert',
    covers: '터미널 실행 취소(화면의 취소 라우트): 실행이 바꾼 파일을 되돌리고 체크포인트를 남기지 않는다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      const started = await driver.waitFor('실행 시작', (event) => event.type === 'run_started');
      const runId = started.runId as string;
      await claude.write('app/hello.txt', '취소될 내용\n');
      await driver.call('cancel', 'POST', `/api/sessions/${id}/runs/${runId}/cancel`);
      await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === runId);
    },
    check: (snapshot) => {
      const problems: string[] = [];
      const disk = snapshot.disk as DiskState;
      if (disk.files['app/hello.txt'] !== '안녕\n') problems.push(`취소했는데 app/hello.txt가 원래 내용이 아니다: ${JSON.stringify(disk.files['app/hello.txt'])}`);
      if (JSON.stringify(snapshot.events).includes('"type":"checkpoint"')) problems.push('취소한 실행이 체크포인트를 남겼다');
      return problems;
    },
  },
  {
    name: 'terminal-platform-failure',
    covers: '터미널 + 도커 쪽(platform) 실패: 복사본 방식이면 되돌리지도 체크포인트를 남기지도 않고, 변경은 작업 복사본에 남는다',
    options: terminalOptions({
      // 파일 반영 확인(docker run)이 도커에 닿지 못한 것처럼 실패한다
      docker: { rules: [{ when: ['run', '--rm'], reply: { exit: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' } }] },
    }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '플랫폼 실패 중\n');
      await claude.stop('고쳤습니다.');
    },
    check: (snapshot) => platformFailureProblems(snapshot, { reverted: false }),
  },
  {
    name: 'terminal-local-workspace-platform-failure',
    covers: '터미널 + 내 폴더(local) 방식 + 플랫폼 실패: 복사본 방식과 달리 되돌린다',
    options: terminalOptions({
      docker: { rules: [{ when: ['run', '--rm'], reply: { exit: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' } }] },
    }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start({ workspace: 'local' });
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '내 폴더 플랫폼 실패\n');
      await claude.stop('고쳤습니다.');
    },
    check: (snapshot) => platformFailureProblems(snapshot, { reverted: true }),
  },
  {
    name: 'terminal-policy-violation-boot',
    covers: '터미널 쓰기 직전 훅 + 도커 정책 순서: 정책 위반이 든 inspect면 컨테이너를 지우고 시작하지 않으며(ready 안 나감), 기준을 잡지 못해 쓰기를 거절한다',
    options: terminalOptions({ docker: { rules: [{ when: ['inspect'], inspectPatch: { app: { HostConfig: { Privileged: true } } } }] } }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '위반\n');
      await claude.stop('못 고쳤습니다.');
    },
    check: (snapshot) => {
      const problems: string[] = [];
      const docker = snapshot.docker as { mutating: string[] };
      if (!docker.mutating.some((call) => call.startsWith('rm --force'))) problems.push('정책 위반 컨테이너를 지우지 않았다');
      if (docker.mutating.some((call) => call.startsWith('start') || call.startsWith('compose start'))) problems.push('정책 위반 컨테이너를 시작했다');
      const events = snapshot.events as { platform: Array<{ type: string; state?: string }> };
      if (events.platform.some((event) => event.type === 'service' && event.state === 'ready')) problems.push('정책 위반인데 서비스가 ready로 나갔다');
      if (!JSON.stringify(snapshot.http).includes('"permissionDecision":"deny"')) problems.push('기준을 잡지 못했는데 쓰기를 허락했다');
      if ((snapshot.disk as DiskState).files['app/hello.txt'] !== '안녕\n') problems.push('거절한 쓰기가 작업 복사본에 남았다');
      return problems;
    },
  },
];

/** 플랫폼 실패의 옳은 동작: 실패로 닫고 체크포인트를 남기지 않는다. 복사본 방식은 변경을 남기고, 내 폴더 방식은 되돌린다 */
function platformFailureProblems(snapshot: BaselineSnapshot, expected: { reverted: boolean }): string[] {
  const problems: string[] = [];
  const run = (snapshot.events as { run: Array<{ type: string; status?: string }> }).run;
  const finished = run.filter((event) => event.type === 'run_finished');
  if (finished.length !== 1 || finished[0].status !== 'failed') problems.push(`실행이 실패로 한 번 닫히지 않았다: ${JSON.stringify(finished.map((event) => event.status))}`);
  if (run.some((event) => event.type === 'checkpoint')) problems.push('플랫폼 실패인데 체크포인트를 남겼다');
  const disk = snapshot.disk as DiskState;
  const original = disk.files['app/hello.txt'] === '안녕\n';
  if (expected.reverted && !original) problems.push(`되돌려야 하는데 변경이 남았다: ${JSON.stringify(disk.files['app/hello.txt'])}`);
  if (!expected.reverted && original) problems.push('바꾼 코드의 문제가 아닌데 변경을 되돌렸다');
  return problems;
}

// ── desk가 실제로 부르는 흐름(C1a, #1301): 모두 지원 경로(이 컴퓨터 방식 세션 터미널)다 ──
// desk 흐름은 파일 변경 알림의 개수를 사진에 남기지 않는다(`withoutFileRevisionCount`)
export const deskScenarios: Scenario[] = ([
  {
    name: 'desk-direct-first-request-pass',
    covers: 'desk의 만들기(route: direct + terminal): 서버가 터미널을 열고 첫 요청을 CLI 실행 인자로 넘기며, 그 요청이 훅으로 이어져 통과하면 체크포인트',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ startRouted }) => {
      const { claude } = await startRouted({ route: 'direct', backend: 'claude-code', request: 'hello.txt를 고쳐 주세요', intent: 'build' });
      await claude!.write('app/hello.txt', '첫 요청 수정\n');
      await claude!.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-rules-first-request-pass',
    covers: 'desk의 만들기(route: rules + terminal): 규칙이 고른 AI로 세션을 만들고 첫 요청을 CLI 실행 인자로 넘긴다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ startRouted }) => {
      const { claude } = await startRouted({ route: 'rules', request: 'hello.txt를 고쳐 주세요', intent: 'build' });
      await claude!.write('app/hello.txt', '규칙으로 고른 수정\n');
      await claude!.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-first-request-not-started',
    covers: 'desk의 만들기: 첫 요청을 넘겼지만 CLI가 훅을 부르지 않으면(폴더 신뢰 창 등) 정해진 시간 뒤 안내와 함께 201로 돌려준다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ startRouted }) => {
      // CLI 흉내가 훅을 부르지 않는다: 서버가 기다리다 안내를 준다
      await startRouted({ route: 'direct', backend: 'claude-code', request: '대답이 없는 요청', intent: 'build' }, { silent: true });
    },
  },
  {
    name: 'desk-stop-resume-turn',
    covers: 'desk의 멈추기(DELETE)와 다시 켜기(resume): 멈춘 세션의 터미널을 다시 열면 이전 대화를 이어 붙여 뜨고, 그 터미널의 한 턴이 통과한다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '멈추기 전 수정\n');
      await claude.stop('고쳤습니다.');
      await driver.call('멈추기', 'DELETE', `/api/sessions/${id}`);
      await driver.call('멈춘 세션 다시 멈추기', 'DELETE', `/api/sessions/${id}`);
      await driver.call('다시 켜기', 'POST', `/api/sessions/${id}/resume`);
      await driver.waitFor('resumed', (event) => event.type === 'resumed');
      const again = await cli(id);
      await driver.observeCli('다시 연 CLI가 받은 인자', 2);
      await again.prompt('한 번 더 고쳐 주세요');
      await again.write('app/hello.txt', '다시 켠 뒤 수정\n');
      await again.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-stop-while-running',
    covers: 'desk의 멈추기: 실행이 열린 채(요청 뒤·턴 끝 전) 멈추면 그 실행을 알림 없이 닫고(끝났다는 이벤트가 없다), 이미 쓴 파일은 되돌리지 않고 남기며, 관문의 서버를 닫고 폴더를 지운다. 다시 켠 뒤의 새 요청은 새 실행이다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      const address = JSON.parse(await readFile(path.join(await driver.gatewayDir(), 'b-studio-gateway.json'), 'utf8')) as { url: string };
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '쓰다 멈춘 수정\n');
      await driver.call('실행 중 멈추기', 'DELETE', `/api/sessions/${id}`);
      await driver.call('멈춘 뒤 읽기', 'GET', `/api/sessions/${id}`);
      // 멈추면 관문의 서버와 설정 폴더도 사라진다(토큰이 든 파일을 남기지 않는다)
      driver.observe('멈춘 뒤 관문 폴더', 'gateway-entries', await readdir(path.join(driver.world.root, 'gateway')).catch(() => null));
      driver.observe('멈춘 뒤 관문 서버', 'gateway-reachable', await fetch(`${address.url}/ping`, { method: 'POST', signal: AbortSignal.timeout(3_000) }).then(() => true, () => false));
      // 다시 켜면 앞 실행은 닫혀 있고, 새 요청은 새 실행이다
      await driver.call('다시 켜기', 'POST', `/api/sessions/${id}/resume`);
      await driver.waitFor('resumed', (event) => event.type === 'resumed');
      const again = await cli(id);
      await again.prompt('이어서 고쳐 주세요');
      await again.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-rename',
    covers: 'desk의 이름 바꾸기(PATCH): 저장하고 이벤트로 알리며, 빈 이름은 지우고, 문자열이 아니면 400',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      const id = await start();
      await driver.call('이름 바꾸기', 'PATCH', `/api/sessions/${id}`, { label: '주문 목록 작업' });
      // 저장은 모아서 한다. 세션 기록(session.json)에 이름이 들어갈 때까지 기다려 본다(서버를 끄기 전의 값)
      driver.observe('저장된 이름', 'session-json-label', await persistedLabel(driver.world.sessionsDir));
      await driver.call('바뀐 이름 읽기', 'GET', `/api/sessions/${id}`);
      await driver.call('이름 지우기', 'PATCH', `/api/sessions/${id}`, { label: '' });
      await driver.call('문자열이 아닌 이름', 'PATCH', `/api/sessions/${id}`, { label: 7 });
      await driver.call('없는 세션 이름 바꾸기', 'PATCH', '/api/sessions/no-such-session', { label: 'x' });
      await driver.call('이름 다시 정하기', 'PATCH', `/api/sessions/${id}`, { label: '마지막 이름' });
    },
  },
  {
    name: 'desk-boot',
    covers: 'desk의 지금 켜기(boot): 지연 기동 세션의 샌드박스를 켜고 202로 답하며, 서비스 상태가 이벤트로 온다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      const id = await start();
      await driver.call('지금 켜기', 'POST', `/api/sessions/${id}/boot`);
      await driver.waitFor('서비스 준비', (event) => event.type === 'status' && event.status === 'ready');
      await driver.call('이미 켜진 세션 켜기', 'POST', `/api/sessions/${id}/boot`);
    },
  },
  {
    name: 'desk-check-changes',
    covers: 'desk의 확인 선언 변경 허용(check-changes): 다음 요청 하나에서 켜고 끄며, boolean이 아니면 400',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      const id = await start();
      await driver.call('허용 켜기', 'POST', `/api/sessions/${id}/check-changes`, { allow: true });
      await driver.call('켠 것 읽기', 'GET', `/api/sessions/${id}`);
      await driver.call('허용 끄기', 'POST', `/api/sessions/${id}/check-changes`, { allow: false });
      await driver.call('boolean이 아닌 값', 'POST', `/api/sessions/${id}/check-changes`, { allow: 'yes' });
      await driver.call('없는 세션', 'POST', '/api/sessions/no-such-session/check-changes', { allow: true });
    },
  },
  {
    name: 'desk-agents-overview',
    covers: 'desk의 목록(GET /api/agents): 요청이 열려 있는 동안과 통과한 뒤의 세션 항목(상태·게이트·터미널)',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      await driver.call('만든 직후 목록', 'GET', '/api/agents');
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '목록 확인 수정\n');
      await driver.call('요청이 열려 있는 동안 목록', 'GET', '/api/agents');
      await claude.stop('고쳤습니다.');
      await driver.call('통과한 뒤 목록', 'GET', '/api/agents');
    },
  },
  {
    name: 'desk-agents-stream',
    covers: 'desk의 목록 통로(GET /api/agents/stream): 처음에 전체(full)를 보내고, 이름이 바뀌면 그 항목만 조각(delta)으로 보낸다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      const id = await start();
      const stream = await driver.openStream('/api/agents/stream');
      const full = await stream.waitFor('full', (message) => (message as { type?: string }).type === 'full');
      driver.observe('처음 조각', 'agents-stream', full);
      await driver.call('이름 바꾸기', 'PATCH', `/api/sessions/${id}`, { label: '통로 확인용 이름' });
      const delta = await stream.waitFor('이름이 바뀐 조각', (message) => {
        const entry = message as { type?: string; items?: Array<{ title?: string }> };
        return entry.type === 'delta' && (entry.items ?? []).some((item) => item.title?.includes('통로 확인용 이름'));
      });
      driver.observe('이름이 바뀐 조각', 'agents-stream', delta);
    },
  },
  {
    name: 'desk-terminals-stream',
    covers: 'desk의 터미널 묶음 통로(GET /api/terminals/stream?ids=): 열기·CLI 시작·CLI 끝이 상태 조각으로 오고, 쓸 수 없는 id는 그 id만 닫힘으로 알린다(출력 바이트는 남기지 않는다)',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const stream = await driver.openStream(`/api/terminals/stream?ids=${id},no-such-session`);
      await stream.waitFor('쓸 수 없는 id', (message) => (message as { id?: string }).id === 'no-such-session');
      const claude = await cli(id);
      await stream.waitFor('CLI 시작', (message) => {
        const entry = message as { id?: string; message?: { kind?: string; alive?: boolean } };
        return entry.id === id && entry.message?.kind === 'cli' && entry.message.alive === true;
      });
      await claude.hook('CLI 끝', 'session-end', { hook_event_name: 'SessionEnd', reason: 'other' });
      await stream.waitFor('CLI 끝', (message) => {
        const entry = message as { id?: string; message?: { kind?: string; alive?: boolean } };
        return entry.id === id && entry.message?.kind === 'cli' && entry.message.alive === false;
      });
      // 출력 바이트(data)는 셸의 글이라 남기지 않는다. 상태 조각만 순서대로 남긴다
      driver.observe('상태 조각', 'terminals-stream', stream.messages.filter((message) => (message as { message?: { kind?: string } }).message?.kind !== 'data'));
    },
  },
  {
    name: 'desk-hook-notification',
    covers: '터미널 Notification 훅: 권한 확인 창은 사람을 기다림 표시로 남기고(훅 답은 빈 값), 모르는 종류와 열린 실행 없는 입력 대기는 무시하며, 도구가 다시 움직이면 푼다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.hook('열린 실행 없는 입력 대기', 'notification', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.hook('모르는 종류', 'notification', { hook_event_name: 'Notification', notification_type: 'something_new', message: '모르는 알림' });
      await claude.hook('권한 확인 창', 'notification', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
      await driver.call('기다리는 중 읽기', 'GET', `/api/sessions/${id}`);
      await claude.hook('도구가 끝남', 'activity', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'app/hello.txt' }, tool_use_id: 'toolu_9' });
      await driver.call('다시 움직인 뒤 읽기', 'GET', `/api/sessions/${id}`);
      await claude.stop('설명했습니다.');
    },
  },
  {
    name: 'desk-hook-session-end-closes-run',
    covers: '터미널 SessionEnd 훅: 검증 결과를 돌려준 적 없이 CLI가 끝나면 열린 실행을 취소로 닫고 바뀐 파일을 되돌린다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '쓰다 끝난 수정\n');
      await claude.hook('CLI 끝', 'session-end', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    },
  },
  {
    name: 'desk-hook-session-end-after-feedback',
    covers: '터미널 SessionEnd 훅: 검증 실패 피드백을 돌려준 뒤 CLI가 끝나면 그 실행을 실패로 닫고 되돌린다',
    options: terminalOptions({ files: WITH_TEST, docker: { rules: failExec() } }),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '틀림\n');
      await claude.stop('첫 시도입니다.');
      await claude.hook('CLI 끝', 'session-end', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    },
  },
  {
    name: 'desk-hook-stop-failure',
    covers: '터미널 StopFailure 훅: API 오류로 턴이 끝나면 게이트 없이 실행을 실패로 닫고 되돌린다. 다음 요청은 새 실행으로 통과한다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '오류로 끊긴 수정\n');
      await claude.hook('API 오류로 턴이 끝남', 'stop-failure', { hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '사용 한도에 닿았습니다' });
      await claude.prompt('다시 고쳐 주세요');
      await claude.write('app/hello.txt', '다시 쓴 수정\n');
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-telemetry',
    covers: '관문 텔레메트리(/v1/logs): 모델 요청의 토큰·비용을 열린 실행에 붙이고 빈 답(200)을 준다. 토큰이 틀리면 거절하고, 객체가 아닌 본문은 5xx로 답한다(CLI는 그대로 돈다)',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      const str = (stringValue: string) => ({ stringValue });
      const int = (intValue: string) => ({ intValue });
      const record = [
        { key: 'event.name', value: str('api_request') },
        { key: 'model', value: str('claude-sonnet-4-5') },
        { key: 'input_tokens', value: int('1200') },
        { key: 'output_tokens', value: int('340') },
        { key: 'cache_read_tokens', value: int('5000') },
        { key: 'cache_creation_tokens', value: int('200') },
        { key: 'cost_usd', value: { doubleValue: 0.0123 } },
        { key: 'duration_ms', value: int('2100') },
        { key: 'request_id', value: str('req_1') },
      ];
      await driver.telemetry('모델 요청 하나', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: record }] }] }] });
      await driver.telemetry('같은 요청 다시', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: record }] }] }] });
      await driver.telemetry('틀린 토큰', {}, { token: 'wrong-token' });
      await driver.telemetry('객체가 아닌 본문', [], {});
      await driver.telemetry('JSON이 아닌 본문', undefined, { raw: '이것은 JSON이 아닙니다' });
      await claude.write('app/hello.txt', '텔레메트리 확인 수정\n');
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-gate-file-moved',
    covers: '게이트가 도는 동안 파일이 더 바뀌면(훅을 거치지 않은 쓰기) 그 검증으로 체크포인트를 남기지 않는다: 지문이 달라진 것을 알아본다',
    options: terminalOptions({ files: WITH_TEST, docker: { rules: [{ when: ['compose', 'exec', 'true'], delayMs: 4_000 }] } }),
    files: ['app/hello.txt', 'app/readme.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '게이트 전 수정\n');
      const stopping = claude.stop('고쳤습니다.');
      await driver.waitFor('검증 시작', (event) => event.type === 'agent' && (event.event as { type?: string }).type === 'verify_start');
      // 검증이 도는 동안 CLI가 훅을 거치지 않고 다른 파일을 바꾼다
      await claude.writeBypassingHook('app/readme.txt', '검증 중에 바뀐 파일\n');
      await stopping;
      // 피드백을 받은 CLI가 파일을 더 건드리지 않고 다시 끝낸다: 바뀐 파일까지 포함해 검증하고 통과한다
      await claude.stop('다시 끝냅니다.');
    },
  },
  {
    name: 'desk-gateway-tamper',
    covers: '관문 감시: 열린 실행 중에 관문 설정(settings.json)을 고치면 위반으로 그 실행을 실패로 닫고 되돌리며, 설정 파일은 쓴 그대로 되돌려 놓는다. 다음 요청은 새 실행으로 통과한다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, driver }) => {
      const id = await start();
      const claude = await cli(id);
      const settings = path.join(await driver.gatewayDir(), 'settings.json');
      const original = await readFile(settings, 'utf8');
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '위반 전 수정\n');
      await writeFile(settings, '{"hooks":{}}\n');
      await driver.waitFor('위반으로 닫힘', (event) => event.type === 'run_finished' && event.status === 'failed', 60_000);
      driver.observe('관문 설정 되돌림', 'gateway-settings-restored', await restoredTo(settings, original));
      await claude.prompt('다시 고쳐 주세요');
      await claude.write('app/hello.txt', '위반 뒤 수정\n');
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-user-commit-unwound',
    covers: '터미널 밖의 커밋(사용자가 같은 브랜치에 커밋을 얹음): 기억한 체크포인트의 자손이면 커밋을 풀어(reset --soft) 변경을 검증에 넣고, 통과하면 체크포인트를 남긴다',
    options: terminalOptions(),
    files: ['app/hello.txt', 'app/user.txt'],
    run: async ({ start, cli, workDir }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '에이전트 수정\n');
      await writeFile(path.join(workDir(), 'app/user.txt'), '사용자 파일\n');
      await git(workDir(), ['add', '-A']);
      await git(workDir(), ['commit', '--quiet', '-m', '사용자가 직접 한 커밋']);
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-user-branch-switch-reverted',
    covers: '터미널 밖의 브랜치 바꿈: 풀 수 없는 모양이라 변경을 보관본으로 남기고 마지막 체크포인트로 되돌린 뒤 실행을 실패로 닫는다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, cli, workDir }) => {
      const id = await start();
      const claude = await cli(id);
      await claude.prompt('hello.txt를 고쳐 주세요');
      await claude.write('app/hello.txt', '브랜치를 바꾸기 전 수정\n');
      await git(workDir(), ['checkout', '--quiet', '-b', 'user-branch']);
      await claude.stop('고쳤습니다.');
    },
  },
  {
    name: 'desk-check-changes-first-request',
    covers: '만들기에서 켠 확인 선언 변경 허용(allowCheckChanges)은 첫 요청 하나만 받아들인다: studio.yaml의 test를 바꾼 첫 요청은 체크포인트가 되고, 다음 요청의 같은 종류의 변경은 막힌다',
    options: terminalOptions({ files: WITH_TEST }),
    files: ['studio.yaml'],
    run: async ({ startRouted, driver }) => {
      const declared = await readFile(path.join(driver.world.projectsDir, driver.world.projectId, 'studio.yaml'), 'utf8');
      const { id, claude } = await startRouted({ route: 'direct', backend: 'claude-code', request: '테스트 명령을 바꿔 주세요', intent: 'build', allowCheckChanges: true });
      await driver.call('요청을 가져간 뒤 읽기', 'GET', `/api/sessions/${id}`);
      await claude!.write('studio.yaml', declared.replace('"true"', '"echo weakened"'));
      await claude!.stop('확인 선언을 바꿨습니다.');
      await claude!.prompt('테스트 명령을 또 바꿔 주세요');
      await claude!.write('studio.yaml', declared.replace('"true"', '"echo weaker still"'));
      await claude!.stop('확인 선언을 또 바꿨습니다.');
    },
  },
  {
    name: 'desk-create-errors',
    covers: 'desk의 만들기 요청 검사: 규칙과 backend를 함께 보내면, 요청이 비면, route 없이 terminal을 보내면, 알 수 없는 값이면 400, 없는 프로젝트는 404. 어느 것도 세션을 만들지 않는다',
    options: terminalOptions(),
    files: ['app/hello.txt'],
    run: async ({ start, driver }) => {
      await start();
      const post = (step: string, body: Record<string, unknown>) => driver.call(step, 'POST', '/api/sessions', { projectId: 'demo', ...body });
      await post('규칙과 backend를 함께', { route: 'rules', backend: 'claude-code', request: 'x', terminal: true });
      await post('요청이 비어 있음', { route: 'direct', backend: 'claude-code', request: '  ', terminal: true });
      await post('route 없이 terminal', { terminal: true });
      await post('알 수 없는 route', { route: 'random', request: 'x', terminal: true });
      await post('직접 고르는데 backend 없음', { route: 'direct', request: 'x', terminal: true });
      await post('알 수 없는 intent', { route: 'direct', backend: 'claude-code', request: 'x', intent: 'plan', terminal: true });
      await post('terminal이 true가 아님', { route: 'direct', backend: 'claude-code', request: 'x', terminal: false });
      await post('allowCheckChanges가 boolean이 아님', { route: 'direct', backend: 'claude-code', request: 'x', terminal: true, allowCheckChanges: 'yes' });
      await post('서버가 허용하지 않는 백엔드', { route: 'direct', backend: 'gemini', request: 'x', terminal: true });
      await driver.call('없는 프로젝트', 'POST', '/api/sessions', { projectId: 'no-such-project', route: 'direct', backend: 'claude-code', request: 'x', terminal: true });
      await driver.call('projectId 없음', 'POST', '/api/sessions', { route: 'direct', backend: 'claude-code', request: 'x', terminal: true });
      await driver.call('만든 세션 목록', 'GET', '/api/sessions');
    },
  },
] satisfies Scenario[]).map((scenario): Scenario => ({ ...scenario, fileRevisionCount: 'ignore' }));

/** 감시가 관문 설정을 되돌릴 때까지 잠깐 기다려 같아졌는지 본다 */
async function restoredTo(file: string, original: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await readFile(file, 'utf8').catch(() => '')) === original) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** 세션 기록(session.json)에 이름이 저장될 때까지(최대 10초) 기다려 그 이름을 읽는다. 저장되지 않으면 null */
async function persistedLabel(sessionsDir: string): Promise<string | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const dirs = await readdir(sessionsDir).catch(() => [] as string[]);
    for (const dir of dirs) {
      const saved = await readFile(path.join(sessionsDir, dir, '.git', 'b-studio', 'session.json'), 'utf8').catch(() => '');
      const label = saved ? ((JSON.parse(saved) as { snapshot?: { label?: string } }).snapshot?.label ?? null) : null;
      if (label) return label;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

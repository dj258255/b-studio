import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { AGENT_HOOK_SCRIPT, AGENT_READ_TOOLS, AGENT_WRITE_TOOL_MATCHER, CODEX_READ_TOOLS, isReadOnlyPrompt, type Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';
import { classifyPrompt, isReadTool } from './session-terminal-classify';
import { archivedSnapshot } from './session-store';

/**
 * 세션 터미널의 요청 시작·쓰기 직전·MCP 판정(ADR-211, 4f B4b)을 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
 * CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이므로 테스트가 그 둘을 직접 한다. 작업 복사본·체크포인트·게이트는 실제 코드가 돈다.
 * 기존 터미널 시험(`sessions-terminal-gateway.test.ts`)의 가짜 샌드박스·가짜 훅 방식과 같다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  failCommands: [] as string[],
  /** 켜면 샌드박스를 켜지 못한다(샌드박스·도커 쪽 문제) */
  startFails: false as boolean,
  starts: 0,
  /** 값이 있으면 `start`가 이 약속이 풀릴 때까지 끝나지 않는다(샌드박스를 켜는 중으로 붙잡아 둔다) */
  startHold: undefined as Promise<void> | undefined,
  /** holdWord가 든 명령은 hold가 풀릴 때까지 끝나지 않는다(검증을 도는 중으로 붙잡아 둔다) */
  holdWord: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  /** 세션 터미널(CLI)에 보낸 Esc의 기록 */
  interrupts: [] as string[],
  /** 서비스가 떠 있는 주소(시험마다 계약을 내놓는 작은 서버) */
  serviceUrl: 'http://127.0.0.1:1',
  /** 세션 터미널 방식. 'host'(이 컴퓨터 방식)면 작업 복사본의 Git을 더 의심한다(이슈 #706) */
  terminalMode: 'container' as 'container' | 'host',
  /** 시험이 studio.yaml에 쓸 턴 상한 */
  maxTurns: undefined as number | undefined,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termclassify-fake',
    name: 'fake',
    async start() {
      fake.starts += 1;
      if (fake.startHold) await fake.startHold;
      if (fake.startFails) throw new actual.SandboxError('도커에 닿지 못했습니다', 'Cannot connect to the Docker daemon', { platform: true });
      return [];
    },
    async restart(service: string) {
      return { service, containerPort: 8080, url: fake.serviceUrl };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: fake.serviceUrl };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {},
    async exec(_service: string, command: string[]) {
      if (command[0] === 'sh' && command[2]?.startsWith('rm -f /tmp/b-studio-test-report.json ')) return { exitCode: 0, stdout: '', stderr: '' };
      fake.execCalls.push(command);
      if (fake.holdWord && command.includes(fake.holdWord)) await fake.hold;
      if (fake.failCommands.some((word) => command.includes(word))) return { exitCode: 1, stdout: '', stderr: 'FAILED: OrderTest' };
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact: (text: string) => text,
    findSecrets: () => [],
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCodex: async () => ({ ok: true as const }) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: (sessionId: string) => {
    fake.interrupts.push(sessionId);
  },
  noteSessionTerminalCli: () => {},
  sessionTerminalMode: () => fake.terminalMode,
  warnSessionTerminal: () => {},
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, openTerminalRunId, resumeSession, sessionTerminalTarget, setTerminalCheckChanges, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';
import { frozenModule, loadTable } from './frozen-vectors';

// 아래 `legacy*`는 옛 TS가 낸 값을 JSON에서 꺼내는 껍데기다(옛 TS 파일은 지웠다). 같은 입력은 같은 값을 돌려준다.
const FROZEN = loadTable(new URL('./sessions-terminal-classify-vectors.json', import.meta.url));
const { LEGACY_AGENT_READ_TOOLS, LEGACY_CODEX_READ_TOOLS, legacyIsReadTool, legacyServerPrompt, legacyServerReadOnly } = frozenModule(FROZEN, 'session-terminal-classify-legacy:');

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termclassify
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termclassify-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  fake.maxTurns = undefined;
  fake.terminalMode = 'container';
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.startFails = false;
  fake.starts = 0;
  fake.startHold = undefined;
  fake.holdWord = undefined;
  fake.hold = undefined;
  fake.interrupts = [];
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_USAGE_DIR = path.join(root, 'usage');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'verify',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com',
  });
});

const servers: Server[] = [];
const contract = {
  openapi: '3.0.1',
  paths: { '/api/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } } } } },
  components: { schemas: { OrderResponse: { type: 'object', properties: { id: { type: 'string' }, memo: { type: 'string' } } } } },
};

/** 게이트가 계약을 뽑는 서비스 */
async function serveContract(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(contract));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const openSessions: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  // 붙잡아 둔 약속을 풀고 세션을 멈춘다(남은 비동기 일이 다음 시험에 새지 않게)
  for (const id of openSessions.splice(0)) await stopSession(id).catch(() => {});
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_EXPERIMENTAL', saved.experimental],
    ['B_STUDIO_USAGE_DIR', saved.usage],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Opened {
  id: string;
  work: string;
  gateway: ReturnType<typeof terminalGatewayHandlersForTest>;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open({ lazy = false, workspace = 'copy', maxTurns }: { lazy?: boolean; workspace?: 'copy' | 'local'; maxTurns?: number } = {}): Promise<Opened> {
  if (maxTurns !== undefined) await writeFile(path.join(fake.root, 'studio.yaml'), `${STUDIO_YAML}  maxTurns: ${maxTurns}\n`);
  const id = (await createSession('termclassify', 'kim', workspace, lazy ? { boot: 'on-demand' as const } : {})).id;
  openSessions.push(id);
  const started = Date.now();
  while (getSnapshot(id)?.status !== (lazy ? 'idle' : 'ready')) {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  const { root } = sessionTerminalTarget(id);
  return { id, work: root, gateway: terminalGatewayHandlersForTest(id), events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 10_000) throw new Error(`${what}이(가) 오지 않았습니다`);
    await sleep(10);
  }
}

const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; }\n' } };

/** 어느 쪽이 먼저 오는가: 약속이 `ms` 안에 끝나지 않으면 'pending' */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([work, sleep(ms).then(() => 'pending' as const)]);
}


/** 세션 저장소(전역). 시험이 실행·점유를 직접 붙잡는 자리다 */
/** 세션 저장소(전역). 시험이 점유·준비·지문 읽기를 직접 붙잡는 자리다 */
interface SessionInternals {
  life: { claims: { beginRun(runId: string): number | { busy: string }; release(token: number): boolean; holds(token: number): boolean } };
  relaying: Promise<void>;
  checkpoints: { pendingFingerprint(): Promise<string> };
}
const sessionOf = (id: string) => (globalThis as unknown as { __bStudio: { sessions: Map<string, SessionInternals> } }).__bStudio.sessions.get(id)!;

/** 지금 어떤 점유도 쥐고 있는 표를 찾는다(시험 전용: 표는 1부터 늘어나는 번호다) */
function heldToken(id: string): number {
  const { claims } = sessionOf(id).life;
  for (let token = 1; token < 200; token += 1) if (claims.holds(token)) return token;
  throw new Error('쥐고 있는 점유가 없습니다');
}

describe('N1: 읽기만 표시는 지문·변경 목록을 기다리기 전에 세운다', () => {
  it('열린 실행에 [읽기만] 요청이 이어 붙어 지문을 읽는 사이 온 쓰기 직전 훅은 거절된다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(openTerminalRunId(session.id)).toBeDefined();
    // 읽기만 요청이 이어 붙으며 처음 부르는 지문 읽기를 붙잡는다(그 뒤의 부름은 그대로 지나간다)
    const checkpoints = sessionOf(session.id).checkpoints;
    const original = checkpoints.pendingFingerprint.bind(checkpoints);
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    checkpoints.pendingFingerprint = async () => {
      calls += 1;
      if (calls === 1) await hold;
      return original();
    };
    const attaching = session.gateway.prompt({ prompt: '[읽기만] 주문 구조를 설명해줘' });
    await until('지문 읽기 시작', () => calls === 1);
    // 요청 훅의 답을 기다리는 사이 쓰기 직전 훅이 왔다
    const tool = await settledWithin(session.gateway.preTool(WRITE), 5_000);
    release();
    expect(await attaching).toMatchObject({ note: expect.stringContaining('읽기만') });
    expect(tool).toMatchObject({ deny: expect.stringContaining('읽기만 요청') });
  }, 30_000);
});

describe('N2: 확인 선언 변경 허용은 다음 요청 하나가 실제로 가져갈 때만 지운다', () => {
  it('(a) 실행을 열지 못하면(준비 중에 점유를 잃음) 허용은 그대로 남는다', async () => {
    fake.terminalMode = 'host';
    const session = await open({ workspace: 'local' });
    setTerminalCheckChanges(session.id, true);
    let release = (): void => {};
    sessionOf(session.id).relaying = new Promise<void>((resolve) => (release = resolve));
    const waiting = session.gateway.prompt({ prompt: '확인 선언을 고쳐줘' });
    await sleep(50);
    // 준비하는 사이 점유가 풀렸다(멈춤 같은 일). 실행은 열리지 못한다
    expect(sessionOf(session.id).life.claims.release(heldToken(session.id))).toBe(true);
    release();
    expect((await waiting).blocked).toContain('세션이 중지되어 요청을 시작하지 않았습니다');
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
  }, 30_000);

  it('(b) 허용을 켠 세션을 멈추면 허용도 지워지고, 이어서 작업한 뒤 첫 요청은 허용을 가져가지 않는다', async () => {
    const session = await open();
    setTerminalCheckChanges(session.id, true);
    await stopSession(session.id);
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBeUndefined();
    // 멈춘 사이 켜진 허용(또는 옛 파일에 실려 온 허용)도 이어받으면 지워진다
    setTerminalCheckChanges(session.id, true);
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
    await resumeSession(session.id);
    const started = Date.now();
    while (getSnapshot(session.id)?.status !== 'ready') {
      if (Date.now() - started > 10_000) throw new Error(`이어받은 세션이 준비되지 않았습니다 (${getSnapshot(session.id)?.status})`);
      await sleep(20);
    }
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBeUndefined();
    const gateway = terminalGatewayHandlersForTest(session.id);
    const answer = await gateway.prompt({ prompt: '주문 설명을 고쳐줘' });
    expect(answer.note ?? '').not.toContain('확인 선언 변경 허용');
  }, 30_000);

  it('(b) 옛 파일에 허용이 실려 있어도(저장 형식은 그대로) 읽어 온 세션은 허용을 켠 채로 보이지 않는다', () => {
    const data = { snapshot: { allowCheckChangesNext: true as const, services: [] } };
    expect(archivedSnapshot(data as unknown as Parameters<typeof archivedSnapshot>[0]).allowCheckChangesNext).toBeUndefined();
  });
});

/** 컨테이너 안의 훅 스크립트를 실제로 돌려 요청 훅의 답을 받는다. 관문 주소 파일이 없어 "닿지 못함" 갈래로 가고, 읽기만이면 요청을 막고 아니면 알림만 낸다 */
const scripts = mkdtemp(path.join(tmpdir(), 'b-studio-classify-hook-')).then(async (dir) => {
  const file = path.join(dir, 'b-studio-hook.mjs');
  await writeFile(file, AGENT_HOOK_SCRIPT);
  return file;
});

async function hookReadOnly(prompt: string): Promise<boolean> {
  const file = await scripts;
  const body = JSON.stringify({ prompt });
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [file, 'prompt'], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin!.end(body);
  });
  const answer = JSON.parse(output) as { decision?: string; systemMessage?: string };
  return answer.decision === 'block';
}

const MARK = '[읽기만]';
const tag = (text: string, id?: string) => `<pasted_content${id === undefined ? '' : ` id="${id}"`}>\n${text}\n</pasted_content${id === undefined ? '' : ` id="${id}"`}>`;
/** 세 구현에 같은 글을 넣는 벡터. 이름은 사람이 읽는 설명이다 */
const VECTORS: Array<[string, string]> = [
  ['표시만', MARK],
  ['표시 + 요청', `${MARK} 주문 구조를 설명해줘`],
  ['표시 없는 요청', '주문 구조를 설명해줘'],
  ['빈 글', ''],
  ['앞 공백', `  \t${MARK} 설명`],
  ['앞 줄바꿈', `\n\r\n${MARK} 설명`],
  ['앞 NBSP·전각 공백', ` 　${MARK} 설명`],
  ['앞 NEL(U+0085)', `\u0085${MARK} 설명`],
  ['앞 BOM', `﻿${MARK} 설명`],
  ['앞 폭 없는 공백', `​${MARK} 설명`],
  ['앞 방향 제어', `‮⁦${MARK} 설명`],
  ['앞 단어 결합자', `⁠${MARK} 설명`],
  ['앞 말뭉치 U+180E', `᠎${MARK} 설명`],
  ['앞 소프트 하이픈', `­${MARK} 설명`],
  ['앞 변이 선택자', `️${MARK} 설명`],
  ['표시 앞 글자 하나', `a${MARK} 설명`],
  ['표시 뒤에만', `설명 ${MARK}`],
  ['전각 대괄호', '［읽기만］ 설명'],
  ['반각 열고 전각 닫기', '[읽기만］ 설명'],
  ['표시 안의 공백', '[ 읽기만 ] 설명'],
  ['영문 표시', '[read-only] explain'],
  ['대문자 영문', '[READ-ONLY] explain'],
  ['조합형(NFD) 한글 표시', `${MARK.normalize('NFD')} 설명`],
  ['호환 자모 표시', '[ㅇㅣㄹㄱㅣㅁㅏㄴ] 설명'],
  ['붙여넣기 하나', tag(`${MARK} 설명`)],
  ['붙여넣기 id', tag(`${MARK} 설명`, 'p1')],
  ['붙여넣기 id 따옴표 안 닫는 글자', `<pasted_content id="a>b">\n${MARK} 설명\n</pasted_content id="a>b">`],
  ['붙여넣기 id 줄바꿈 공백', `<pasted_content\n  id="p1">\n${MARK} 설명\n</pasted_content>`],
  ['붙여넣기 id 빈 값', tag(`${MARK} 설명`, '')],
  ['붙여넣기 속성 변형(대문자)', `<PASTED_CONTENT>\n${MARK} 설명\n</PASTED_CONTENT>`],
  ['붙여넣기 속성 변형(다른 속성)', `<pasted_content name="x">\n${MARK} 설명\n</pasted_content>`],
  ['붙여넣기 속성 변형(홑따옴표)', `<pasted_content id='p1'>\n${MARK} 설명\n</pasted_content>`],
  ['붙여넣기 속성 변형(id 앞 공백 없음)', `<pasted_contentid="p1">\n${MARK} 설명\n</pasted_content>`],
  ['붙여넣기 CRLF', `<pasted_content>\r\n${MARK} 설명\r\n</pasted_content>`],
  ['붙여넣기 CR만', `<pasted_content>\r${MARK} 설명\r</pasted_content>`],
  ['붙여넣기 줄바꿈 둘', `<pasted_content>\n\n${MARK} 설명\n\n</pasted_content>`],
  ['붙여넣기 여는 표시만', `<pasted_content>\n${MARK} 설명`],
  ['붙여넣기 닫는 표시만', `${MARK} 설명\n</pasted_content>`],
  ['붙여넣기 짝 안 맞음(닫는 표시가 앞)', `</pasted_content>\n${MARK} 설명\n<pasted_content>`],
  ['붙여넣기 두 겹', tag(tag(`${MARK} 설명`, 'b'), 'a')],
  ['붙여넣기 두 겹 같은 id 없음', tag(tag(`${MARK} 설명`))],
  ['붙여넣기 세 겹', tag(tag(tag(`${MARK} 설명`)))],
  ['붙여넣기 이어 붙여 겹침(표시를 만들어 냄)', `<pasted_content<pasted_content>>\n${MARK} 설명`],
  ['붙여넣기 이어 붙여 겹침 세 번', `<pasted_content<pasted_content<pasted_content>>>${MARK} 설명`],
  ['붙여넣기 닫는 표시가 이어 붙어 만들어짐', `${MARK} 설명</pasted_content</pasted_content>>`],
  ['붙여넣기 앞에 글', `먼저 ${tag(`${MARK} 설명`)}`],
  ['붙여넣기 앞에 공백', `  ${tag(`${MARK} 설명`)}`],
  ['붙여넣기 두 번 이어 붙임(첫 것이 표시)', `${tag(`${MARK} 설명`)}${tag('두번째')}`],
  ['붙여넣기 두 번 이어 붙임(둘째가 표시)', `${tag('첫째')}${tag(`${MARK} 설명`)}`],
  ['붙여넣기 안이 비어 있음', tag('')],
  ['붙여넣기 뒤에 표시', `${tag('첫째')}\n${MARK} 설명`],
  ['붙여넣기 감싼 표시 앞 NBSP', tag(` ${MARK} 설명`)],
  ['슬래시 명령', '/model'],
  ['슬래시 명령 + 표시', `/model ${MARK}`],
  ['표시 + 슬래시', `${MARK} /model`],
  ['슬래시 앞 공백', '  /model'],
  ['슬래시 앞 BOM', '﻿/model'],
  ['슬래시 앞 폭 없는 공백', '​/model'],
  ['붙여넣기 안 슬래시', tag('/model')],
  ['붙여넣기 안 슬래시 + 표시', tag(`/ ${MARK}`)],
  ['슬래시 뒤 표시 줄', `/clear\n${MARK} 설명`],
  ['줄바꿈 LS', ` ${MARK} 설명`],
  ['줄바꿈 PS', ` ${MARK} 설명`],
  ['NUL 앞', `\u0000${MARK} 설명`],
  ['이모지 앞', `😀${MARK} 설명`],
  ['짝 없는 서로게이트 앞', `\ud800${MARK} 설명`],
  ['표시가 둘', `${MARK}${MARK}`],
  ['표시 대소문자 무관한 글자 없음', '[읽기만'],
];

const READ_ONLY_VECTOR_NAMES: string[] = [
  '표시만',
  '표시 + 요청',
  '앞 공백',
  '앞 줄바꿈',
  '앞 NBSP·전각 공백',
  '앞 BOM',
  '앞 폭 없는 공백',
  '앞 방향 제어',
  '앞 단어 결합자',
  '조합형(NFD) 한글 표시',
  '붙여넣기 하나',
  '붙여넣기 id',
  '붙여넣기 id 따옴표 안 닫는 글자',
  '붙여넣기 id 줄바꿈 공백',
  '붙여넣기 id 빈 값',
  '붙여넣기 CRLF',
  '붙여넣기 CR만',
  '붙여넣기 줄바꿈 둘',
  '붙여넣기 여는 표시만',
  '붙여넣기 닫는 표시만',
  '붙여넣기 짝 안 맞음(닫는 표시가 앞)',
  '붙여넣기 두 겹',
  '붙여넣기 두 겹 같은 id 없음',
  '붙여넣기 세 겹',
  '붙여넣기 이어 붙여 겹침(표시를 만들어 냄)',
  '붙여넣기 이어 붙여 겹침 세 번',
  '붙여넣기 닫는 표시가 이어 붙어 만들어짐',
  '붙여넣기 앞에 공백',
  '붙여넣기 두 번 이어 붙임(첫 것이 표시)',
  '붙여넣기 감싼 표시 앞 NBSP',
  '표시 + 슬래시',
  '줄바꿈 LS',
  '줄바꿈 PS',
  '표시가 둘',
];

describe('N3: 코어·TS·훅 스크립트는 같은 글을 같게 읽는다', () => {
  it('세 구현이 모든 벡터에서 읽기만 판정이 같다', async () => {
    const rows = await Promise.all(VECTORS.map(async ([name, text]) => ({ name, core: classifyPrompt(text).readOnly, twin: isReadOnlyPrompt(text), hook: await hookReadOnly(text) })));
    expect(rows.filter((row) => row.core !== row.twin || row.core !== row.hook)).toEqual([]);
    console.log(`N3 차등 사례 ${rows.length}건(읽기만 ${rows.filter((row) => row.core).length}건)`);
  }, 120_000);

  it('옛 서버가 읽기만으로 본 글은 코어도 읽기만으로 본다(막는 쪽으로만 다르다). 다른 칸은 목록으로 고정한다', () => {
    const rows = VECTORS.map(([name, text]) => ({ name, legacy: legacyServerReadOnly(text), core: classifyPrompt(text).readOnly }));
    expect(rows.filter((row) => row.legacy && !row.core)).toEqual([]);
    // 코어만 읽기만으로 보는 칸: 이어 붙은 표시를 세 번 벗겨야 표시가 앞에 오는 입력(옛 서버는 두 번까지만 벗겼다)
    expect(rows.filter((row) => !row.legacy && row.core).map((row) => row.name)).toEqual(['붙여넣기 이어 붙여 겹침 세 번']);
  });

  it('읽기만으로 읽는 벡터를 목록으로 고정한다(전각 대괄호·표시 안의 공백·영문·대소문자 변형은 읽기만이 아니다)', () => {
    const names = VECTORS.filter(([, text]) => classifyPrompt(text).readOnly).map(([name]) => name);
    expect(names).toEqual(READ_ONLY_VECTOR_NAMES);
  });

  it('조각을 이어 붙인 무작위 글 3000건: 코어와 TS 쌍둥이가 같고(앞 150건은 훅 스크립트도), 옛 서버의 읽기만은 코어의 부분집합이며, 요청 글과 `/` 판정은 옛 서버와 같다', async () => {
    const pieces = ['<pasted_content', '<pasted_content>', '</pasted_content>', '</pasted_content', '>', ' id="x"', ' id="', '"', '\u3000id="q">', '[읽기만]', '[읽기만', '읽기만]', '\n', '\r', '\r\n', ' ', '\t', '\u00a0', '\u0085', '\ufeff', '\u200b', '\u202e', '\u2060', '\u180e', 'a', '/', '한', '\u1112\u1161\u11ab', '[\u110b\u1175\u11af\u1100\u1175\u11b7\u1106\u1161\u11ab]', '<', '</', 'id="q"'];
    let seed = 20261118;
    const next = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    let readOnlyCount = 0;
    let widened = 0;
    const hooked: Array<{ text: string; core: boolean }> = [];
    const bad: string[] = [];
    for (let n = 0; n < 3000; n += 1) {
      const text = Array.from({ length: 1 + next(14) }, () => pieces[next(pieces.length)]).join('');
      const core = classifyPrompt(text);
      const legacyText = legacyServerPrompt(text);
      const legacyRead = legacyServerReadOnly(text);
      if (n < 150) hooked.push({ text, core: core.readOnly });
      if (core.readOnly) readOnlyCount += 1;
      if (core.readOnly && !legacyRead) widened += 1;
      if (core.readOnly !== isReadOnlyPrompt(text) || (legacyRead && !core.readOnly) || core.unwrapped !== legacyText || core.slashCommand !== legacyText.startsWith('/')) bad.push(JSON.stringify(text));
    }
    expect(bad.slice(0, 5)).toEqual([]);
    const hookRows = await Promise.all(hooked.map(async ({ text, core }) => ({ text, core, hook: await hookReadOnly(text) })));
    expect(hookRows.filter((row) => row.core !== row.hook).slice(0, 5)).toEqual([]);
    // 시험이 두 갈래를 모두 지났는지 본다(읽기만이 하나도 없거나 모두면 차등이 아무것도 가리지 못한다)
    expect(readOnlyCount).toBeGreaterThan(100);
    expect(readOnlyCount).toBeLessThan(2900);
    console.log(`무작위 차등 3000건(훅 스크립트 ${hooked.length}건): 읽기만 ${readOnlyCount}건, 코어만 읽기만 ${widened}건`);
  }, 120_000);

  it('슬래시 명령 판정과 요청 글(감싸개를 한 번 벗기고 자름)은 옛 서버와 모든 벡터에서 같다', () => {
    for (const [name, text] of VECTORS) {
      const legacyText = legacyServerPrompt(text.toWellFormed());
      const core = classifyPrompt(text);
      expect({ name, unwrapped: core.unwrapped, slash: core.slashCommand }).toEqual({ name, unwrapped: legacyText, slash: legacyText.startsWith('/') });
    }
  });

  it('읽기 도구 표는 옛 표(Claude Code·Codex)와 정확히 같고, 쓰기 도구는 하나도 읽기 도구가 아니다', () => {
    const names = [...LEGACY_AGENT_READ_TOOLS, ...LEGACY_CODEX_READ_TOOLS, ...AGENT_READ_TOOLS, ...CODEX_READ_TOOLS, 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'mcp__b-studio__run_in_service', 'read', 'READ', 'Read ', ' Read', 'Glob\n', 'exec_command', 'apply_patch', ''];
    expect(names.filter((name) => isReadTool(name) !== legacyIsReadTool(name))).toEqual([]);
    expect([...AGENT_READ_TOOLS].sort()).toEqual([...LEGACY_AGENT_READ_TOOLS].sort());
    expect([...CODEX_READ_TOOLS].sort()).toEqual([...LEGACY_CODEX_READ_TOOLS].sort());
    for (const write of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillShell', 'mcp__b-studio__run_in_service']) expect(isReadTool(write)).toBe(false);
    // 훅 설정의 matcher(쓰기 직전 훅을 거는 도구)는 같은 표에서 만든다. 표가 어긋나면 훅이 읽기 도구에 걸리거나 쓰기 도구를 놓친다
    for (const read of AGENT_READ_TOOLS) expect(new RegExp(AGENT_WRITE_TOOL_MATCHER).test(read)).toBe(false);
    expect(new RegExp(AGENT_WRITE_TOOL_MATCHER).test('Write')).toBe(true);
  });

  it('짝 없는 서로게이트가 든 글도 던지지 않고 같은 답을 낸다', () => {
    expect(classifyPrompt(`\ud800${MARK} x`).readOnly).toBe(false);
    expect(classifyPrompt(`${MARK}\udc00 x`).readOnly).toBe(true);
    expect(isReadTool('Read\ud800')).toBe(false);
  });
});

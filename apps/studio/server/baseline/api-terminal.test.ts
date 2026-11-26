import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorld, Driver, startNodeTarget, type World } from './harness';

/**
 * API 모드 세션의 이 컴퓨터 방식 터미널이 b-studio의 자체 CLI를 띄우는 길(ADR-226)을 진짜 PTY에서 본다.
 * 서버는 진짜 studio 서버(Node), 터미널은 진짜 PTY와 진짜 `agent-tty` 프로세스, 모델은 이 시험 안의 가짜 OpenAI 호환 서버다.
 * 진짜 모델·claude·Docker·3000번 포트는 쓰지 않는다. 가짜 docker는 harness의 것이다.
 */

const KEY_ENV = 'B_STUDIO_FAKE_API_TERMINAL_KEY';
const KEY = 'sk-fake-api-terminal-secret';

interface FakeProvider {
  server: Server;
  baseUrl: string;
  /** 받은 요청의 Authorization 머리글 */
  auth: string[];
  /** 받은 요청에 든 도구 결과(role: tool)의 내용 */
  toolResults: string[];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** 처음에는 Write 도구 호출을, 도구 결과가 오면 글로 답한다 */
async function fakeProvider(file: string, content: string, call?: { name: string; args: Record<string, unknown> }): Promise<FakeProvider> {
  const auth: string[] = [];
  const toolResults: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) return send(response, { id: 'api-term-fake', object: 'model' });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return void response.writeHead(404).end('{}');
    auth.push(String(request.headers.authorization));
    const body = JSON.parse(await readBody(request)) as { messages?: Array<{ role?: string; content?: unknown }> };
    for (const message of body.messages ?? []) if (message.role === 'tool') toolResults.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    if (!body.messages?.some((message) => message.role === 'tool')) {
      return send(response, {
        id: 'm1',
        model: 'api-term-fake',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: call?.name ?? 'Write', arguments: JSON.stringify(call?.args ?? { file_path: file, content }) } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      });
    }
    send(response, { id: 'm2', model: 'api-term-fake', choices: [{ finish_reason: 'stop', message: { content: '파일을 만들었습니다.' } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, auth, toolResults };
}

async function apiWorld(provider: FakeProvider, env: Record<string, string>, docker?: { logs?: string[] }): Promise<World> {
  const world = await createWorld({ terminal: true, env: { B_STUDIO_MODE: 'api', ...env }, ...(docker ? { docker } : {}) });
  const registry = [
    {
      id: 'api-term-fake',
      provider: 'openai',
      model: 'api-term-fake',
      label: 'API 터미널 가짜 모델',
      capabilities: ['tools', 'json'],
      contextWindow: 32_000,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      baselineQuality: 0.8,
      baselineLatencyMs: 100,
      baseUrl: provider.baseUrl,
      apiKeyEnv: KEY_ENV,
    },
  ];
  const file = path.join(world.root, 'models.json');
  await writeFile(file, JSON.stringify(registry), { mode: 0o600 });
  world.env.B_STUDIO_MODEL_REGISTRY = file;
  return world;
}

async function waitUntil<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다(${label}): ${JSON.stringify(value).slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('API 모드 세션 터미널(이 컴퓨터 방식)의 자체 CLI', () => {
  it('진짜 PTY에서 자체 CLI가 관문(훅)을 거쳐 실행 한 건을 열고 체크포인트까지 가며, 세션을 멈추면 모델 파일이 지워진다', async () => {
    const provider = await fakeProvider('notes/api-terminal.txt', '자체 CLI가 썼습니다\n');
    const world = await apiWorld(provider, { [KEY_ENV]: KEY });
    const target = await startNodeTarget(world);
    const driver = new Driver(target.origin, world);
    try {
      const created = await driver.call('세션 만들기', 'POST', '/api/sessions', { projectId: world.projectId, backend: 'api', workspace: 'copy' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      const workDir = created.body.workDir as string;
      await driver.subscribe(id);

      const opened = await driver.call('터미널 열기', 'POST', `/api/sessions/${id}/terminal`, { action: 'open', cols: 100, rows: 30 });
      expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
      const gateway = await driver.gatewayDir();
      // 모델 파일은 600이고 키가 든다. 실행기는 700이다
      const model = await stat(path.join(gateway, 'agent-model.json'));
      expect(model.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path.join(gateway, 'agent-model.json'), 'utf8')).apiKey).toBe(KEY);
      expect((await stat(path.join(gateway, 'agent-tty'))).mode & 0o777).toBe(0o700);

      // CLI가 입력을 읽기 시작하기 전에 붙인 글은 터미널이 버린다(원시 모드로 바뀔 때 입력 대기열을 비운다). 자체 CLI가 뜰 때까지 요청이 시작되지 않으면 다시 붙여 넣는다
      const paste = `\u001b[200~notes/api-terminal.txt를 만들어 주세요\u001b[201~\r`;
      let started: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && !started; attempt++) {
        await driver.call('요청 붙여 넣기', 'POST', `/api/sessions/${id}/terminal`, { action: 'input', data: paste });
        for (let wait = 0; wait < 30 && !started; wait++) {
          started = driver.events.map((entry) => entry.event).find((event) => event.type === 'run_started');
          if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!started) throw new Error('붙여 넣은 요청으로 실행이 열리지 않았습니다');
      expect(started.via).toBe('terminal');
      expect(started.backend).toBe('api');

      const finished = await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === started.runId, 120_000);
      expect(finished.status, JSON.stringify(finished)).toBe('done');
      const checkpoint = driver.events.map((entry) => entry.event).find((event) => event.type === 'checkpoint') as { checkpoint?: { files?: string[] } } | undefined;
      expect(checkpoint?.checkpoint?.files, JSON.stringify(driver.events.map((entry) => entry.event)).slice(0, 6000)).toContain('notes/api-terminal.txt');
      expect(await readFile(path.join(workDir, 'notes/api-terminal.txt'), 'utf8')).toBe('자체 CLI가 썼습니다\n');
      // 모델 호출에는 모델 파일의 키가 갔다
      expect(provider.auth.length).toBeGreaterThanOrEqual(2);
      expect(new Set(provider.auth)).toEqual(new Set([`Bearer ${KEY}`]));
      // 텔레메트리의 비용이 실행에 기록됐다(가격 1·2달러/백만 토큰: 첫 모델 호출 1000 입력·100 출력 = 0.0012달러)
      const usage = driver.events.map((entry) => entry.event).filter((event) => event.type === 'run_usage' && event.runId === started.runId) as Array<{ costUsd?: number; model?: string }>;
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)).toBeGreaterThan(0);
      expect(usage[0]!.model).toBe('api-term-fake');
      // 세션을 멈추면 관문 폴더의 모델 파일(키)이 남지 않는다
      const stopped = await driver.call('멈추기', 'DELETE', `/api/sessions/${id}`);
      expect(stopped.status).toBeLessThan(300);
      await waitUntil('관문 폴더 정리', () => readdir(path.dirname(gateway)).catch(() => [] as string[]), (names) => !names.includes(path.basename(gateway)), 30_000);
    } finally {
      await driver.close();
      await target.stop();
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await world.cleanup();
    }
  }, 240_000);

  it('모델이 Bash로 명령을 실행하면 관문의 쓰기 직전 훅이 Bash로 보고, 바뀐 파일이 체크포인트에 든다', async () => {
    const provider = await fakeProvider('', '', { name: 'Bash', args: { command: 'mkdir -p notes && printf hi > notes/bash.txt', description: '파일 만들기' } });
    const world = await apiWorld(provider, { [KEY_ENV]: KEY });
    const target = await startNodeTarget(world);
    const driver = new Driver(target.origin, world);
    try {
      const created = await driver.call('세션 만들기', 'POST', '/api/sessions', { projectId: world.projectId, backend: 'api', workspace: 'copy' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      const workDir = created.body.workDir as string;
      await driver.subscribe(id);
      const opened = await driver.call('터미널 열기', 'POST', `/api/sessions/${id}/terminal`, { action: 'open', cols: 100, rows: 30 });
      expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
      const paste = `\u001b[200~notes/bash.txt를 만들어 주세요\u001b[201~\r`;
      let started: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && !started; attempt++) {
        await driver.call('요청 붙여 넣기', 'POST', `/api/sessions/${id}/terminal`, { action: 'input', data: paste });
        for (let wait = 0; wait < 30 && !started; wait++) {
          started = driver.events.map((entry) => entry.event).find((event) => event.type === 'run_started');
          if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!started) throw new Error('붙여 넣은 요청으로 실행이 열리지 않았습니다');
      const finished = await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === started.runId, 120_000);
      expect(finished.status, JSON.stringify(finished)).toBe('done');
      // 서버의 쓰기 직전 훅이 Bash 도구 호출로 봤다(claude의 Bash와 같은 이름이라 같은 분류를 거친다)
      const toolCalls = driver.events.map((entry) => entry.event).filter((event) => event.type === 'agent' && (event.event as { type?: string }).type === 'tool_call') as Array<{ event: { name: string; input?: { command?: string } } }>;
      expect(toolCalls.map((call) => call.event.name)).toContain('Bash');
      expect(toolCalls.find((call) => call.event.name === 'Bash')?.event.input?.command).toContain('notes/bash.txt');
      const checkpoint = driver.events.map((entry) => entry.event).find((event) => event.type === 'checkpoint') as { checkpoint?: { files?: string[] } } | undefined;
      expect(checkpoint?.checkpoint?.files, JSON.stringify(driver.events.map((entry) => entry.event)).slice(0, 6000)).toContain('notes/bash.txt');
      expect(await readFile(path.join(workDir, 'notes/bash.txt'), 'utf8')).toBe('hi');
      await driver.call('멈추기', 'DELETE', `/api/sessions/${id}`);
    } finally {
      await driver.close();
      await target.stop();
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await world.cleanup();
    }
  }, 240_000);

  it('모델이 관문의 b-studio 도구(MCP)를 mcp__b-studio__ 이름으로 부르면 서버가 실행하고 결과가 모델에 돌아온다', async () => {
    const marker = 'api-terminal-mcp-marker-4417';
    const provider = await fakeProvider('', '', { name: 'mcp__b-studio__service_logs', args: { service: 'app', lines: 10 } });
    const world = await apiWorld(provider, { [KEY_ENV]: KEY }, { logs: [marker] });
    const target = await startNodeTarget(world);
    const driver = new Driver(target.origin, world);
    try {
      const created = await driver.call('세션 만들기', 'POST', '/api/sessions', { projectId: world.projectId, backend: 'api', workspace: 'copy' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      await driver.subscribe(id);
      const opened = await driver.call('터미널 열기', 'POST', `/api/sessions/${id}/terminal`, { action: 'open', cols: 100, rows: 30 });
      expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
      // 관문 폴더의 mcp.json은 600이고 토큰이 든다(자체 CLI가 이 파일로 붙는다)
      const gateway = await driver.gatewayDir();
      expect((await stat(path.join(gateway, 'mcp.json'))).mode & 0o777).toBe(0o600);
      const paste = `\u001b[200~app 로그를 보여 주세요\u001b[201~\r`;
      let started: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && !started; attempt++) {
        await driver.call('요청 붙여 넣기', 'POST', `/api/sessions/${id}/terminal`, { action: 'input', data: paste });
        for (let wait = 0; wait < 30 && !started; wait++) {
          started = driver.events.map((entry) => entry.event).find((event) => event.type === 'run_started');
          if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!started) throw new Error('붙여 넣은 요청으로 실행이 열리지 않았습니다');
      const finished = await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === started.runId, 120_000);
      expect(finished.status, JSON.stringify(finished)).toBe('done');
      // 가짜 모델이 받은 도구 결과에 서버가 실행한 도구의 출력이 들어 있다(모델 → 자체 CLI → 관문의 MCP 서버 → 도구 → 되돌아옴)
      expect(provider.toolResults.join('\n')).toContain(marker);
      await driver.call('멈추기', 'DELETE', `/api/sessions/${id}`);
    } finally {
      await driver.close();
      await target.stop();
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await world.cleanup();
    }
  }, 240_000);

  it('키 없는 로컬 모델(이 컴퓨터의 OpenAI 호환 서버)은 키 없이 터미널을 열고, 모델 호출에 인증을 보내지 않는다', async () => {
    const provider = await fakeProvider('notes/local.txt', '로컬 모델이 썼습니다\n');
    // 키 환경 변수를 주지 않는다. 가짜 서버는 127.0.0.1이라 레지스트리·클라이언트·서버 모두 키 없이 되는 모델로 본다
    const world = await apiWorld(provider, {});
    const target = await startNodeTarget(world);
    const driver = new Driver(target.origin, world);
    try {
      const created = await driver.call('세션 만들기', 'POST', '/api/sessions', { projectId: world.projectId, backend: 'api', workspace: 'copy' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      const workDir = created.body.workDir as string;
      await driver.subscribe(id);
      const opened = await driver.call('터미널 열기', 'POST', `/api/sessions/${id}/terminal`, { action: 'open', cols: 100, rows: 30 });
      expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
      const gateway = await driver.gatewayDir();
      const model = JSON.parse(await readFile(path.join(gateway, 'agent-model.json'), 'utf8')) as { apiKey?: unknown; profile?: { id?: string } };
      expect(model.profile?.id).toBe('api-term-fake');
      expect(model).not.toHaveProperty('apiKey');

      const paste = `\u001b[200~notes/local.txt를 만들어 주세요\u001b[201~\r`;
      let started: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && !started; attempt++) {
        await driver.call('요청 붙여 넣기', 'POST', `/api/sessions/${id}/terminal`, { action: 'input', data: paste });
        for (let wait = 0; wait < 30 && !started; wait++) {
          started = driver.events.map((entry) => entry.event).find((event) => event.type === 'run_started');
          if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!started) throw new Error('붙여 넣은 요청으로 실행이 열리지 않았습니다');
      expect(started.backend).toBe('api');
      const finished = await driver.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === started.runId, 120_000);
      expect(finished.status, JSON.stringify(finished)).toBe('done');
      expect(await readFile(path.join(workDir, 'notes/local.txt'), 'utf8')).toBe('로컬 모델이 썼습니다\n');
      // 키가 없으니 인증 헤더를 보내지 않았다(가짜 서버는 없는 헤더를 'undefined'로 적는다)
      expect(provider.auth.length).toBeGreaterThanOrEqual(2);
      expect(new Set(provider.auth)).toEqual(new Set(['undefined']));
    } finally {
      await driver.close();
      await target.stop();
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await world.cleanup();
    }
  }, 240_000);

  // Fleet을 고른 까닭: 작업 분해 카드 계획은 계획 만들기·승인·통합 검증까지 거쳐 설정이 많고, Fleet은 같은 runTerminalTask(서버가 붙여 넣고 실행을 기다리는 길)를 한 요청으로 탄다.
  // 작업 분해 레인이 api를 받는 판정은 Fleet과 같은 isTerminalRunnableBackend이고 단위 시험(task-plans.test.ts)이 따로 본다
  it('API 후보 둘의 터미널 방식 Fleet이 진짜 PTY의 자체 CLI로 끝까지 돌아 멤버마다 체크포인트를 남긴다', async () => {
    const provider = await fakeProvider('notes/api-fleet.txt', '플릿 멤버가 썼습니다\n');
    const world = await apiWorld(provider, { [KEY_ENV]: KEY });
    const target = await startNodeTarget(world);
    const driver = new Driver(target.origin, world);
    try {
      const created = await driver.call('Fleet 만들기', 'POST', '/api/fleets', {
        projectId: world.projectId,
        request: 'notes/api-fleet.txt를 만들어 주세요',
        runner: 'terminal',
        candidates: [
          { backend: 'api', model: 'api-term-fake' },
          { backend: 'api', model: 'api-term-fake' },
        ],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.runner).toBe('terminal');
      const fleetId = created.body.id as string;
      type Member = { status: string; backend?: string; summary?: string; checkpoint?: { files: string[] } };
      const members = await waitUntil(
        'Fleet의 멤버가 모두 끝나기',
        async () => (await driver.peek(`/api/fleets/${fleetId}`)).body.members as Member[],
        (list) => list.length === 2 && list.every((member) => !['booting', 'running', 'awaiting_input'].includes(member.status)),
        180_000,
      );
      expect(members.map((member) => `${member.backend}:${member.status}`), JSON.stringify(members)).toEqual(['api:done', 'api:done']);
      for (const member of members) expect(member.checkpoint?.files).toEqual(['notes/api-fleet.txt']);
      // 모델 호출에는 모델 파일의 키가 갔다
      // 채팅식이 아니라 멤버마다 자체 CLI가 떴다는 증거: 멤버마다 관문 폴더가 있고 그 안에 모델 파일이 있다
      const gateways = await readdir(path.join(world.root, 'gateway'));
      expect(gateways).toHaveLength(2);
      for (const name of gateways) expect(await readdir(path.join(world.root, 'gateway', name))).toContain('agent-model.json');
      expect(new Set(provider.auth)).toEqual(new Set([`Bearer ${KEY}`]));
    } finally {
      await driver.close();
      await target.stop();
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await world.cleanup();
    }
  }, 240_000);
});

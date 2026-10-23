import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStudio, parseSse, StudioClient, INPUT_CHUNK } from './client';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let origin: string;
let seen: Seen[];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => res.end('{}');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('스튜디오 찾기', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'desk-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('launch가 남긴 PID 파일의 포트와 로컬 토큰으로 이 컴퓨터 주소를 만든다', async () => {
    const dir = path.join(home, '.cache', 'b-studio', 'launch');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'studio.pid'), JSON.stringify({ pid: 1, port: 3456, mode: 'local' }));
    await writeFile(path.join(dir, 'local-token'), 'tok\n');
    expect(await findStudio({ HOME: home }, {})).toEqual({ origin: 'http://127.0.0.1:3456', token: 'tok' });
  });

  it('포트를 주면 그것을 쓰고, 토큰 파일 자리는 스튜디오와 같은 환경 변수를 따른다', async () => {
    const file = path.join(home, 'token');
    await writeFile(file, 'abc');
    expect(await findStudio({ HOME: home, B_STUDIO_LOCAL_TOKEN_FILE: file }, { port: 3101 })).toEqual({ origin: 'http://127.0.0.1:3101', token: 'abc' });
  });

  it('토큰이 없으면 launch로 띄우라고 알린다', async () => {
    const found = await findStudio({ HOME: home }, { port: 3101 });
    expect('error' in found && found.error).toContain('studio launch');
  });
});

describe('SSE 해석', () => {
  it('조각난 입력을 이어 붙여 data 줄만 꺼내고 주석 줄은 버린다', () => {
    const first = parseSse('', 'data: {"a":1}\n\n: ping\n\ndata: {"b"');
    expect(first.events).toEqual(['{"a":1}']);
    const second = parseSse(first.rest, ':2}\n\n');
    expect(second.events).toEqual(['{"b":2}']);
    expect(second.rest).toBe('');
  });
});

describe('스튜디오 손님', () => {
  it('요청마다 로컬 토큰 쿠키를 싣고 Origin은 싣지 않는다', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ items: [{ id: 's1' }], totals: {} }));
    const client = new StudioClient({ origin, token: 'tok' });
    expect((await client.agents()).items).toEqual([{ id: 's1' }]);
    expect(seen[0]!.url).toBe('/api/agents');
    expect(seen[0]!.headers.cookie).toBe('b_studio_local=tok');
    expect(seen[0]!.headers.origin).toBeUndefined();
  });

  it('오류 응답은 서버가 준 문구로 던진다', async () => {
    handler = (_req, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: '고른 AI를 쓸 수 없습니다' }));
    };
    await expect(new StudioClient({ origin, token: 't' }).open('s1', 80, 24)).rejects.toThrow('고른 AI를 쓸 수 없습니다');
  });

  it('터미널 열기·크기·입력은 세션별 터미널 API로 보내고, 긴 입력은 차례대로 나눠 보낸다', async () => {
    const client = new StudioClient({ origin, token: 't' });
    await client.open('s1', 80, 24);
    await client.resize('s1', 100, 30);
    const long = 'x'.repeat(INPUT_CHUNK + 5);
    await client.input('s1', long);
    expect(seen.map((request) => [request.method, request.url, JSON.parse(request.body).action])).toEqual([
      ['POST', '/api/sessions/s1/terminal', 'open'],
      ['POST', '/api/sessions/s1/terminal', 'resize'],
      ['POST', '/api/sessions/s1/terminal', 'input'],
      ['POST', '/api/sessions/s1/terminal', 'input'],
    ]);
    expect(JSON.parse(seen[2]!.body).data).toHaveLength(INPUT_CHUNK);
    expect(JSON.parse(seen[3]!.body).data).toBe('xxxxx');
  });

  it('나눌 자리가 이모지 한가운데면 이모지를 쪼개지 않고 앞에서 나눈다(#860)', async () => {
    const client = new StudioClient({ origin, token: 't' });
    await client.input('s1', `${'x'.repeat(INPUT_CHUNK - 1)}😀y`);
    const parts = seen.map((request) => JSON.parse(request.body).data as string);
    expect(parts).toEqual(['x'.repeat(INPUT_CHUNK - 1), '😀y']);
  });

  it('새 요청은 터미널로 보내 달라고(terminal: true) 세션 API에 보낸다', async () => {
    handler = (_req, res) => {
      res.statusCode = 201;
      res.end(JSON.stringify({ session: { id: 'new' }, routing: { backend: 'codex' }, terminal: { opened: true, pasted: true } }));
    };
    const client = new StudioClient({ origin, token: 't' });
    const result = await client.start({ projectId: 'p1', request: '주문 목록', choice: 'rules' });
    expect(result.session.id).toBe('new');
    expect(JSON.parse(seen[0]!.body)).toEqual({ projectId: 'p1', route: 'rules', request: '주문 목록', intent: 'build', terminal: true });
    await client.start({ projectId: 'p1', request: 'x', choice: 'codex' });
    expect(JSON.parse(seen[1]!.body)).toEqual({ projectId: 'p1', route: 'direct', backend: 'codex', request: 'x', intent: 'build', terminal: true });
    // 계정까지 고르면(#885) 그 계정 id를 함께 보낸다
    await client.start({ projectId: 'p1', request: 'x', choice: 'codex@acct-1a2b3c4d' });
    expect(JSON.parse(seen[2]!.body)).toEqual({ projectId: 'p1', route: 'direct', backend: 'codex', accountId: 'acct-1a2b3c4d', request: 'x', intent: 'build', terminal: true });
  });

  it('계정 목록을 읽는다(#885)', async () => {
    handler = (_req, res) => {
      res.end(JSON.stringify({ accounts: [{ id: 'codex', name: '기본', backend: 'codex', builtin: true }] }));
    };
    const accounts = await new StudioClient({ origin, token: 't' }).accounts();
    expect(accounts).toEqual([{ id: 'codex', name: '기본', backend: 'codex', builtin: true }]);
    expect(seen[0]!.url).toBe('/api/ai-accounts');
  });

  it('기록 화면과 세션 자세히가 쓰는 API를 부른다(#891)', async () => {
    handler = (req, res) => {
      if (req.url?.includes('/checkpoints/abc') && req.method === 'GET') return res.end(JSON.stringify({ patch: 'diff --git a/x b/x' }));
      if (req.url?.endsWith('/export') && req.method === 'POST') return res.end(JSON.stringify({ sha: 'abc', commits: 1, forced: false, pullRequest: { url: 'https://example.test/pr/1', created: true } }));
      res.end(JSON.stringify({ ok: true, rows: [], excluded: { asks: 0, unfinished: 0 }, report: { projectId: 'p1' }, id: 's1', checkpoints: [] }));
    };
    const client = new StudioClient({ origin, token: 't' });
    await client.routingStats();
    await client.tokenReport('p 1', '2026-10-16T00:00:00.000Z');
    await client.tokenReport('p1');
    await client.session('s/1');
    expect(await client.checkpointPatch('s1', 'abc')).toBe('diff --git a/x b/x');
    await client.restoreCheckpoint('s1', 'abc');
    await client.reverify('s1', 'abc');
    await client.deleteSession('s1');
    await client.exportPreview('s1');
    expect((await client.exportSession('s1', true)).pullRequest?.url).toBe('https://example.test/pr/1');
    await client.reviewRound('s1', true);
    await client.resolveFinding('s1', { round: 2, findingIndex: 0, reason: '오탐' });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/routing/stats',
      'GET /api/projects/p%201/token-report?from=2026-10-16T00%3A00%3A00.000Z',
      'GET /api/projects/p1/token-report',
      'GET /api/sessions/s%2F1',
      'GET /api/sessions/s1/checkpoints/abc',
      'POST /api/sessions/s1/checkpoints/abc/restore',
      'POST /api/sessions/s1/checkpoints/abc/reverify',
      'POST /api/sessions/s1/delete',
      'POST /api/sessions/s1/export/preview',
      'POST /api/sessions/s1/export',
      'POST /api/sessions/s1/review',
      'POST /api/sessions/s1/review/resolve',
    ]);
    expect(JSON.parse(seen[9]!.body)).toEqual({ pullRequest: true });
    expect(JSON.parse(seen[10]!.body)).toEqual({ restart: true });
    expect(JSON.parse(seen[11]!.body)).toEqual({ round: 2, findingIndex: 0, reason: '오탐' });
  });

  it('설정 화면이 계정·로그인·규칙을 다루는 요청을 보낸다(#890)', async () => {
    handler = (req, res) => {
      if (req.url === '/api/ai-accounts' && req.method === 'POST') res.end(JSON.stringify({ account: { id: 'acct-1', name: '피오', backend: 'codex', configDir: '/h/x' } }));
      else if (req.url?.endsWith('/status')) res.end(JSON.stringify({ status: { connected: true, installed: true } }));
      else if (req.url?.endsWith('/login') && req.method === 'POST') res.end(JSON.stringify({ spawnable: true, progress: { state: 'running', lines: [] } }));
      else if (req.url === '/api/routing/rules' && req.method === 'GET') res.end(JSON.stringify({ rules: { rules: [] }, allowed: ['codex'], defaultBackend: 'codex' }));
      else if (req.url === '/api/routing/rules') res.end(JSON.stringify({ rules: { rules: [{ when: {}, backend: 'codex' }] } }));
      else res.end(JSON.stringify({ account: { id: 'acct-1', name: '마르코', backend: 'codex' }, progress: { state: 'cancelled', lines: [] }, ok: true }));
    };
    const client = new StudioClient({ origin, token: 't' });
    expect(await client.addAccount({ name: '피오', backend: 'codex', configDir: '~/x' })).toMatchObject({ id: 'acct-1' });
    expect(await client.updateAccount('acct-1', { name: '마르코', sprite: '' })).toMatchObject({ name: '마르코' });
    await client.removeAccount('acct-1');
    expect(await client.accountStatus('acct-1')).toEqual({ connected: true, installed: true });
    expect(await client.startLogin('acct-1')).toEqual({ spawnable: true, progress: { state: 'running', lines: [] } });
    expect(await client.loginProgress('acct-1')).toMatchObject({ state: 'cancelled' });
    expect(await client.cancelLogin('acct-1')).toMatchObject({ state: 'cancelled' });
    expect(await client.rules()).toEqual({ rules: { rules: [] }, allowed: ['codex'], defaultBackend: 'codex' });
    expect(await client.saveRules({ rules: [{ when: {}, backend: 'codex' }] })).toEqual({ rules: [{ when: {}, backend: 'codex' }] });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'POST /api/ai-accounts',
      'PATCH /api/ai-accounts/acct-1',
      'DELETE /api/ai-accounts/acct-1',
      'GET /api/ai-accounts/acct-1/status',
      'POST /api/ai-accounts/acct-1/login',
      'GET /api/ai-accounts/acct-1/login',
      'DELETE /api/ai-accounts/acct-1/login',
      'GET /api/routing/rules',
      'PUT /api/routing/rules',
    ]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: '피오', backend: 'codex', configDir: '~/x' });
    expect(JSON.parse(seen[1]!.body)).toEqual({ name: '마르코', sprite: '' });
    expect(JSON.parse(seen[8]!.body)).toEqual({ rules: [{ when: {}, backend: 'codex' }] });
  });

  it('계정마다의 사용량 한도를 묻고, 다시 읽기는 refresh=1로 청한다(#889)', async () => {
    const accounts = [{ id: 'codex', backend: 'codex', name: '기본', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 26 }], source: 'codex-app-server' }];
    handler = (_req, res) => {
      res.end(JSON.stringify({ accounts, warning: '계정 목록 파일을 읽지 못했습니다' }));
    };
    const client = new StudioClient({ origin, token: 't' });
    expect(await client.limits()).toEqual({ accounts, warning: '계정 목록 파일을 읽지 못했습니다' });
    await client.limits(true);
    expect(seen.map((entry) => entry.url)).toEqual(['/api/usage/limits', '/api/usage/limits?refresh=1']);
  });

  it('여러 AI 비교의 목록·보기·만들기·승자·지우기를 fleets API로 보낸다(#892)', async () => {
    handler = (_req, res) => res.end('[]');
    const client = new StudioClient({ origin, token: 't' });
    await client.fleets();
    await client.fleet('f 1');
    await client.createFleet({ projectId: 'shop', request: '검색', candidates: [{ backend: 'codex', accountId: 'acct-pio' }, { backend: 'claude-code', model: 'sonnet' }] });
    await client.chooseFleetWinner('f1', 's1');
    await client.deleteFleet('f1');
    expect(seen.map((entry) => `${entry.method} ${entry.url} ${entry.body}`)).toEqual([
      'GET /api/fleets ',
      'GET /api/fleets/f%201 ',
      'POST /api/fleets {"projectId":"shop","request":"검색","candidates":[{"backend":"codex","accountId":"acct-pio"},{"backend":"claude-code","model":"sonnet"}]}',
      'POST /api/fleets/f1/winner {"sessionId":"s1"}',
      'POST /api/fleets/f1/delete ',
    ]);
  });

  it('요구사항·문서 화면이 세션의 요구사항·테스트·문서·현황 API를 부른다(#894)', async () => {
    handler = (req, res) => {
      if (req.url?.includes('/docs/content') && req.method === 'GET') res.end(JSON.stringify({ path: 'docs/a b.md', content: '# 제목' }));
      else if (req.url?.endsWith('/docs')) res.end(JSON.stringify({ docs: [{ path: 'README.md', title: '쇼핑몰' }] }));
      else res.end(JSON.stringify({ exists: true, requirements: [], assumptions: [], manualSteps: [] }));
    };
    const client = new StudioClient({ origin, token: 't' });
    await client.requirements('s/1');
    await client.tests('s1');
    expect(await client.docs('s1')).toEqual([{ path: 'README.md', title: '쇼핑몰' }]);
    expect(await client.doc('s1', 'docs/a b.md')).toBe('# 제목');
    await client.saveDoc('s1', 'docs/a.md', '본문');
    await client.projectStatus('s1');
    await client.verifyRequirement('s1', 'R1', '손으로 확인');
    await client.clearVerification('s1', 'R1');
    await client.applyRequirements('s1', { requirements: [] });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/sessions/s%2F1/requirements',
      'GET /api/sessions/s1/tests',
      'GET /api/sessions/s1/docs',
      'GET /api/sessions/s1/docs/content?path=docs%2Fa+b.md',
      'POST /api/sessions/s1/docs/content',
      'GET /api/sessions/s1/status',
      'POST /api/sessions/s1/requirements/verify',
      'DELETE /api/sessions/s1/requirements/verify',
      'POST /api/sessions/s1/requirements/apply',
    ]);
    expect(JSON.parse(seen[4]!.body)).toEqual({ path: 'docs/a.md', content: '본문' });
    expect(JSON.parse(seen[6]!.body)).toEqual({ requirementId: 'R1', note: '손으로 확인' });
    expect(JSON.parse(seen[7]!.body)).toEqual({ requirementId: 'R1' });
    expect(JSON.parse(seen[8]!.body)).toEqual({ requirements: [], assumptions: [], manualSteps: [] });
  });

  it('묶음 통로를 열어 세션별 메시지를 넘기고, 끊으면 끝난다', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ id: 's1', message: { kind: 'data', data: Buffer.from('hi').toString('base64') } })}\n\n`);
      res.write(': ping\n\n');
      res.write(`data: ${JSON.stringify({ id: 's2', message: { kind: 'cli', alive: true } })}\n\n`);
    };
    const client = new StudioClient({ origin, token: 't' });
    const controller = new AbortController();
    const got: Array<[string, string]> = [];
    const done = client.stream(['s1', 's2'], (id, message) => {
      got.push([id, message.kind]);
      if (got.length === 2) controller.abort();
    }, controller.signal);
    await done;
    expect(seen[0]!.url).toBe('/api/terminals/stream?ids=s1%2Cs2');
    expect(got).toEqual([
      ['s1', 'data'],
      ['s2', 'cli'],
    ]);
  });
});

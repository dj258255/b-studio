/**
 * 스크립트 제어 명령 시험용 가짜 스튜디오와 가짜 CLI. 진짜 스튜디오·PTY·모델 없이 같은 HTTP 모양(목록·목록 통로·터미널 입력·터미널 통로)을 낸다.
 * 가짜 CLI의 행동: 붙여넣기 표지로 온 글 뒤의 Enter를 받으면 요청으로 받아 작업 중이 되고, 조금 뒤 쉬면서 게이트를 돈다.
 * dropEnters만큼은 Enter를 먹지 않는다(herdr에서 Enter가 가끔 안 먹던 일)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeskItem } from '../desk/types';

export const FAKE_TOKEN = 'fake-local-token';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface FakeSession {
  item: DeskItem;
  /** 터미널 화면에 그린 글(줄바꿈은 CRLF) */
  screen: string;
  /** 붙여 넣은 뒤 Enter를 기다리는 글 */
  pending?: string;
  /** 받은 입력 전부 */
  inputs: string[];
  /** 받아들인 요청 */
  requests: string[];
  /** 터미널을 못 여는 까닭(권한 없음 등). 있으면 터미널 통로가 닫힘으로만 답한다 */
  closed?: string;
}

export interface FakeOptions {
  /** 작업 중에서 쉬기까지 */
  workMs: number;
  /** 쉰 뒤 게이트가 끝나기까지 */
  gateMs: number;
  gateResult: 'passed' | 'failed' | 'none';
  /** 이 수만큼의 Enter는 먹지 않는다 */
  dropEnters: number;
  /** 로그인을 요구하는 서버(token 방식)인가. 켜면 이 쿠키 없이는 401 */
  requireCookie?: string;
}

export class FakeStudio {
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: string[] = [];
  readonly startBodies: unknown[] = [];
  readonly cookies = new Set<string>();
  options: FakeOptions = { workMs: 150, gateMs: 150, gateResult: 'passed', dropEnters: 0 };
  readonly #server: Server;
  readonly #streams = new Set<ServerResponse>();
  readonly #terminals = new Set<{ res: ServerResponse; id: string }>();
  #counter = 0;
  port = 0;

  constructor() {
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const res of [...this.#streams, ...[...this.#terminals].map((entry) => entry.res)]) res.end();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  addSession(partial: Partial<DeskItem> = {}, screen = ''): FakeSession {
    const id = partial.id ?? `s-${++this.#counter}`;
    const item: DeskItem = { kind: 'session', id, title: `세션 ${id}`, projectName: 'demo', state: 'idle', backend: 'claude-code', lastActivityAt: new Date().toISOString(), terminal: { cli: 'up', waiting: 'idle' }, gate: { state: 'none', checkpoints: 0 }, ...partial };
    const session: FakeSession = { item, screen, inputs: [], requests: [] };
    this.sessions.set(id, session);
    this.notify();
    return session;
  }

  /** 목록 통로 구독자에게 전체를 다시 보낸다 */
  notify(): void {
    const body = `data: ${JSON.stringify({ type: 'full', items: [...this.sessions.values()].map((entry) => entry.item) })}\n\n`;
    for (const res of this.#streams) res.write(body);
  }

  touch(id: string, patch: Partial<DeskItem>): void {
    const session = this.sessions.get(id)!;
    session.item = { ...session.item, ...patch };
    this.notify();
  }

  draw(id: string, text: string): void {
    const session = this.sessions.get(id)!;
    const data = text.replace(/\n/g, '\r\n');
    session.screen += data;
    for (const entry of this.#terminals) if (entry.id === id) entry.res.write(`data: ${JSON.stringify({ id, message: { kind: 'data', data: Buffer.from(data).toString('base64') } })}\n\n`);
  }

  #submit(session: FakeSession, text: string): void {
    const id = session.item.id;
    session.requests.push(text);
    const now = new Date().toISOString();
    this.draw(id, `❯ ${text}\n`);
    this.touch(id, { state: 'working', workingSince: now, lastActivityAt: now, terminal: { cli: 'up' }, gate: { state: 'none', checkpoints: session.item.gate?.checkpoints ?? 0 } });
    setTimeout(() => {
      this.draw(id, '작업을 마쳤습니다\n');
      const { workingSince: _drop, ...rest } = session.item;
      this.sessions.get(id)!.item = rest;
      this.touch(id, { state: 'idle', lastActivityAt: new Date().toISOString(), terminal: { cli: 'up', waiting: 'idle' }, gate: { state: 'verifying', checkpoints: session.item.gate?.checkpoints ?? 0 } });
      setTimeout(() => {
        const result = this.options.gateResult;
        this.touch(id, { gate: { state: result, checkpoints: (session.item.gate?.checkpoints ?? 0) + (result === 'passed' ? 1 : 0) }, ...(result === 'failed' ? { attention: 'gate_failed', reason: '테스트 2개 실패' } : {}) });
      }, this.options.gateMs);
    }, this.options.workMs);
  }

  #input(session: FakeSession, data: string): void {
    session.inputs.push(data);
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      session.pending = data.slice(PASTE_START.length, -PASTE_END.length);
      this.draw(session.item.id, `[입력줄] ${session.pending}\n`);
      return;
    }
    if (data === '\r' && session.pending !== undefined) {
      if (this.options.dropEnters > 0) {
        this.options.dropEnters -= 1;
        return;
      }
      const text = session.pending;
      session.pending = undefined;
      this.#submit(session, text);
      return;
    }
    // 권한 창의 답: 1이면 허락
    if (session.item.terminal?.waiting === 'permission' && data === '1') this.touch(session.item.id, { state: 'idle', terminal: { cli: 'up', waiting: 'idle' } });
  }

  #authorized(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie ?? '';
    const expected = this.options.requireCookie ?? `b_studio_local=${FAKE_TOKEN}`;
    return cookie.split(';').some((part) => part.trim() === expected);
  }

  async #body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    this.calls.push(`${req.method} ${url.pathname}`);
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await this.#body(req);
      if (body.name !== 'beomsu' || body.token !== 'secret-token') return json(401, { error: '이름이나 접근 토큰이 맞지 않습니다' });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'b_studio_session=signed.value; Path=/; HttpOnly' });
      return void res.end(JSON.stringify({ user: 'beomsu' }));
    }
    if (!this.#authorized(req)) return json(403, { error: '터미널은 `pnpm studio launch`가 연 창에서 씁니다' });

    if (url.pathname === '/api/agents' && req.method === 'GET') return json(200, { items: [...this.sessions.values()].map((entry) => entry.item) });
    if (url.pathname === '/api/agents/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      this.#streams.add(res);
      res.on('close', () => this.#streams.delete(res));
      this.notify();
      return;
    }
    if (url.pathname === '/api/projects') return json(200, [{ id: 'p1', name: 'demo' }]);
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const body = await this.#body(req);
      this.startBodies.push(body);
      if (body.projectId !== 'p1') return json(404, { error: '프로젝트를 찾을 수 없습니다' });
      const session = this.addSession({ title: String(body.request).slice(0, 20), backend: body.backend ?? 'claude-code' });
      this.#submit(session, String(body.request));
      return json(201, { session: { id: session.item.id }, routing: { backend: body.backend ?? 'claude-code', matched: body.route === 'rules' ? '기본 규칙' : '직접' }, terminal: { opened: true, pasted: true } });
    }
    const match = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
      const session = this.sessions.get(decodeURIComponent(match[1]!));
      if (!session) return json(404, { error: '세션을 찾을 수 없습니다' });
      const sub = match[2] ?? '';
      if (sub === '' && req.method === 'DELETE') {
        this.touch(session.item.id, { state: 'stopped' });
        return json(200, { ok: true });
      }
      if (sub === '' && req.method === 'GET') return json(200, { id: session.item.id, status: 'ready', running: false, checkpoints: [{ sha: 'abc1234def', shortSha: 'abc1234', message: '로그인 추가', createdAt: new Date().toISOString(), files: ['src/a.ts'], verify: 'full' }] });
      if (sub === '/changes') return json(200, { files: [{ file: 'src/b.ts', change: 'modified', added: 3, removed: 1 }], truncated: false });
      if (sub === '/terminal' && req.method === 'POST') {
        const body = await this.#body(req);
        if (body.action === 'input') this.#input(session, String(body.data));
        return json(200, { ok: true });
      }
    }
    if (url.pathname === '/api/terminals/stream') {
      const id = url.searchParams.get('ids') ?? '';
      const session = this.sessions.get(id);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (message: unknown): void => void res.write(`data: ${JSON.stringify({ id, message })}\n\n`);
      if (!session || session.closed) {
        send({ kind: 'status', state: 'closed', message: session?.closed ?? '세션을 찾을 수 없습니다' });
        return;
      }
      if (session.screen) send({ kind: 'data', data: Buffer.from(session.screen).toString('base64') });
      send({ kind: 'status', state: 'open', size: { cols: 80, rows: 10 } });
      send({ kind: 'cli', alive: session.item.terminal?.cli === 'up' });
      const entry = { res, id };
      this.#terminals.add(entry);
      res.on('close', () => this.#terminals.delete(entry));
      return;
    }
    json(404, { error: `없는 경로 ${url.pathname}` });
  }
}

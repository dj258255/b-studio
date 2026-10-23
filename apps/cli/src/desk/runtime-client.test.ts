/**
 * 실행 화면(#895)이 부르는 스튜디오 API: 세션 이벤트 통로, 배포, 서비스 켜고 끄기, 미리보기 주소, 저장소
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudioClient } from './client';
import type { DeskSessionEvent } from './types';

let server: Server;
let client: StudioClient;
let seen: Array<{ method: string; url: string; cookie?: string; body: string }>;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => res.end('{}');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new StudioClient({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 't0k' });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('세션 이벤트 통로', () => {
  it('SSE의 data 줄을 이벤트로 넘기고, 끊으면 끝난다', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: { id: 's1', projectId: 'p1', status: 'ready', services: [], checkpoints: [] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'log', service: 'web', text: 'hi', at: 'x' }).slice(0, 20)}`);
      res.write(`${JSON.stringify({ type: 'log', service: 'web', text: 'hi', at: 'x' }).slice(20)}\n\n`);
    };
    const events: DeskSessionEvent[] = [];
    const controller = new AbortController();
    const done = client.sessionEvents('s 1', (event) => {
      events.push(event);
      if (events.length === 2) controller.abort();
    }, controller.signal);
    await done;
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/sessions/s%201/events', cookie: 'b_studio_local=t0k' });
    expect(events.map((event) => event.type)).toEqual(['snapshot', 'log']);
  });

  it('통로를 열지 못하면 스튜디오의 오류를 던진다', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: '세션을 찾을 수 없습니다' }));
    };
    await expect(client.sessionEvents('s1', () => {}, new AbortController().signal)).rejects.toThrow('세션을 찾을 수 없습니다');
  });
});

describe('배포·서비스·미리보기·저장소', () => {
  it('배포 상태를 받고, 배포·되돌리기를 보낸다', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ state: { releases: [] }, urls: {}, containers: [] }));
    await client.deploys('s1');
    await client.deploy('s1', 'abc');
    await client.rollback('s1', 'r1');
    expect(seen.map((entry) => `${entry.method} ${entry.url} ${entry.body}`)).toEqual([
      'GET /api/sessions/s1/deploys ',
      'POST /api/sessions/s1/deploys {"sha":"abc"}',
      'POST /api/sessions/s1/deploys/rollback {"releaseId":"r1"}',
    ]);
  });

  it('서비스를 켜고 끄고, 샌드박스를 켠다', async () => {
    await client.setService('s1', 'web app', false);
    await client.boot('s1');
    expect(seen.map((entry) => `${entry.method} ${entry.url} ${entry.body}`)).toEqual(['POST /api/sessions/s1/services/web%20app/selection {"on":false}', 'POST /api/sessions/s1/boot ']);
  });

  it('미리보기 주소: 게이트웨이면 1회용 주소를, 아니면 로컬 프록시 주소를 받는다', async () => {
    handler = (req, res) => res.end(JSON.stringify({ url: req.url?.includes('preview-access') ? 'https://gw/x?t=1' : 'http://127.0.0.1:5000/' }));
    expect(await client.previewUrl('s1', { name: 'web', previewUrl: 'https://gw/x' })).toBe('https://gw/x?t=1');
    expect(await client.previewUrl('s1', { name: 'web', url: 'http://127.0.0.1:41001' })).toBe('http://127.0.0.1:5000/');
    expect(seen.map((entry) => `${entry.method} ${entry.url} ${entry.body}`)).toEqual(['POST /api/sessions/s1/preview-access {"service":"web","path":"/"}', 'POST /api/sessions/s1/services/web/preview-proxy ']);
  });

  it('로컬 프록시를 받지 못하면 서비스 주소를 그대로 쓴다', async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end('{}');
    };
    expect(await client.previewUrl('s1', { name: 'web', url: 'http://127.0.0.1:41001' })).toBe('http://127.0.0.1:41001');
  });

  it('올리기 전 점검과 이슈·PR 목록을 받는다', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ok: true, issues: [] }));
    await client.submission('s1');
    await client.repository('p 1', 'issues', 'closed');
    await client.repository('p1', 'pulls', 'open');
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/sessions/s1/submission',
      'GET /api/projects/p%201/repository/issues?state=closed',
      'GET /api/projects/p1/repository/pulls?state=open',
    ]);
  });
});

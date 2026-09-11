import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callerResolver,
  isAllowedCall,
  isAllowedHost,
  isPrivateAddress,
  maskJson,
  matchPath,
  normalizeExternal,
  parseAllow,
  parseExternals,
  parseForwards,
  splitHostPort,
  startApiProxy,
  startEdge,
  upstreamUrl,
  type ApiAuditEntry,
} from './edge.mjs';

describe('설정 해석', () => {
  it('포워딩과 허용 목록을 읽는다', () => {
    expect(parseForwards('20000=web:3000, 20001=api:8080')).toEqual([
      { listen: 20000, host: 'web', port: 3000 },
      { listen: 20001, host: 'api', port: 8080 },
    ]);
    expect(() => parseForwards('20000=web')).toThrow('잘못된 포워딩 설정');
    expect(parseAllow('Registry.npmjs.org, *.gradle.org,')).toEqual(['registry.npmjs.org', '*.gradle.org']);
    expect(splitHostPort('registry.npmjs.org:443')).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(splitHostPort('[::1]:443')).toEqual({ host: '::1', port: 443 });
  });
});

describe('isAllowedHost', () => {
  const rules = ['registry.npmjs.org', '*.gradle.org'];

  it('목록의 호스트와 하위 도메인만, 80·443 포트로만 허용한다', () => {
    expect(isAllowedHost('registry.npmjs.org', 443, rules)).toBe(true);
    expect(isAllowedHost('plugins.gradle.org', 443, rules)).toBe(true);
    expect(isAllowedHost('gradle.org', 443, rules)).toBe(false);
    expect(isAllowedHost('evilgradle.org', 443, rules)).toBe(false);
    expect(isAllowedHost('registry.npmjs.org.evil.com', 443, rules)).toBe(false);
    expect(isAllowedHost('registry.npmjs.org', 5432, rules)).toBe(false);
  });

  it('IP로 직접 접속하는 요청은 막는다', () => {
    expect(isAllowedHost('104.16.7.34', 443, ['104.16.7.34'])).toBe(false);
    expect(isAllowedHost('[2606:4700::6810:722]', 443, rules)).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.19.0.1', true],
    ['192.168.0.10', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:10.0.0.1', true],
    ['104.16.7.34', false],
    ['2606:4700::6810:722', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('사내 API 정책', () => {
  it('*는 한 구간, **는 여러 구간과 맞는다', () => {
    expect(matchPath('/api/users/*', '/api/users/1')).toBe(true);
    expect(matchPath('/api/users/*', '/api/users/1/orders')).toBe(false);
    expect(matchPath('/api/users/*', '/api/users')).toBe(false);
    expect(matchPath('/api/**', '/api')).toBe(true);
    expect(matchPath('/api/**/orders', '/api/users/1/orders')).toBe(true);
    expect(matchPath('/**', '/anything/at/all')).toBe(true);
  });

  it('규칙이 없으면 GET·HEAD만, 규칙이 있으면 호출자·메서드·경로가 모두 맞는 것만 허용한다', () => {
    const readOnly = { mask: [] };
    expect(isAllowedCall(readOnly, 'api', 'GET', '/x')).toBe(true);
    expect(isAllowedCall(readOnly, 'api', 'POST', '/x')).toBe(false);

    const policy = { mask: [], allow: [{ callers: ['api', 'studio'], methods: ['GET'], paths: ['/api/users/*'] }, { callers: ['worker'], methods: ['POST'] }] };
    expect(isAllowedCall(policy, 'api', 'GET', '/api/users/7')).toBe(true);
    expect(isAllowedCall(policy, 'web', 'GET', '/api/users/7')).toBe(false);
    expect(isAllowedCall(policy, 'api', 'DELETE', '/api/users/7')).toBe(false);
    expect(isAllowedCall(policy, 'api', 'GET', '/api/admin')).toBe(false);
    expect(isAllowedCall(policy, 'worker', 'POST', '/any/path')).toBe(true);
  });

  it('필드 이름으로 어느 깊이든 값을 가리고 개수를 센다', () => {
    const { value, masked } = maskJson(
      { id: 1, Phone: '010-1234-5678', owner: { email: 'kim@example.com', address: { street: 'x' } }, users: [{ phone: '010' }, { phone: null }] },
      ['phone', 'email', 'address'],
    );
    expect(value).toEqual({ id: 1, Phone: '[가림]', owner: { email: '[가림]', address: '[가림]' }, users: [{ phone: '[가림]' }, { phone: null }] });
    expect(masked).toBe(4);
  });

  it('등록한 주소의 경로 뒤에 요청 경로와 쿼리를 붙인다', () => {
    expect(upstreamUrl(new URL('https://users.internal.example.com/users-api/'), '/api/users/1', '?expand=orders').toString()).toBe(
      'https://users.internal.example.com/users-api/api/users/1?expand=orders',
    );
  });

  it('설정을 읽고 요청 IP로 호출한 서비스를 찾는다', async () => {
    expect(parseExternals('[{"name":"legacy-users","baseUrl":"https://u.example.com","policy":{"mask":["Phone"]}}]')[0]).toMatchObject({
      name: 'legacy-users',
      policy: { mask: ['phone'] },
    });
    const addresses: Record<string, string[]> = { api: ['172.30.0.5'], web: ['172.30.0.6'] };
    const resolve = callerResolver(['api', 'web'], async (name) => (addresses[name] ?? []).map((address) => ({ address })));
    expect(await resolve('::ffff:172.30.0.6')).toBe('web');
    expect(await resolve('172.30.0.99')).toBeUndefined();
  });
});

describe('startApiProxy', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  }

  /** fetch는 Host 헤더를 바꿀 수 없으므로 http.request로 등록한 이름을 Host에 넣는다 */
  function call(port: number, host: string, method: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method, path, headers: { host, authorization: 'Bearer from-sandbox' } }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end();
    });
  }

  async function setup(caller: string | undefined) {
    const received: Array<{ path: string; authorization?: string }> = [];
    const upstream = http.createServer((request, response) => {
      received.push({ path: request.url ?? '', authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 1, name: 'kim', phone: '010-1234-5678', echoedAuth: request.headers.authorization }));
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const audits: ApiAuditEntry[] = [];
    const external = normalizeExternal({
      name: 'legacy-users',
      baseUrl: `http://127.0.0.1:${upstreamPort}/users-api`,
      policy: {
        allow: [{ callers: ['api'], methods: ['GET'], paths: ['/api/users/*'] }],
        mask: ['phone'],
        auth: { header: 'Authorization', secret: 'LEGACY_USERS_TOKEN', prefix: 'Bearer ' },
      },
    });
    const proxy = startApiProxy({
      externals: [external],
      secrets: { LEGACY_USERS_TOKEN: 'tok_live_1234567890' },
      resolveCaller: async () => caller,
      port: 0,
      host: '127.0.0.1',
      log: (entry) => audits.push(entry),
    });
    servers.push(proxy);
    await new Promise((resolve) => proxy.once('listening', resolve));
    return { port: (proxy.address() as net.AddressInfo).port, received, audits };
  }

  it('허용한 호출에 인증 헤더를 붙이고, 응답의 개인정보와 되돌아온 인증 값을 가린다', async () => {
    const { port, received, audits } = await setup('api');

    const response = await call(port, 'legacy-users', 'GET', '/api/users/1');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 1, name: 'kim', phone: '[가림]', echoedAuth: 'Bearer [LEGACY_USERS_TOKEN 가림]' });
    expect(received).toEqual([{ path: '/users-api/api/users/1', authorization: 'Bearer tok_live_1234567890' }]);
    expect(audits).toEqual([expect.objectContaining({ caller: 'api', target: 'legacy-users', method: 'GET', path: '/api/users/1', decision: 'allow', status: 200, masked: 1 })]);
  });

  it('허용하지 않은 메서드·경로, 모르는 호출자, 등록하지 않은 이름은 사내 API로 보내지 않는다', async () => {
    const denied = await setup('api');
    expect((await call(denied.port, 'legacy-users', 'DELETE', '/api/users/1')).status).toBe(403);
    expect((await call(denied.port, 'legacy-users', 'GET', '/api/admin/users')).status).toBe(403);
    expect((await call(denied.port, 'legacy-users', 'GET', '/api/users/../admin/users')).status).toBe(403);
    expect((await call(denied.port, 'billing', 'GET', '/api/users/1')).status).toBe(404);
    expect(denied.received).toEqual([]);
    expect(denied.audits.map((entry) => entry.decision)).toEqual(['deny', 'deny', 'deny', 'deny']);

    const unknown = await setup(undefined);
    const response = await call(unknown.port, 'legacy-users', 'GET', '/api/users/1');
    expect(response.status).toBe(403);
    expect(response.body).toContain('요청한 서비스를 알 수 없습니다');
    expect(unknown.received).toEqual([]);
  });
});

describe('startEdge', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  }

  it('공개 포트로 들어온 연결을 서비스로 넘긴다', async () => {
    const service = http.createServer((_, response) => response.end('hello from web'));
    servers.push(service);
    const servicePort = await listen(service);
    const listenPort = 30_000 + Math.floor(Math.random() * 20_000);
    servers.push(...startEdge({ forwards: [{ listen: listenPort, host: '127.0.0.1', port: servicePort }], rules: [], proxyPort: listenPort + 1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const body = await fetch(`http://127.0.0.1:${listenPort}/`).then((response) => response.text());
    expect(body).toBe('hello from web');
  });

  it('허용 목록에 없는 CONNECT와 사설 주소로 풀리는 이름은 403으로 막는다', async () => {
    const proxyPort = 30_000 + Math.floor(Math.random() * 20_000);
    servers.push(...startEdge({ forwards: [], rules: ['localhost'], proxyPort }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const connect = (target: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.once('data', (data) => {
          resolve(data.toString().split('\r\n')[0]!);
          socket.destroy();
        });
      });

    expect(await connect('db.internal.example:5432')).toBe('HTTP/1.1 403 Forbidden');
    // localhost는 목록에 있어도 루프백 주소로 풀리므로 막는다
    expect(await connect('localhost:443')).toBe('HTTP/1.1 403 Forbidden');
  });
});

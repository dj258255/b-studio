import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error 컨테이너에서 그대로 실행하는 의존성 없는 스크립트라 타입 선언이 없다
import { isAllowedHost, isPrivateAddress, parseAllow, parseForwards, splitHostPort, startEdge } from './edge.mjs';

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

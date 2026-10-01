import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { injectLocationScript, pipeMaybeInjected, shouldInject } from './preview-inject';

describe('injectLocationScript', () => {
  it('</head> 앞에 심는다', () => {
    const html = injectLocationScript('<html><head><title>t</title></head><body>hi</body></html>');
    expect(html).toContain('<script>');
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('b-studio:location');
  });

  it('head가 없으면 <body> 바로 뒤에 심는다', () => {
    const html = injectLocationScript('<html><body class="x">hi</body></html>');
    const bodyOpenEnd = html.indexOf('<body class="x">') + '<body class="x">'.length;
    expect(html.indexOf('<script>')).toBe(bodyOpenEnd);
  });

  it('head·body 여는 태그가 둘 다 없으면 </body> 앞에 심는다', () => {
    const html = injectLocationScript('hi</body>');
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</body>'));
  });

  it('아무 표식도 없으면 맨 끝에 붙인다', () => {
    const html = injectLocationScript('<div>fragment</div>');
    expect(html.endsWith('</script>')).toBe(true);
    expect(html.startsWith('<div>fragment</div>')).toBe(true);
  });

  it('대소문자와 속성이 섞여도 </HEAD>를 찾는다', () => {
    const html = injectLocationScript('<HEAD></HEAD ><body>hi</body>');
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</HEAD'));
  });
});

describe('shouldInject', () => {
  it('text/html만 통과시킨다', () => {
    expect(shouldInject(200, { 'content-type': 'text/html; charset=utf-8' })).toBe(true);
    expect(shouldInject(200, { 'content-type': 'application/json' })).toBe(false);
    expect(shouldInject(200, {})).toBe(false);
  });

  it('304는 몸이 없으므로 건드리지 않는다', () => {
    expect(shouldInject(304, { 'content-type': 'text/html' })).toBe(false);
  });

  it('CSP가 있으면 인라인 스크립트를 막을 수 있어 건드리지 않는다', () => {
    expect(shouldInject(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" })).toBe(false);
  });

  it('gzip·deflate·br·identity는 통과시키고, 모르는 인코딩은 건드리지 않는다', () => {
    for (const encoding of ['gzip', 'deflate', 'br', 'identity']) {
      expect(shouldInject(200, { 'content-type': 'text/html', 'content-encoding': encoding })).toBe(true);
    }
    expect(shouldInject(200, { 'content-type': 'text/html', 'content-encoding': 'x-custom' })).toBe(false);
  });
});

// pipeMaybeInjected는 실제 http 소켓을 거쳐야 ServerResponse의 헤더·종료 처리를 있는 그대로 검증할 수 있다.
// 그래서 진짜 업스트림 서버와, 그걸 pipeMaybeInjected로 중계하는 작은 서버를 띄워 실제 요청으로 확인한다
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** upstream이 내보내는 그대로를 pipeMaybeInjected로 돌려주는 중계 서버 */
async function proxyFor(upstreamPort: number): Promise<number> {
  const server = http.createServer((request, response) => {
    const proxied = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url }, (upstreamResponse) => {
      pipeMaybeInjected(upstreamResponse, response, { ...upstreamResponse.headers });
    });
    request.pipe(proxied);
  });
  return listen(server);
}

describe('pipeMaybeInjected', () => {
  it('HTML이면 스크립트를 심고, 원래(바뀌기 전) 길이의 content-length는 남기지 않는다', async () => {
    const html = '<html><head></head><body>hi</body></html>';
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(html)) });
        response.end(html);
      }),
    );
    const proxyPort = await proxyFor(upstreamPort);
    const result = await get(proxyPort);
    expect(result.status).toBe(200);
    // 몸이 길어졌으니 원래 길이 그대로의 content-length가 남아 있으면 브라우저가 스크립트 뒤를 잘라 읽는다
    expect(result.headers['content-length']).not.toBe(String(Buffer.byteLength(html)));
    expect(result.body.toString('utf8')).toContain('b-studio:location');
  });

  it('JSON이면 바이트 그대로 돌려준다(건드리지 않는다)', async () => {
    const body = Buffer.from(JSON.stringify({ ok: true, list: [1, 2, 3] }));
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      }),
    );
    const proxyPort = await proxyFor(upstreamPort);
    const result = await get(proxyPort);
    expect(result.body.equals(body)).toBe(true);
  });

  it('gzip HTML은 풀어서 스크립트를 심고, content-encoding을 지운다', async () => {
    const raw = '<html><head></head><body>hi</body></html>';
    const gz = zlib.gzipSync(raw);
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end(gz);
      }),
    );
    const proxyPort = await proxyFor(upstreamPort);
    const result = await get(proxyPort);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.body.toString('utf8')).toContain('b-studio:location');
  });

  it('손상된 압축 데이터는 풀지 못하면 원문 그대로(스크립트 없이) 돌려준다', async () => {
    const corrupted = Buffer.from('not actually gzip');
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end(corrupted);
      }),
    );
    const proxyPort = await proxyFor(upstreamPort);
    const result = await get(proxyPort);
    expect(result.body.equals(corrupted)).toBe(true);
    expect(result.headers['content-encoding']).toBe('gzip');
  });

  it('304는 몸이 없으니 그대로 지나간다', async () => {
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        response.writeHead(304, { 'content-type': 'text/html' });
        response.end();
      }),
    );
    const proxyPort = await proxyFor(upstreamPort);
    const result = await get(proxyPort);
    expect(result.status).toBe(304);
    expect(result.body.length).toBe(0);
  });
});

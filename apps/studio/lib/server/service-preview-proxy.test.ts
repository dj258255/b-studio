import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServicePreviewProxies, ensureServicePreviewProxy } from './service-preview-proxy';

const upstreams: http.Server[] = [];
afterEach(async () => {
  await Promise.all([...upstreams.splice(0)].map((server) => new Promise((resolve) => server.close(resolve))));
});

async function fakeService(reply: string): Promise<number> {
  const server = http.createServer((_request, response) => response.end(reply));
  upstreams.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/' }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

describe('ensureServicePreviewProxy / closeServicePreviewProxies', () => {
  it('같은 세션·서비스로 다시 부르면 같은 프록시(포트)를 돌려주고, 가리키는 주소만 갱신한다', async () => {
    const portA = await fakeService('A');
    const portB = await fakeService('B');
    try {
      const first = await ensureServicePreviewProxy('s1', 'web', `http://127.0.0.1:${portA}`);
      expect(await get(Number(new URL(first).port))).toBe('A');

      const second = await ensureServicePreviewProxy('s1', 'web', `http://127.0.0.1:${portB}`);
      expect(second).toBe(first); // 포트가 바뀌지 않았다 — 프록시를 새로 띄우지 않았다
      expect(await get(Number(new URL(second).port))).toBe('B'); // 그런데 가리키는 주소는 바뀌었다
    } finally {
      await closeServicePreviewProxies('s1');
    }
  });

  it('세션이 다르면 서로 다른 프록시를 쓴다', async () => {
    const portA = await fakeService('A');
    try {
      const forS1 = await ensureServicePreviewProxy('s1', 'web', `http://127.0.0.1:${portA}`);
      const forS2 = await ensureServicePreviewProxy('s2', 'web', `http://127.0.0.1:${portA}`);
      expect(forS1).not.toBe(forS2);
    } finally {
      await closeServicePreviewProxies('s1');
      await closeServicePreviewProxies('s2');
    }
  });

  it('닫은 뒤에는 그 포트가 더 이상 응답하지 않는다', async () => {
    const portA = await fakeService('A');
    const proxyUrl = await ensureServicePreviewProxy('s3', 'web', `http://127.0.0.1:${portA}`);
    await closeServicePreviewProxies('s3');
    await expect(get(Number(new URL(proxyUrl).port))).rejects.toBeTruthy();
  });
});

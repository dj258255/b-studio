import http, { type Server } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { pipeMaybeInjected } from './preview-inject';
import { upstreamHeaders } from './preview-gateway';

/**
 * 세션 서비스 하나를 studio 서버의 루프백 포트로 그대로 비춰 주는 로컬 프록시(ADR-113).
 * preview-gateway.ts(원격 미리보기, 호스트 이름으로 여러 서비스를 가리키는 다중 세입자 게이트웨이)와 달리
 * 이 프록시는 "포트 하나 = 서비스 하나"라 호스트 기반 분기가 필요 없다 — 그래서 더 작은 서버를 새로 둔다.
 * 다만 헤더를 루프백 같은 출처로 보이게 바꾸는 규칙(upstreamHeaders)은 게이트웨이의 것을 그대로 쓴다
 */
export interface PreviewProxyOptions {
  /** 지금 가리키는 서비스 주소(예: http://127.0.0.1:33048). 세션이 재시작해 포트가 바뀌면 다음 요청부터 바로 반영된다 */
  resolve(): Promise<string | undefined> | string | undefined;
}

export function createPreviewProxy({ resolve }: PreviewProxyOptions): Server {
  const server = http.createServer((request, response) => {
    void (async () => {
      const base = await resolve();
      if (!base) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('서비스 주소를 찾지 못했습니다. 서비스가 다시 뜨는 중일 수 있습니다.');
        return;
      }
      const upstream = new URL(base);
      const proxied = http.request(
        { hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: upstreamHeaders(request.headers, upstream, request.headers.host) },
        (upstreamResponse) => pipeMaybeInjected(upstreamResponse, response, { ...upstreamResponse.headers }),
      );
      proxied.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('서비스에 연결하지 못했습니다. 서비스가 다시 뜨는 중일 수 있습니다.');
      });
      request.pipe(proxied);
    })();
  });

  // HMR 같은 웹소켓은 업그레이드 요청을 그대로 넘기고 양쪽 소켓을 잇는다(preview-gateway.ts와 같은 방식)
  server.on('upgrade', (request, socket: Duplex, head: Buffer) => {
    void (async () => {
      const base = await resolve();
      if (!base) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        return;
      }
      const upstream = new URL(base);
      const connection = net.connect(Number(upstream.port), upstream.hostname, () => {
        const headers = upstreamHeaders(request.headers, upstream, request.headers.host);
        const lines = Object.entries(headers).flatMap(([name, value]) =>
          value === undefined ? [] : Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`],
        );
        connection.write([`${request.method} ${request.url} HTTP/${request.httpVersion}`, ...lines, '', ''].join('\r\n'));
        if (head.length > 0) connection.write(head);
        connection.pipe(socket);
        socket.pipe(connection);
      });
      // 반쯤 열린 연결이 남아 서버를 못 닫는 일이 없게, 어느 쪽이든 끝나면 양쪽을 모두 닫는다
      const close = () => {
        connection.destroy();
        socket.destroy();
      };
      for (const side of [connection, socket]) {
        side.on('end', close);
        side.on('close', close);
        side.on('error', close);
      }
    })();
  });

  return server;
}

import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * 원격 미리보기 게이트웨이.
 * 샌드박스 서비스 포트는 루프백에만 열려 있어(ADR-009) 다른 PC의 브라우저가 직접 열 수 없다.
 * 스튜디오 서버가 `<서비스>--<세션>--<토큰>.<미리보기 도메인>` 호스트로 받은 요청을 경로 그대로 서비스에 넘긴다.
 * 경로에 접두사를 붙이지 않으므로 `/_next/...` 같은 절대 경로 자원과 HMR 웹소켓이 그대로 동작한다
 */
export interface PreviewTarget {
  service: string;
  sessionId: string;
  token: string;
}

/** 서비스 주소(예: http://127.0.0.1:33048)를 돌려준다. 세션·토큰이 맞지 않으면 undefined */
export type PreviewResolver = (target: PreviewTarget) => Promise<string | undefined>;

const LABEL = /^([a-z][a-z0-9-]*?)--([0-9a-f]{8})--([0-9a-f]{32})$/;

export function previewHost(target: PreviewTarget, domain: string): string {
  return `${target.service}--${target.sessionId}--${target.token}.${domain}`;
}

/** Host 헤더에서 미리보기 대상을 읽는다. 도메인이 다르거나 형식이 맞지 않으면 undefined */
export function parsePreviewHost(host: string | undefined, domain: string): PreviewTarget | undefined {
  if (!host) return undefined;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return undefined;
  const match = LABEL.exec(name.slice(0, -suffix.length));
  if (!match) return undefined;
  return { service: match[1]!, sessionId: match[2]!, token: match[3]! };
}

/**
 * 샌드박스 앱이 보기에 루프백 주소에서 온 같은 출처 요청이 되도록 Host, Origin, Referer를 바꾼다.
 * Next dev 서버는 허용하지 않은 출처의 개발용 요청(HMR)을 막는데, 템플릿은 127.0.0.1만 허용한다
 */
export function upstreamHeaders(headers: IncomingHttpHeaders, upstream: URL, publicHost: string | undefined): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = { ...headers, host: upstream.host };
  if (headers.origin) result.origin = upstream.origin;
  if (typeof headers.referer === 'string') {
    try {
      const referer = new URL(headers.referer);
      result.referer = `${upstream.origin}${referer.pathname}${referer.search}`;
    } catch {
      delete result.referer;
    }
  }
  if (publicHost) result['x-forwarded-host'] = publicHost;
  return result;
}

/** 서비스가 자기 주소로 리다이렉트하면 브라우저가 미리보기 주소에 머물도록 바꾼다 */
export function rewriteLocation(location: string, upstream: URL, publicOrigin: string): string {
  try {
    const target = new URL(location, upstream);
    return target.origin === upstream.origin ? `${publicOrigin}${target.pathname}${target.search}${target.hash}` : location;
  } catch {
    return location;
  }
}

export function createPreviewGateway({ domain, resolve }: { domain: string; resolve: PreviewResolver }): Server {
  const locate = async (request: IncomingMessage): Promise<URL | undefined> => {
    const target = parsePreviewHost(request.headers.host, domain);
    const base = target ? await resolve(target).catch(() => undefined) : undefined;
    return base ? new URL(base) : undefined;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const upstream = await locate(request);
      if (!upstream) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('미리보기를 찾을 수 없습니다. 세션이 중지됐거나 주소가 올바르지 않습니다.');
        return;
      }
      const publicOrigin = `http://${request.headers.host}`;
      const proxied = http.request(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          method: request.method,
          path: request.url,
          headers: upstreamHeaders(request.headers, upstream, request.headers.host),
        },
        (upstreamResponse) => {
          const headers = { ...upstreamResponse.headers };
          if (typeof headers.location === 'string') headers.location = rewriteLocation(headers.location, upstream, publicOrigin);
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
        },
      );
      proxied.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('서비스에 연결하지 못했습니다. 서비스가 다시 뜨는 중일 수 있습니다.');
      });
      request.pipe(proxied);
    })();
  });

  // HMR 같은 웹소켓은 업그레이드 요청을 그대로 넘기고 양쪽 소켓을 잇는다
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const upstream = await locate(request);
      if (!upstream) {
        socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        return;
      }
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
      // 웹소켓은 한쪽만 닫는 쓰임이 없다. HTTP 서버 소켓은 반쯤 열린 연결을 허용하므로 끝(end)만 오고 close가 오지 않을 수 있어,
      // 어느 쪽이든 끝나면 양쪽을 모두 닫는다. 그대로 두면 소켓이 남아 서버를 닫지 못한다
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

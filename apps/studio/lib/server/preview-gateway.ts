import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
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

/**
 * 스튜디오 인증을 켰을 때의 미리보기 접근 확인.
 * 스튜디오가 로그인한 사람에게 1회용 티켓을 주고, 게이트웨이는 티켓을 그 호스트 전용 쿠키로 바꾼다.
 * 호스트 이름의 토큰만 알아서는 미리보기를 볼 수 없다
 */
export interface PreviewAccess {
  cookieName: string;
  /** 티켓이 맞으면 미리보기 호스트에 줄 쿠키 값과 유지 시간 */
  redeem(host: string, ticket: string): { cookie: string; maxAgeSeconds: number } | undefined;
  allows(host: string, cookie: string | undefined): boolean;
}

/** 게이트웨이가 서비스 대신 답하는 경로. 서비스의 경로와 겹치지 않게 접두사를 둔다 */
export const ACCESS_PATH = '/__b-studio/preview-access';

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

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0 && part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return undefined;
}

export function withoutCookie(header: string, name: string): string {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const equals = part.indexOf('=');
      return part && (equals < 0 ? part : part.slice(0, equals).trim()) !== name;
    })
    .join('; ');
}

/** 티켓을 바꾼 뒤 돌아갈 경로. 같은 호스트의 경로만 받는다 */
export function safePreviewPath(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

/**
 * 샌드박스 앱이 보기에 루프백 주소에서 온 같은 출처 요청이 되도록 Host, Origin, Referer를 바꾼다.
 * Next dev 서버는 허용하지 않은 출처의 개발용 요청(HMR)을 막는데, 템플릿은 127.0.0.1만 허용한다.
 * 게이트웨이의 접근 쿠키는 샌드박스 앱이 볼 필요가 없으므로 넘기지 않는다
 */
export function upstreamHeaders(headers: IncomingHttpHeaders, upstream: URL, publicHost: string | undefined, stripCookie?: string): OutgoingHttpHeaders {
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
  if (stripCookie && typeof headers.cookie === 'string') {
    const rest = withoutCookie(headers.cookie, stripCookie);
    if (rest) result.cookie = rest;
    else delete result.cookie;
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

/** 접근 확인을 통과하면 true. 티켓 교환과 거부는 여기서 응답을 끝낸다 */
function admit(request: IncomingMessage, response: ServerResponse, host: string, access: PreviewAccess): boolean {
  const url = new URL(request.url ?? '/', 'http://preview.invalid');
  if (url.pathname === ACCESS_PATH) {
    const granted = access.redeem(host, url.searchParams.get('ticket') ?? '');
    if (!granted) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('미리보기 티켓이 맞지 않거나 이미 썼거나 만료됐습니다. 스튜디오에서 미리보기를 다시 여세요.');
      return false;
    }
    const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    response.writeHead(302, {
      location: safePreviewPath(url.searchParams.get('next')),
      'set-cookie': `${access.cookieName}=${granted.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${granted.maxAgeSeconds}${secure}`,
      'cache-control': 'no-store',
    });
    response.end();
    return false;
  }
  if (access.allows(host, readCookie(request.headers.cookie, access.cookieName))) return true;
  response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('미리보기를 볼 권한을 확인하지 못했습니다. 스튜디오에서 미리보기를 다시 여세요.');
  return false;
}

export function createPreviewGateway({ domain, resolve, access }: { domain: string; resolve: PreviewResolver; access?: PreviewAccess }): Server {
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
      const host = request.headers.host ?? '';
      if (access && !admit(request, response, host, access)) return;
      const publicOrigin = `http://${host}`;
      const proxied = http.request(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          method: request.method,
          path: request.url,
          headers: upstreamHeaders(request.headers, upstream, host, access?.cookieName),
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
      if (access && !access.allows(request.headers.host ?? '', readCookie(request.headers.cookie, access.cookieName))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        return;
      }
      const connection = net.connect(Number(upstream.port), upstream.hostname, () => {
        const headers = upstreamHeaders(request.headers, upstream, request.headers.host, access?.cookieName);
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

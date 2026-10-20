import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server } from 'node:http';
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

/**
 * studio가 브라우저에 심는 쿠키 이름의 접두사. 쿠키는 포트를 가리지 않아 studio의 쿠키가 이 프록시로도 실린다.
 * 에이전트가 만든 앱(신뢰하지 않는 코드)이 그 쿠키를 받거나 `Set-Cookie`로 덮어쓰지 못하게, 이 접두사로 시작하는
 * 쿠키는 들어오는 것도 나가는 것도 뗀다. 접두사로 거르면 studio 쿠키가 늘어나도 목록을 고칠 필요가 없다(닫힌 쪽)
 */
export const STUDIO_COOKIE_PREFIX = 'b_studio_';

const HOST_MESSAGE = '미리보기는 127.0.0.1 또는 localhost 주소로만 열 수 있습니다.';
const FORBIDDEN_UPGRADE = 'HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n';
const BAD_GATEWAY_UPGRADE = 'HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n';

/** `Set-Cookie` 줄이나 쿠키 한 조각에서 쿠키 이름(첫 `=` 앞, 공백 제거)을 읽는다 */
function cookieName(header: string): string {
  const equals = header.indexOf('=');
  return (equals < 0 ? header : header.slice(0, equals)).trim();
}

/**
 * `Set-Cookie` 값이 studio 쿠키를 심는가. 이름이 빈 쿠키(`=b_studio_local=x`)는 브라우저가 요청 때 값만 보내
 * `Cookie: b_studio_local=x`로 도착하므로, 그 값을 다시 이름처럼 읽어 판정한다. `=`가 아예 없는 값(`b_studio_local`)도
 * 이름 없는 쿠키라 값이 그대로 이름이 된다
 */
function studioCookie(setCookie: string): boolean {
  const pair = setCookie.split(';')[0] ?? '';
  const equals = pair.indexOf('=');
  const name = equals < 0 ? pair : pair.slice(0, equals);
  const effective = name.trim() === '' && equals >= 0 ? pair.slice(equals + 1) : name;
  return cookieName(effective).startsWith(STUDIO_COOKIE_PREFIX);
}

/** 업스트림으로 보내는 `cookie` 헤더에서 studio 쿠키(접두사로 시작)를 모두 뗀다. 남는 게 없으면 undefined */
export function withoutStudioCookies(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !cookieName(part).startsWith(STUDIO_COOKIE_PREFIX));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** 나가는 응답 헤더에서 studio 쿠키를 버린다. 남는 게 없으면 헤더를 지운다 */
export function dropStudioSetCookies(headers: { 'set-cookie'?: string[] }): void {
  const value = headers['set-cookie'];
  if (!Array.isArray(value)) return;
  const kept = value.filter((entry) => !studioCookie(entry));
  if (kept.length > 0) headers['set-cookie'] = kept;
  else delete headers['set-cookie'];
}

/**
 * 업그레이드 경로에서 업스트림 응답 머리를 브라우저에 다시 쓴다. Node의 HTTP 파서가 읽은 `rawHeaders`를 그대로 쓰되,
 * 값에 줄바꿈이 있는 헤더는 버리고 studio 쿠키를 심는 `Set-Cookie`는 뺀다. `reframe`이면 파서가 청크를 푼 몸에
 * 맞춰 `transfer-encoding`·`content-length`·`connection`을 빼고 `connection: close`를 붙인다(끝까지 읽고 닫는다)
 */
function writeResponseHead(socket: Duplex, response: IncomingMessage, reframe = false): void {
  const statusMessage = (response.statusMessage ?? '').replace(/[\r\n]/g, ' ');
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${statusMessage}`.trimEnd()];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!;
    const value = response.rawHeaders[index + 1]!;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    if (reframe && ['transfer-encoding', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'set-cookie' && studioCookie(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  if (reframe) lines.push('connection: close');
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

/** Node의 HTTP 파서가 응답을 읽다 낸 오류인가. 이런 오류에는 업스트림 바이트를 하나도 넘기지 않는다 */
function isHttpParseError(error: Error): boolean {
  return ((error as NodeJS.ErrnoException).code ?? '').startsWith('HPE_');
}

/** 요청 Host가 정확히 이 프록시가 듣는 `127.0.0.1:<포트>` 또는 `localhost:<포트>`(대소문자 무시)인가. 듣기 전에는 모두 거절 */
function hostAllowed(server: Server, host: string | undefined): boolean {
  const address = server.address();
  if (!address || typeof address === 'string') return false;
  const name = (host ?? '').trim().toLowerCase();
  return name === `127.0.0.1:${address.port}` || name === `localhost:${address.port}`;
}

/** 루프백 같은 출처로 보이게 헤더를 바꾸고, studio 쿠키는 업스트림에 넘기지 않는다(HTTP·업그레이드 공통) */
function proxiedHeaders(headers: IncomingHttpHeaders, upstream: URL, publicHost: string | undefined): OutgoingHttpHeaders {
  const result = upstreamHeaders(headers, upstream, publicHost);
  const cookie = withoutStudioCookies(typeof result.cookie === 'string' ? result.cookie : undefined);
  if (cookie !== undefined) result.cookie = cookie;
  else delete result.cookie;
  return result;
}

export function createPreviewProxy({ resolve }: PreviewProxyOptions): Server {
  // Host 없는 요청도 우리 허용 목록이 403으로 거절하게, Node의 내장 400(requireHostHeader)을 끈다
  const server = http.createServer({ requireHostHeader: false }, (request, response) => {
    void (async () => {
      if (!hostAllowed(server, request.headers.host)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(HOST_MESSAGE);
        return;
      }
      const base = await resolve();
      if (!base) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('서비스 주소를 찾지 못했습니다. 서비스가 다시 뜨는 중일 수 있습니다.');
        return;
      }
      const upstream = new URL(base);
      const proxied = http.request(
        { hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: proxiedHeaders(request.headers, upstream, request.headers.host) },
        (upstreamResponse) => {
          const headers = { ...upstreamResponse.headers };
          dropStudioSetCookies(headers);
          pipeMaybeInjected(upstreamResponse, response, headers);
        },
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
      if (!hostAllowed(server, request.headers.host)) {
        socket.end(FORBIDDEN_UPGRADE);
        return;
      }
      const base = await resolve();
      if (!base) {
        socket.end(BAD_GATEWAY_UPGRADE);
        return;
      }
      const upstream = new URL(base);
      // 응답 머리는 손으로 나누지 않고 Node의 HTTP 파서가 읽게 한다. 파서가 거부한 응답은 브라우저에 넘기지 않는다
      const proxied = http.request({
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: proxiedHeaders(request.headers, upstream, request.headers.host),
      });
      let headSent = false;
      // 반쯤 열린 연결이 남아 서버를 못 닫는 일이 없게, 어느 쪽이든 끝나면 양쪽을 모두 닫는다
      const close = () => {
        proxied.destroy();
        socket.destroy();
      };
      for (const event of ['end', 'close', 'error'] as const) {
        socket.on(event, close);
        proxied.on('socket', (upstreamSocket) => upstreamSocket.on(event, close));
      }
      proxied.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        headSent = true;
        writeResponseHead(socket, response);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });
      proxied.on('response', (response) => {
        headSent = true;
        writeResponseHead(socket, response, true);
        response.on('error', close);
        response.on('end', () => socket.end());
        response.pipe(socket);
      });
      proxied.on('error', (error) => {
        // 파서가 거부한 응답은 브라우저에 아무 바이트도 넘기지 않는다
        if (headSent || isHttpParseError(error)) {
          close();
          return;
        }
        socket.end(BAD_GATEWAY_UPGRADE);
      });
      proxied.end(head.length > 0 ? head : undefined);
    })();
  });

  return server;
}

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';

/**
 * 허용 출처 밖으로 나가는 요청을 네트워크 층에서 막는 로컬 전달 프록시(#1210, ADR-198).
 *
 * 화면 확인 브라우저(Chromium)를 이 프록시 뒤에서 띄운다. 리다이렉트의 둘째 홉, 서비스 워커·워커, 미리 연결은 Playwright의
 * `page.route`를 거치지 않지만 브라우저의 모든 네트워크는 프록시를 지난다. 그래서 "무엇에 접속하는가"를 한 자리에서 판정한다.
 *
 * 판정은 부르는 쪽이 준 `isAllowed(url)` 하나다(라우트와 같은 함수). 프록시는 **판정한 URL의 host:port로만** 접속한다.
 * 같은 문자열을 한 번만 파싱해 판정과 접속에 함께 쓰고, Host 머리로 다른 곳에 가지 않는다.
 * 모르는 요청(origin-form, 알 수 없는 메서드, 파싱 실패, Host 불일치, Upgrade)은 모두 막는다(막는 쪽으로 틀린다).
 *
 * 서비스 워커 스크립트 요청은 허용 출처라도 막는다. 화면 확인은 서비스 워커를 쓰지 않는다는 전제인데(`serviceWorkers: 'block'`),
 * 그 설정은 `register`를 바꿔치는 init 스크립트뿐이라 우회할 수 있고, Playwright는 막힌 설정에서 서비스 워커에 붙지 않아
 * 그 요청을 보지 못한다. 브라우저는 서비스 워커 스크립트를 받을 때 `Service-Worker: script` 머리와 `Sec-Fetch-Dest: serviceworker`를
 * 붙이므로(Service Workers 명세, Fetch Metadata) 그 요청을 막으면 우회 등록도 설치되지 못한다.
 *
 * 막을 때는 업스트림에 접속하지 않고 클라이언트 연결을 끊는다. 상태 코드 응답을 주지 않는 이유: 403 같은 응답을 주면 문서 이동이
 * 응답으로 끝나(상태 코드만 다른 화면) 상태 코드를 따지지 않는 확인이 통과할 수 있다. 연결을 끊으면 브라우저는 요청이 실패한 것으로
 * 본다(`net::ERR_EMPTY_RESPONSE`, 문서 이동이면 이동이 오류로 끝난다. 기존 `blockedbyclient`와 같은 결과다).
 */

/**
 * 막은 것의 종류. `url`·`tunnel`은 허용 출처 밖이거나 모르는 모양이라 막은 것이고, `serviceWorker`는 허용 출처 안이라도
 * 서비스 워커 스크립트라 막은 것이다. `serviceWorker`의 URL은 허용 출처 안의 주소일 수 있으므로, 부르는 쪽은 이것을
 * "경계 밖이라 막은 요청"(실패 기록에서 빼는 목록)과 섞으면 안 된다. 섞으면 같은 주소의 진짜 요청 실패가 가려진다
 */
export type OriginProxyBlock =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'tunnel'; readonly hostPort: string }
  | { readonly kind: 'serviceWorker'; readonly url: string };

export interface OriginProxy {
  /** 브라우저의 `--proxy-server`에 넘길 주소(`http://127.0.0.1:포트`) */
  readonly server: string;
  /** 서버와 열려 있는 모든 연결(클라이언트·업스트림)을 닫는다 */
  close(): Promise<void>;
}

export interface OriginProxyOptions {
  /** 절대 형식 URL의 허용 여부. 라우트와 같은 판정(`isAllowedRequest`)을 넘긴다 */
  isAllowed: (url: string) => boolean;
  /** 막은 요청을 알린다. 연결을 끊기 전에 동기로 부른다(`runInBrowser`가 실패 기록보다 먼저 막은 것으로 알게 하려고) */
  onBlocked: (block: OriginProxyBlock) => void;
}

const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** 한 연결 구간에서만 뜻이 있는 머리. 전달하지 않는다(RFC 9110 7.6.1) */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

/** `host:port` 꼴의 CONNECT 대상. 사용자 정보·경로·공백이 낄 수 없는 문자만 받는다 */
const AUTHORITY = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/;

function filterHeaders(rawHeaders: readonly string[]): string[] {
  // Connection 머리가 이름을 댄 머리도 한 구간용이다
  const named = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === 'connection') for (const token of rawHeaders[index + 1]!.split(',')) named.add(token.trim().toLowerCase());
  }
  const kept: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    kept.push(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return kept;
}

/** `[::1]` → `::1`. 소켓 접속에는 괄호가 없는 주소를 준다 */
const socketHost = (hostname: string) => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname);

export async function startOriginProxy({ isAllowed, onBlocked }: OriginProxyOptions): Promise<OriginProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server: Server = createServer();
  server.on('connection', (socket) => {
    track(socket);
    // 클라이언트가 먼저 끊거나 오류가 나도 프로세스가 죽지 않게 한다. 요청 쪽 오류는 각 처리기가 응답·로그로 다룬다
    socket.on('error', () => socket.destroy());
  });

  const blockUrl = (url: string, socket: Socket) => {
    onBlocked({ kind: 'url', url });
    socket.destroy();
  };

  server.on('request', (clientRequest: IncomingMessage, clientResponse: ServerResponse) => {
    const target = clientRequest.url ?? '';
    const method = clientRequest.method ?? '';
    // 판정과 접속이 같은 파싱 결과를 쓰도록 여기서 한 번만 파싱한다
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      // origin-form(`GET /path`)이나 깨진 대상: 어디로 가는지 알 수 없으므로 막는다
      blockUrl(target, clientRequest.socket);
      return;
    }
    // 서비스 워커 스크립트(위 설명)는 허용 출처라도 막는다. 둘 중 하나만 있어도 막고, 다른 막기와 구분해 알린다
    if (clientRequest.headers['service-worker'] !== undefined || clientRequest.headers['sec-fetch-dest']?.toLowerCase() === 'serviceworker') {
      onBlocked({ kind: 'serviceWorker', url: target });
      clientRequest.socket.destroy();
      return;
    }
    const hostHeader = clientRequest.headers.host;
    const hostHeaders = clientRequest.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host');
    if (
      parsed.protocol !== 'http:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !FORWARDED_METHODS.has(method) ||
      clientRequest.headers.upgrade !== undefined ||
      // 절대 형식 URL과 Host 머리가 다르면 어느 쪽이 진짜 목적지인지 알 수 없다
      hostHeaders.length !== 1 ||
      hostHeader?.toLowerCase() !== parsed.host ||
      !isAllowed(target)
    ) {
      blockUrl(target, clientRequest.socket);
      return;
    }
    const upstream = httpRequest({
      host: socketHost(parsed.hostname),
      port: parsed.port === '' ? 80 : Number(parsed.port),
      method,
      path: `${parsed.pathname}${parsed.search}`,
      headers: filterHeaders(clientRequest.rawHeaders),
      agent: false,
    });
    upstream.on('socket', (socket) => track(socket));
    upstream.on('response', (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, filterHeaders(upstreamResponse.rawHeaders));
      upstreamResponse.pipe(clientResponse);
      upstreamResponse.on('error', () => clientResponse.destroy());
    });
    // 업스트림에 닿지 못한 것은 통과가 아니라 실패다. 응답을 시작하지 못했으면 502, 시작했으면 연결을 끊어 잘린 본문을 알린다
    upstream.on('error', () => {
      if (clientResponse.headersSent) clientResponse.destroy();
      else {
        clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        clientResponse.end('b-studio 출처 제한 프록시: 업스트림에 접속하지 못했습니다');
      }
    });
    clientResponse.on('close', () => {
      if (!clientResponse.writableFinished) upstream.destroy();
    });
    clientRequest.pipe(upstream);
  });

  // 평문 웹소켓을 절대 형식 Upgrade로 보내는 길은 실측에서 쓰이지 않았다(Chromium은 ws·wss 모두 CONNECT). 모르는 길이므로 막는다
  server.on('upgrade', (clientRequest: IncomingMessage, socket: Socket) => blockUrl(clientRequest.url ?? '', socket));

  server.on('connect', (clientRequest: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const authority = clientRequest.url ?? '';
    const match = AUTHORITY.exec(authority);
    const port = match ? Number(match[2]) : 0;
    let host: URL | undefined;
    if (match && port >= 1 && port <= 65_535) {
      try {
        host = new URL(`http://${match[1]}:${port}/`);
      } catch {
        host = undefined;
      }
    }
    // CONNECT는 https와 웹소켓(ws·wss)이 쓴다. 어느 쪽인지 알 수 없으므로, 허용 출처의 같은 host:port(http든 https든)일 때만 터널을 연다.
    // 그 host:port로는 평문 요청도 이미 허용돼 있어 터널이 허용 범위를 넓히지 않는다
    if (!host || !(isAllowed(`http://${host.hostname}:${port}/`) || isAllowed(`https://${host.hostname}:${port}/`))) {
      onBlocked({ kind: 'tunnel', hostPort: authority });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let established = false;
    const upstream = track(netConnect({ host: socketHost(host.hostname), port }));
    upstream.once('connect', () => {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // 연결 전의 실패는 502로, 터널이 선 뒤의 오류는 양쪽을 끊어 알린다. 어느 쪽도 통과로 바뀌지 않는다
    upstream.on('error', () => {
      if (established) clientSocket.destroy();
      else clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.once('close', () => clientSocket.destroy());
    clientSocket.once('close', () => upstream.destroy());
  });

  // 형식이 깨진 요청은 응답하지 않고 끊는다
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

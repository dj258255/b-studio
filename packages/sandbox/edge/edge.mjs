// b-studio edge: 샌드박스 네트워크의 유일한 출입구.
//
// 샌드박스 서비스는 외부로 나갈 수 없는 internal 네트워크에만 붙는다. 이 컨테이너만 두 네트워크에 붙어
//  1. 호스트 루프백에 공개한 포트로 들어온 연결을 서비스로 넘기고 (미리보기, API 탐색기, 준비 확인)
//  2. 서비스가 밖으로 나가는 HTTP(S) 요청을 허용 목록에 있는 호스트로만 통과시킨다 (패키지 저장소 등).
// 컨테이너 안에서 의존성 없이 돌도록 Node 표준 모듈만 쓴다.
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const PROXY_PORT = 3128;
const EGRESS_PORTS = new Set([80, 443]);

/** "20000=web:3000,20001=api:8080" */
export function parseForwards(text = '') {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = /^(\d+)=([a-z0-9][a-z0-9_.-]*):(\d+)$/i.exec(item);
      if (!match) throw new Error(`잘못된 포워딩 설정: ${item}`);
      return { listen: Number(match[1]), host: match[2], port: Number(match[3]) };
    });
}

/** "registry.npmjs.org,*.gradle.org" */
export function parseAllow(text = '') {
  return text
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 허용 목록 판단. `*.example.com`은 하위 도메인만 뜻한다(example.com 자체는 따로 적는다).
 * IP로 직접 접속하는 요청은 이름으로 판단할 수 없으므로 막는다.
 */
export function isAllowedHost(host, port, rules) {
  if (!EGRESS_PORTS.has(port)) return false;
  const name = String(host).toLowerCase().replace(/\.$/, '');
  if (!name || net.isIP(name.replace(/^\[|\]$/g, ''))) return false;
  return rules.some((rule) => (rule.startsWith('*.') ? name.endsWith(rule.slice(1)) && name.length > rule.length - 1 : name === rule));
}

/** 사설·루프백·링크 로컬 주소. 허용한 이름이 사내 주소로 풀리면(DNS 재바인딩 포함) 막는다 */
export function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return true;
}

/** CONNECT 대상 "host:443", "[::1]:443" */
export function splitHostPort(target) {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
  return match ? { host: match[1], port: Number(match[2]) } : undefined;
}

function audit(decision, host, port, reason) {
  // 한 줄 JSON이라 스튜디오 로그와 감사 기록에서 그대로 걸러 쓸 수 있다
  console.log(JSON.stringify({ edge: 'egress', decision, host, port, ...(reason ? { reason } : {}), at: new Date().toISOString() }));
}

/** 허용 목록과 주소 검사를 모두 통과한 IP를 돌려준다 */
async function resolveAllowed(host, port, rules) {
  if (!isAllowedHost(host, port, rules)) return { denied: '허용 목록에 없는 호스트나 포트' };
  const addresses = await dns.lookup(host, { all: true }).catch(() => []);
  // Docker 기본 네트워크에는 IPv6 경로가 없는 경우가 많으므로 IPv4를 먼저 쓴다
  const usable = addresses
    .sort((a, b) => a.family - b.family)
    .map((entry) => entry.address)
    .filter((address) => !isPrivateAddress(address));
  if (usable.length === 0) return { denied: addresses.length === 0 ? '이름을 풀지 못함' : '사설 주소로 풀림' };
  return { address: usable[0] };
}

export function startEdge({ forwards, rules, proxyPort = PROXY_PORT }) {
  const servers = [];

  for (const forward of forwards) {
    const server = net.createServer((client) => {
      const target = net.connect(forward.port, forward.host);
      client.pipe(target).pipe(client);
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });
    server.listen(forward.listen, '0.0.0.0');
    servers.push(server);
  }

  const proxy = http.createServer(async (request, response) => {
    // 평문 HTTP 프록시 요청은 절대 URL로 온다
    let url;
    try {
      url = new URL(request.url ?? '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const resolved = url.protocol === 'http:' ? await resolveAllowed(url.hostname, port, rules) : { denied: 'http 이외의 프로토콜' };
    if ('denied' in resolved) {
      audit('deny', url.hostname, port, resolved.denied);
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(`b-studio: ${url.hostname}:${port} 접속이 허용되지 않았습니다 (${resolved.denied})\n`);
      return;
    }
    audit('allow', url.hostname, port);
    const upstream = http.request(
      { host: resolved.address, servername: url.hostname, port, method: request.method, path: `${url.pathname}${url.search}`, headers: { ...request.headers, host: url.host } },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });

  proxy.on('connect', async (request, socket, head) => {
    socket.on('error', () => {});
    const target = splitHostPort(request.url ?? '');
    const resolved = target ? await resolveAllowed(target.host, target.port, rules) : { denied: '잘못된 CONNECT 대상' };
    if ('denied' in resolved) {
      audit('deny', target?.host ?? request.url, target?.port, resolved.denied);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    audit('allow', target.host, target.port);
    const upstream = net.connect(target.port, resolved.address, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.on('close', () => upstream.destroy());
  });

  proxy.listen(proxyPort, '0.0.0.0');
  servers.push(proxy);
  return servers;
}

// 컨테이너에서는 `node --input-type=module -e <스크립트>`로 실행하므로 EDGE_MAIN으로 시작 여부를 정한다
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (process.env.EDGE_MAIN === '1' || invokedDirectly) {
  const forwards = parseForwards(process.env.EDGE_FORWARDS);
  const rules = parseAllow(process.env.EDGE_ALLOW);
  startEdge({ forwards, rules });
  console.log(JSON.stringify({ edge: 'started', forwards, allow: rules, proxyPort: PROXY_PORT }));
  process.on('SIGTERM', () => process.exit(0));
}

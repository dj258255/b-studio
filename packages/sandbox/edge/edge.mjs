// b-studio edge: 샌드박스 네트워크의 유일한 출입구.
//
// 샌드박스 서비스는 외부로 나갈 수 없는 internal 네트워크에만 붙는다. 이 컨테이너만 두 네트워크에 붙어
//  1. 호스트 루프백에 공개한 포트로 들어온 연결을 서비스로 넘기고 (미리보기, API 탐색기, 준비 확인)
//  2. 서비스가 밖으로 나가는 HTTP(S) 요청을 허용 목록에 있는 호스트로만 통과시키고 (패키지 저장소 등)
//  3. 등록한 사내 API로 가는 요청에 정책(호출자·메서드·경로 허용, 인증 헤더, 응답 가림)을 적용한다.
// 컨테이너 안에서 의존성 없이 돌도록 Node 표준 모듈만 쓴다. 정책 함수는 스튜디오 서버도 같은 파일에서 가져다 쓴다.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
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

/** 샌드박스 서비스가 `http://<등록한 이름>/경로`로 부르는 포트 */
export const API_PORT = 80;
/** 정책에서 샌드박스 서비스가 아닌 호출자 (스튜디오 서버가 에이전트 도구·API 탐색기 요청을 대신 보낸다) */
export const STUDIO_CALLER = 'studio';
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export class ApiPolicyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiPolicyError';
    this.status = status;
  }
}

/** EDGE_EXTERNALS: `[{ "name": "legacy-users", "baseUrl": "https://...", "policy": { "allow"?, "mask", "auth"? } }]` */
export function parseExternals(text = '') {
  if (!text.trim()) return [];
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('EDGE_EXTERNALS는 배열이어야 합니다');
  return list.map(normalizeExternal);
}

/** studio.yaml의 external 서비스 하나를 정책 함수가 쓰는 형태로 맞춘다 */
export function normalizeExternal({ name, baseUrl, policy = {} }) {
  return {
    name,
    baseUrl: new URL(baseUrl),
    policy: { allow: policy.allow, mask: (policy.mask ?? []).map((field) => field.toLowerCase()), auth: policy.auth },
  };
}

/** `*`는 한 경로 구간, `**`는 0개 이상의 구간과 맞는다. 경로는 URL 해석으로 `..`를 정리한 뒤 비교한다 */
export function matchPath(pattern, pathname) {
  const want = pattern.split('/').filter(Boolean);
  const have = pathname.split('/').filter(Boolean);
  const walk = (i, j) => {
    if (i === want.length) return j === have.length;
    if (want[i] === '**') return walk(i + 1, j) || (j < have.length && walk(i, j + 1));
    return j < have.length && (want[i] === '*' || want[i] === have[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** 규칙을 적지 않은 API는 모든 호출자에게 GET·HEAD만 허용한다. 규칙을 적으면 적은 것만 허용한다 */
export function isAllowedCall(policy, caller, method, pathname) {
  if (!policy.allow) return READ_ONLY_METHODS.has(method);
  return policy.allow.some(
    (rule) => rule.callers.includes(caller) && rule.methods.includes(method) && (rule.paths ?? ['/**']).some((pattern) => matchPath(pattern, pathname)),
  );
}

/** 응답 JSON에서 이름이 fields에 있는 필드(대소문자 무시, 어느 깊이든)의 값을 가린다. null은 그대로 둔다 */
export function maskJson(value, fields) {
  let masked = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        if (child !== null && fields.includes(key.toLowerCase())) {
          masked += 1;
          return [key, '[가림]'];
        }
        return [key, walk(child)];
      }),
    );
  };
  return { value: walk(value), masked };
}

/** 등록한 주소의 경로 뒤에 요청 경로를 붙인다 (`https://host/users-api` + `/api/users/1`) */
export function upstreamUrl(baseUrl, pathname, search = '') {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${pathname}`;
  url.search = search;
  return url;
}

/** 요청이 온 IP가 어느 compose 서비스인지 서비스 이름을 풀어 찾는다. 재시작으로 IP가 바뀌므로 요청마다 푼다 */
export function callerResolver(names, lookup = (name) => dns.lookup(name, { all: true })) {
  return async (address) => {
    const ip = String(address ?? '').replace(/^::ffff:/, '');
    const hits = await Promise.all(
      names.map(async (name) => ((await lookup(name).catch(() => [])).some((entry) => entry.address === ip) ? name : undefined)),
    );
    return hits.find(Boolean);
  };
}

/**
 * 정책을 통과한 요청을 사내 API로 보내고 응답을 받는다. edge(샌드박스 서비스)와 스튜디오 서버(에이전트·API 탐색기)가 함께 쓴다.
 *  - 인증 헤더는 여기서 붙이므로 값이 샌드박스 서비스에 들어가지 않는다
 *  - 가릴 필드가 있으면 압축하지 않은 JSON만 받고, 해석할 수 없는 응답은 넘기지 않는다
 *  - API가 받은 인증 값을 응답에 되돌려 보내도 가린다
 */
export async function callUpstream(external, secrets, { method, pathname, search = '', headers = {}, body }) {
  const url = upstreamUrl(external.baseUrl, pathname, search);
  const outgoing = Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase()) && !key.toLowerCase().startsWith('x-b-studio-')));
  const { auth, mask } = external.policy;
  let secretValue;
  if (auth) {
    secretValue = secrets[auth.secret];
    if (!secretValue) throw new ApiPolicyError(502, `인증에 쓸 시크릿 ${auth.secret}의 값이 없습니다`);
    for (const key of Object.keys(outgoing)) if (key.toLowerCase() === auth.header.toLowerCase()) delete outgoing[key];
    outgoing[auth.header] = `${auth.prefix ?? ''}${secretValue}`;
  }
  const masking = mask.length > 0;
  if (masking) outgoing['accept-encoding'] = 'identity';
  if (body && body.length > 0) outgoing['content-length'] = String(Buffer.byteLength(body));

  const client = url.protocol === 'https:' ? https : http;
  const reply = await new Promise((resolve, reject) => {
    const request = client.request(url, { method, headers: outgoing, timeout: API_TIMEOUT_MS }, resolve);
    request.on('timeout', () => request.destroy(new ApiPolicyError(504, '사내 API 응답 시간 초과')));
    request.on('error', reject);
    request.end(body && body.length > 0 ? body : undefined);
  });

  const chunks = [];
  let size = 0;
  for await (const chunk of reply) {
    size += chunk.length;
    if (size > MAX_API_BODY_BYTES) {
      reply.destroy();
      throw new ApiPolicyError(502, '응답이 너무 커서 정책을 적용하지 못했습니다');
    }
    chunks.push(chunk);
  }
  let payload = Buffer.concat(chunks);
  const contentType = String(reply.headers['content-type'] ?? '');
  const textual = /json|text|xml|html|javascript|form/i.test(contentType);
  let masked = 0;

  if (masking && payload.length > 0) {
    if (!/json/i.test(contentType)) throw new ApiPolicyError(502, `가릴 필드가 있어 JSON이 아닌 응답(${contentType || '형식 없음'})은 넘기지 않습니다`);
    try {
      const result = maskJson(JSON.parse(payload.toString('utf8')), mask);
      payload = Buffer.from(JSON.stringify(result.value));
      masked = result.masked;
    } catch {
      throw new ApiPolicyError(502, 'JSON 응답을 해석하지 못해 가리지 못했습니다');
    }
  }
  if (secretValue && (textual || masking) && payload.includes(secretValue)) {
    payload = Buffer.from(payload.toString('utf8').replaceAll(secretValue, `[${auth.secret} 가림]`));
  }

  const responseHeaders = Object.fromEntries(
    Object.entries(reply.headers).filter(([key]) => !HOP_BY_HOP.has(key) && !(masking && key === 'content-encoding')),
  );
  return { status: reply.statusCode ?? 502, headers: responseHeaders, body: payload, masked };
}

/** 등록한 API 호출 감사 기록 한 줄 */
export function auditApi(entry) {
  console.log(JSON.stringify({ edge: 'api', ...entry, at: new Date().toISOString() }));
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

/**
 * 샌드박스 서비스가 `http://<등록한 이름>/경로`로 부르는 사내 API 프록시.
 * edge는 internal 네트워크에서 등록한 이름을 별칭으로 가지므로 Host 헤더로 대상을 고르고, 요청이 온 IP로 호출한 서비스를 찾는다.
 */
export function startApiProxy({ externals, secrets = {}, resolveCaller, port = API_PORT, host = '0.0.0.0', log = auditApi }) {
  const server = http.createServer(async (request, response) => {
    const name = String(request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const external = externals.find((item) => item.name === name);
    const target = new URL(request.url ?? '/', 'http://edge');
    const method = String(request.method ?? 'GET').toUpperCase();
    const caller = await resolveCaller(request.socket.remoteAddress);
    const entry = { caller: caller ?? String(request.socket.remoteAddress), via: 'sandbox', target: external?.name ?? name, method, path: target.pathname };
    const deny = (status, reason) => {
      log({ ...entry, decision: 'deny', status, reason });
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: `b-studio: ${reason}` }));
    };

    if (!external) return deny(404, '등록하지 않은 API입니다');
    if (!caller) return deny(403, '요청한 서비스를 알 수 없습니다');
    if (!isAllowedCall(external.policy, caller, method, target.pathname)) return deny(403, `${caller} 서비스에 허용하지 않은 호출입니다`);

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_API_BODY_BYTES) return deny(413, '요청 본문이 너무 큽니다');
        chunks.push(chunk);
      }
      const result = await callUpstream(external, secrets, { method, pathname: target.pathname, search: target.search, headers: request.headers, body: Buffer.concat(chunks) });
      log({ ...entry, decision: 'allow', status: result.status, masked: result.masked });
      response.writeHead(result.status, { ...result.headers, 'content-length': String(result.body.length) }).end(result.body);
    } catch (error) {
      if (error instanceof ApiPolicyError) return deny(error.status, error.message);
      return deny(502, `사내 API에 연결하지 못했습니다 (${error?.code ?? error?.message ?? error})`);
    }
  });
  server.listen(port, host);
  return server;
}

// 컨테이너에서는 `node --input-type=module -e <스크립트>`로 실행하므로 EDGE_MAIN으로 시작 여부를 정한다
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (process.env.EDGE_MAIN === '1' || invokedDirectly) {
  const forwards = parseForwards(process.env.EDGE_FORWARDS);
  const rules = parseAllow(process.env.EDGE_ALLOW);
  startEdge({ forwards, rules });
  const externals = parseExternals(process.env.EDGE_EXTERNALS);
  if (externals.length > 0) {
    const callers = String(process.env.EDGE_CALLERS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    // 인증 시크릿 값은 compose가 edge 컨테이너 환경에만 채운다
    startApiProxy({ externals, secrets: process.env, resolveCaller: callerResolver(callers) });
  }
  console.log(JSON.stringify({ edge: 'started', forwards, allow: rules, proxyPort: PROXY_PORT, apis: externals.map((external) => external.name) }));
  process.on('SIGTERM', () => process.exit(0));
}

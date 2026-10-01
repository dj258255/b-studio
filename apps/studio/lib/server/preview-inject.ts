import zlib from 'node:zlib';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { PREVIEW_LOCATION_MESSAGE } from '@/lib/preview-message';

/**
 * 미리보기 프록시(preview-proxy.ts·preview-gateway.ts)가 HTML 응답에 심는 스크립트(ADR-113).
 * iframe이 다른 출처라 studio가 contentWindow.location을 읽을 수 없으므로, 샌드박스 앱 쪽에서
 * 자기 위치를 postMessage로 부모(studio 화면)에 알려 준다. 사용자 코드를 건드리지 않고 프록시가 지나가는
 * HTML에만 끼워 넣는다. target origin을 '*'로 둔 것은 studio가 iframe을 어느 호스트로 열지(로컬 프록시 포트,
 * 원격 게이트웨이 호스트) 이 스크립트가 알 길이 없기 때문이다 — 담는 값(지금 주소)은 이미 브라우저의 네트워크
 * 탭에서도 보이는 값이라 수신 쪽에서만 출처·창을 확인하면 된다(preview-message.ts)
 */
const INJECTED_SCRIPT = `<script>(function(){
if(window.parent===window)return;
function post(){try{window.parent.postMessage({type:${JSON.stringify(PREVIEW_LOCATION_MESSAGE)},href:location.href},"*");}catch(e){}}
var rawPush=history.pushState,rawReplace=history.replaceState;
history.pushState=function(){var r=rawPush.apply(this,arguments);post();return r;};
history.replaceState=function(){var r=rawReplace.apply(this,arguments);post();return r;};
window.addEventListener("popstate",post);
window.addEventListener("hashchange",post);
if(document.readyState==="complete")post();else window.addEventListener("load",post);
})();</script>`;

const HEAD_CLOSE = /<\/head\s*>/i;
const BODY_OPEN = /<body[^>]*>/i;
const BODY_CLOSE = /<\/body\s*>/i;

/** `</head>` 앞, 없으면 `<body>` 바로 뒤, 그것도 없으면 `</body>` 앞, 셋 다 없으면 맨 끝에 스크립트를 끼워 넣는다 */
export function injectLocationScript(html: string): string {
  if (HEAD_CLOSE.test(html)) return html.replace(HEAD_CLOSE, (match) => `${INJECTED_SCRIPT}${match}`);
  if (BODY_OPEN.test(html)) return html.replace(BODY_OPEN, (match) => `${match}${INJECTED_SCRIPT}`);
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, (match) => `${INJECTED_SCRIPT}${match}`);
  return `${html}${INJECTED_SCRIPT}`;
}

const DECOMPRESSIBLE = new Set(['gzip', 'deflate', 'br', 'identity']);

/**
 * 이 응답에 스크립트를 넣어도 되는지. HTML이 아니거나(JSON·이미지·정적 자원), 몸이 없거나(304),
 * 모르는 인코딩이면 건드리지 않는다. content-security-policy 헤더가 있으면 인라인 스크립트를 막을 수 있어
 * 넣지 않는다(nonce를 CSP에 끼워 넣는 대신 더 안전한 쪽을 택했다 — ADR-113 감수한 트레이드오프)
 */
export function shouldInject(statusCode: number | undefined, headers: IncomingHttpHeaders): boolean {
  if (statusCode === 304) return false;
  const type = headers['content-type'];
  if (typeof type !== 'string' || !type.toLowerCase().startsWith('text/html')) return false;
  if (headers['content-security-policy'] !== undefined) return false;
  const encoding = headers['content-encoding'];
  if (typeof encoding === 'string' && !DECOMPRESSIBLE.has(encoding.toLowerCase())) return false;
  return true;
}

function decompress(encoding: string | string[] | undefined, body: Buffer): Promise<Buffer> {
  const value = (Array.isArray(encoding) ? encoding[0] : encoding)?.toLowerCase();
  if (!value || value === 'identity') return Promise.resolve(body);
  const fn = value === 'br' ? zlib.brotliDecompress : value === 'gzip' ? zlib.gunzip : value === 'deflate' ? zlib.inflate : undefined;
  if (!fn) return Promise.resolve(body);
  return new Promise((resolve, reject) => fn(body, (error, result) => (error ? reject(error) : resolve(result))));
}

/**
 * 업스트림 응답을 그대로 전달하되, HTML이면 풀어서 스크립트를 심고 다시 응답한다. 몸을 바꾸므로 content-length는
 * 지운다(한 번에 .end()하면 Node가 다시 계산해 붙인다). content-encoding도 지운다 — 다시 압축하지 않고 그대로 보낸다.
 * 풀지 못하면(알 수 없는 인코딩이 실려 왔거나 손상됐으면) 스크립트 없이 원문 그대로 돌려준다 — 끊어진 페이지보다 낫다
 */
export function pipeMaybeInjected(upstream: IncomingMessage, response: ServerResponse, headers: OutgoingHttpHeaders): void {
  if (!shouldInject(upstream.statusCode, upstream.headers)) {
    response.writeHead(upstream.statusCode ?? 502, headers);
    upstream.pipe(response);
    return;
  }
  const chunks: Buffer[] = [];
  upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end();
  });
  upstream.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks);
      delete headers['content-length'];
      try {
        const decompressed = await decompress(upstream.headers['content-encoding'], raw);
        delete headers['content-encoding'];
        response.writeHead(upstream.statusCode ?? 502, headers);
        response.end(injectLocationScript(decompressed.toString('utf8')), 'utf8');
      } catch {
        response.writeHead(upstream.statusCode ?? 502, headers);
        response.end(raw);
      }
    })();
  });
}

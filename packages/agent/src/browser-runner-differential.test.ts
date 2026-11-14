import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserUnavailableError, StepFailedError, StepWithoutActionError, runInBrowser, type BrowserPageResult, type BrowserPageOptions, type BrowserPageStep } from './browser-check';
import { runInBrowserNative } from './browser-check-native';

/**
 * 옛 러너(`runInBrowser`, Playwright)와 새 러너(`runInBrowserNative`, Rust CDP)가 같은 로컬 고정 페이지에서 같은 결과를 내는지 견준다(ADR-199).
 * 판정(`browser_problems`)은 이 값만 보므로 값이 다르면 판정이 바뀐다. 실제 Chromium으로 돈다(없으면 건너뛰지 않고 실패한다).
 * `loadMs`는 둘 다 0 이상인 숫자인지만 본다. 나머지는 같아야 한다.
 */

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** 스크립트 여러 개를 `<script>` 하나씩으로 감싼다. 앞 스크립트가 던져도 다음 스크립트는 돈다 */
const scripts = (...bodies: string[]) => bodies.map((body) => `<script>${body}</script>`).join('');
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

let server: Server;
let base = '';
let closedPort = 0;
/** 허용 밖 서버. 요청이 닿으면 센다 */
let outside: Server;
let outsideBase = '';
let outsidePort = 0;
let outsideHits = 0;

/** 요청 경로에 따라 응답을 돌려준다 */
function route(path: string): { status?: number; type?: string; body: string | Buffer; headers?: Record<string, string>; delay?: number } {
  switch (path) {
    case '/ok':
      return { body: page('<h1 id="t"></h1>' + scripts(`document.getElementById('t').textContent = '주문 목록'`)) };
    case '/plain':
      return { body: page('<p>평범한 화면</p>') };
    case '/console-forms':
      return {
        body: page(
          scripts(
            `console.error('plain text')`,
            `console.error('multi', 1, true, null, undefined, 'end')`,
            `console.error({ a: 1, b: 'x', c: [1, 2], d: { e: 1 } })`,
            `console.error([1, 2, 3], ['a', 'b'])`,
            `console.error('%s is %d', 'a', 3)`,
            `console.error(new Error('boom'))`,
            `console.error(new TypeError('type boom'))`,
            `console.error(Symbol('sym'))`,
            `console.error(function namedFn() { return 1; })`,
            `console.error(() => 2)`,
            `console.error(12345678901234567890, 1e21, 1e-7, 0.1 + 0.2, -0, NaN, Infinity, -Infinity, 10n, 1.5, -3)`,
            `console.error(new Map([[1, 2]]), new Set([1]))`,
            `console.error(document.body)`,
            `console.error(Object.create(null))`,
            `console.error(class Foo {})`,
            `console.error(new (class Bar { constructor() { this.x = 1; } })())`,
            `console.error([1, , 3], new Array(5))`,
            `console.error({ a: { b: { c: 1 } } })`,
            `console.error('유니코드 글자 🙂', '二')`,
            `console.error(new Date(0).getTime(), /re/g, null)`,
            `console.error('')`,
            `console.error('line1\\nline2')`,
            `console.error('Failed to load resource: 이것은 페이지가 직접 남긴 글')`,
            `console.warn('warn은 세지 않는다')`,
            `console.log('log도 세지 않는다')`,
            `console.info('info도 세지 않는다')`,
            `console.assert(false, 'assert는 type이 assert다')`,
            `console.debug('debug')`,
            `console.trace('trace')`,
            `console.dir({ a: 1 })`,
            `console.table([[1, 2]])`,
            `console.group('g'); console.error('그룹 안'); console.groupEnd()`,
          ),
        ),
      };
    case '/csp-console':
      // 브라우저가 스스로 남기는 오류(Log.entryAdded)
      return { body: page(scripts(`console.error('page script is blocked')`), `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`) };
    case '/csp-violation':
      return { body: page('<img src="/pixel.png"><script src="/pixel.png"></script>', `<meta http-equiv="Content-Security-Policy" content="img-src 'none'">`) };
    case '/exceptions':
      return {
        body: page(
          scripts(
            `throw new Error('boom')`,
            `throw 'string thrown'`,
            `throw { a: 1 }`,
            `throw {}`,
            `throw null`,
            `throw undefined`,
            `throw 42`,
            `throw [1, 2]`,
            `class MyErr extends Error { constructor(m) { super(m); this.name = 'MyErr'; } } throw new MyErr('custom name')`,
            `throw new TypeError('multi\\nline message')`,
            `throw 'a: b: c'`,
            `throw 'colon at end:'`,
            `throw new Error('')`,
            `throw new RangeError('range: with colon')`,
            `throw Object.assign(new Error('has name prop'), { name: 'Renamed' })`,
            `Promise.reject(new Error('rejected error'))`,
            `Promise.reject('rejected string')`,
            `setTimeout(() => { throw new Error('timer boom'); }, 50)`,
            `window.missing.call()`,
            `JSON.parse('{bad')`,
            `throw '유니코드: 한글 메시지'`,
          ),
        ),
      };
    case '/syntax-error':
      return { body: page(scripts(`var x = ;`, `console.error('after syntax error')`)) };
    case '/resources':
      return {
        body: page(
          '<img src="/missing.png"><img src="/missing.png">' +
            '<link rel="stylesheet" href="/broken.css">' +
            '<link rel="icon" href="/favicon.ico">' +
            scripts(
              `fetch('/api/500')`,
              `fetch('/api/404', { method: 'POST' })`,
              `fetch('/favicon.ico?x=1')`,
              `fetch('/dir/favicon.ico')`,
              `fetch('/api/ok')`,
              `fetch('/chunk.js')`,
            ) +
            '<script src="/chunk-404.js"></script>',
        ),
      };
    case '/outside-direct':
      // 허용 출처 밖으로 곧바로 나가는 요청(이미지·fetch·https·워커 스크립트). 리다이렉트가 아니라 첫 요청이다
      return {
        body: page(
          `<img src="${outsideBase}/pixel.png"><img src="https://127.0.0.1:${outsidePort}/tls.png">` +
            scripts(`fetch('${outsideBase}/data.json').catch(() => {})`, `fetch('https://127.0.0.1:${outsidePort}/tls.json').catch(() => {})`, `fetch('/api/ok')`),
        ),
      };
    case '/refused-image':
      return { body: page(`<img src="http://127.0.0.1:${closedPort}/gone.png">` + scripts(`fetch('http://127.0.0.1:${closedPort}/api').catch(() => {})`)) };
    case '/media':
      return {
        body: page(
          '<video id="v" preload="auto" src="/missing.mp4"></video>' +
            '<audio preload="auto" src="/missing.mp3"></audio>' +
            '<img src="/missing-img.png">' +
            '<video preload="auto" src="/corrupt.mp4"></video>' +
            '<video preload="auto" src="data:video/mp4;base64,AAAA"></video>',
        ),
      };
    case '/corrupt.mp4':
      return { type: 'video/mp4', body: Buffer.from('this is not a video') };
    case '/wide':
      return { body: page('<div style="width:900px">표</div>', '<meta name="viewport" content="width=device-width"><style>body{margin:0}</style>') };
    case '/vp':
      return {
        body: page(
          '<div class="scroller" style="height:100px;overflow:auto"><p style="margin:0;height:70px">영상</p><p style="margin:0;height:40px">주문하려면 로그인하세요</p></div>' +
            '<button style="height:30px">바로 주문</button><p style="display:none">숨은 글자</p><div style="height:900px"></div><p>아래 글자</p>',
          '<style>body{margin:0}</style>',
        ),
      };
    case '/redirect-ok':
      return { status: 302, body: '', headers: { location: '/ok' } };
    case '/redirect-chain':
      return { status: 301, body: '', headers: { location: '/redirect-ok' } };
    case '/redirect-404':
      return { status: 302, body: '', headers: { location: '/does-not-exist' } };
    case '/doc-404':
      return { status: 404, body: page('<p>없는 화면</p>') };
    case '/doc-500':
      return { status: 500, body: page('<p>서버 오류 화면</p>') };
    case '/late-error':
      return { body: page('<p>늦게 오는 오류</p>' + scripts(`setTimeout(() => console.error('late 300ms'), 300)`)) };
    case '/later-error':
      return { body: page('<p>더 늦게 오는 오류</p>' + scripts(`setTimeout(() => console.error('later 2500ms'), 2500)`)) };
    case '/hanging-request':
      // 끝나지 않는 요청이 있으면 networkidle은 상한(5초)까지 기다린다
      return { body: page('<p>끝나지 않는 요청</p>' + scripts(`fetch('/hang')`, `setTimeout(() => console.error('during idle cap 3000ms'), 3000)`, `setTimeout(() => console.error('after idle cap 7500ms'), 7500)`)) };
    case '/worker':
      return {
        body: page(
          scripts(
            `const w = new Worker('/worker.js');`,
            `w.onmessage = (e) => { document.body.append(e.data); }`,
          ),
        ),
      };
    case '/worker.js':
      return { type: 'text/javascript', body: `console.error('worker console error'); fetch('/worker-missing.json').catch(() => {}); setTimeout(() => { throw new Error('worker exception'); }, 20); postMessage('worker ready');` };
    case '/iframe':
      return { body: page('<iframe src="/iframe-child"></iframe><iframe srcdoc="<script>console.error(\'srcdoc error\')</script>"></iframe>') };
    case '/iframe-child':
      return { body: page('<img src="/iframe-missing.png">' + scripts(`console.error('iframe console error')`, `throw new Error('iframe exception')`)) };
    case '/dialog':
      return { body: page('<p>대화상자</p>' + scripts(`alert('hello'); console.error('after alert')`, `confirm('sure?')`)) };
    case '/pushstate':
      return { body: page('<p>한 화면 앱</p>' + scripts(`history.pushState({}, '', '/pushed'); fetch('/api/500')`)) };
    case '/slow-script':
      return { body: page('<p>느린 스크립트</p><script src="/slow.js"></script>') };
    case '/slow.js':
      return { type: 'text/javascript', body: `console.error('slow script ran')`, delay: 300 };
    case '/js-redirect':
      return { body: page(scripts(`location.replace('/plain')`)) };
    case '/body-less':
      return { body: '<!doctype html><html></html>' };
    case '/api/500':
      return { status: 500, type: 'application/json', body: '{}' };
    case '/api/404':
      return { status: 404, type: 'text/plain', body: 'no' };
    case '/api/ok':
      return { type: 'application/json', body: '{"ok":true}' };
    case '/broken.css':
      return { status: 500, type: 'text/css', body: 'body{}' };
    case '/pixel.png':
      return { type: 'image/png', body: PIXEL };
    case '/chunk.js':
      return { type: 'text/javascript', body: '/* ok */' };
    case '/hang':
      return { body: '', delay: 60_000 };
    // ── 단계(A6b): 상호작용 페이지들. 값은 body의 보이는 글자(innerText)로 읽으므로 결과를 글자로 드러낸다
    case '/steps':
      return {
        body: page(
          `<h1>단계 확인</h1><button id="go" class="primary" onclick="count()">바로 주문</button><p id="o">누른 횟수 0</p>
<form id="f"><input id="q" name="q" placeholder="검색"><button type="submit" id="submit">찾기</button></form><p id="r">결과 없음</p>
<input id="a" value="abcdef"><input id="b"><p id="focus">포커스 없음</p><p id="sel">선택 없음</p><a id="link" href="/plain">다른 화면으로</a>` +
            scripts(
              `var n = 0; function count() { n++; document.getElementById('o').textContent = '누른 횟수 ' + n; }`,
              `document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); document.getElementById('r').textContent = '검색: ' + document.getElementById('q').value; });`,
              `['a', 'b'].forEach(function (id) { document.getElementById(id).addEventListener('focus', function () { document.getElementById('focus').textContent = '포커스 ' + id; }); });`,
              `document.getElementById('a').addEventListener('keydown', function (e) { var t = e.target; setTimeout(function () { document.getElementById('sel').textContent = '선택 ' + e.key + ' ' + t.selectionStart + '-' + t.selectionEnd; }, 0); });`,
            ),
        ),
      };
    case '/steps-fill':
      return {
        body: page(
          `<input id="t" value="기존"><input id="d" type="date"><input id="n" type="number"><textarea id="ta">옛</textarea><div id="ce" contenteditable="true">옛 글</div><div id="plain">입력 아님</div><input id="ro" readonly value="읽기 전용"><input id="dis" disabled><input id="chk" type="checkbox"><p id="log"></p>` +
            scripts(`document.addEventListener('input', function (e) { var t = e.target; document.getElementById('log').textContent += t.id + '=' + (t.value !== undefined ? t.value : t.textContent) + '; '; });`),
        ),
      };
    case '/steps-keys':
      return {
        body: page(
          `<input id="k"><p id="log">기록:</p>` +
            scripts(
              `var k = document.getElementById('k'); k.focus();`,
              `['keydown', 'keypress', 'keyup'].forEach(function (type) { k.addEventListener(type, function (e) { document.getElementById('log').textContent += ' ' + type.slice(3, 4) + ':' + e.key + '/' + e.code + '/' + (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '') + (e.metaKey ? 'M' : ''); }); });`,
            ),
        ),
      };
    case '/steps-late':
      return { body: page('<p>처음 화면</p>' + scripts(`setTimeout(function () { var p = document.createElement('p'); p.id = 'late'; p.textContent = '늦게 나타남'; document.body.appendChild(p); }, 1200)`)) };
    case '/steps-scroll':
      return { body: page('<div style="height:2500px">길다</div><button id="far" onclick="document.getElementById(\'o\').textContent = \'아래 버튼 눌림\'">아래 버튼</button><p id="o">대기</p>') };
    case '/steps-anim':
      return {
        body: page(
          `<style>#m { position: absolute; left: 0; top: 200px; width: 120px; height: 40px; transition: left 0.8s linear; }</style><button id="m" onclick="document.getElementById('o').textContent = '눌림 위치 ' + Math.round(this.getBoundingClientRect().left)">움직이는 버튼</button><p id="o">대기</p>` +
            scripts(`setTimeout(function () { document.getElementById('m').style.left = '300px'; }, 30)`),
        ),
      };
    case '/steps-enable-late':
      return {
        body: page(`<button id="b" disabled onclick="document.getElementById('o').textContent = '활성화 뒤 눌림'">곧 활성화</button><p id="o">대기</p>` + scripts(`setTimeout(function () { document.getElementById('b').disabled = false; }, 800)`)),
      };
    case '/steps-covered':
      return { body: page('<button id="b" onclick="document.getElementById(\'o\').textContent = \'눌림\'">가려진 버튼</button><p id="o">대기</p><div style="position:fixed;left:0;top:0;right:0;bottom:0"></div>') };
    case '/steps-disabled':
      return { body: page('<button id="b" disabled onclick="document.getElementById(\'o\').textContent = \'눌림\'">비활성 버튼</button><p id="o">대기</p>') };
    case '/steps-hidden':
      return { body: page('<p>보이는 글자</p><div id="h" style="display:none">숨은 글자</div>') };
    case '/steps-fetch':
      return {
        body: page(
          `<button id="fast" onclick="fetch('/api/500')">바로 실패</button><button id="slow" onclick="fetch('/api/slow500')">느리게 실패</button><button id="chain" onclick="fetch('/api/ok').then(function () { return fetch('/api/404'); })">이어서 실패</button><p>대기</p>`,
        ),
      };
    case '/api/slow500':
      return { status: 500, type: 'application/json', body: '{}', delay: 300 };
    case '/steps-outside':
      return {
        body: page(
          `<button id="f" onclick="fetch('${outsideBase}/data.json').catch(function () {})">밖으로 요청</button><button id="n" onclick="location.assign('${outsideBase}/page')">밖으로 이동</button><button id="i" onclick="var i = new Image(); i.src = '${outsideBase}/pixel.png'">밖 이미지</button><p>허용 안</p>`,
        ),
      };
    case '/blocked-nav':
      return { body: page('<p>이동 전</p>' + scripts(`location.assign('http://order-done.invalid/')`)) };
    case '/forged':
      // 페이지가 전역을 바꿔 판정을 속이려는 화면. 숨은 글자를 "보이는" 것으로, 가로 넘침을 0으로, 화면 글자를 다른 글자로 읽히게 한다
      return {
        body: page(
          `<div style="width:900px;height:10px;background:#ccc"></div><p id="hidden" style="display:none">숨은 글자</p><p>진짜 글자</p>` +
            scripts(
              `Object.defineProperty(HTMLElement.prototype, 'innerText', { get: function () { return '위조된 글자 주문 완료'; }, configurable: true });`,
              `Math.max = function () { return 0; };`,
              `Element.prototype.getClientRects = function () { return [{ width: 100, height: 20 }]; };`,
              `Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20, x: 10, y: 10 }; };`,
              `Document.prototype.elementFromPoint = function () { return document.getElementById('hidden'); };`,
            ),
          '<style>body { margin: 0 }</style>',
        ),
      };
    case '/steps-forged':
      // 선택자·판정에 쓰이는 전역을 바꾼 화면: 실행 환경이 같으면 보임 판정이 깨져 단계가 멈춘다
      return {
        body: page(
          `<button id="b" onclick="document.getElementById('o').textContent = '위조된 화면에서 눌림'">눌러 보세요</button><p id="o">대기</p>` +
            scripts(
              `Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; };`,
              `Array.prototype.some = function () { return false; }; Array.prototype.includes = function () { return false; }; Array.prototype.indexOf = function () { return -1; };`,
              `Object.defineProperty(Element.prototype, 'isConnected', { get: function () { return false; }, configurable: true });`,
            ),
        ),
      };
    default:
      return { status: 404, type: 'text/plain', body: 'not found' };
  }
}

beforeAll(async () => {
  // 닫힌 포트: 서버를 띄웠다가 닫아 번호만 얻는다
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  outside = createServer((_request, response) => {
    outsideHits += 1;
    response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    response.end('outside');
  });
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
  outsidePort = (outside.address() as AddressInfo).port;
  outsideBase = `http://127.0.0.1:${outsidePort}`;

  server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]!;
    const reply = route(path);
    const send = () => {
      response.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'text/html; charset=utf-8', ...reply.headers });
      response.end(reply.body);
    };
    if (reply.delay) {
      const timer = setTimeout(send, reply.delay);
      response.on('close', () => clearTimeout(timer));
    } else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      outside.closeAllConnections();
      outside.close(() => server.close(() => resolve()));
    }),
);

/**
 * 서로 다른 요청의 실패·미디어 오류·막은 요청은 네트워크 도착 순서로 쌓이는데, 같은 러너를 두 번 돌려도 그 순서가 달라진다(실측: 옛 러너도 6회 중 2가지 순서).
 * 그래서 이 목록들은 정렬해서 견준다. 한 스크립트 안에서 차례로 부르는 console·예외는 순서까지 견준다. 워커·iframe처럼 대상이 여럿인 페이지만 `unorderedErrors`로 정렬한다
 */
const normalize = ({ loadMs: _loadMs, ...rest }: BrowserPageResult, unorderedErrors: boolean, ignoreScreenText = false) => ({
  ...rest,
  // 브라우저 오류 화면(막힌 이동 뒤)의 글자: 옛 러너는 브라우저에 따라 빈 문서(headless shell)나 오류 문구(시스템 Chrome)를 읽는다. 새 러너는 늘 빈 문서로 읽는 의도한 차이다
  ...(ignoreScreenText ? { text: '', viewportTexts: undefined } : {}),
  steps: normalizeSteps(rest.steps),
  failedRequests: [...rest.failedRequests].sort(),
  mediaErrors: [...rest.mediaErrors].sort(),
  blockedRequests: [...rest.blockedRequests].sort(),
  ...(unorderedErrors ? { consoleErrors: [...rest.consoleErrors].sort(), pageErrors: [...rest.pageErrors].sort() } : {}),
});

/** PNG 머리(서명 8바이트 + IHDR)에서 가로·세로를 읽는다. PNG가 아니면 null */
function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** 스크린샷 바이트는 견주지 않고, PNG인지와 크기만 견준다 */
function normalizeSteps(steps: readonly BrowserPageStep[]) {
  return steps.map(({ screenshot, ...rest }) => ({ ...rest, ...(screenshot ? { screenshot: { png: pngSize(screenshot) } } : {}) }));
}

/** 둘 다 돌려 `loadMs`를 뺀 결과를 견준다 */
async function compare(path: string, options: BrowserPageOptions = {}, unorderedErrors = false, ignoreScreenText = false): Promise<{ old: BrowserPageResult; native: BrowserPageResult }> {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const old = await runInBrowser(url, options);
  const native = await runInBrowserNative(url, options);
  expect(normalize(native, unorderedErrors, ignoreScreenText), path).toEqual(normalize(old, unorderedErrors, ignoreScreenText));
  expect(old.loadMs === undefined, path).toBe(native.loadMs === undefined);
  return { old, native };
}

async function firstLineOfRejection(runner: typeof runInBrowser, url: string, options: BrowserPageOptions = {}): Promise<string> {
  try {
    await runner(url, options);
  } catch (error) {
    return (error as Error).message.split('\n')[0]!;
  }
  return '(던지지 않음)';
}

describe('Rust 러너는 옛 러너와 같은 결과를 낸다 (ADR-199)', { timeout: 120_000 }, () => {
  it('평범한 화면: 클라이언트 스크립트가 만든 글자와 상태 코드', async () => {
    const { native } = await compare('/ok');
    expect(native).toMatchObject({ status: 200, pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0 });
    expect(native.text).toContain('주문 목록');
    expect(native.steps).toEqual([{ label: 'open /ok', ok: true }]);
  });

  it('console.error의 여러 꼴: 인자를 글자로 만드는 규칙, 다른 종류는 세지 않는다', async () => {
    const { native } = await compare('/console-forms');
    // 규칙 자체도 고정해 둔다(둘이 함께 틀리는 것을 막는다)
    expect(native.consoleErrors).toContain('plain text');
    expect(native.consoleErrors).toContain('multi 1 true null undefined end');
    expect(native.consoleErrors).toContain('{a: 1, b: x, c: Array(2), d: Object}');
    expect(native.consoleErrors).toContain('[1, 2, 3] [a, b]');
    expect(native.consoleErrors).toContain('%s is %d a 3');
    expect(native.consoleErrors.some((line) => line.includes('다른 종류') || line.includes('warn은'))).toBe(false);
    expect(native.consoleErrors.some((line) => line.startsWith('Failed to load resource'))).toBe(false);
  });

  it('브라우저가 스스로 남기는 오류(콘텐츠 보안 정책 위반)도 같게 센다', async () => {
    const { native } = await compare('/csp-console');
    expect(native.consoleErrors.length).toBeGreaterThan(0);
    await compare('/csp-violation');
  });

  it('잡히지 않은 예외의 여러 꼴: 문자열·객체·null·Error 하위 클래스·여러 줄·거절된 약속', async () => {
    const { native } = await compare('/exceptions');
    expect(native.pageErrors).toContain('boom');
    expect(native.pageErrors).toContain('string thrown');
    expect(native.pageErrors).toContain('Object');
    expect(native.pageErrors).toContain('null');
    expect(native.pageErrors.some((line) => line.startsWith('multi\nline message'))).toBe(true);
    expect(native.pageErrors).toContain('b: c');
    await compare('/syntax-error');
  });

  it('404·500 리소스, 파비콘 예외, 같은 URL은 첫 기록만', async () => {
    const { native } = await compare('/resources');
    expect(native.failedRequests.some((line) => line.startsWith('404 ') && line.endsWith('/missing.png'))).toBe(true);
    expect(native.failedRequests.filter((line) => line.endsWith('/missing.png'))).toHaveLength(1);
    expect(native.failedRequests.some((line) => line.includes('favicon.ico'))).toBe(false);
  });

  it('연결 거부된 이미지와 fetch는 오류 글과 함께 실패한 요청이다', async () => {
    const { native } = await compare('/refused-image');
    expect(native.failedRequests.some((line) => line.startsWith('net::ERR_CONNECTION_REFUSED '))).toBe(true);
  });

  it('깨진 <video>·<audio>·<img>는 mediaErrors로 남는다', async () => {
    const { native } = await compare('/media');
    expect(native.mediaErrors.length).toBeGreaterThanOrEqual(3);
  });

  it('모바일 창 크기에서 가로 넘침을 잰다', async () => {
    const { native } = await compare('/wide', { viewport: { width: 390, height: 844 } });
    expect(native.horizontalOverflowPx).toBe(900 - 390);
    await compare('/wide', { viewport: { width: 1280, height: 800 } });
  });

  it('viewportTexts: 보임·잘림·숨김·창 밖·없음을 같게 잰다', async () => {
    const { native } = await compare('/vp', { viewportTexts: ['주문하려면 로그인하세요', '바로 주문', '숨은 글자', '아래 글자', '없는 글자'], viewport: { width: 800, height: 400 } });
    expect(native.viewportTexts?.findings).toHaveLength(5);
  });

  it('리다이렉트된 문서는 최종 문서 응답의 상태 코드를 돌려준다', async () => {
    const { native } = await compare('/redirect-ok');
    expect(native.status).toBe(200);
    expect(native.text).toContain('주문 목록');
    await compare('/redirect-chain');
    const missing = await compare('/redirect-404');
    expect(missing.native.status).toBe(404);
  });

  it('문서 상태가 404·500이어도 오류 없이 결과를 돌려준다', async () => {
    expect((await compare('/doc-404')).native.status).toBe(404);
    expect((await compare('/doc-500')).native.status).toBe(500);
  });

  it('이동이 실패하면 오류 글의 첫 줄이 같다 (닫힌 포트)', async () => {
    const url = `http://127.0.0.1:${closedPort}/`;
    const old = await firstLineOfRejection(runInBrowser, url);
    const native = await firstLineOfRejection(runInBrowserNative, url);
    expect(old).toMatch(/^page\.goto: net::ERR_CONNECTION_REFUSED at /);
    expect(native).toBe(old);
  });

  it('허용 밖으로 곧바로 나가는 요청(http·https 이미지와 fetch)은 둘 다 같은 글로 막고 서버에 닿지 않는다', async () => {
    outsideHits = 0;
    const { native } = await compare('/outside-direct', { allowedOrigins: [base] });
    expect(outsideHits).toBe(0);
    expect([...native.blockedRequests].sort()).toEqual([`${outsideBase}/data.json`, `${outsideBase}/pixel.png`, `https://127.0.0.1:${outsidePort}/tls.json`, `https://127.0.0.1:${outsidePort}/tls.png`].sort());
    // 막은 요청은 앱의 실패가 아니다
    expect(native.failedRequests).toEqual([]);
  });

  it('measureLoad를 켜면 둘 다 loadMs를 0 이상으로 재고, 워밍업 이동의 오류는 비운다', async () => {
    const { old, native } = await compare('/ok', { measureLoad: true });
    expect(old.loadMs).toBeGreaterThanOrEqual(0);
    expect(native.loadMs).toBeGreaterThanOrEqual(0);
    await compare('/resources', { measureLoad: true });
    // 워밍업 이동이 남긴 예외·console 오류는 비워져 한 번씩만 남는다
    const errors = await compare('/exceptions', { measureLoad: true });
    expect(errors.native.pageErrors.filter((line) => line === 'boom')).toHaveLength(1);
    const consoleCases = await compare('/console-forms', { measureLoad: true });
    expect(consoleCases.native.consoleErrors.filter((line) => line === 'plain text')).toHaveLength(1);
    const off = await runInBrowserNative(`${base}/ok`, {});
    expect(off.loadMs).toBeUndefined();
  });

  it('networkidle 안에 오는 console.error는 잡고, 그 뒤에 오는 것은 둘 다 놓친다', async () => {
    const early = await compare('/late-error');
    expect(early.native.consoleErrors).toEqual(['late 300ms']);
    const late = await compare('/later-error');
    expect(late.native.consoleErrors).toEqual([]);
  });

  it('끝나지 않는 요청이 있으면 networkidle을 5초까지 기다리고, 그 안의 오류만 잡는다', async () => {
    const { native } = await compare('/hanging-request');
    expect(native.consoleErrors).toEqual(['during idle cap 3000ms']);
  });

  it('전용 워커와 iframe의 오류도 같게 모은다', async () => {
    const worker = await compare('/worker', {}, true);
    expect(worker.native.consoleErrors).toContain('worker console error');
    await compare('/iframe', {}, true);
  });

  it('alert·confirm이 떠도 멈추지 않는다', async () => {
    await compare('/dialog');
  });

  it('같은 문서 안의 주소 변경(pushState)과 스크립트 이동, 본문이 없는 문서', async () => {
    await compare('/pushstate');
    await compare('/js-redirect');
    await compare('/body-less');
    await compare('/slow-script');
  });

  it('중단 신호: 브라우저·프록시·임시 폴더가 남지 않고 옛 러너와 같은 오류로 끝난다', async () => {
    // 공용 임시 폴더를 보면 동시에 도는 다른 시험 파일(다른 작업자 프로세스)의 브라우저 프로필도 잡힌다(Linux CI에서 Playwright 프로필 7개).
    // 이 시험 동안만 이 프로세스의 TMPDIR을 빈 폴더로 바꾼다. 두 러너 모두 부를 때마다 TMPDIR을 읽는다(Node os.tmpdir(), Rust temp_dir())
    const savedTmpdir = process.env.TMPDIR;
    const isolated = mkdtempSync(path.join(tmpdir(), 'runner-abort-'));
    process.env.TMPDIR = isolated;
    try {
      expect(tmpdir()).toBe(isolated);
      for (const runner of [runInBrowser, runInBrowserNative]) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 700);
        const startedAt = Date.now();
        await expect(runner(`${base}/hanging-request`, { signal: controller.signal, allowedOrigins: [base] })).rejects.toThrow(/abort/i);
        // 신호를 무시하면 이 화면은 networkidle 상한(5초)까지 간다. 취소는 그 전에 끝나야 한다
        expect(Date.now() - startedAt).toBeLessThan(4000);
        const already = new AbortController();
        already.abort();
        await expect(runner(`${base}/ok`, { signal: already.signal })).rejects.toThrow(/abort/i);
      }
      // Rust 러너는 이 러너가 만든 폴더만 지운다. 옛 러너(Playwright)의 프로필 폴더는 견주지 않는다: 격리한 TMPDIR에서도 Linux CI(시스템 Chrome)에서
      // 중단 뒤 `playwright_chromiumdev_profile-*` 하나가 남았다(옛 러너의 동작, ADR-199). 이 시험이 확인하는 것은 Rust 러너의 정리다
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(tmpEntries().filter((name) => name.startsWith('b-studio-cdp-'))).toEqual([]);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('실행 파일이 없으면 BrowserUnavailableError다 (조용히 통과시키지 않는다)', async () => {
    const saved = process.env.B_STUDIO_BROWSER_EXECUTABLE;
    process.env.B_STUDIO_BROWSER_EXECUTABLE = '/nonexistent/chrome-for-test';
    try {
      await expect(runInBrowserNative(`${base}/ok`, {})).rejects.toBeInstanceOf(BrowserUnavailableError);
      await expect(runInBrowser(`${base}/ok`, {})).rejects.toBeInstanceOf(BrowserUnavailableError);
    } finally {
      if (saved === undefined) delete process.env.B_STUDIO_BROWSER_EXECUTABLE;
      else process.env.B_STUDIO_BROWSER_EXECUTABLE = saved;
    }
  });

  it('아직 지원하지 않는 입력(화면 중계)은 조용히 무시하지 않고, 브라우저 없음이 아닌 오류로 던진다', async () => {
    const error = await runInBrowserNative(`${base}/ok`, { onFrame: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BrowserUnavailableError);
    expect((error as Error).message).toMatch(/아직 지원하지 않/);
  });
});

/** 단계가 실패했을 때 두 러너가 던진 것을 같은 모양으로 모은다 */
async function failureOf(runner: typeof runInBrowser, url: string, options: BrowserPageOptions) {
  try {
    await runner(url, options);
  } catch (error) {
    if (error instanceof StepFailedError) return { kind: 'StepFailedError', message: error.message, steps: normalizeSteps(error.steps) };
    return { kind: (error as Error).constructor.name, message: (error as Error).message };
  }
  return { kind: '(던지지 않음)' };
}

/** 같은 단계를 두 러너로 돌려 실패의 종류·오류 글(첫 줄이 같은 한 줄)·그때까지의 단계가 같은지 견준다 */
async function compareFailure(path: string, options: BrowserPageOptions) {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const old = await failureOf(runInBrowser, url, options);
  const native = await failureOf(runInBrowserNative, url, options);
  expect(native, path).toEqual(old);
  return native as { kind: string; message: string; steps?: ReturnType<typeof normalizeSteps> };
}

describe('Rust 러너의 단계(click·fill·press·waitFor)는 옛 러너와 같은 결과를 낸다 (ADR-199 A6b)', { timeout: 180_000 }, () => {
  it('click: text=·role=·CSS·>> 이어 쓰기 선택자로 같은 버튼을 누른다', async () => {
    const { native } = await compare('/steps', {
      steps: [{ click: 'text=바로 주문' }, { click: 'role=button[name="바로 주문"]' }, { click: 'button.primary' }, { click: 'form >> button[type=submit]' }, { click: '#go >> nth=0' }, { click: 'button:has-text("바로 주문")' }, { click: '[id=go]' }],
    });
    expect(native.text).toContain('누른 횟수 6');
    expect(native.steps.map((step) => step.label)).toEqual(['open /steps', 'click text=바로 주문', 'click role=button[name="바로 주문"]', 'click button.primary', 'click form >> button[type=submit]', 'click #go >> nth=0', 'click button:has-text("바로 주문")', 'click [id=go]']);
    expect(native.steps.every((step) => step.ok)).toBe(true);
  });

  it('fill 뒤 Enter 제출, Tab·Shift+Tab 이동, Control+A·ControlOrMeta+A, 글자 키', async () => {
    const submitted = await compare('/steps', { steps: [{ fill: { selector: '#q', text: '김토스' } }, { press: 'Enter' }, { waitFor: 'text=검색: 김토스' }] });
    expect(submitted.native.text).toContain('검색: 김토스');
    const moved = await compare('/steps', { steps: [{ click: '#a' }, { press: 'Control+A' }, { press: 'Tab' }, { press: 'Shift+Tab' }, { press: 'ControlOrMeta+A' }, { press: 'ArrowDown' }, { press: 'Shift+Tab' }] });
    expect(moved.native.text).toContain('포커스 ');
    expect(moved.native.text).not.toContain('포커스 없음');
    await compare('/steps-keys', {
      steps: [{ press: 'a' }, { press: 'Shift+A' }, { press: 'Shift+a' }, { press: 'Control+Shift+KeyB' }, { press: 'Alt+ArrowDown' }, { press: 'Meta+KeyZ' }, { press: 'Shift+Meta+KeyZ' }, { press: 'Enter' }, { press: 'NumpadEnter' }, { press: 'Backspace' }, { press: 'Escape' }, { press: '1' }, { press: '+' }, { press: 'Control++' }, { press: 'Home' }, { press: 'PageDown' }, { press: 'F5' }],
    });
  });

  it('fill: input·textarea·contenteditable·date를 채우고, 빈 글자는 지운다', async () => {
    const { native } = await compare('/steps-fill', {
      steps: [{ fill: { selector: '#t', text: '새 글' } }, { fill: { selector: '#d', text: '2026-11-14' } }, { fill: { selector: '#n', text: ' 42 ' } }, { fill: { selector: '#ta', text: '여러\n줄' } }, { fill: { selector: '#ce', text: '편집 가능' } }, { fill: { selector: '#t', text: '' } }],
    });
    expect(native.text).toContain('t=새 글');
    expect(native.text).toContain('d=2026-11-14');
    expect(native.text).toContain('n=42');
    expect(native.text).toContain('ce=편집 가능');
    expect(native.text).toContain('t=;');
  });

  it('waitFor: 늦게 나타나는 요소를 기다린다', async () => {
    const { native } = await compare('/steps-late', { steps: [{ waitFor: 'text=늦게 나타남' }, { waitFor: '#late' }] });
    expect(native.text).toContain('늦게 나타남');
  });

  it('스크롤해야 보이는 버튼과 애니메이션 중인 버튼(안정할 때까지 기다린다)', async () => {
    const far = await compare('/steps-scroll', { steps: [{ click: 'text=아래 버튼' }] });
    expect(far.native.text).toContain('아래 버튼 눌림');
    const moving = await compare('/steps-anim', { steps: [{ click: '#m' }] });
    // 움직임이 끝난 뒤(left 300px)에 눌러야 한다
    expect(moving.native.text).toContain('눌림 위치 300');
  });

  it('처음에는 비활성이던 버튼이 곧 활성화되면 다시 시도해 누른다', async () => {
    const { native } = await compare('/steps-enable-late', { steps: [{ click: 'text=곧 활성화' }] });
    expect(native.text).toContain('활성화 뒤 눌림');
  });

  it('새 문서로 이동한 뒤의 단계: 링크 클릭과 폼 제출이 이동을 마친 뒤 이어진다', async () => {
    const link = await compare('/steps', { steps: [{ click: 'text=다른 화면으로' }, { waitFor: 'text=평범한 화면' }, { click: 'p' }] });
    expect(link.native.text).toContain('평범한 화면');
    expect(link.native.steps.map((step) => step.label)).toEqual(['open /steps', 'click text=다른 화면으로', 'waitFor text=평범한 화면', 'click p']);
  });

  it('페이지가 전역(Element.prototype·Array.prototype)을 바꿔도 단계는 격리된 실행 환경에서 같게 돈다', async () => {
    const { native } = await compare('/steps-forged', { steps: [{ click: 'text=눌러 보세요' }, { waitFor: '#o' }] });
    expect(native.text).toContain('위조된 화면에서 눌림');
  });

  it('실패: 없는 선택자 click은 5초 시간 초과이고 오류 글 첫 줄과 단계 배열이 같다', async () => {
    const failure = await compareFailure('/steps', { steps: [{ click: '#go' }, { click: '#nope' }, { click: '#go' }] });
    expect(failure.kind).toBe('StepFailedError');
    expect(failure.message).toBe('2번째 단계 실패 (click #nope): page.click: Timeout 5000ms exceeded.');
    expect(failure.steps).toEqual([{ label: 'open /steps', ok: true }, { label: 'click #go', ok: true }, { label: 'click #nope', ok: false, detail: 'page.click: Timeout 5000ms exceeded.' }]);
  });

  it('실패: 가려진 버튼·비활성 버튼은 시간 초과이고 누르지 않는다', async () => {
    const covered = await compareFailure('/steps-covered', { steps: [{ click: '#b' }] });
    expect(covered.message).toBe('1번째 단계 실패 (click #b): page.click: Timeout 5000ms exceeded.');
    const disabled = await compareFailure('/steps-disabled', { steps: [{ click: 'text=비활성 버튼' }] });
    expect(disabled.message).toBe('1번째 단계 실패 (click text=비활성 버튼): page.click: Timeout 5000ms exceeded.');
  });

  it('실패: 보이지 않는 요소 waitFor, input이 아닌 요소 fill, 편집할 수 없는 입력, 알 수 없는 키, 깨진 선택자', async () => {
    const hidden = await compareFailure('/steps-hidden', { steps: [{ waitFor: '#h' }] });
    expect(hidden.message).toBe('1번째 단계 실패 (waitFor #h): page.waitForSelector: Timeout 5000ms exceeded.');
    const notInput = await compareFailure('/steps-fill', { steps: [{ fill: { selector: '#plain', text: 'x' } }] });
    expect(notInput.message).toBe('1번째 단계 실패 (fill #plain): page.fill: Error: Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]');
    const readonly = await compareFailure('/steps-fill', { steps: [{ fill: { selector: '#ro', text: 'x' } }] });
    expect(readonly.message).toMatch(/^1번째 단계 실패 \(fill #ro\): page\.fill: Timeout 5000ms exceeded\.$/);
    const checkbox = await compareFailure('/steps-fill', { steps: [{ fill: { selector: '#chk', text: 'x' } }] });
    expect(checkbox.message).toBe('1번째 단계 실패 (fill #chk): page.fill: Error: Input of type "checkbox" cannot be filled');
    const unknownKey = await compareFailure('/steps-keys', { steps: [{ press: 'NoSuchKey' }] });
    expect(unknownKey.message).toBe('1번째 단계 실패 (press NoSuchKey): keyboard.press: Unknown key: "NoSuchKey"');
    await compareFailure('/steps-keys', { steps: [{ press: 'Control+NoSuchKey' }] });
    const badSelector = await compareFailure('/steps', { steps: [{ click: 'button[' }] });
    expect(badSelector.message).toBe('1번째 단계 실패 (click button[): page.click: Unexpected token "" while parsing css selector "button[". Did you mean to CSS.escape it?');
    // 틀린 선택자는 5초를 기다리지 않고 바로 실패한다. 모르는 엔진도 같은 규칙으로 바로 실패한다
    await compareFailure('/steps', { steps: [{ waitFor: 'nosuchengine=abc' }] });
    await compareFailure('/steps', { steps: [{ click: 'text=' }] });
    // 페이지 안에서 던진 오류는 스택이 붙어 여러 줄이다. 첫 줄만 쓴다
    const xpath = await compareFailure('/steps', { steps: [{ click: 'xpath=//*[' }] });
    expect(xpath.message.includes('\n')).toBe(false);
  });

  it('동작이 없는 단계는 단계 실패로 감싸지 않고 그 자리에서 던진다 (앞 단계는 돈다)', async () => {
    const failure = await compareFailure('/steps', { steps: [{ click: '#go' }, {} as never] });
    expect(failure.kind).toBe('StepWithoutActionError');
    expect(failure.message).toBe('2번째 단계에 실행할 동작이 없습니다 (click, fill, press, waitFor 중 하나가 필요합니다)');
    const native = await runInBrowserNative(`${base}/steps`, { steps: [{} as never] }).catch((error: unknown) => error);
    expect(native).toBeInstanceOf(StepWithoutActionError);
  });

  it('단계가 보낸 fetch가 500을 받으면 둘 다 failedRequests에 남긴다 (#684: 단계 뒤 요청을 기다린다)', async () => {
    for (const selector of ['#fast', '#slow']) {
      const { native } = await compare('/steps-fetch', { steps: [{ click: selector }] });
      expect(native.failedRequests.some((line) => line.startsWith('500 ') && line.includes('/api/')), selector).toBe(true);
    }
    // 이어서 보내는 요청의 실패도 기다린다(응답을 받고 이어 보낸 요청)
    const chained = await compare('/steps-fetch', { steps: [{ click: '#chain' }] });
    expect(chained.native.failedRequests.some((line) => line.startsWith('404 ') && line.endsWith('/api/404'))).toBe(true);
  });

  it('capture: 단계 수(첫 화면 포함)만큼 PNG가 있고 크기가 뷰포트와 같다. 실패한 단계의 스크린샷도 담는다', async () => {
    const viewport = { width: 640, height: 480 };
    const { old, native } = await compare('/steps', { viewport, capture: true, steps: [{ click: '#go' }, { fill: { selector: '#q', text: '가' } }, { press: 'Enter' }] });
    for (const result of [old, native]) {
      expect(result.steps).toHaveLength(4);
      for (const step of result.steps) expect(pngSize(step.screenshot!), step.label).toEqual(viewport);
    }
    const failure = await compareFailure('/steps', { viewport, capture: true, steps: [{ click: '#go' }, { click: '#nope' }] });
    expect(failure.steps).toHaveLength(3);
    expect(failure.steps!.at(-1)).toMatchObject({ ok: false, screenshot: { png: viewport } });
    // 켜지 않으면 스크린샷이 없다
    const off = await runInBrowserNative(`${base}/steps`, { viewport, steps: [{ click: '#go' }] });
    expect(off.steps.every((step) => step.screenshot === undefined)).toBe(true);
  });

  it('출처 제한과 함께: 단계가 허용 밖으로 fetch·이동·이미지를 보내면 막히고 기록되고 서버에 닿지 않는다', async () => {
    outsideHits = 0;
    const { native } = await compare('/steps-outside', { allowedOrigins: [base], steps: [{ click: '#f' }, { click: '#i' }, { click: '#n' }] }, false, true);
    expect(outsideHits).toBe(0);
    expect(native.blockedRequests).toEqual(expect.arrayContaining([`${outsideBase}/data.json`, `${outsideBase}/pixel.png`, `${outsideBase}/page`]));
    expect(native.failedRequests).toEqual([]);
    // 막힌 이동 뒤의 브라우저 오류 화면은 빈 문서로 읽는다(옛 러너는 headless shell에서 빈 문서, 시스템 Chrome에서 오류 문구를 읽는다. 의도한 차이): 오류 문구(페이지가 고른 호스트 이름이 들어간다)를 화면 글자로 읽지 않는다
    expect(native.text).toBe('');
    const withViewport = await compare('/steps-outside', { allowedOrigins: [base], steps: [{ click: '#n' }], viewportTexts: ['밖으로 이동', 'ERR_BLOCKED_BY_CLIENT'] }, false, true);
    expect(withViewport.native.viewportTexts?.findings.every((finding) => !finding.visible)).toBe(true);
  });

  it('페이지가 막힌 곳으로 스스로 이동해 브라우저 오류 화면이 떠도 그 문구(페이지가 고른 호스트 이름)를 화면 글자로 읽지 않는다', async () => {
    const { native } = await compare('/blocked-nav', { allowedOrigins: [base] }, false, true);
    expect(native.text).toBe('');
    expect(native.text).not.toContain('order-done');
    expect(native.blockedRequests).toContain('http://order-done.invalid/');
  });

  it('막힌 곳으로 이동한 뒤의 브라우저 오류 화면에서 단계의 선택자는 아무것도 찾지 못한다 (오류 문구로 waitFor·click을 통과시키지 않는다)', async () => {
    // 옛 러너는 headless shell에서 이 두 단계가 시간 초과로 실패한다(시스템 Chrome에서는 오류 화면의 문구·버튼을 찾아 통과한다)
    for (const step of [{ waitFor: 'text=order-done' }, { click: 'button' }]) {
      const failure = await runInBrowserNative(`${base}/blocked-nav`, { allowedOrigins: [base], steps: [step] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, JSON.stringify(step)).toBeInstanceOf(StepFailedError);
      expect((failure as StepFailedError).message).toMatch(/Timeout 5000ms exceeded/);
    }
  }, 30_000);

  it('의도한 차이: 페이지가 전역을 바꿔 글자·넘침·보임 판정을 속여도 Rust 러너는 진짜 값을 잰다 (옛 러너는 속는다)', async () => {
    const options: BrowserPageOptions = { viewport: { width: 800, height: 400 }, viewportTexts: ['숨은 글자', '진짜 글자'] };
    const old = await runInBrowser(`${base}/forged`, options);
    const native = await runInBrowserNative(`${base}/forged`, options);
    // 옛 러너(같은 실행 환경에서 잼): 위조된 글자, 가로 넘침 0, 숨은 글자가 "보인다"
    expect(old.text).toBe('위조된 글자 주문 완료');
    expect(old.horizontalOverflowPx).toBe(0);
    expect(old.viewportTexts?.findings.find((finding) => finding.text === '숨은 글자')?.visible).toBe(true);
    // Rust 러너(격리된 실행 환경에서 잼): 진짜 값
    expect(native.text).toContain('진짜 글자');
    expect(native.text).not.toContain('위조된');
    expect(native.horizontalOverflowPx).toBe(100);
    const hidden = native.viewportTexts?.findings.find((finding) => finding.text === '숨은 글자');
    expect(hidden).toMatchObject({ visible: false });
    expect(hidden?.problem?.kind).not.toBe(undefined);
    expect(native.viewportTexts?.findings.find((finding) => finding.text === '진짜 글자')?.visible).toBe(true);
    // 로드 시간도 격리된 실행 환경에서 읽힌다
    const timed = await runInBrowserNative(`${base}/forged`, { measureLoad: true });
    expect(timed.loadMs).toBeGreaterThanOrEqual(0);
  });

  it('중단 신호가 단계 도중에 와도 브라우저·프록시·임시 폴더가 남지 않고 중단 오류로 끝난다', async () => {
    const savedTmpdir = process.env.TMPDIR;
    const isolated = mkdtempSync(path.join(tmpdir(), 'runner-abort-steps-'));
    process.env.TMPDIR = isolated;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 900);
      const startedAt = Date.now();
      // 없는 선택자를 5초까지 기다리는 도중에 중단한다
      await expect(runInBrowserNative(`${base}/steps`, { signal: controller.signal, allowedOrigins: [base], steps: [{ click: '#nope' }] })).rejects.toThrow(/abort/i);
      expect(Date.now() - startedAt).toBeLessThan(4000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(tmpEntries().filter((name) => name.startsWith('b-studio-cdp-'))).toEqual([]);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

function tmpEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('b-studio-cdp-') || name.startsWith('playwright_chromiumdev_profile-'));
}

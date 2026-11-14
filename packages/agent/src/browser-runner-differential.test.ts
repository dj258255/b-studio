import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserUnavailableError, runInBrowser, type BrowserPageResult, type BrowserPageOptions } from './browser-check';
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

afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

/**
 * 서로 다른 요청의 실패·미디어 오류·막은 요청은 네트워크 도착 순서로 쌓이는데, 같은 러너를 두 번 돌려도 그 순서가 달라진다(실측: 옛 러너도 6회 중 2가지 순서).
 * 그래서 이 목록들은 정렬해서 견준다. 한 스크립트 안에서 차례로 부르는 console·예외는 순서까지 견준다. 워커·iframe처럼 대상이 여럿인 페이지만 `unorderedErrors`로 정렬한다
 */
const normalize = ({ loadMs: _loadMs, ...rest }: BrowserPageResult, unorderedErrors: boolean) => ({
  ...rest,
  failedRequests: [...rest.failedRequests].sort(),
  mediaErrors: [...rest.mediaErrors].sort(),
  blockedRequests: [...rest.blockedRequests].sort(),
  ...(unorderedErrors ? { consoleErrors: [...rest.consoleErrors].sort(), pageErrors: [...rest.pageErrors].sort() } : {}),
});

/** 둘 다 돌려 `loadMs`를 뺀 결과를 견준다 */
async function compare(path: string, options: BrowserPageOptions = {}, unorderedErrors = false): Promise<{ old: BrowserPageResult; native: BrowserPageResult }> {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const old = await runInBrowser(url, options);
  const native = await runInBrowserNative(url, options);
  expect(normalize(native, unorderedErrors), path).toEqual(normalize(old, unorderedErrors));
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

  it('measureLoad를 켜면 둘 다 loadMs를 0 이상으로 재고, 워밍업 이동의 오류는 비운다', async () => {
    const { old, native } = await compare('/ok', { measureLoad: true });
    expect(old.loadMs).toBeGreaterThanOrEqual(0);
    expect(native.loadMs).toBeGreaterThanOrEqual(0);
    await compare('/resources', { measureLoad: true });
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
    const profilesBefore = tmpEntries();
    for (const runner of [runInBrowser, runInBrowserNative]) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 700);
      await expect(runner(`${base}/hanging-request`, { signal: controller.signal, allowedOrigins: [base] })).rejects.toThrow(/abort/i);
      const already = new AbortController();
      already.abort();
      await expect(runner(`${base}/ok`, { signal: already.signal })).rejects.toThrow(/abort/i);
    }
    // Playwright의 프로필 폴더는 자기 이름으로 지우고, Rust 러너는 이 러너가 만든 폴더만 지운다
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(tmpEntries().filter((name) => !profilesBefore.includes(name))).toEqual([]);
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

  it('아직 지원하지 않는 입력은 조용히 무시하지 않고, 브라우저 없음이 아닌 오류로 던진다', async () => {
    const attempts: BrowserPageOptions[] = [{ steps: [{ click: 'button' }] }, { capture: true }, { onFrame: () => {} }];
    for (const options of attempts) {
      const error = await runInBrowserNative(`${base}/ok`, options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BrowserUnavailableError);
      expect((error as Error).message).toMatch(/아직 지원하지 않/);
    }
  });
});

function tmpEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('b-studio-cdp-') || name.startsWith('playwright_chromiumdev_profile-'));
}

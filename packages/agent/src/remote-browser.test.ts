import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRemoteBrowser, type RemoteBrowser } from './remote-browser';

// 실제 헤드리스 Chromium을 띄운다. 브라우저가 없으면 기존 browser-check 테스트와 같이 건너뛰지 않고 실패한다
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 1×1 투명 PNG */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let server: Server;
let other: Server;
let base = '';
let otherBase = '';
/** 허용하지 않은 서버로 실제 요청이 닿았는지. 라우트가 막으면 0이어야 한다 */
let otherHits = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 어떤 요소(0,0 자리)의 HTML이 문구를 담을 때까지 기다린다. 화면의 스크립트가 끝났는지 보는 데 쓴다 */
async function waitForHtml(browser: RemoteBrowser, text: string, timeoutMs = 8_000): Promise<string> {
  const start = Date.now();
  let html = '';
  while (Date.now() - start < timeoutMs) {
    html = (await browser.pick(10, 10)).html;
    if (html.includes(text)) return html;
    await sleep(50);
  }
  return html;
}

/** 어떤 요소(0,0 자리)의 HTML이 문구를 더 이상 담지 않을 때까지 기다린다 */
async function waitForHtmlChange(browser: RemoteBrowser, initial: string, timeoutMs = 8_000): Promise<string> {
  const start = Date.now();
  let html = '';
  while (Date.now() - start < timeoutMs) {
    html = (await browser.pick(10, 10)).html;
    if (!html.includes(initial)) return html;
    await sleep(50);
  }
  return html;
}

/** 허용한 서버가 내려주는 페이지. 일부는 허용하지 않은 서버 주소를 참조하므로 그때그때 만든다 */
function pages(): Record<string, string> {
  const head = '<html><head><style>body { margin: 0 }</style></head><body>';
  const box = 'position:fixed;top:0;left:0;width:300px;height:50px';
  return {
    // 위쪽 카운터와 아래쪽 버튼. 버튼을 누르면 카운터가 오른다
    '/counter': `<html><head><style>body { margin: 0 }</style></head><body>
<div id="count" style="position:fixed;top:0;left:0;width:100px;height:50px">0</div>
<button id="go" style="position:fixed;top:100px;left:0;width:400px;height:300px">+</button>
<script>document.getElementById('go').onclick = () => { const count = document.getElementById('count'); count.textContent = String(Number(count.textContent) + 1); };</script>
</body></html>`,
    // 입력칸에 친 값이 아래 div로 옮겨 그려진다
    '/type': `<html><body style="margin:0">
<input id="q" style="position:fixed;top:0;left:0;width:300px;height:40px">
<div id="out" style="position:fixed;top:60px;left:0;width:300px;height:40px"></div>
<script>document.getElementById('q').oninput = () => { document.getElementById('out').textContent = document.getElementById('q').value; };</script>
</body></html>`,
    // 요소 선택(pick)용 페이지. id·data-testid·클래스와 계산 스타일을 함께 본다
    '/pick': `<html><body style="margin:0">
<div id="card" data-testid="card" class="panel box" style="margin:8px;padding:4px;display:flex;gap:6px;color:rgb(10,20,30);background-color:rgb(240,240,240)"><span style="font-size:13px">안녕</span></div>
</body></html>`,
    // 허용하지 않은 출처로 나가는 링크
    '/link': `${head}<a id="out" href="${otherBase}/landing" style="${box}">stay</a></body></html>`,
    // 허용하지 않은 출처로 fetch
    '/fetch-blocked': `${head}<div id="out" style="${box}">pending</div>
<script>fetch('${otherBase}/data.json').then((response) => response.text()).then(() => { document.getElementById('out').textContent = 'ok'; }).catch(() => { document.getElementById('out').textContent = 'fail'; });</script></body></html>`,
    // 허용한 출처로 fetch
    '/fetch-ok': `${head}<div id="out" style="${box}">pending</div>
<script>fetch('/data.json').then((response) => response.json()).then((data) => { document.getElementById('out').textContent = 'ok:' + data.value; }).catch(() => { document.getElementById('out').textContent = 'fail'; });</script></body></html>`,
    // 허용하지 않은 출처의 이미지
    '/img-blocked': `${head}<div id="out" style="${box}">pending</div>
<img src="${otherBase}/pixel.png" onload="document.getElementById('out').textContent='loaded'" onerror="document.getElementById('out').textContent='error'"></body></html>`,
    // 허용한 출처의 이미지
    '/img-ok': `${head}<div id="out" style="${box}">pending</div>
<img src="/pixel.png" onload="document.getElementById('out').textContent='loaded'" onerror="document.getElementById('out').textContent='error'"></body></html>`,
    // 서비스 워커를 등록하려는 페이지. 원격 브라우저는 등록을 막아야 한다
    '/sw': `${head}<div id="out" style="${box}">pending</div>
<script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.getRegistrations()).then((registrations) => { document.getElementById('out').textContent = 'registered:' + registrations.length; }).catch(() => { document.getElementById('out').textContent = 'failed'; });</script></body></html>`,
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PIXEL);
      return;
    }
    if (path === '/data.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"value":"allowed"}');
      return;
    }
    if (path === '/sw.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('self.addEventListener("install", () => {});');
      return;
    }
    const body = pages()[path];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  other = createServer((request, response) => {
    otherHits += 1;
    response.writeHead(200, { 'content-type': request.url === '/data.json' ? 'application/json' : 'text/html; charset=utf-8' });
    response.end(request.url === '/data.json' ? '{"value":"other"}' : request.url === '/pixel.png' ? PIXEL : '<html><body>landing</body></html>');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      other.close(() => server.close(() => resolve()));
    }),
);

describe('openRemoteBrowser', { timeout: 60_000 }, () => {
  it('마우스 클릭을 CDP로 되돌려 보내 페이지 상태를 바꾼다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/counter`, viewport: { width: 400, height: 400 }, allowedOrigins: [base], onFrame: () => {} });
    try {
      await browser.mouse({ type: 'down', x: 200, y: 300 });
      await browser.mouse({ type: 'up', x: 200, y: 300 });
      expect((await browser.pick(10, 10)).html).toContain('>1<');
    } finally {
      await browser.close();
    }
  });

  it('type으로 입력칸에 텍스트를 넣는다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/type`, viewport: { width: 400, height: 400 }, allowedOrigins: [base], onFrame: () => {} });
    try {
      await browser.mouse({ type: 'down', x: 100, y: 20 });
      await browser.mouse({ type: 'up', x: 100, y: 20 });
      await browser.type('김토스');
      expect((await browser.pick(10, 70)).html).toContain('김토스');
    } finally {
      await browser.close();
    }
  });

  it('pick은 선택자·HTML·계산 스타일·잘라 낸 스크린샷·영역을 돌려준다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/pick`, viewport: { width: 400, height: 400 }, allowedOrigins: [base], onFrame: () => {} });
    try {
      const picked = await browser.pick(10, 10);
      expect(picked.selector).toBe('#card');
      expect(picked.html).toContain('data-testid="card"');
      expect(picked.css.display).toBe('flex');
      expect(picked.css['background-color']).toBe('rgb(240, 240, 240)');
      expect(picked.css).toHaveProperty('font-size');
      expect(picked.rect.x).toBeCloseTo(8, 0);
      expect(picked.rect.y).toBeCloseTo(8, 0);
      expect(picked.rect.width).toBeGreaterThan(0);
      expect(picked.screenshot.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    } finally {
      await browser.close();
    }
  });

  it('navigate·reload·resize로 화면을 바꾸고 이동을 알린다', async () => {
    const navigated: string[] = [];
    const browser = await openRemoteBrowser({
      url: `${base}/counter`,
      viewport: { width: 400, height: 400 },
      allowedOrigins: [base],
      onFrame: () => {},
      onNavigate: (url) => navigated.push(url),
    });
    try {
      await browser.navigate(`${base}/pick`);
      await browser.reload();
      await browser.resize({ width: 320, height: 480 });
      expect(navigated.some((url) => url.endsWith('/pick'))).toBe(true);
      expect((await browser.pick(10, 10)).selector).toBe('#card');
    } finally {
      await browser.close();
    }
  });

  it('close를 두 번 불러도 안전하다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/pick`, viewport: { width: 400, height: 400 }, allowedOrigins: [base], onFrame: () => {} });
    await browser.close();
    await browser.close();
  });
});

describe('허용한 출처만 요청을 내보낸다', { timeout: 60_000 }, () => {
  const allowed = () => [base];

  it('허용하지 않은 출처로 나가는 링크 이동을 막고 알린다', async () => {
    const blocked: Array<{ url: string; kind: string }> = [];
    const navigated: string[] = [];
    otherHits = 0;
    const browser = await openRemoteBrowser({
      url: `${base}/link`,
      viewport: { width: 400, height: 400 },
      allowedOrigins: allowed(),
      onFrame: () => {},
      onBlocked: (event) => blocked.push(event),
      onNavigate: (url) => navigated.push(url),
    });
    try {
      // 링크를 눌러 이동을 시도한다
      await browser.mouse({ type: 'down', x: 100, y: 25 });
      await browser.mouse({ type: 'up', x: 100, y: 25 });
      const start = Date.now();
      while (Date.now() - start < 8_000 && !blocked.some((event) => event.kind === 'navigation')) await sleep(50);

      expect(blocked.some((event) => event.kind === 'navigation' && event.url.startsWith(otherBase))).toBe(true);
      // 허용하지 않은 출처로 실제 이동하지 않았고, 그 서버로 요청이 닿지도 않았다
      expect(navigated.every((url) => !url.startsWith(otherBase))).toBe(true);
      expect(otherHits).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('허용하지 않은 출처로의 fetch와 img를 막고, 허용한 출처는 통과시킨다', async () => {
    const blocked: Array<{ url: string; kind: string }> = [];
    otherHits = 0;
    const blockedBrowser = await openRemoteBrowser({
      url: `${base}/fetch-blocked`,
      viewport: { width: 400, height: 400 },
      allowedOrigins: allowed(),
      onFrame: () => {},
      onBlocked: (event) => blocked.push(event),
    });
    const imgBrowser = await openRemoteBrowser({
      url: `${base}/img-blocked`,
      viewport: { width: 400, height: 400 },
      allowedOrigins: allowed(),
      onFrame: () => {},
      onBlocked: (event) => blocked.push(event),
    });
    try {
      expect(await waitForHtml(blockedBrowser, 'fail')).toContain('fail');
      expect(await waitForHtml(imgBrowser, 'error')).toContain('error');
      expect(blocked.filter((event) => event.kind === 'resource').length).toBeGreaterThanOrEqual(2);
      expect(blocked.every((event) => event.url.startsWith(otherBase))).toBe(true);
      expect(otherHits).toBe(0);
    } finally {
      await blockedBrowser.close();
      await imgBrowser.close();
    }
  });

  it('허용한 출처의 fetch와 img는 통과한다', async () => {
    const fetchBrowser = await openRemoteBrowser({ url: `${base}/fetch-ok`, viewport: { width: 400, height: 400 }, allowedOrigins: allowed(), onFrame: () => {} });
    const imgBrowser = await openRemoteBrowser({ url: `${base}/img-ok`, viewport: { width: 400, height: 400 }, allowedOrigins: allowed(), onFrame: () => {} });
    try {
      expect(await waitForHtml(fetchBrowser, 'ok:allowed')).toContain('ok:allowed');
      expect(await waitForHtml(imgBrowser, 'loaded')).toContain('loaded');
    } finally {
      await fetchBrowser.close();
      await imgBrowser.close();
    }
  });
});

describe('서비스 워커를 막는다', { timeout: 60_000 }, () => {
  it('등록을 막아 page.route를 우회하는 요청 경로를 없앤다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/sw`, viewport: { width: 400, height: 400 }, allowedOrigins: [base], onFrame: () => {} });
    try {
      const html = await waitForHtmlChange(browser, 'pending');
      // 등록이 거부되거나(failed), 등록 수가 0이어야 한다. 실제로 등록되면(registered:1 이상) 안 된다
      expect(html).toMatch(/failed|registered:0/);
    } finally {
      await browser.close();
    }
  });
});

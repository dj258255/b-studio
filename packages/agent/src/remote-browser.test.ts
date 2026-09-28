import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRemoteBrowser } from './remote-browser';

// 실제 헤드리스 Chromium을 띄운다. 브라우저가 없으면 기존 browser-check 테스트와 같이 건너뛰지 않고 실패한다
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PAGES: Record<string, string> = {
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
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('openRemoteBrowser', { timeout: 60_000 }, () => {
  it('마우스 클릭을 CDP로 되돌려 보내 페이지 상태를 바꾼다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/counter`, viewport: { width: 400, height: 400 }, onFrame: () => {} });
    try {
      await browser.mouse({ type: 'down', x: 200, y: 300 });
      await browser.mouse({ type: 'up', x: 200, y: 300 });
      expect((await browser.pick(10, 10)).html).toContain('>1<');
    } finally {
      await browser.close();
    }
  });

  it('type으로 입력칸에 텍스트를 넣는다', async () => {
    const browser = await openRemoteBrowser({ url: `${base}/type`, viewport: { width: 400, height: 400 }, onFrame: () => {} });
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
    const browser = await openRemoteBrowser({ url: `${base}/pick`, viewport: { width: 400, height: 400 }, onFrame: () => {} });
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
    const browser = await openRemoteBrowser({ url: `${base}/pick`, viewport: { width: 400, height: 400 }, onFrame: () => {} });
    await browser.close();
    await browser.close();
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInBrowser, StepFailedError, type BrowserFrame } from './browser-check';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);
/** 1×1 투명 PNG */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// 실제 헤드리스 Chromium을 띄운다. 브라우저가 없으면 건너뛰지 않고 실패한다. 건너뛰면 검사 안 함이 통과처럼 보인다
const PAGES: Record<string, string> = {
  '/ok': `<html><body><h1 id="title"></h1><script>document.getElementById('title').textContent = '주문 목록'</script></body></html>`,
  '/broken': `<html><body><p>로딩</p><script>console.error('hydration failed'); window.missing.call()</script></body></html>`,
  '/missing-chunk': `<html><body><p>표</p><script src="/chunk.js"></script></body></html>`,
  '/wide': `<html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><div style="width:900px">표</div></body></html>`,
  // 입력값을 버튼으로 옮겨 그리는 페이지. 처음 화면에는 결과 문구가 없다
  '/interactive': `<html><body><input id="q"><button id="go" onclick="document.getElementById('out').textContent = document.getElementById('q').value">검색</button><p id="out"></p></body></html>`,
  // 입력칸에서 Enter를 누르면 폼이 제출되는 페이지
  '/form': `<html><body><form onsubmit="event.preventDefault(); document.getElementById('done').textContent = '제출됨'"><input id="name"></form><p id="done"></p></body></html>`,
  // screencast가 볼 화면 변화를 계속 만드는 페이지
  '/animation': `<html><body style="margin:0"><script>let i = 0; const timer = setInterval(() => { document.body.style.background = i++ % 2 ? 'red' : 'blue'; }, 50); setTimeout(() => clearInterval(timer), 1500);</script></body></html>`,
  // 트러블슈팅 83: 상대 경로 미디어 주소가 404여서 재생되지 않는 <video>·<img>
  '/video-404': `<html><body><video id="v" preload="auto" src="/missing.mp4"></video></body></html>`,
  // 안쪽 스크롤 영역에 잘린 줄(도그푸딩 사례): 영역 높이 100px 안에 150px짜리 내용이 있고, 두 번째 줄은 창 안이지만 영역 밖으로 잘린다
  '/vp-clipped': `<html><body style="margin:0"><div class="shorts-scroller" style="height:100px;overflow:auto"><p style="margin:0;height:70px">영상</p><p style="margin:0;height:40px" id="login">주문하려면 로그인하세요</p></div></body></html>`,
  '/vp-visible': `<html><body style="margin:0"><div class="box" style="height:200px;overflow:auto"><button style="height:30px">바로 주문</button></div></body></html>`,
  '/vp-below': `<html><body style="margin:0"><div style="height:900px">채움</div><button style="height:40px;margin:0">바로 주문</button></body></html>`,
  '/vp-none': `<html><body style="margin:0"><p>다른 글자</p><p style="display:none">바로 주문</p></body></html>`,
  '/vp-hidden': `<html><body style="margin:0"><p style="visibility:hidden">바로 주문</p></body></html>`,
  '/vp-twin': `<html><body style="margin:0"><div style="height:100px;overflow:hidden"><span style="display:block;height:40px"></span><b>바로 주문</b></div><p style="margin:0">바로 주문</p></body></html>`,
  '/vp-twin-hidden': `<html><body style="margin:0"><p style="display:none">바로 주문</p><p style="margin:0">바로 주문</p></body></html>`,
  '/img-404': `<html><body><img id="i" src="/missing.png"></body></html>`,
};

let server: Server;
let other: Server;
let base = '';
let otherBase = '';
/** 허용하지 않은 서버로 실제 요청이 닿았는지. 라우트가 막으면 0이어야 한다 */
let otherHits = 0;

/** 기준 서버에 없는, 허용하지 않은 출처를 참조하는 페이지들. 그때그때 만든다 */
function dynamicPages(): Record<string, string> {
  return {
    '/mixed': `<html><body><img src="${otherBase}/pixel.png"><script>fetch('${otherBase}/data.json').catch(() => {});</script></body></html>`,
    '/fetch-ok': `<html><body><div id="out">pending</div><script>fetch('/data.json').then((response) => response.json()).then((data) => { document.getElementById('out').textContent = 'ok:' + data.value; }).catch(() => { document.getElementById('out').textContent = 'fail'; });</script></body></html>`,
    '/sw': `<html><body><div id="out">pending</div><script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.getRegistrations()).then((registrations) => { document.getElementById('out').textContent = 'registered:' + registrations.length; }).catch(() => { document.getElementById('out').textContent = 'failed'; });</script></body></html>`,
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/data.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"value":"allowed"}');
      return;
    }
    if (path === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PIXEL);
      return;
    }
    if (path === '/sw.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('self.addEventListener("install", () => {});');
      return;
    }
    const body = PAGES[path] ?? dynamicPages()[path];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  other = createServer((_request, response) => {
    otherHits += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('other');
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

describe('runInBrowser', { timeout: 60_000 }, () => {
  it('클라이언트 스크립트가 만든 텍스트를 렌더링 뒤에 읽는다 (HTTP 본문에는 없는 문구)', async () => {
    const result = await runInBrowser(`${base}/ok`, {});
    // 서버에 favicon이 없어 브라우저가 스스로 연 /favicon.ico는 404지만 실패로 세지 않는다
    expect(result).toMatchObject({ status: 200, pageErrors: [], consoleErrors: [], failedRequests: [], horizontalOverflowPx: 0 });
    expect(result.text).toContain('주문 목록');
  });

  it('스크립트 예외와 console.error를 모은다', async () => {
    const result = await runInBrowser(`${base}/broken`, {});
    expect(result.status).toBe(200);
    expect(result.pageErrors.join()).toMatch(/Cannot read properties of undefined/);
    expect(result.consoleErrors).toContain('hydration failed');
  });

  it('페이지가 부른 리소스가 404면 URL과 함께 실패한 요청으로 남긴다', async () => {
    const result = await runInBrowser(`${base}/missing-chunk`, {});
    expect(result.failedRequests).toEqual([`404 ${base}/chunk.js`]);
    expect(result.consoleErrors).toEqual([]);
  });

  it('모바일 창 크기에서 가로 넘침을 잰다', async () => {
    const mobile = await runInBrowser(`${base}/wide`, { viewport: { width: 390, height: 844 } });
    expect(mobile.horizontalOverflowPx).toBe(900 - 390);
    const desktop = await runInBrowser(`${base}/wide`, { viewport: { width: 1280, height: 800 } });
    expect(desktop.horizontalOverflowPx).toBe(0);
  });

  it('선언한 단계를 순서대로 실행해 처음에는 없던 문구가 나타난다', async () => {
    // 단계 없이 열면 결과 문구가 없어야 단계가 실제로 화면을 바꿨다는 증거가 된다
    expect((await runInBrowser(`${base}/interactive`, {})).text).not.toContain('김토스');
    const result = await runInBrowser(`${base}/interactive`, {
      steps: [{ fill: { selector: '#q', text: '김토스' } }, { click: '#go' }, { waitFor: 'text=김토스' }],
    });
    expect(result.text).toContain('김토스');
  });

  it('단계가 실패하면 몇 번째 단계였는지와 선택자를 담아 그 자리에서 멈춘다', async () => {
    await expect(runInBrowser(`${base}/interactive`, { steps: [{ click: '#go' }, { click: '[data-testid=missing]' }] })).rejects.toThrow(
      '2번째 단계 실패 (click [data-testid=missing])',
    );
  });

  it('press로 폼을 제출한 뒤의 화면을 읽는다', async () => {
    expect((await runInBrowser(`${base}/form`, {})).text).not.toContain('제출됨');
    const result = await runInBrowser(`${base}/form`, {
      steps: [{ fill: { selector: '#name', text: '김토스' } }, { press: 'Enter' }, { waitFor: 'text=제출됨' }],
    });
    expect(result.text).toContain('제출됨');
  });

  it('실행할 동작이 없는 단계는 조용히 넘기지 않고 몇 번째 단계인지 알린다', async () => {
    await expect(runInBrowser(`${base}/interactive`, { steps: [{ click: '#go' }, {} as never] })).rejects.toThrow(
      '2번째 단계에 실행할 동작이 없습니다 (click, fill, press, waitFor 중 하나가 필요합니다)',
    );
  });

  it('capture를 켜면 열기와 단계마다 결과를 남기고 PNG 스크린샷을 찍는다', async () => {
    const result = await runInBrowser(`${base}/interactive`, {
      capture: true,
      steps: [{ fill: { selector: '#q', text: '김토스' } }, { click: '#go' }],
    });
    expect(result.steps.map((step) => [step.label, step.ok])).toEqual([
      ['open /interactive', true],
      ['fill #q', true],
      ['click #go', true],
    ]);
    for (const step of result.steps) expect(step.screenshot?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('capture를 끄면 스크린샷 없이 단계 결과만 남긴다', async () => {
    const result = await runInBrowser(`${base}/interactive`, { steps: [{ click: '#go' }] });
    expect(result.steps.map((step) => step.label)).toEqual(['open /interactive', 'click #go']);
    expect(result.steps.every((step) => step.screenshot === undefined)).toBe(true);
  });

  it('단계가 실패하면 던지기 전에 실패 단계의 스크린샷을 예외에 담는다', async () => {
    const error = await runInBrowser(`${base}/interactive`, {
      capture: true,
      steps: [{ click: '#go' }, { click: '[data-testid=missing]' }],
    }).then(
      () => expect.unreachable('단계 실패로 끝나야 합니다'),
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StepFailedError);
    const steps = (error as StepFailedError).steps;
    expect(steps.map((step) => [step.label, step.ok])).toEqual([
      ['open /interactive', true],
      ['click #go', true],
      ['click [data-testid=missing]', false],
    ]);
    expect(steps.at(-1)?.detail).toBeTruthy();
    expect(steps.at(-1)?.screenshot?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('onFrame으로 JPEG 프레임을 받되 초당 5장 상한을 넘지 않는다', async () => {
    const frames: BrowserFrame[] = [];
    await runInBrowser(`${base}/animation`, { viewport: { width: 400, height: 300 }, onFrame: (frame) => frames.push(frame) });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.data.subarray(0, 2)).toEqual(JPEG_SIGNATURE);
    expect(frames[0]?.width).toBe(400);
    // 콜백은 시간 기준으로 걸러지므로 연속한 프레임 간격이 200ms보다 좁을 수 없다
    for (const [index, frame] of frames.slice(1).entries()) expect(frame.at - frames[index]!.at).toBeGreaterThanOrEqual(190);
  });

  it('allowedOrigins가 있으면 허용한 출처 밖 요청을 막고, 실패가 아니라 기록으로 남긴다', async () => {
    otherHits = 0;
    const result = await runInBrowser(`${base}/mixed`, { allowedOrigins: [base] });
    expect(result.failedRequests).toEqual([]);
    expect([...result.blockedRequests].sort()).toEqual([`${otherBase}/data.json`, `${otherBase}/pixel.png`]);
    // 실제로 그 서버에 요청이 닿지 않았다
    expect(otherHits).toBe(0);
  });

  it('허용한 출처의 요청은 막지 않는다', async () => {
    const result = await runInBrowser(`${base}/fetch-ok`, { allowedOrigins: [base] });
    expect(result.blockedRequests).toEqual([]);
    expect(result.failedRequests).toEqual([]);
    expect(result.text).toContain('ok:allowed');
  });

  it('allowedOrigins가 있으면 서비스 워커 등록을 막는다', async () => {
    const result = await runInBrowser(`${base}/sw`, { allowedOrigins: [base] });
    expect(result.text).toMatch(/failed|registered:0/);
  });

  it('allowedOrigins를 넘기지 않으면 막지 않고 blockedRequests는 비어 있다', async () => {
    const result = await runInBrowser(`${base}/missing-chunk`, {});
    expect(result.blockedRequests).toEqual([]);
    expect(result.failedRequests).toEqual([`404 ${base}/chunk.js`]);
  });

  it('measureLoad를 켜면 워밍업 뒤 이동의 로드 시간을 잰다', async () => {
    const result = await runInBrowser(`${base}/ok`, { measureLoad: true });
    expect(result.text).toContain('주문 목록');
    expect(result.loadMs).toBeGreaterThanOrEqual(0);
    // 워밍업과 측정 두 번 이동하므로 첫 이동의 오류·실패 요청은 측정 결과에 남지 않는다
    expect(result.failedRequests).toEqual([]);
  });

  it('measureLoad를 켜지 않으면 로드 시간을 남기지 않는다', async () => {
    expect((await runInBrowser(`${base}/ok`, {})).loadMs).toBeUndefined();
  });

  describe('expectInViewport', () => {
    const vp = { width: 800, height: 600 };
    const measure = async (path: string, texts: string[], viewport = vp) => (await runInBrowser(`${base}${path}`, { viewport, viewportTexts: texts })).viewportTexts;

    it('창 안에 온전히 들어 있으면 보인다고 한다', async () => {
      const report = await measure('/vp-visible', ['바로 주문']);
      expect(report).toEqual({ width: 800, height: 600, findings: [{ text: '바로 주문', visible: true }] });
    });

    it('창 아래로 넘친 글자는 몇 px 넘쳤는지 알린다', async () => {
      const report = await measure('/vp-below', ['바로 주문'], { width: 800, height: 600 });
      // 900px 채움 + 버튼 40px = 940, 창 600
      expect(report?.findings[0]).toMatchObject({ text: '바로 주문', visible: false, problem: { kind: 'below', px: 340 } });
    });

    it('안쪽 스크롤 영역에 잘린 글자는 그 조상과 잘린 크기를 알린다 (창 안이어도)', async () => {
      const report = await measure('/vp-clipped', ['영상', '주문하려면 로그인하세요']);
      expect(report?.findings[0]).toEqual({ text: '영상', visible: true });
      expect(report?.findings[1]).toMatchObject({
        text: '주문하려면 로그인하세요',
        visible: false,
        problem: { kind: 'clipped', side: 'bottom', px: 10, by: 'div.shorts-scroller' },
      });
    });

    it('display:none 요소와 visibility:hidden 요소는 숨겨짐이다', async () => {
      expect((await measure('/vp-none', ['바로 주문']))?.findings[0]).toMatchObject({ visible: false, problem: { kind: 'hidden' } });
      expect((await measure('/vp-hidden', ['바로 주문']))?.findings[0]).toMatchObject({ visible: false, problem: { kind: 'hidden' } });
    });

    it('글자가 화면에 없으면 없음이다', async () => {
      expect((await measure('/vp-none', ['없는 글자']))?.findings[0]).toEqual({ text: '없는 글자', visible: false, problem: { kind: 'absent' } });
    });

    it('같은 글자가 둘이면 하나라도 온전히 보일 때 통과한다', async () => {
      expect((await measure('/vp-twin', ['바로 주문']))?.findings[0]).toEqual({ text: '바로 주문', visible: true });
      expect((await measure('/vp-twin-hidden', ['바로 주문']))?.findings[0]).toEqual({ text: '바로 주문', visible: true });
    });

    it('viewportTexts를 넘기지 않으면 재지 않는다', async () => {
      expect((await runInBrowser(`${base}/vp-visible`, {})).viewportTexts).toBeUndefined();
    });
  });

  it('<video>의 미디어 주소가 404면 재생 실패를 mediaErrors로 남긴다 (트러블슈팅 83)', async () => {
    const result = await runInBrowser(`${base}/video-404`, {});
    expect(result.mediaErrors).toHaveLength(1);
    expect(result.mediaErrors[0]).toContain('video');
    expect(result.mediaErrors[0]).toContain(`${base}/missing.mp4`);
    // 같은 네트워크 404는 failedRequests에도 남는다(다른 신호로 중복 확인)
    expect(result.failedRequests).toEqual([`404 ${base}/missing.mp4`]);
  });

  it('<img>가 404면 이미지 로드 실패를 mediaErrors로 남긴다', async () => {
    const result = await runInBrowser(`${base}/img-404`, {});
    expect(result.mediaErrors).toEqual([`img 이미지를 불러오지 못했습니다 ${base}/missing.png`]);
  });

  it('미디어 오류가 없으면 mediaErrors가 빈 배열이다', async () => {
    expect((await runInBrowser(`${base}/ok`, {})).mediaErrors).toEqual([]);
  });
});

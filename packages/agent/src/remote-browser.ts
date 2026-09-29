import { createScreencast, launchBrowser, restrictPageToOrigins, type BrowserFrame, type OriginBlockEvent } from './browser-check';

/**
 * 스튜디오 서버가 미리보기 패널용으로 소유하는 Chromium. 화면 확인(browser_check)과는 별개 인스턴스다.
 * 서버가 화면을 CDP screencast로 중계하고, 사용자의 입력을 CDP Input으로 되돌려 보낸다.
 */
const NAVIGATION_TIMEOUT_MS = 30_000;
const PICK_HTML_MAX = 4_000;
/** 요소를 설명할 때 읽는 계산 스타일 */
const PICK_STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'border-radius',
  'gap',
];

export interface RemoteBrowserViewport {
  width: number;
  height: number;
}

export interface RemoteBrowserMouseEvent {
  type: 'down' | 'up' | 'move' | 'wheel';
  x: number;
  y: number;
  /** 기본 left */
  button?: 'left' | 'right';
  deltaX?: number;
  deltaY?: number;
}

export interface RemoteBrowserKeyEvent {
  type: 'down' | 'up' | 'press';
  key: string;
  text?: string;
}

export interface RemoteBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RemoteBrowserPick {
  selector: string;
  html: string;
  css: Record<string, string>;
  screenshot: Buffer;
  /** 문서 좌표(스크롤 포함). page.screenshot의 clip은 문서 기준이라 스크린샷을 자를 때 이 값을 쓴다 */
  rect: RemoteBrowserRect;
  /** 뷰포트 좌표(스크롤 미포함, 고른 순간 화면에 보이던 그대로). 미리보기 위 오버레이 표시에 쓴다 */
  viewportRect: RemoteBrowserRect;
}

export interface RemoteBrowserOptions {
  url: string;
  viewport: RemoteBrowserViewport;
  /**
   * 이 브라우저가 요청해도 되는 출처(origin) 목록. 여기 없는 출처로 나가는 요청은 모두 막는다.
   * 서버 소유 브라우저라, 모델이 만든 페이지가 호스트 내부 주소나 외부로 나가면 서버 측 요청 위조 통로가 된다
   */
  allowedOrigins: string[];
  onFrame: (frame: BrowserFrame) => void;
  onNavigate?: (url: string) => void;
  /** 허용하지 않은 출처로 나가려던 요청을 막을 때마다 불린다 */
  onBlocked?: (event: OriginBlockEvent) => void;
}

export interface RemoteBrowser {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  resize(viewport: RemoteBrowserViewport): Promise<void>;
  mouse(event: RemoteBrowserMouseEvent): Promise<void>;
  key(event: RemoteBrowserKeyEvent): Promise<void>;
  type(text: string): Promise<void>;
  pick(x: number, y: number): Promise<RemoteBrowserPick>;
  /** 드래그한 사각형(뷰포트 좌표)이 덮는 요소를 고른다. 고르는 규칙은 pickRectExpression 참고 */
  pickRect(rect: RemoteBrowserRect): Promise<RemoteBrowserPick>;
  /** 좌표 아래 요소의 뷰포트 영역만 가볍게 돌려준다(스크린샷 없이). 고르기 모드의 마우스 오버 강조에 쓴다 */
  hover(x: number, y: number): Promise<{ rect: RemoteBrowserRect } | null>;
  close(): Promise<void>;
}

/**
 * 서버 소유 Chromium을 열고 첫 화면을 띄운다.
 * 허용한 출처로만 요청을 내보낸다: 메인 프레임·하위 프레임 이동과 하위 리소스(fetch·img·script 등)를 모두 검사해,
 * 허용 목록에 없는 출처면 막고 onBlocked으로 알린다. 그래서 모델이 만든 페이지가 막히더라도 호스트 내부나 외부로 새 나가지 않는다.
 * 세션마다 프로세스 하나를 쓰므로 다 쓰면 close()로 내려야 한다
 */
export async function openRemoteBrowser(options: RemoteBrowserOptions): Promise<RemoteBrowser> {
  const browser = await launchBrowser();
  try {
    // serviceWorkers: 'block'로 서비스 워커 등록을 막는다. 서비스 워커가 만든 요청은 page.route를 우회하므로,
    // 허용 출처 검사를 유일한 통로로 남기려면 꺼야 한다(대신 오프라인 캐시 같은 기능은 원격 미리보기에서 동작하지 않는다)
    const page = await browser.newPage({ viewport: options.viewport, serviceWorkers: 'block' });
    // 허용한 출처 밖으로 나가는 요청을 막는다(공통 규칙은 browser-check.ts). goto 전에 걸어 첫 문서 요청부터 검사한다
    await restrictPageToOrigins(page, options.allowedOrigins, options.onBlocked);
    const client = await page.context().newCDPSession(page);
    // createScreencast는 이 객체를 참조로 읽으므로 resize가 값을 바꾸면 프레임 크기 fallback도 따라간다
    const viewport = { width: options.viewport.width, height: options.viewport.height };
    const screencast = createScreencast(client, viewport, options.onFrame);

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) options.onNavigate?.(frame.url());
    });
    await screencast.start(viewport.width);
    await page.goto(options.url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });

    let closed = false;

    /** 영역을 자른 스크린샷은 잠깐 화면 크기를 바꿔 screencast가 잘린 프레임을 내보낸다. 페이지가 그 뒤 바뀌지 않으면
     * 새 프레임이 오지 않아 미리보기가 잘린 화면에 멈춘다. 찍는 동안 screencast를 멈췄다가 다시 켜 전체 화면 프레임을 받는다 */
    async function screenshotOf(rect: RemoteBrowserRect): Promise<Buffer> {
      await screencast.stop();
      try {
        return await page.screenshot({ type: 'png', clip: { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) } });
      } finally {
        await screencast.start(viewport.width);
      }
    }

    return {
      async navigate(url) {
        await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      },
      async reload() {
        await page.reload({ waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      },
      async resize(next) {
        await screencast.stop();
        viewport.width = next.width;
        viewport.height = next.height;
        await page.setViewportSize(next);
        await screencast.start(next.width);
      },
      async mouse(event) {
        const button = event.button ?? 'left';
        if (event.type === 'down' || event.type === 'up') {
          await client.send('Input.dispatchMouseEvent', {
            type: event.type === 'down' ? 'mousePressed' : 'mouseReleased',
            x: event.x,
            y: event.y,
            button,
            clickCount: 1,
            buttons: event.type === 'down' ? (button === 'right' ? 2 : 1) : 0,
          });
        } else if (event.type === 'move') {
          await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: event.x, y: event.y });
        } else {
          await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 });
        }
      },
      async key(event) {
        if (event.type !== 'up') {
          await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: event.key, ...(event.text !== undefined ? { text: event.text } : {}) });
        }
        if (event.type !== 'down') await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: event.key });
      },
      async type(text) {
        await client.send('Input.insertText', { text });
      },
      async pick(x, y) {
        const info = await page.evaluate<Omit<RemoteBrowserPick, 'screenshot'> | null>(pickExpression(x, y));
        if (!info) throw new Error(`좌표 (${x}, ${y})에서 요소를 찾지 못했습니다`);
        return { ...info, screenshot: await screenshotOf(info.rect) };
      },
      async pickRect(rect) {
        const info = await page.evaluate<Omit<RemoteBrowserPick, 'screenshot'> | null>(pickRectExpression(rect));
        if (!info) throw new Error(`영역 (${rect.x}, ${rect.y}, ${rect.width}x${rect.height})에서 요소를 찾지 못했습니다`);
        return { ...info, screenshot: await screenshotOf(info.rect) };
      },
      async hover(x, y) {
        return page.evaluate<{ rect: RemoteBrowserRect } | null>(hoverExpression(x, y));
      },
      async close() {
        // 여러 번 불러도 안전하다
        if (closed) return;
        closed = true;
        await screencast.stop();
        await browser.close().catch(() => {});
      },
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** 여러 page.evaluate 식이 함께 쓰는 조각. 요소를 선택자·HTML·계산 스타일·(문서/뷰포트) 영역으로 요약한다 */
function describeElementSnippet(): string {
  return `
  const escape = (value) => (window.CSS && window.CSS.escape ? window.CSS.escape(value) : value);
  const selectorFor = (node) => {
    if (node.id) return '#' + escape(node.id);
    const testId = node.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 3) {
      let part = current.tagName.toLowerCase();
      const className = typeof current.className === 'string' ? current.className.trim() : '';
      if (className) part += className.split(/\\s+/).slice(0, 2).map((name) => '.' + escape(name)).join('');
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const describeElement = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const css = {};
    for (const key of ${JSON.stringify(PICK_STYLE_KEYS)}) css[key] = style.getPropertyValue(key);
    return {
      selector: selectorFor(element),
      html: element.outerHTML.slice(0, ${PICK_HTML_MAX}),
      css,
      rect: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height },
      viewportRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  };`;
}

/** 좌표의 요소에서 선택자·HTML·계산 스타일·영역을 읽는 페이지 식. DOM 타입을 쓰지 않으려고 문자열로 넘긴다 */
function pickExpression(x: number, y: number): string {
  return `(() => {
  ${describeElementSnippet()}
  const element = document.elementFromPoint(${x}, ${y});
  if (!element) return null;
  return describeElement(element);
})()`;
}

/**
 * 드래그한 사각형(뷰포트 좌표)이 덮는 요소를 고르는 페이지 식.
 * 드래그 선택은 보통 사람이 고르려는 요소를 상자로 감싸듯 그린다(디자인 도구의 마퀴 선택과 같은 습관). 그래서
 * 규칙(우선순위 순): 1) 드래그 사각형 안에 완전히 들어오는 요소 중 면적이 가장 작은 것(상자로 정확히 둘러싼, 가장 구체적인 요소).
 * 2) 완전히 들어오는 요소가 없으면(상자가 요소 가장자리를 살짝 벗어나거나, 요소보다 작게 그렸을 때), 드래그와 겹치는 비율
 * (교집합 면적 / 자기 면적)이 가장 크고 그중 면적이 가장 작은 요소.
 * html·body처럼 문서 전체를 덮는 뿌리 요소는 어지간히 크게 드래그하지 않는 한 1번 조건을 만족하지 않으므로,
 * 특정 요소를 놔두고 뿌리로 물러나는 일은 드물다(2번에서 겹침 비율이 극히 작아 다른 후보가 있으면 밀린다).
 * 같은 규칙을 apps/studio/lib/element-pick-geometry.ts의 pickBestRect가 순수 함수로 구현하고 vitest로 검증한다(이 식은 DOM 안에서 돌아 그 함수를 직접 재사용할 수 없다).
 */
function pickRectExpression(rect: RemoteBrowserRect): string {
  return `(() => {
  ${describeElementSnippet()}
  const drag = ${JSON.stringify(rect)};
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  };
  const contains = (outer, inner) =>
    outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
  let containedByDrag = null;
  let overlapping = null;
  for (const element of document.querySelectorAll('*')) {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const candidate = { x: box.left, y: box.top, width: box.width, height: box.height };
    if (contains(drag, candidate)) {
      const candidateArea = area(candidate);
      if (!containedByDrag || candidateArea < containedByDrag.area) containedByDrag = { element, area: candidateArea };
      continue;
    }
    const overlap = intersect(drag, candidate);
    if (!overlap) continue;
    const candidateArea = area(candidate);
    const ratio = candidateArea > 0 ? area(overlap) / candidateArea : 0;
    if (ratio <= 0) continue;
    if (!overlapping || ratio > overlapping.ratio || (ratio === overlapping.ratio && candidateArea < overlapping.area)) {
      overlapping = { element, ratio, area: candidateArea };
    }
  }
  const chosen = containedByDrag || overlapping;
  if (!chosen) return null;
  return describeElement(chosen.element);
})()`;
}

/** 좌표 아래 요소의 뷰포트 영역만 읽는 가벼운 페이지 식. 고르기 모드의 마우스 오버 강조용이라 스크린샷은 찍지 않는다 */
function hoverExpression(x: number, y: number): string {
  return `(() => {
  const element = document.elementFromPoint(${x}, ${y});
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
})()`;
}

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

export interface RemoteBrowserPick {
  selector: string;
  html: string;
  css: Record<string, string>;
  screenshot: Buffer;
  rect: { x: number; y: number; width: number; height: number };
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
        const screenshot = await page.screenshot({
          type: 'png',
          clip: { x: info.rect.x, y: info.rect.y, width: Math.max(1, info.rect.width), height: Math.max(1, info.rect.height) },
        });
        return { ...info, screenshot };
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

/** 좌표의 요소에서 선택자·HTML·계산 스타일·영역을 읽는 페이지 식. DOM 타입을 쓰지 않으려고 문자열로 넘긴다 */
function pickExpression(x: number, y: number): string {
  return `(() => {
  const element = document.elementFromPoint(${x}, ${y});
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const css = {};
  for (const key of ${JSON.stringify(PICK_STYLE_KEYS)}) css[key] = style.getPropertyValue(key);
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
  return {
    selector: selectorFor(element),
    html: element.outerHTML.slice(0, ${PICK_HTML_MAX}),
    css,
    rect: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height },
  };
})()`;
}

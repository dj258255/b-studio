import type { Browser, CDPSession, Page } from 'playwright-core';
import type { WorkflowPageStep } from '@b-studio/spec';

/** CDP screencast로 받은 화면 한 장. `at`은 프레임을 받은 시각(ms) */
export interface BrowserFrame {
  data: Buffer;
  width: number;
  height: number;
  at: number;
}

/** 화면 확인 단계 한 줄. capture가 켜져 있으면 그 시점의 뷰포트 스크린샷(PNG)을 담는다 */
export interface BrowserPageStep {
  label: string;
  ok: boolean;
  detail?: string;
  screenshot?: Buffer;
}

/**
 * browser_check의 browser 모드. 헤드리스 Chromium으로 화면을 실제로 렌더링하고 클라이언트 스크립트를 실행해 본다.
 * HTTP 응답만으로는 hydration 오류, 스크립트 예외, 모바일 가로 넘침을 알 수 없어서 따로 둔다.
 */
export interface BrowserPageResult {
  /** 첫 문서 응답의 상태 코드. 응답을 받지 못했으면 null */
  status: number | null;
  /** 렌더링이 끝난 뒤 body의 보이는 텍스트 */
  text: string;
  /** 잡히지 않은 스크립트 예외 */
  pageErrors: string[];
  /** 페이지 스크립트가 console.error로 남긴 메시지. 브라우저가 남기는 리소스 로드 실패 문구는 failedRequests로 옮긴다 */
  consoleErrors: string[];
  /** 4xx·5xx로 끝났거나 연결되지 않은 요청. 브라우저가 스스로 여는 /favicon.ico는 제외한다 */
  failedRequests: string[];
  /**
   * `<video>`·`<audio>`·`<img>`가 캡처 단계 `error` 이벤트로 알린 미디어 로드·재생 실패.
   * 트러블슈팅 83: 상대 경로 미디어 주소가 백엔드로 넘어가지 않아 `<video>`의 readyState가 0에 머문 사례처럼,
   * failedRequests(네트워크 응답)만으로는 "그 요청이 어느 화면 요소의 재생 실패로 이어졌는지"를 알 수 없어 따로 모은다
   */
  mediaErrors: string[];
  /**
   * 허용한 출처 밖이라 막은 요청. 앱의 오류가 아니라 경계에서 막은 것이라 실패로 세지 않고 기록만 한다.
   * allowedOrigins를 넘기지 않았으면 항상 빈 배열이다
   */
  blockedRequests: string[];
  /** viewportTexts를 넘겼을 때만 있다. 각 글자가 첫 화면에 온전히 보이는지 잰 결과(ADR-161) */
  viewportTexts?: ViewportTextReport;
  /** 문서 너비가 화면 너비를 넘는 픽셀 수. 0이면 가로 스크롤이 없다 */
  horizontalOverflowPx: number;
  /** measureLoad를 켰을 때 워밍업 뒤 이동의 load까지 걸린 시간(ms). 재지 못했으면 없다 */
  loadMs?: number;
  /** 페이지를 연 직후와 각 단계의 결과. 첫 항목은 `open <경로>` */
  steps: BrowserPageStep[];
}

/**
 * 글자가 첫 화면에 온전히 보이지 않는 이유.
 * absent: 화면에 없음 / hidden: display:none·visibility:hidden이거나 크기 0, 또는 눈에 보이지 않게 만든 요소(투명, 2px보다 작은 상자, clip) /
 * clipped: overflow가 visible이 아닌 조상(by)에 side 쪽으로 px만큼 잘림 / above·below·left·right: 창 밖으로 px만큼 넘침 /
 * covered: 다른 요소(by)가 위에 덮여 있음 / scrolled: 잴 때 창이 px만큼 스크롤돼 있어 첫 화면이 아님
 */
export type ViewportProblem =
  | { kind: 'absent' }
  | { kind: 'hidden' }
  | { kind: 'clipped'; side: 'top' | 'bottom' | 'left' | 'right'; px: number; by: string }
  | { kind: 'above' | 'below' | 'left' | 'right'; px: number }
  | { kind: 'covered'; by: string }
  | { kind: 'scrolled'; px: number };

export interface ViewportTextFinding {
  text: string;
  visible: boolean;
  problem?: ViewportProblem;
}

/** 측정한 창 크기와 글자별 결과 */
export interface ViewportTextReport {
  width: number;
  height: number;
  findings: ViewportTextFinding[];
}

export interface BrowserPageOptions {
  /** 첫 화면(단계를 마친 뒤 창 크기 그대로)에 온전히 보여야 하는 글자. 넘기면 결과의 viewportTexts에 잰 값을 담는다 */
  viewportTexts?: readonly string[];
  viewport?: { width: number; height: number };
  /** 페이지를 연 뒤 순서대로 실행할 동작. 선언한 네 동작만 받는다 */
  steps?: readonly WorkflowPageStep[];
  /** true면 페이지를 연 직후와 각 단계 뒤에 뷰포트 스크린샷(PNG)을 찍는다 */
  capture?: boolean;
  /**
   * 이 페이지가 요청해도 되는 출처(origin) 목록. 넘기면 여기 없는 출처로 나가는 요청을 막고 서비스 워커도 막는다.
   * 서버(스튜디오 호스트)에서 도는 검사라, 모델이 만든 페이지가 호스트 내부나 외부로 나가면 요청 위조 통로가 된다
   */
  allowedOrigins?: string[];
  /** CDP screencast 프레임. 초당 5장 상한으로 거른 뒤 넘긴다 */
  onFrame?: (frame: BrowserFrame) => void;
  /**
   * true면 화면 로드를 잰다. 개발 서버 첫 컴파일(콜드 스타트) 때문에 첫 이동이 튀므로
   * 한 번 워밍업 이동을 한 뒤 다음 이동의 load까지 걸린 시간을 Performance API로 잰다(loadEventEnd - startTime).
   */
  measureLoad?: boolean;
  signal?: AbortSignal;
}

export type BrowserRunner = (url: string, options: BrowserPageOptions) => Promise<BrowserPageResult>;

const NAVIGATION_TIMEOUT_MS = 30_000;
/** 네트워크가 잠잠해질 때까지 기다리되, 개발 서버의 HMR 연결처럼 끝나지 않는 요청 때문에 멈추지 않게 상한을 둔다 */
const SETTLE_TIMEOUT_MS = 5_000;
const STEP_TIMEOUT_MS = 5_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** screencast 전송량 상한. 프레임은 세션 기록에 남기지 않고 실시간 채널로만 보낸다 */
export const SCREENCAST_MAX_FPS = 5;
const SCREENCAST_INTERVAL_MS = 1000 / SCREENCAST_MAX_FPS;

export class BrowserUnavailableError extends Error {}

/** 단계가 실패했을 때 그때까지의 단계 결과를 함께 담는다. 실패 단계의 스크린샷도 들어 있다 */
export class StepFailedError extends Error {
  readonly steps: readonly BrowserPageStep[];

  constructor(message: string, steps: readonly BrowserPageStep[]) {
    super(message);
    this.name = 'StepFailedError';
    this.steps = steps;
  }
}

/** 선언한 네 동작 중 어느 것도 없는 단계. 단계 실패가 아니라 잘못된 입력이라 따로 구분한다 */
class StepWithoutActionError extends Error {}

function isAutomaticFavicon(url: string): boolean {
  return new URL(url).pathname === '/favicon.ico';
}

/** MediaError.code → 이름. 표준에 있는 네 값만 안다(https://developer.mozilla.org/docs/Web/API/MediaError) */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/**
 * 문서 전체에 캡처 단계로 `error` 리스너를 하나 달아 `<video>`·`<audio>`·`<img>`의 로드·재생 실패를 모은다.
 * 리소스 `error` 이벤트는 버블링하지 않아 document가 직접 들을 수 없으므로 캡처 단계(`true`)로 듣는다.
 * 에이전트 패키지는 DOM 타입을 쓰지 않아(다른 page.evaluate 호출과 같은 이유) 평문 문자열로 둔다.
 * `window.__bStudioMediaError__`는 goto 전에 exposeFunction으로 등록해 둔다
 */
const MEDIA_ERROR_INIT_SCRIPT = `(() => {
  var names = ${JSON.stringify(MEDIA_ERROR_NAMES)};
  document.addEventListener('error', function (event) {
    var target = event.target;
    if (!target || !target.tagName) return;
    var tag = target.tagName.toLowerCase();
    var src = target.currentSrc || target.src || '';
    if (tag === 'video' || tag === 'audio') {
      var code = target.error && target.error.code;
      var reason = code ? (names[code] || ('code ' + code)) : 'unknown';
      window.__bStudioMediaError__(tag + ' ' + reason + ' ' + src);
    } else if (tag === 'img') {
      window.__bStudioMediaError__('img 이미지를 불러오지 못했습니다 ' + src);
    }
  }, true);
})();`;

/**
 * 글자가 첫 화면에 온전히 보이는지 페이지 안에서 잰다(ADR-161). 에이전트 패키지는 DOM 타입을 쓰지 않아 문자열로 둔다.
 * 글자를 담은 가장 안쪽 요소(자식 요소 중 같은 글자를 담은 것이 없는 요소)마다:
 * 렌더링 여부(크기 0·display:none·visibility:hidden) → overflow가 visible이 아닌 조상의 안쪽 영역에 잘림 → 창 밖 순으로 본다.
 * 같은 글자를 담은 요소가 여럿이면 하나라도 온전히 보이면 보인 것으로 친다. 오차는 1px까지 허용한다.
 * "하나라도"가 쉬운 통과 길이 되지 않게, 눈에 보이지 않는 요소는 보인 것으로 치지 않는다: 투명한 요소(자신과 조상의 opacity 곱이 0.1 미만),
 * 2px보다 작은 상자와 clip을 건 요소(화면 낭독기 전용 숨김), 다른 요소에 덮인 요소(가운데 점의 맨 위 요소가 남남일 때).
 * 창이 스크롤돼 있으면(단계가 화면을 내렸을 때) 첫 화면이 아니므로 모든 글자를 재지 않고 scrolled로 돌려준다.
 * position:fixed 요소는 조상 클리핑을 받지 않고, absolute 요소는 위치 기준 조상 바깥의 조상에는 잘리지 않는 것으로 단순하게 다룬다
 */
export const VIEWPORT_MEASURE_SCRIPT = (texts: readonly string[]) => `((texts) => {
  var TOL = 1;
  var vw = window.innerWidth, vh = window.innerHeight;
  var scrolled = Math.max(Math.abs(Math.round(window.scrollY || 0)), Math.abs(Math.round(window.scrollX || 0)));
  if (scrolled > TOL) return { width: vw, height: vh, findings: texts.map(function (text) { return { text: text, visible: false, problem: { kind: 'scrolled', px: scrolled } }; }) };
  var norm = function (s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
  var all = Array.prototype.slice.call(document.body ? document.body.querySelectorAll('*') : []);
  all = all.filter(function (el) { return !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|TITLE|META|LINK)$/.test(el.tagName); });
  var textOf = new Map();
  all.forEach(function (el) { textOf.set(el, norm(el.textContent)); });
  var describe = function (el) {
    var tag = el.tagName.toLowerCase();
    var classes = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2);
    if (classes.length) return tag + '.' + classes.join('.');
    return el.id ? tag + '#' + el.id : tag;
  };
  var judge = function (el) {
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    if (el.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.visibility === 'collapse') return { kind: 'hidden' };
    if (rect.width < 2 || rect.height < 2 || (style.clip && style.clip !== 'auto')) return { kind: 'hidden' };
    var opacity = 1;
    for (var o = el; o && o.nodeType === 1; o = o.parentElement) opacity *= parseFloat(getComputedStyle(o).opacity || '1');
    if (opacity < 0.1) return { kind: 'hidden' };
    var left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    var skipUntilPositioned = style.position === 'absolute';
    var escapes = style.position === 'fixed';
    var cur = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement && !escapes) {
      var cs = getComputedStyle(cur);
      if (skipUntilPositioned) {
        if (cs.position !== 'static') skipUntilPositioned = false; else { cur = cur.parentElement; continue; }
      }
      var clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
      if (clipX || clipY) {
        var box = cur.getBoundingClientRect();
        var cl = box.left + cur.clientLeft, ct = box.top + cur.clientTop, cr = cl + cur.clientWidth, cb = ct + cur.clientHeight;
        if (clipY && bottom - cb > TOL) return { kind: 'clipped', side: 'bottom', px: Math.round(bottom - cb), by: describe(cur) };
        if (clipY && ct - top > TOL) return { kind: 'clipped', side: 'top', px: Math.round(ct - top), by: describe(cur) };
        if (clipX && right - cr > TOL) return { kind: 'clipped', side: 'right', px: Math.round(right - cr), by: describe(cur) };
        if (clipX && cl - left > TOL) return { kind: 'clipped', side: 'left', px: Math.round(cl - left), by: describe(cur) };
      }
      if (cs.position === 'fixed') break;
      cur = cur.parentElement;
    }
    if (bottom - vh > TOL) return { kind: 'below', px: Math.round(bottom - vh) };
    if (-top > TOL) return { kind: 'above', px: Math.round(-top) };
    if (right - vw > TOL) return { kind: 'right', px: Math.round(right - vw) };
    if (-left > TOL) return { kind: 'left', px: Math.round(-left) };
    // 다른 요소가 위에 덮여 있는지: 가운데 점의 맨 위 요소가 이 요소와 안팎 관계가 아니면 덮인 것이다.
    // pointer-events:none인 요소는 이 방법으로 알 수 없어 건너뛴다(비활성 버튼에 흔하다)
    if (style.pointerEvents !== 'none') {
      var hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { kind: 'covered', by: describe(hit) };
    }
    return null;
  };
  var findings = texts.map(function (text) {
    var needle = norm(text);
    var candidates = all.filter(function (el) {
      if (!textOf.get(el).includes(needle)) return false;
      return !Array.prototype.some.call(el.children, function (child) { return textOf.has(child) && textOf.get(child).includes(needle); });
    });
    if (candidates.length === 0) return { text: text, visible: false, problem: { kind: 'absent' } };
    var worst = null;
    for (var i = 0; i < candidates.length; i++) {
      var problem = judge(candidates[i]);
      if (!problem) return { text: text, visible: true };
      // 여러 요소가 모두 안 보이면 숨겨짐보다 "보이려다 잘린" 쪽이 고칠 단서가 많아 그쪽을 알린다
      if (!worst || (worst.kind === 'hidden' && problem.kind !== 'hidden')) worst = problem;
    }
    return { text: text, visible: false, problem: worst };
  });
  return { width: vw, height: vh, findings: findings };
})(${JSON.stringify(texts)})`;

/** 실패한 단계를 사람이 알아볼 수 있게 무슨 동작을 어디에 하려 했는지 적는다 */
function describeStep(step: WorkflowPageStep): string {
  if (step.click !== undefined) return `click ${step.click}`;
  if (step.fill !== undefined) return `fill ${step.fill.selector}`;
  if (step.press !== undefined) return `press ${step.press}`;
  return `waitFor ${step.waitFor}`;
}

/**
 * Playwright가 내려받은 Chromium을 먼저 쓰고, 없으면 설치된 Chrome을 쓴다.
 * B_STUDIO_BROWSER_EXECUTABLE로 실행 파일을 지정할 수 있다. 어느 것도 없으면 검사를 통과시키지 않고 실패로 알린다
 */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const executablePath = process.env.B_STUDIO_BROWSER_EXECUTABLE;
  const attempts = executablePath ? [{ executablePath }] : [{}, { channel: 'chrome' }];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless: true, ...attempt });
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new BrowserUnavailableError(`헤드리스 브라우저를 실행할 수 없습니다: ${failures.join(' / ')}`);
}

/** 네트워크로 나가지 않는 내부 스킴. 이 셋은 허용 목록과 무관하게 통과시킨다 */
const INTERNAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/** 출처가 허용 목록에 있으면 true. 내부 스킴은 허용하고, 파싱할 수 없으면 거부한다 */
export function isAllowedRequest(url: string, allowed: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return INTERNAL_SCHEMES.has(parsed.protocol) || allowed.has(parsed.origin);
}

/** 허용하지 않은 출처로 나가려던 요청을 막을 때의 정보 */
export interface OriginBlockEvent {
  url: string;
  kind: 'navigation' | 'resource';
}

/**
 * 페이지의 모든 요청을 허용한 출처로 제한한다. 메인·하위 프레임 이동과 하위 리소스(fetch·img·script 등)를 모두 검사해,
 * 허용 목록에 없는 출처면 막고 onBlocked으로 알린다. 그래서 모델이 만든 페이지가 (스튜디오) 호스트 내부나 외부로 새 나가지 않는다.
 * 서비스 워커는 이 검사를 우회하므로, 부르는 쪽이 페이지를 만들 때 serviceWorkers: 'block'을 함께 줘야 한다.
 * 원격 브라우저(remote-browser.ts)와 게이트의 화면 확인(runInBrowser)이 같은 규칙을 쓰도록 여기 모아 둔다
 */
export async function restrictPageToOrigins(page: Page, allowedOrigins: readonly string[], onBlocked?: (event: OriginBlockEvent) => void): Promise<void> {
  const allowed = new Set(allowedOrigins);
  // goto 전에 걸어 첫 문서 요청부터 검사한다
  await page.route('**/*', (route) => {
    const request = route.request();
    if (isAllowedRequest(request.url(), allowed)) return route.continue();
    onBlocked?.({ url: request.url(), kind: request.isNavigationRequest() ? 'navigation' : 'resource' });
    return route.abort('blockedbyclient');
  });
}

/**
 * CDP screencast를 켜고 끄는 도구. 리스너는 한 번만 붙이고 start·stop으로 전환한다.
 * ack를 빠뜨리면 브라우저가 전송을 멈추므로, 상한에 걸러 콜백을 건너뛸 때도 항상 ack한다.
 */
export function createScreencast(client: CDPSession, viewport: { width: number; height: number }, onFrame: (frame: BrowserFrame) => void) {
  // 초당 상한을 넘는 프레임은 버리지 않고 가장 최근 것 하나를 들고 있다가 간격이 지나면 보낸다(뒤쪽 스로틀).
  // 앞쪽에서 버리기만 하면 변화의 마지막 프레임이 사라져, 페이지가 멈춘 뒤에도 미리보기가 그 전 화면에 머문다
  let last = 0;
  let pending: BrowserFrame | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (frame: BrowserFrame) => {
    last = Date.now();
    onFrame({ ...frame, at: last });
  };
  client.on('Page.screencastFrame', (params) => {
    void client.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    const frame: BrowserFrame = {
      data: Buffer.from(params.data, 'base64'),
      width: params.metadata.deviceWidth || viewport.width,
      height: params.metadata.deviceHeight || viewport.height,
      at: Date.now(),
    };
    const wait = last + SCREENCAST_INTERVAL_MS - frame.at;
    if (wait <= 0 && !timer) {
      deliver(frame);
      return;
    }
    pending = frame;
    timer ??= setTimeout(() => {
      timer = undefined;
      const next = pending;
      pending = undefined;
      if (next) deliver(next);
    }, Math.max(0, wait));
  });
  return {
    start: (maxWidth: number) => client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth, everyNthFrame: 1 }).then(() => {}),
    stop: () => {
      // 멈춘 뒤에는 들고 있던 프레임도 보내지 않는다(잘린 화면이나 닫힌 브라우저의 프레임이 늦게 도착하지 않게)
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      return client.send('Page.stopScreencast').then(() => {}).catch(() => {});
    },
  };
}

export const runInBrowser: BrowserRunner = async (url, { viewport = DEFAULT_VIEWPORT, viewportTexts, steps = [], capture = false, allowedOrigins, onFrame, measureLoad = false, signal }) => {
  signal?.throwIfAborted();
  const browser = await launchBrowser();
  const abort = () => void browser.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // 허용 출처를 넘기면 서비스 워커를 막는다. 서비스 워커가 만든 요청은 page.route를 우회하기 때문이다
    const page = await browser.newPage({ viewport, ...(allowedOrigins ? { serviceWorkers: 'block' as const } : {}) });
    // 허용 출처 밖으로 나가려는 요청을 막고, 막은 URL을 모아 둔다(앱의 오류가 아니라 경계에서 막은 것이라 실패로 세지 않는다)
    const blockedUrls = new Set<string>();
    if (allowedOrigins) await restrictPageToOrigins(page, allowedOrigins, ({ url: blocked }) => void blockedUrls.add(blocked));
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const mediaErrors: string[] = [];
    // goto 전에 등록해야 첫 문서가 로드될 때부터 받는다. addInitScript는 이후의 모든 이동(워밍업 포함)에도 다시 붙는다
    await page.exposeFunction('__bStudioMediaError__', (message: string) => mediaErrors.push(message));
    await page.addInitScript(MEDIA_ERROR_INIT_SCRIPT);
    const failedRequests: string[] = [];
    page.on('console', (message) => {
      // 리소스 로드 실패는 브라우저가 URL 없이 남기는 문구라 원인을 알 수 없다. 요청 이벤트에서 URL과 함께 따로 모은다
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
    });
    // 4xx 스크립트는 응답 뒤 브라우저가 한 번 더 ERR_ABORTED로 끊는다. 같은 URL은 상태 코드가 있는 첫 기록만 남긴다
    const failedUrls = new Set<string>();
    const recordFailure = (url: string, reason: string) => {
      // 허용 출처 밖이라 막은 요청은 앱의 오류가 아니므로 실패로 세지 않는다(이중 기록 방지)
      if (isAutomaticFavicon(url) || failedUrls.has(url) || blockedUrls.has(url)) return;
      failedUrls.add(url);
      failedRequests.push(`${reason} ${url}`);
    };
    page.on('response', (response) => {
      if (response.status() >= 400) recordFailure(response.url(), String(response.status()));
    });
    page.on('requestfailed', (request) => recordFailure(request.url(), request.failure()?.errorText ?? 'failed'));

    const screencast = onFrame ? createScreencast(await page.context().newCDPSession(page), viewport, onFrame) : undefined;
    const recorded: BrowserPageStep[] = [];
    // 단계마다 결과를 남긴다. capture가 켜져 있으면 그 시점의 뷰포트 스크린샷(PNG)을 함께 담는다
    const record = async (label: string, ok: boolean, detail?: string) => {
      const screenshot = capture ? await page.screenshot({ type: 'png' }).catch(() => undefined) : undefined;
      recorded.push({ label, ok, ...(detail !== undefined ? { detail } : {}), ...(screenshot ? { screenshot } : {}) });
    };
    try {
      if (screencast) await screencast.start(viewport.width);
      if (measureLoad) {
        // 개발 서버 첫 컴파일(콜드 스타트)이 첫 로드를 튀게 한다. 한 번 워밍업 이동 뒤에 잰다
        await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
        // 워밍업 이동의 오류·실패 요청은 측정 대상이 아니므로 비운다
        pageErrors.length = 0;
        consoleErrors.length = 0;
        failedRequests.length = 0;
        mediaErrors.length = 0;
        failedUrls.clear();
        blockedUrls.clear();
      }
      const response = await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      await record(`open ${new URL(url).pathname}`, true);
      // 단계는 순서대로 실행한다. 실패하면 그 자리에서 멈춰 몇 번째 단계였는지 알린다
      for (const [index, step] of steps.entries()) {
        try {
          if (step.click !== undefined) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
          else if (step.fill !== undefined) await page.fill(step.fill.selector, step.fill.text, { timeout: STEP_TIMEOUT_MS });
          else if (step.press !== undefined) await page.keyboard.press(step.press);
          else if (step.waitFor !== undefined) await page.waitForSelector(step.waitFor, { timeout: STEP_TIMEOUT_MS });
          else throw new StepWithoutActionError(`${index + 1}번째 단계에 실행할 동작이 없습니다 (click, fill, press, waitFor 중 하나가 필요합니다)`);
          await record(describeStep(step), true);
        } catch (error) {
          // 동작 없는 단계는 타입을 통과한 잘못된 입력이라 단계 실패로 감싸지 않는다
          if (error instanceof StepWithoutActionError) throw error;
          const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error);
          // 실패한 단계의 스크린샷도 남겨 예외에 함께 담는다
          await record(describeStep(step), false, reason);
          throw new StepFailedError(`${index + 1}번째 단계 실패 (${describeStep(step)}): ${reason}`, recorded);
        }
      }
      // 에이전트 패키지는 DOM 타입을 쓰지 않으므로 페이지 안에서 실행할 식은 문자열로 넘긴다
      const { text, overflow } = await page.evaluate<{ text: string; overflow: number }>(
        `({ text: document.body ? document.body.innerText : '', overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) })`,
      );
      // 글자 위치 측정은 expectText와 같은 시점(단계를 마친 뒤)에 한다
      const viewportReport = viewportTexts && viewportTexts.length > 0 ? await page.evaluate<ViewportTextReport>(VIEWPORT_MEASURE_SCRIPT(viewportTexts)) : undefined;
      // 이동의 load까지 걸린 시간. 워밍업 뒤 이동이라 개발 서버 콜드 스타트가 섞이지 않는다
      const loadMs = measureLoad
        ? await page.evaluate<number | null>(`(() => { const nav = performance.getEntriesByType('navigation')[0]; return nav ? Math.round(nav.loadEventEnd - nav.startTime) : null; })()`)
        : null;
      return {
        status: response?.status() ?? null,
        text,
        pageErrors,
        consoleErrors,
        failedRequests,
        mediaErrors,
        blockedRequests: [...blockedUrls],
        horizontalOverflowPx: overflow,
        ...(viewportReport ? { viewportTexts: viewportReport } : {}),
        ...(loadMs !== null ? { loadMs } : {}),
        steps: recorded,
      };
    } finally {
      await screencast?.stop();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
    signal?.throwIfAborted();
  }
};

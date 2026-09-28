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
   * 허용한 출처 밖이라 막은 요청. 앱의 오류가 아니라 경계에서 막은 것이라 실패로 세지 않고 기록만 한다.
   * allowedOrigins를 넘기지 않았으면 항상 빈 배열이다
   */
  blockedRequests: string[];
  /** 문서 너비가 화면 너비를 넘는 픽셀 수. 0이면 가로 스크롤이 없다 */
  horizontalOverflowPx: number;
  /** 페이지를 연 직후와 각 단계의 결과. 첫 항목은 `open <경로>` */
  steps: BrowserPageStep[];
}

export interface BrowserPageOptions {
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

export const runInBrowser: BrowserRunner = async (url, { viewport = DEFAULT_VIEWPORT, steps = [], capture = false, allowedOrigins, onFrame, signal }) => {
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
      return { status: response?.status() ?? null, text, pageErrors, consoleErrors, failedRequests, blockedRequests: [...blockedUrls], horizontalOverflowPx: overflow, steps: recorded };
    } finally {
      await screencast?.stop();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
    signal?.throwIfAborted();
  }
};

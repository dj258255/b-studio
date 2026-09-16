import type { WorkflowPageStep } from '@b-studio/spec';

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
  /** 문서 너비가 화면 너비를 넘는 픽셀 수. 0이면 가로 스크롤이 없다 */
  horizontalOverflowPx: number;
}

export interface BrowserPageOptions {
  viewport?: { width: number; height: number };
  /** 페이지를 연 뒤 순서대로 실행할 동작. 선언한 네 동작만 받는다 */
  steps?: readonly WorkflowPageStep[];
  signal?: AbortSignal;
}

export type BrowserRunner = (url: string, options: BrowserPageOptions) => Promise<BrowserPageResult>;

const NAVIGATION_TIMEOUT_MS = 30_000;
/** 네트워크가 잠잠해질 때까지 기다리되, 개발 서버의 HMR 연결처럼 끝나지 않는 요청 때문에 멈추지 않게 상한을 둔다 */
const SETTLE_TIMEOUT_MS = 5_000;
const STEP_TIMEOUT_MS = 5_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export class BrowserUnavailableError extends Error {}

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
export const runInBrowser: BrowserRunner = async (url, { viewport = DEFAULT_VIEWPORT, steps = [], signal }) => {
  signal?.throwIfAborted();
  const { chromium } = await import('playwright-core');
  const executablePath = process.env.B_STUDIO_BROWSER_EXECUTABLE;
  const attempts = executablePath ? [{ executablePath }] : [{}, { channel: 'chrome' }];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      browser = await chromium.launch({ headless: true, ...attempt });
      break;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  if (!browser) throw new BrowserUnavailableError(`헤드리스 브라우저를 실행할 수 없습니다: ${failures.join(' / ')}`);

  const abort = () => void browser?.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const page = await browser.newPage({ viewport });
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
      if (isAutomaticFavicon(url) || failedUrls.has(url)) return;
      failedUrls.add(url);
      failedRequests.push(`${reason} ${url}`);
    };
    page.on('response', (response) => {
      if (response.status() >= 400) recordFailure(response.url(), String(response.status()));
    });
    page.on('requestfailed', (request) => recordFailure(request.url(), request.failure()?.errorText ?? 'failed'));

    const response = await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    // 단계는 순서대로 실행한다. 실패하면 그 자리에서 멈춰 몇 번째 단계였는지 알린다
    for (const [index, step] of steps.entries()) {
      try {
        if (step.click !== undefined) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
        else if (step.fill !== undefined) await page.fill(step.fill.selector, step.fill.text, { timeout: STEP_TIMEOUT_MS });
        else if (step.press !== undefined) await page.keyboard.press(step.press);
        else if (step.waitFor !== undefined) await page.waitForSelector(step.waitFor, { timeout: STEP_TIMEOUT_MS });
        else throw new StepWithoutActionError(`${index + 1}번째 단계에 실행할 동작이 없습니다 (click, fill, press, waitFor 중 하나가 필요합니다)`);
      } catch (error) {
        // 동작 없는 단계는 타입을 통과한 잘못된 입력이라 단계 실패로 감싸지 않는다
        if (error instanceof StepWithoutActionError) throw error;
        const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error);
        throw new Error(`${index + 1}번째 단계 실패 (${describeStep(step)}): ${reason}`);
      }
    }
    // 에이전트 패키지는 DOM 타입을 쓰지 않으므로 페이지 안에서 실행할 식은 문자열로 넘긴다
    const { text, overflow } = await page.evaluate<{ text: string; overflow: number }>(
      `({ text: document.body ? document.body.innerText : '', overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) })`,
    );
    return { status: response?.status() ?? null, text, pageErrors, consoleErrors, failedRequests, horizontalOverflowPx: overflow };
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
    signal?.throwIfAborted();
  }
};

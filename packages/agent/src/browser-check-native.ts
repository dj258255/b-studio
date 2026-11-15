import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { native } from '@b-studio/sandbox';
import type { WorkflowPageStep } from '@b-studio/spec';
import { BrowserUnavailableError, MEDIA_ERROR_INIT_SCRIPT, StepFailedError, StepWithoutActionError, VIEWPORT_MEASURE_SCRIPT, describeStep, type BrowserPageResult, type BrowserPageStep, type BrowserRunner, type ViewportTextReport } from './browser-check';

/**
 * 화면 확인 러너의 Rust 구현(ADR-199, ADR-195 4f A6a). `runInBrowser`(Playwright)와 같은 입력·출력·오류 타입을 쓴다.
 * 브라우저를 띄우고 페이지를 열어 결과를 모으는 일은 Rust(`crates/bstudio-io/src/browser`)가 하고, 여기는 값을 넘기고 오류를 옛 타입으로 바꾼다.
 *
 * 단계(`click`·`fill`·`press`·`waitFor`)와 스크린샷(`capture`)을 돈다(A6b).
 * 던지는 오류는 `BrowserUnavailableError`가 아니다(그러면 HTTP 확인으로 대신 통과한다).
 * 화면 글자·가로 넘침·`viewportTexts`·로드 시간은 페이지와 격리된 실행 환경에서 읽는다. 옛 러너는 페이지와 같은 실행 환경에서 읽어, 페이지가 전역을
 * 바꿔치면 위조된 값을 받는다(의도한 차이, ADR-199).
 *
 * 게이트의 기본 `browserRunner`다(A6c-3). 옛 `runInBrowser`는 차등 시험의 기준값으로만 남는다.
 */

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Playwright가 'chrome' 채널로 찾는 시스템 Chrome의 기본 위치(옛 `launchBrowser`의 `channel: 'chrome'` 시도와 같은 곳) */
function systemChromePaths(): string[] {
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (process.platform === 'win32') return [];
  return ['/opt/google/chrome/chrome'];
}

type PlaywrightRegistry = { findExecutable(name: string): { executablePath(): string | undefined } | undefined };

/**
 * 옛 러너의 `chromium.launch({ headless: true })`가 띄우는 실행 파일(Playwright가 받은 headless shell)의 경로. `chromium.executablePath()`는
 * 전체 Chromium(새 headless 모드)이라 다르다. 그것을 띄우면 시작·대상 만들기·종료가 느려 호출 전체가 약 400ms 길어졌다(ADR-199 A6c 덧붙임).
 * 경로는 Playwright의 설치 목록(`registry`)에서 읽는다. 공개 API가 아니므로 찾지 못하면 없는 것으로 친다(그러면 설치된 Chrome을 시도한다)
 */
function playwrightHeadlessShell(): string | undefined {
  try {
    const bundle = createRequire(import.meta.url)('playwright-core/lib/coreBundle') as { registry?: { registry?: PlaywrightRegistry } };
    return bundle.registry?.registry?.findExecutable('chromium-headless-shell')?.executablePath() || undefined;
  } catch {
    return undefined;
  }
}

/** Playwright가 받은 전체 Chromium의 경로. 모르면 undefined */
function playwrightFullChromium(): string | undefined {
  try {
    return chromium.executablePath() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 시도할 실행 파일의 순서. 지정한 실행 파일이 있으면 그것만, 없으면 옛 `launchBrowser`처럼 headless shell → 설치된 Chrome.
 * headless shell을 찾으면 전체 Chromium은 넣지 않는다(옛 러너도 띄우지 않고, 띄우면 호출이 수백 ms 느리다. A6c-1).
 * 찾지 못했으면 마지막에 전체 Chromium을 둔다. headless shell의 경로는 공개 API가 아닌 설치 목록에서 읽으므로 그 읽기가 깨질 수 있는데, 옛 러너는 Playwright가
 * 직접 찾아 브라우저로 확인했을 상황에서 새 러너만 "브라우저 없음"이 되면 게이트가 HTTP 확인으로 대신 통과한다(열린 쪽). 느려도 브라우저로 확인하는 쪽을 고른다(A6c-3)
 */
export function browserCandidatesFrom(input: { configured?: string; headlessShell?: string; systemChrome: readonly string[]; fullChromium?: string }): string[] {
  if (input.configured) return [input.configured];
  if (input.headlessShell) return [input.headlessShell, ...input.systemChrome];
  return [...input.systemChrome, ...(input.fullChromium ? [input.fullChromium] : [])];
}

/**
 * 이 기계에서 시도할 실행 파일(`browserCandidatesFrom`). B_STUDIO_BROWSER_EXECUTABLE이 지정한 실행 파일이다.
 * 경로는 파일이 있는지 보지 않고 넘긴다(Rust가 순서대로 시도하고, 모두 실패하면 그 이유를 `unavailable`로 알린다)
 */
export function nativeBrowserCandidates(): string[] {
  const configured = process.env.B_STUDIO_BROWSER_EXECUTABLE;
  const headlessShell = configured ? undefined : playwrightHeadlessShell();
  const fullChromium = configured || headlessShell ? undefined : playwrightFullChromium();
  return browserCandidatesFrom({ ...(configured ? { configured } : {}), ...(headlessShell ? { headlessShell } : {}), systemChrome: systemChromePaths(), ...(fullChromium ? { fullChromium } : {}) });
}

type NativeBrowserStepInput = { label: string; kind: 'click' | 'fill' | 'press' | 'waitFor' | 'none'; value: string; text?: string };

/** 옛 러너와 같은 우선순위로 동작 하나를 고른다(click → fill → press → waitFor). 어느 것도 없으면 `none` */
function nativeStep(step: WorkflowPageStep): NativeBrowserStepInput {
  const label = describeStep(step);
  if (step.click !== undefined) return { label, kind: 'click', value: String(step.click) };
  if (step.fill !== undefined) return { label, kind: 'fill', value: String(step.fill.selector), text: step.fill.text === undefined ? '' : String(step.fill.text) };
  if (step.press !== undefined) return { label, kind: 'press', value: String(step.press) };
  if (step.waitFor !== undefined) return { label, kind: 'waitFor', value: String(step.waitFor) };
  return { label, kind: 'none', value: '' };
}

function toPageSteps(steps: readonly { label: string; ok: boolean; detail?: string | null; screenshot?: Buffer | null }[]): BrowserPageStep[] {
  return steps.map((step) => ({ label: step.label, ok: step.ok, ...(step.detail !== undefined && step.detail !== null ? { detail: step.detail } : {}), ...(step.screenshot ? { screenshot: step.screenshot } : {}) }));
}

export const runInBrowserNative: BrowserRunner = async (url, { viewport = DEFAULT_VIEWPORT, viewportTexts, steps = [], capture = false, allowedOrigins, measureLoad = false, signal }) => {
  signal?.throwIfAborted();
  const { pathname } = new URL(url);
  let result;
  try {
    result = await native.runBrowserCheck(
      {
        executables: nativeBrowserCandidates(),
        url,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        viewportScript: viewportTexts && viewportTexts.length > 0 ? VIEWPORT_MEASURE_SCRIPT(viewportTexts) : undefined,
        viewportTexts: viewportTexts && viewportTexts.length > 0 ? [...viewportTexts] : undefined,
        allowedOrigins,
        measureLoad,
        mediaErrorScript: MEDIA_ERROR_INIT_SCRIPT,
        steps: steps.map(nativeStep),
        capture,
        openLabel: `open ${pathname}`,
      },
      signal,
    );
  } finally {
    // 옛 러너와 같게: 정리가 끝난 뒤 중단 신호가 있으면 결과보다 중단이 먼저다
    signal?.throwIfAborted();
  }
  if (result.kind === 'unavailable') throw new BrowserUnavailableError(result.message);
  if (result.kind === 'failed') throw new Error(result.message);
  // 동작 없는 단계는 단계 실패로 감싸지 않고 그 자리에서 던진다(옛 러너와 같다)
  if (result.kind === 'stepWithoutAction') throw new StepWithoutActionError(result.message);
  if (result.kind === 'stepFailed') throw new StepFailedError(result.message, toPageSteps(result.steps));
  if (result.kind === 'aborted') {
    signal?.throwIfAborted();
    throw new Error('취소되었습니다');
  }
  // 모르는 종류는 성공으로 읽지 않는다
  if (result.kind !== 'done') throw new Error(`Rust 화면 확인 러너가 알 수 없는 결과를 돌려주었습니다: ${String(result.kind)}`);
  const report: BrowserPageResult = {
    status: result.status ?? null,
    text: result.text,
    pageErrors: result.pageErrors,
    consoleErrors: result.consoleErrors,
    failedRequests: result.failedRequests,
    mediaErrors: result.mediaErrors,
    blockedRequests: result.blockedRequests,
    horizontalOverflowPx: result.horizontalOverflowPx,
    ...(result.viewportTextsJson ? { viewportTexts: JSON.parse(result.viewportTextsJson) as ViewportTextReport } : {}),
    ...(result.loadMs !== null && result.loadMs !== undefined ? { loadMs: result.loadMs } : {}),
    // 첫 항목은 페이지를 연 직후(`open <경로>`)이고 뒤는 단계마다다
    steps: toPageSteps(result.steps),
  };
  return report;
};

import { chromium } from 'playwright-core';
import { native } from '@b-studio/sandbox';
import { BrowserUnavailableError, MEDIA_ERROR_INIT_SCRIPT, VIEWPORT_MEASURE_SCRIPT, type BrowserPageResult, type BrowserRunner, type ViewportTextReport } from './browser-check';

/**
 * 화면 확인 러너의 Rust 구현(ADR-199, ADR-195 4f A6a). `runInBrowser`(Playwright)와 같은 입력·출력·오류 타입을 쓴다.
 * 브라우저를 띄우고 페이지를 열어 결과를 모으는 일은 Rust(`crates/bstudio-io/src/browser`)가 하고, 여기는 값을 넘기고 오류를 옛 타입으로 바꾼다.
 *
 * 이번 조각은 단계(`steps`)가 빈 확인만 다룬다. 단계·스크린샷(A6b)과 화면 중계(A6c)는 아직 지원하지 않으므로 조용히 무시하지 않고 던진다.
 * 던지는 오류는 `BrowserUnavailableError`가 아니다(그러면 HTTP 확인으로 대신 통과한다).
 *
 * 게이트의 기본 `browserRunner`는 아직 `runInBrowser`다(A6c에서 바꾼다).
 */

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Playwright가 'chrome' 채널로 찾는 시스템 Chrome의 기본 위치(옛 `launchBrowser`의 `channel: 'chrome'` 시도와 같은 곳) */
function systemChromePaths(): string[] {
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (process.platform === 'win32') return [];
  return ['/opt/google/chrome/chrome'];
}

/**
 * 옛 `launchBrowser`와 같은 순서로 시도할 실행 파일: B_STUDIO_BROWSER_EXECUTABLE이 있으면 그것만, 없으면 Playwright가 받은 Chromium → 설치된 Chrome.
 * 경로는 파일이 있는지 보지 않고 넘긴다(없으면 Rust가 그 이유를 `unavailable`로 알린다)
 */
function candidateExecutables(): string[] {
  const configured = process.env.B_STUDIO_BROWSER_EXECUTABLE;
  if (configured) return [configured];
  const candidates: string[] = [];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // Playwright가 Chromium 경로를 알지 못하면(지원하지 않는 플랫폼) 설치된 Chrome만 시도한다
  }
  return [...candidates, ...systemChromePaths()];
}

export const runInBrowserNative: BrowserRunner = async (url, { viewport = DEFAULT_VIEWPORT, viewportTexts, steps = [], capture = false, allowedOrigins, onFrame, measureLoad = false, signal }) => {
  signal?.throwIfAborted();
  if (steps.length > 0 || capture || onFrame) {
    throw new Error('Rust 화면 확인 러너는 단계(steps)·스크린샷(capture)·화면 중계(onFrame)를 아직 지원하지 않습니다');
  }
  let result;
  try {
    result = await native.runBrowserCheck(
      {
        executables: candidateExecutables(),
        url,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        viewportScript: viewportTexts && viewportTexts.length > 0 ? VIEWPORT_MEASURE_SCRIPT(viewportTexts) : undefined,
        allowedOrigins,
        measureLoad,
        mediaErrorScript: MEDIA_ERROR_INIT_SCRIPT,
      },
      signal,
    );
  } finally {
    // 옛 러너와 같게: 정리가 끝난 뒤 중단 신호가 있으면 결과보다 중단이 먼저다
    signal?.throwIfAborted();
  }
  if (result.kind === 'unavailable') throw new BrowserUnavailableError(result.message);
  if (result.kind === 'failed') throw new Error(result.message);
  if (result.kind === 'aborted') {
    signal?.throwIfAborted();
    throw new Error('취소되었습니다');
  }
  const { pathname } = new URL(url);
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
    // 옛 러너는 페이지를 연 직후 단계를 하나 남긴다. 단계가 없으면 이것뿐이다
    steps: [{ label: `open ${pathname}`, ok: true }],
  };
  return report;
};

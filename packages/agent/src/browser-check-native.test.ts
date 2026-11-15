import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserCandidatesFrom, nativeBrowserCandidates } from './browser-check-native';

describe('Rust 화면 확인 러너가 띄울 브라우저', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.B_STUDIO_BROWSER_EXECUTABLE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.B_STUDIO_BROWSER_EXECUTABLE;
    else process.env.B_STUDIO_BROWSER_EXECUTABLE = saved;
  });

  it('지정하지 않으면 옛 러너(chromium.launch({ headless: true }))처럼 Playwright의 headless shell을 먼저, 설치된 Chrome을 그다음에 시도한다', () => {
    delete process.env.B_STUDIO_BROWSER_EXECUTABLE;
    const candidates = nativeBrowserCandidates();
    expect(candidates[0]).toMatch(/chromium_headless_shell-\d+[\\/]chrome-headless-shell-[^\\/]+[\\/]chrome-headless-shell(\.exe)?$/);
    // `chromium.executablePath()`는 전체 Chromium(새 headless 모드)이다. 옛 러너는 이것을 띄우지 않고, 띄우면 시작·대상 만들기·종료가 수백 ms 느리다
    expect(candidates).not.toContain(chromium.executablePath());
    if (process.platform === 'darwin') expect(candidates.at(-1)).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('B_STUDIO_BROWSER_EXECUTABLE을 지정하면 그것만 시도한다', () => {
    process.env.B_STUDIO_BROWSER_EXECUTABLE = '/opt/some/chrome';
    expect(nativeBrowserCandidates()).toEqual(['/opt/some/chrome']);
  });

  it('headless shell을 찾지 못하면(설치 목록을 읽지 못함) 설치된 Chrome 다음 마지막에 전체 Chromium을 시도한다: 브라우저를 못 찾아 HTTP 확인으로 약해지지 않게', () => {
    const systemChrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    expect(browserCandidatesFrom({ systemChrome, fullChromium: '/pw/chromium/chrome' })).toEqual([...systemChrome, '/pw/chromium/chrome']);
    // headless shell을 찾으면 전체 Chromium은 넣지 않는다(느리다, A6c-1)
    expect(browserCandidatesFrom({ headlessShell: '/pw/shell/chrome-headless-shell', systemChrome, fullChromium: '/pw/chromium/chrome' })).toEqual(['/pw/shell/chrome-headless-shell', ...systemChrome]);
    // 지정한 실행 파일이 있으면 그것만
    expect(browserCandidatesFrom({ configured: '/opt/x', headlessShell: '/pw/shell', systemChrome, fullChromium: '/pw/chromium/chrome' })).toEqual(['/opt/x']);
    // 전체 Chromium 경로도 모르면 설치된 Chrome만
    expect(browserCandidatesFrom({ systemChrome })).toEqual(systemChrome);
  });
});

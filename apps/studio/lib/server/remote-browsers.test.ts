import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserFrame, RemoteBrowser } from '@b-studio/agent';
import { clearFrames, subscribe, type LiveFrame, type LiveMessage } from './live-frames';
import {
  closeAllRemoteBrowsers,
  closeRemoteBrowser,
  inputRemoteBrowser,
  pickRemoteBrowser,
  REMOTE_BROWSER_IDLE_MS,
  RemoteBrowserError,
  remoteBrowserRequestSchema,
  startRemoteBrowser,
} from './remote-browsers';

const SESSION = 'session';

function stubBrowser() {
  const browser: RemoteBrowser = {
    navigate: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    mouse: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    pick: vi.fn(async () => ({ selector: '#buy', html: '<button id="buy">', css: { display: 'block' }, screenshot: Buffer.from([1, 2]), rect: { x: 0, y: 0, width: 10, height: 10 } })),
    close: vi.fn(async () => {}),
  };
  return browser;
}

const VIEWPORT = { width: 1280, height: 800 };

afterEach(async () => {
  await closeAllRemoteBrowsers();
  clearFrames(SESSION);
  vi.useRealTimers();
});

describe('startRemoteBrowser', () => {
  it('세션당 하나만 열고, 새로 시작하면 이전 브라우저를 닫는다', async () => {
    const first = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => first);
    const second = stubBrowser();
    const opened = await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(opened).toEqual({ service: 'web', viewport: VIEWPORT, url: 'http://127.0.0.1:3000/' });
  });

  it('미리보기 주소의 출처를 벗어난 이동은 거부하고, 같은 출처의 경로는 허용한다', async () => {
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => browser);

    await expect(inputRemoteBrowser(SESSION, { type: 'navigate', url: 'http://evil.example/' })).rejects.toBeInstanceOf(RemoteBrowserError);
    await expect(inputRemoteBrowser(SESSION, { type: 'navigate', url: 'http://127.0.0.1:3001/' })).rejects.toBeInstanceOf(RemoteBrowserError);
    await inputRemoteBrowser(SESSION, { type: 'navigate', url: '/orders' });
    expect(browser.navigate).toHaveBeenCalledWith('http://127.0.0.1:3000/orders');
  });

  it('뷰포트 범위를 벗어난 좌표를 거부한다', async () => {
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: { width: 375, height: 812 }, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => browser);

    await expect(inputRemoteBrowser(SESSION, { type: 'mouse', event: 'move', x: 400, y: 10 })).rejects.toMatchObject({ status: 400 });
    await inputRemoteBrowser(SESSION, { type: 'mouse', event: 'down', x: 10, y: 20 });
    expect(browser.mouse).toHaveBeenCalledWith(expect.objectContaining({ type: 'down', x: 10, y: 20 }));
  });

  it('열려 있지 않으면 조작을 거부한다', async () => {
    await expect(inputRemoteBrowser(SESSION, { type: 'reload' })).rejects.toMatchObject({ status: 409 });
    await expect(pickRemoteBrowser(SESSION, 1, 1)).rejects.toMatchObject({ status: 409 });
  });
});

describe('프레임 중계', () => {
  it('브라우저 프레임을 원격 프레임으로 게시한다', async () => {
    const frames: LiveFrame[] = [];
    const off = subscribe(SESSION, (message) => {
      if (!('kind' in message)) frames.push(message);
    });
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async (options) => {
      options.onFrame({ data: Buffer.from([1, 2]), width: 375, height: 812, at: 123 } satisfies BrowserFrame);
      return browser;
    });

    expect(frames.at(-1)).toMatchObject({ source: 'remote', mime: 'image/jpeg', width: 375, height: 812, at: 123 });
    expect(frames.at(-1)?.data).toBe(Buffer.from([1, 2]).toString('base64'));
    off();
  });
});

describe('허용 출처와 차단 집계', () => {
  it('허용 출처를 그대로 넘기고, 막힌 요청 수를 프레임 채널로 알린다', async () => {
    const messages: LiveMessage[] = [];
    const off = subscribe(SESSION, (message) => messages.push(message));
    const browser = stubBrowser();
    let origins: string[] = [];
    let onBlocked: ((input: { url: string; kind: 'navigation' | 'resource' }) => void) | undefined;

    await startRemoteBrowser(
      SESSION,
      { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000', 'http://127.0.0.1:8080'] },
      async (options) => {
        origins = options.allowedOrigins;
        onBlocked = options.onBlocked;
        return browser;
      },
    );

    expect(origins).toEqual(['http://127.0.0.1:3000', 'http://127.0.0.1:8080']);
    onBlocked?.({ url: 'http://evil.example/a', kind: 'resource' });
    onBlocked?.({ url: 'http://evil.example/b', kind: 'navigation' });
    const counts = messages.flatMap((message) => ('kind' in message && message.kind === 'blocked' ? [message.count] : []));
    expect(counts.at(-1)).toBe(2);
    off();
  });
});

describe('pick', () => {
  it('고른 요소의 선택자·HTML·CSS·스크린샷을 돌려준다', async () => {
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => browser);

    const pick = await pickRemoteBrowser(SESSION, 5, 6);
    expect(pick.selector).toBe('#buy');
    expect(pick.screenshot).toBeInstanceOf(Buffer);
    expect(browser.pick).toHaveBeenCalledWith(5, 6);
  });
});

describe('정리', () => {
  it('닫기는 여러 번 불러도 안전하다', async () => {
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => browser);
    await closeRemoteBrowser(SESSION);
    await closeRemoteBrowser(SESSION);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('유휴 시간이 지나면 스스로 닫는다', async () => {
    vi.useFakeTimers();
    const browser = stubBrowser();
    await startRemoteBrowser(SESSION, { service: 'web', url: 'http://127.0.0.1:3000/', viewport: VIEWPORT, allowedOrigins: ['http://127.0.0.1:3000'] }, async () => browser);
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_IDLE_MS + 60_000);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe('remoteBrowserRequestSchema', () => {
  it('action별 필드와 좌표·키 길이를 좁게 검증한다', () => {
    expect(remoteBrowserRequestSchema.safeParse({ action: 'start', service: 'web' }).success).toBe(true);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'start' }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'stop' }).success).toBe(true);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'pick', x: 0, y: 10 }).success).toBe(true);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'pick', x: -1, y: 0 }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'pick', x: 99999, y: 0 }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'input', input: { type: 'key', key: 'Enter' } }).success).toBe(true);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'input', input: { type: 'key', key: 'a'.repeat(33) } }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'input', input: { type: 'navigate' } }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'input', input: { type: 'resize', viewport: { width: 10, height: 10 } } }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse({ action: 'other' }).success).toBe(false);
    expect(remoteBrowserRequestSchema.safeParse(undefined).success).toBe(false);
  });
});

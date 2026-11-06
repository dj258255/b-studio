import type { RemoteBrowser, RemoteBrowserViewport } from '@b-studio/agent';

export class RemoteBrowserError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RemoteBrowserError';
    this.status = status;
  }
}

interface BrowserEntry {
  sessionId: string;
  service: string;
  /** 마지막으로 연 주소. 항상 허용한 출처 안이다 */
  url: string;
  origin: string;
  viewport: RemoteBrowserViewport;
  browser: RemoteBrowser;
  /** 허용하지 않은 출처로 나가려다 막힌 요청 수. 화면에 한 줄로 보여 준다 */
  blocked: number;
  /** 입력이 마지막으로 온 시각(ms). 유휴 판정에 쓴다 */
  state: { lastAt: number };
  timer: NodeJS.Timeout;
}

const globalStore = globalThis as typeof globalThis & { __bStudioRemoteBrowsers?: { entries: Map<string, BrowserEntry> } };
const store = (globalStore.__bStudioRemoteBrowsers ??= { entries: new Map() });

/** 원격 브라우저를 닫는다. 열려 있지 않으면 아무것도 하지 않는다 */
export async function closeRemoteBrowser(sessionId: string): Promise<void> {
  const entry = store.entries.get(sessionId);
  if (!entry) return;
  store.entries.delete(sessionId);
  clearInterval(entry.timer);
  await entry.browser.close().catch(() => {});
}

export async function closeAllRemoteBrowsers(): Promise<void> {
  await Promise.all([...store.entries.keys()].map((sessionId) => closeRemoteBrowser(sessionId)));
}

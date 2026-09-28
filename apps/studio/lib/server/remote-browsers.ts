import { z } from 'zod';
import type { RemoteBrowser, RemoteBrowserOptions, RemoteBrowserPick, RemoteBrowserViewport } from '@b-studio/agent';
import { publish, publishBlocked } from './live-frames';

/**
 * 스튜디오 서버가 소유하는 원격 브라우저. 세션당 하나만 열고, 그 화면을 프레임 채널로 중계하며 사용자의 입력을 되돌려 보낸다.
 * 화면 확인(browser_check)의 헤드리스 브라우저와는 별개 인스턴스다(사람이 보는 화면과 판정용 화면이 서로를 방해하지 않게).
 */
export const REMOTE_BROWSER_IDLE_MS = 10 * 60_000;
/** 유휴 브라우저를 닫는 주기. 열어 둔 채 잊어도 호스트 메모리를 오래 붙잡지 않게 한다 */
const SWEEP_MS = 60_000;

export type RemoteBrowserOpener = (options: RemoteBrowserOptions) => Promise<RemoteBrowser>;

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

/** 기본 opener. 테스트는 가짜를 넘기고, 실제 경로에서만 agent 패키지를 불러온다 */
const defaultOpener: RemoteBrowserOpener = async (options) => {
  const { openRemoteBrowser } = await import('@b-studio/agent');
  return openRemoteBrowser(options);
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEntry(sessionId: string): BrowserEntry {
  const entry = store.entries.get(sessionId);
  if (!entry) throw new RemoteBrowserError(409, '원격 브라우저가 열려 있지 않습니다. 먼저 시작하세요');
  return entry;
}

/** 허용한 출처(미리보기 서비스 주소) 안의 주소만 돌려준다. 다른 호스트로 나가는 것을 막는다 */
function allowedUrl(entry: Pick<BrowserEntry, 'origin' | 'url'>, raw: string): string {
  let target: URL;
  try {
    target = new URL(raw, entry.url);
  } catch {
    throw new RemoteBrowserError(400, '주소가 올바르지 않습니다');
  }
  if (target.origin !== entry.origin) throw new RemoteBrowserError(400, '미리보기 서비스의 주소만 열 수 있습니다');
  return target.toString();
}

function assertCoord(value: number, axis: 'x' | 'y', limit: number): number {
  if (!Number.isFinite(value) || value < 0 || value > limit) throw new RemoteBrowserError(400, `좌표 ${axis}가 뷰포트 범위를 벗어났습니다`);
  return value;
}

/**
 * 세션의 원격 브라우저를 연다. 이미 열려 있으면 닫고 새로 연다(서비스나 뷰포트를 바꿀 때).
 * url은 호출자가 정한 미리보기 주소이고, allowedOrigins 밖으로는 어떤 요청도 나가지 않는다(모델이 만든 페이지를 통한 요청 위조 차단).
 * 막힌 요청 수는 프레임 채널로 알려 화면에 한 줄로 보여 준다
 */
export async function startRemoteBrowser(
  sessionId: string,
  { service, url, viewport, allowedOrigins }: { service: string; url: string; viewport: RemoteBrowserViewport; allowedOrigins: readonly string[] },
  opener: RemoteBrowserOpener = defaultOpener,
): Promise<{ service: string; viewport: RemoteBrowserViewport; url: string }> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new RemoteBrowserError(400, '미리보기 주소가 올바르지 않습니다');
  }
  await closeRemoteBrowser(sessionId);

  const state = { lastAt: Date.now() };
  const entry: BrowserEntry = {
    sessionId,
    service,
    url,
    origin,
    viewport: { ...viewport },
    browser: undefined as unknown as RemoteBrowser,
    blocked: 0,
    state,
    timer: undefined as unknown as NodeJS.Timeout,
  };
  // 열기 전에 0으로 알려, 첫 문서에서 막힌 요청이 바로 이어서 쌓이게 한다
  publishBlocked(sessionId, 0);
  try {
    entry.browser = await opener({
      url,
      viewport: entry.viewport,
      allowedOrigins: [...allowedOrigins],
      onFrame: (frame) => {
        state.lastAt = Date.now();
        publish(sessionId, {
          source: 'remote',
          mime: 'image/jpeg',
          data: frame.data.toString('base64'),
          width: frame.width,
          height: frame.height,
          at: frame.at,
        });
      },
      onNavigate: (next) => {
        entry.url = next;
      },
      onBlocked: () => {
        state.lastAt = Date.now();
        entry.blocked += 1;
        publishBlocked(sessionId, entry.blocked);
      },
    });
  } catch (error) {
    throw new RemoteBrowserError(502, `원격 브라우저를 열지 못했습니다: ${describe(error)}`);
  }
  entry.timer = setInterval(() => sweep(), SWEEP_MS);
  entry.timer.unref();
  store.entries.set(sessionId, entry);
  return { service, viewport: entry.viewport, url };
}

export type RemoteBrowserInput =
  | { type: 'mouse'; event: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; button?: 'left' | 'right'; deltaX?: number; deltaY?: number }
  | { type: 'key'; key: string; text?: string }
  | { type: 'type'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  | { type: 'resize'; viewport: RemoteBrowserViewport };

/** 사용자의 입력을 원격 브라우저로 되돌려 보낸다 */
export async function inputRemoteBrowser(sessionId: string, input: RemoteBrowserInput): Promise<void> {
  const entry = requireEntry(sessionId);
  entry.state.lastAt = Date.now();
  const { browser } = entry;
  switch (input.type) {
    case 'mouse':
      await browser.mouse({
        type: input.event,
        x: assertCoord(input.x, 'x', entry.viewport.width),
        y: assertCoord(input.y, 'y', entry.viewport.height),
        ...(input.button ? { button: input.button } : {}),
        ...(input.deltaX !== undefined ? { deltaX: input.deltaX } : {}),
        ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
      });
      return;
    case 'key':
      await browser.key({ type: 'press', key: input.key, ...(input.text !== undefined ? { text: input.text } : {}) });
      return;
    case 'type':
      await browser.type(input.text);
      return;
    case 'navigate':
      entry.url = allowedUrl(entry, input.url);
      await browser.navigate(entry.url);
      return;
    case 'reload':
      await browser.reload();
      return;
    case 'resize':
      entry.viewport = { ...input.viewport };
      await browser.resize(entry.viewport);
      return;
  }
}

/** 좌표의 요소를 골라 선택자·HTML·CSS·잘라 낸 스크린샷을 돌려준다. 산출물 저장은 호출자가 한다 */
export async function pickRemoteBrowser(sessionId: string, x: number, y: number): Promise<RemoteBrowserPick> {
  const entry = requireEntry(sessionId);
  entry.state.lastAt = Date.now();
  return entry.browser.pick(assertCoord(x, 'x', entry.viewport.width), assertCoord(y, 'y', entry.viewport.height));
}

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

function sweep(): void {
  const now = Date.now();
  for (const entry of store.entries.values()) {
    if (now - entry.state.lastAt >= REMOTE_BROWSER_IDLE_MS) void closeRemoteBrowser(entry.sessionId);
  }
}

const viewportSchema = z.object({
  width: z.number().int().min(240).max(3840),
  height: z.number().int().min(240).max(3840),
});
const coord = z.number().min(0).max(4096);

const inputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    event: z.enum(['down', 'up', 'move', 'wheel']),
    x: coord,
    y: coord,
    button: z.enum(['left', 'right']).optional(),
    deltaX: z.number().min(-10_000).max(10_000).optional(),
    deltaY: z.number().min(-10_000).max(10_000).optional(),
  }),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(32), text: z.string().max(8).optional() }),
  z.object({ type: z.literal('type'), text: z.string().max(1_000) }),
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(2_048) }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('resize'), viewport: viewportSchema }),
]);

/**
 * 원격 브라우저 라우트의 입력. 좌표 범위, 키 문자열 길이, action별 필수 필드를 좁게 검증한다.
 * 여기서 통과한 값만 manager에 넘어가므로 라우트는 파싱만 하고 분기한다
 */
export const remoteBrowserRequestSchema = z.union([
  z.object({ action: z.literal('start'), service: z.string().min(1).max(63), viewport: viewportSchema.optional() }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('pick'), x: coord, y: coord }),
  z.object({ action: z.literal('input'), input: inputSchema }),
]);

export type RemoteBrowserRequest = z.infer<typeof remoteBrowserRequestSchema>;

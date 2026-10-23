/**
 * `studio desk`: herdr처럼 터미널 하나에서 여러 AI CLI를 나란히 쓰는 작업대(#837, ADR-183).
 *
 * 화면·키·스튜디오 손님은 따로 테스트한 순수 함수와 작은 객체이고, 여기서는 그것들을 잇는다:
 * 키 → handleInput → 할 일(입력 보내기, 칸 열기, 새 요청 …) → 스튜디오 API, 터미널 출력 → 칸 해석 → 화면 그리기.
 * 터미널을 대체 화면 버퍼로 바꾸고 raw 모드로 두므로, 어떤 길로 끝나든 되돌린다
 */
import { basename } from 'node:path';
import { StudioClient, StudioRequestError, findStudio } from './client';
import { colorDepth, deskConfigDir, loadDeskConfig, loadDeskLayout, saveDeskLayout, type DeskLayout, type DeskPrefix } from './config';
import { BROWSING, SHELL_ID, flushPending, handleInput, initialState, isShellId, pasteFor, reselect, toInnerKeys, type DeskState, type Effect } from './keys';
import { PaneTerminal } from './pane';
import { spaceScreen } from './cards';
import { previewLine, renderScreen, sidebarView, spaceRect, type PaneView } from './render';
import { placePanes, terminalSize } from './screen';
import { agentStatus, backendLabel, deskSessions, deskSpaces, gateStatus } from './sidebar';
import { loadSprite, spriteDir, type Sprite } from './sprite';
import type { ThemeName } from './theme';
import type { DeskItem, DeskTerminalMessage } from './types';

/** 사이드바를 새로 받는 주기 */
const POLL_MS = 1_500;
/** 화면을 다시 그리는 최소 간격 */
const FRAME_MS = 30;
/** 미리보기를 묻기 전에 기다리는 시간(쓰는 동안 매 글자 묻지 않게) */
const PREVIEW_DELAY_MS = 300;
/** 통로를 다시 열면 스튜디오가 최근 출력을 다시 보낸다. 그동안 그 칸의 해석기가 내는 질의 응답은 CLI에 보내지 않는다(ADR-177 4) */
const REPLAY_QUIET_MS = 500;
/** 통로가 끊기면 다시 여는 간격 */
const RECONNECT_MS = 2_000;
/** 조각 끝의 Esc가 방향키의 앞인지 기다리는 시간. 지나면 Esc 하나로 본다 */
const ESC_WAIT_MS = 25;
/** 창 크기를 끌어 바꾸는 동안 스튜디오에 알리는 것을 미루는 시간(칸 안 해석기는 바로 맞춘다) */
const RESIZE_SETTLE_MS = 150;
/** 터미널로 띄울 수 있는 AI. 스튜디오 routed-session.ts의 terminalBackends와 같은 기준이다(desk가 붙는 launch는 이 컴퓨터 방식) */
const TERMINAL_BACKENDS: readonly string[] = ['claude-code', 'codex'];
/** 사람이 손대야 하는 상태. 이리로 바뀌면 알린다(#864) */
const WAITING: readonly string[] = ['권한 대기', '답 기다림', '승인 대기'];
/** 작업 중에서 이리로 바뀌면 끝났다고 알린다 */
const SETTLED: readonly string[] = ['CLI 대기', '쉼'];
/** 게이트 판정이 이리로 바뀌면 알린다. 값은 알림 문구 */
const GATE_NOTICE: Record<string, string> = { 실패: '검증 실패', '확인 필요': '확인 필요', 통과: '검증 통과' };
/** 이어서 작업한 세션이 아직 켜지지 않은 상태 */
const NOT_READY: readonly string[] = ['stopped', 'booting'];
/** 한 번에 내는 OS 알림의 상한(여럿이 한꺼번에 바뀌어도 알림이 쏟아지지 않게) */
const MAX_OS_NOTICES = 3;
/** 휠 한 칸에 옮기는 줄 수 */
const WHEEL_LINES = 3;

// 밖 터미널의 bracketed paste를 켜서 붙여넣기를 표지로 받는다(붙인 글 안의 Ctrl-b를 명령으로 보지 않게, #860)
const ENTER_SCREEN = '\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J';
const LEAVE_SCREEN = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l';
// 마우스는 누름·뗌·휠(1000)을 SGR 꼴(1006)로 받는다. 끌기(1002)는 받지 않는다(#874)
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

export interface DeskOptions {
  port?: number;
  /** false면 벨과 OS 알림을 내지 않는다(--no-notify). 설정 파일보다 앞선다. 사이드바 표시와 아래 줄 알림은 그대로다 */
  notify?: boolean;
  /** false면 마우스를 받지 않는다(--no-mouse). 설정 파일보다 앞선다 */
  mouse?: boolean;
}

/** 셸 칸의 가상 터미널에서 desk가 쓰는 부분(node-pty와 같은 꼴, #873) */
export interface ShellPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}
/** 셸 칸의 가상 터미널을 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnShell = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => ShellPty | Promise<ShellPty>;

const spawnWithNodePty: SpawnShell = async (file, args, options) => {
  // 스튜디오의 세션 터미널(packages/sandbox host-terminal)과 같은 가상 터미널 모듈이다. 셸 칸을 열 때만 읽는다
  const pty = await import('@lydell/node-pty');
  return pty.spawn(file, args, options);
};

/**
 * 셸 칸에 넘길 환경. desk의 환경에서 B_STUDIO_로 시작하는 것을 모두 뺀다:
 * 관문·MCP·인증 토큰과 비밀(B_STUDIO_GATE_TOKEN, B_STUDIO_GATEWAY_TOKEN, B_STUDIO_MCP_TOKEN, B_STUDIO_AUTH_*, B_STUDIO_SECRET_* …)이 이 이름 아래 있고,
 * 셸 칸은 관문 밖이다. desk를 세션 터미널 안에서 띄웠을 때 그 세션의 토큰이 관문 밖 셸로 새지 않게 한다
 */
export function shellEnvOf(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith('B_STUDIO_')) continue;
    out[name] = value;
  }
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/** 배치를 읽고 쓰는 곳(실제로는 desk-state.json, 테스트에서는 메모리) */
export interface DeskLayoutStore {
  load(): DeskLayout | undefined;
  save(layout: DeskLayout): void;
}

export interface DeskAppOptions {
  notify?: boolean;
  /** false면 밖 터미널의 마우스를 켜지 않는다 */
  mouse?: boolean;
  /** false면 칸의 24비트 색을 256색으로 낮춰 그린다 */
  truecolor?: boolean;
  /** desk 자신의 색 팔레트(#887). 없으면 dark */
  theme?: ThemeName;
  /** 카드 그림(세션 id·AI 이름·default 차례로 찾는다). 없으면 desk의 기본 그림 */
  sprites?: Record<string, Sprite>;
  /** 설정한 앞글쇠(없으면 Ctrl-b) */
  prefix?: DeskPrefix;
  layoutStore?: DeskLayoutStore;
  /** 시작할 때 아래 줄에 보일 설정 알림(잘못된 값) */
  warnings?: string[];
  /** 셸 칸을 띄우는 자리(기본은 node-pty, #873) */
  spawnShell?: SpawnShell;
  /** 셸 칸에 넘길 환경의 바탕(기본은 desk의 환경. B_STUDIO_로 시작하는 것은 뺀다) */
  shellEnv?: Record<string, string | undefined>;
  /** 셸 칸의 폴더(기본은 desk를 띄운 폴더) */
  shellCwd?: string;
}

/** desk가 부르는 스튜디오 API(테스트에서는 가짜를 넣는다) */
export type DeskClient = Pick<StudioClient, 'agents' | 'projects' | 'rules' | 'preview' | 'start' | 'open' | 'resize' | 'input' | 'stream' | 'stop' | 'resume' | 'rename'>;

/** desk가 쓰는 터미널 입출력. 실제로는 process.stdin·stdout이다 */
export interface DeskIo {
  write(data: string): void;
  size(): { cols: number; rows: number };
  onInput(listener: (chunk: string) => void): void;
  onResize(listener: () => void): void;
  setRaw(on: boolean): void;
  /** 신호·처리 못 한 예외에서도 화면을 되돌리게 건다(테스트에서는 없다) */
  guard?(restore: () => void, stop: (code: number) => void): void;
}

function processIo(): DeskIo {
  return {
    write: (data) => process.stdout.write(data),
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onInput: (listener) => {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', listener);
      process.stdin.resume();
    },
    onResize: (listener) => process.stdout.on('resize', listener),
    setRaw: (on) => {
      try {
        process.stdin.setRawMode(on);
      } catch {
        // 이미 닫힌 입력
      }
      if (!on) process.stdin.pause();
    },
    guard: (restore, stop) => {
      process.once('exit', restore);
      const fatal = (error: unknown) => {
        restore();
        console.error(`studio desk가 멈췄습니다: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        process.exit(1);
      };
      process.on('uncaughtException', fatal);
      process.on('unhandledRejection', fatal);
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => stop(0));
    },
  };
}

export async function desk(options: DeskOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('studio desk는 터미널에서 실행합니다(입력과 출력이 터미널이어야 합니다)');
    return 2;
  }
  const found = await findStudio(env, options);
  if ('error' in found) {
    console.error(found.error);
    return 1;
  }
  const client = new StudioClient(found);
  let first: DeskState['items'];
  try {
    first = (await client.agents()).items;
  } catch (error) {
    console.error(`스튜디오(${found.origin})에 닿지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    console.error('`pnpm studio launch`로 띄운 뒤 다시 실행하세요. 다른 포트면 --port를 주세요');
    return 1;
  }
  const dir = deskConfigDir(env);
  const { config, warnings } = loadDeskConfig(dir);
  // 카드 그림: 그림 폴더의 AI 이름별 그림과 default.png(#887)
  const sprites: Record<string, Sprite> = {};
  for (const name of ['claude-code', 'codex', 'gemini', 'default']) {
    const sprite = loadSprite(spriteDir(dir), [name], warnings);
    if (sprite) sprites[name] = sprite;
  }
  const app = new DeskApp(client, first, processIo(), {
    // 명령 인자가 설정 파일보다 앞선다
    notify: options.notify ?? config.notify ?? true,
    mouse: options.mouse ?? config.mouse ?? true,
    truecolor: colorDepth(env, config.color) === 'truecolor',
    ...(config.theme ? { theme: config.theme } : {}),
    sprites,
    ...(config.prefix ? { prefix: config.prefix } : {}),
    layoutStore: { load: () => loadDeskLayout(dir), save: (layout) => saveDeskLayout(dir, layout) },
    warnings,
  });
  const code = await app.run();
  if (app.exitWarning) console.error(app.exitWarning);
  return code;
}

export class DeskApp {
  readonly #client: DeskClient;
  readonly #io: DeskIo;
  #state: DeskState;
  readonly #panes = new Map<string, PaneTerminal>();
  readonly #notes = new Map<string, string>();
  /** 칸마다 마지막으로 스튜디오에 알린 터미널 크기 */
  readonly #sizes = new Map<string, string>();
  /** 터미널이 끝났거나 열지 못한 세션. 사람이 다시 고를 때(Ctrl-b Enter)까지 열기·크기를 보내지 않는다 */
  readonly #closed = new Set<string>();
  #pendingTimer: NodeJS.Timeout | undefined;
  #resizeTimer: NodeJS.Timeout | undefined;
  #polling = false;
  #prevFrame: string[] = [];
  #frameTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #previewTimer: NodeJS.Timeout | undefined;
  /** 칸마다 따로 연 터미널 통로. 칸 하나를 열고 닫아도 다른 칸의 통로와 화면은 그대로다(#863) */
  readonly #streams = new Map<string, { controller: AbortController; timer?: NodeJS.Timeout }>();
  /** 칸마다 최근 출력을 다시 받는 동안(질의 응답을 CLI에 보내지 않는 때)의 끝 */
  readonly #quietUntil = new Map<string, number>();
  readonly #notify: boolean;
  /** 세션마다 지난번에 본 상태·게이트(바뀐 것을 알리려고 둔다). 처음 받은 목록은 알리지 않고 여기에 적기만 한다 */
  readonly #last = new Map<string, { status: string; gate?: string }>();
  /** 이어서 작업을 보낸 세션. 켜지면 칸을 다시 연다 */
  readonly #resuming = new Set<string>();
  /** 칸 안 CLI가 벨을 울린 세션(칸 머리에 보이고, 그 칸을 고르면 지운다) */
  readonly #bells = new Set<string>();
  #restored = false;
  #finish: (code: number) => void = () => {};
  readonly #mouseOn: boolean;
  readonly #truecolor: boolean;
  readonly #layoutStore: DeskLayoutStore | undefined;
  /** 배치를 저장하지 못한 것을 이미 알렸다(같은 알림을 되풀이하지 않는다) */
  #layoutWarned = false;
  /** 나갈 때 배치를 저장하지 못했으면 화면을 되돌린 뒤 보일 글 */
  #exitWarning: string | undefined;
  /** 셸 칸(#873). desk가 직접 든 로컬 셸이라 스튜디오·관문을 거치지 않고, desk를 나가거나 칸을 비우면 끝난다 */
  readonly #shells = new Map<string, { pty?: ShellPty; ended: boolean; dir: string }>();
  #shellSeq = 0;
  readonly #spawnShell: SpawnShell;
  readonly #shellEnv: Record<string, string | undefined>;
  readonly #shellCwd: string;

  constructor(client: DeskClient, items: DeskState['items'], io: DeskIo, options: DeskAppOptions = {}) {
    this.#client = client;
    this.#io = io;
    this.#notify = options.notify !== false;
    this.#mouseOn = options.mouse !== false;
    this.#truecolor = options.truecolor !== false;
    this.#layoutStore = options.layoutStore;
    this.#spawnShell = options.spawnShell ?? spawnWithNodePty;
    this.#shellEnv = options.shellEnv ?? process.env;
    this.#shellCwd = options.shellCwd ?? process.cwd();
    const prefix = options.prefix ? { prefixKey: options.prefix.key, prefixLabel: options.prefix.label } : {};
    const warnings = options.warnings?.length ? { message: `설정: ${options.warnings.join(' / ')}` } : {};
    const theme = { name: options.theme ?? 'dark', depth: this.#truecolor ? 'truecolor' : '256' } as const;
    const restored = this.#restoredLayout(items);
    // 열린 칸이 없으면 스페이스 화면(카드)부터 보인다(#887)
    const open = (restored.slots ?? []).some((id, slot) => id && slot < (restored.layout ?? 1));
    this.#state = { ...initialState(), items, theme, sprites: options.sprites ?? {}, ...prefix, ...warnings, ...restored, ...(open ? {} : { view: 'space' as const }) };
    for (const item of items) this.#last.set(item.id, statusOf(item));
  }

  /** 나갈 때 배치를 저장하지 못했으면 그 알림(desk가 화면을 되돌린 뒤 보인다) */
  get exitWarning(): string | undefined {
    return this.#exitWarning;
  }

  /** 저장해 둔 배치. 지금 없는 세션의 자리는 비운다 */
  #restoredLayout(items: DeskState['items']): Partial<DeskState> {
    const saved = this.#layoutStore?.load();
    if (!saved) return {};
    const known = new Set(deskSessions(items).map((item) => item.id));
    const slots = saved.slots.map((id, slot) => (id && slot < saved.layout && known.has(id) ? id : undefined));
    return { layout: saved.layout, slots, focus: Math.min(saved.focus, saved.layout - 1), zoom: saved.zoom, sidebarHidden: saved.sidebarHidden };
  }

  #saveLayout(): void {
    if (!this.#layoutStore) return;
    const { layout, slots, focus, zoom, sidebarHidden } = this.#state;
    try {
      // 셸 칸은 남기지 않는다: desk를 나가면 셸이 끝나고, 다음에 같은 자리에 새 셸을 띄우면 전과 다른 셸인데 이어진 것처럼 보인다
      this.#layoutStore.save({ layout, slots: slots.map((id, slot) => (slot < layout && !isShellId(id) ? id : undefined)), focus, zoom: zoom === true, sidebarHidden: sidebarHidden === true });
    } catch (error) {
      const text = `칸 배치를 저장하지 못했습니다: ${messageOf(error)}`;
      if (this.#restored) {
        if (!this.#layoutWarned) this.#exitWarning = text;
      } else if (!this.#layoutWarned) this.#say(text);
      this.#layoutWarned = true;
    }
  }

  /** 지금 상태(테스트가 본다) */
  get state(): DeskState {
    return this.#state;
  }

  run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      this.#finish = resolve;
    });
    this.#io.guard?.(
      () => this.#restore(),
      (code) => this.#stop(code),
    );
    this.#io.write(ENTER_SCREEN + (this.#mouseOn ? MOUSE_ON : ''));
    this.#io.setRaw(true);
    this.#io.onInput((chunk) => this.#onInput(chunk));
    this.#io.onResize(() => {
      // 칸 해석기와 화면은 바로 맞추고, 스튜디오에는 크기가 멈춘 뒤 한 번만 알린다
      this.#prevFrame = [];
      this.#ensurePanes();
      this.#render();
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.#syncPanes(), RESIZE_SETTLE_MS);
    });
    this.#pollTimer = setInterval(() => void this.#poll(), POLL_MS);
    // 되살린 배치의 칸을 연다
    if (this.#visible().length > 0) this.#slotsChanged();
    this.#render();
    return done;
  }

  #size(): { cols: number; rows: number } {
    const { cols, rows } = this.#io.size();
    return { cols: Math.max(20, cols), rows: Math.max(6, rows) };
  }

  #onInput(chunk: string): void {
    clearTimeout(this.#pendingTimer);
    this.#take(handleInput(this.#state, chunk));
    // 조각 끝에서 끊긴 이스케이프 열은 잠깐 기다린다. 이어지는 조각이 없으면 그대로 처리한다(혼자 누른 Esc)
    if (this.#state.pending) this.#pendingTimer = setTimeout(() => this.#take(flushPending(this.#state)), ESC_WAIT_MS);
  }

  #take({ state, effects }: { state: DeskState; effects: Effect[] }): void {
    this.#state = state;
    for (const effect of effects) this.#apply(effect);
    this.#clearSeen();
    this.#scheduleRender();
  }

  /** 지금 고른 칸의 세션 */
  #focused(): string | undefined {
    return this.#state.focus < this.#state.layout ? this.#state.slots[this.#state.focus] : undefined;
  }

  /** 사람이 본 세션의 표시를 지운다: 고른 칸의 세션, 사이드바를 고르는 중이면 고른 세션 */
  #clearSeen(): void {
    const seen = new Set<string>();
    const focused = this.#focused();
    if (focused) seen.add(focused);
    if (this.#state.browsing) {
      const selected = deskSessions(this.#state.items)[this.#state.selected]?.id;
      if (selected) seen.add(selected);
    }
    for (const id of seen) this.#bells.delete(id);
    const flagged = this.#state.flagged?.filter((id) => !seen.has(id));
    if (flagged && flagged.length !== this.#state.flagged!.length) this.#state = { ...this.#state, flagged };
  }

  #send(id: string, data: string): void {
    if (isShellId(id)) {
      const shell = this.#shells.get(id);
      if (shell?.pty && !shell.ended) shell.pty.write(data);
      return;
    }
    this.#client.input(id, data).catch((error: unknown) => this.#say(`입력을 보내지 못했습니다: ${messageOf(error)}`));
  }

  #apply(effect: Effect): void {
    switch (effect.type) {
      case 'input': {
        // 안쪽 CLI가 응용 커서 키 모드면 방향키를 그 꼴로 바꾼다(밖 터미널은 늘 보통 꼴로 보낸다)
        const modes = this.#panes.get(effect.id)?.modes();
        this.#send(effect.id, modes ? toInnerKeys(effect.data, modes) : effect.data);
        return;
      }
      case 'paste':
        this.#send(effect.id, pasteFor(effect, this.#panes.get(effect.id)?.modes().bracketedPaste ?? false));
        return;
      case 'reopen':
        // 끝났거나 열지 못한 터미널만 다시 연다. 열려 있으면 크기가 같아 아무것도 보내지 않는다
        if (this.#closed.delete(effect.id)) this.#sizes.delete(effect.id);
        this.#syncPanes();
        return;
      case 'close':
        if (isShellId(effect.id)) {
          this.#closeShell(effect.slot, effect.id, effect.confirmed === true);
          return;
        }
        this.#slotsChanged();
        this.#saveLayout();
        return;
      case 'open':
      case 'layout':
        this.#slotsChanged();
        this.#saveLayout();
        return;
      case 'mouse':
        this.#mouse(effect);
        return;
      case 'copy':
        this.#copy(effect.id, effect.action, effect.text);
        return;
      case 'quit': {
        // 셸 칸은 desk와 함께 끝난다. 살아 있는 셸이 있으면 한 번 묻는다
        const live = [...this.#shells.values()].filter((shell) => !shell.ended).length;
        if (live > 0 && !effect.confirmed) {
          this.#state = { ...this.#state, confirm: { action: 'quit', id: '', title: `셸 칸 ${live}개` } };
          return;
        }
        this.#stop(0);
        return;
      }
      case 'shell':
        void this.#openShell(effect.slot);
        return;
      case 'prompt':
        void this.#openPrompt();
        return;
      case 'preview':
        this.#schedulePreview(effect.text);
        return;
      case 'submit':
        void this.#submit(effect.projectId, effect.request, effect.choice);
        return;
      case 'session':
        void this.#sessionAction(effect.action, effect.id);
        return;
      case 'rename':
        void this.#rename(effect.id, effect.label);
        return;
    }
  }

  /** 세션 멈추기·이어서 작업(#864). 이어서 작업한 세션은 켜진 뒤 칸을 다시 연다(#poll) */
  async #sessionAction(action: 'stop' | 'resume', id: string): Promise<void> {
    const title = this.#state.items.find((entry) => entry.id === id)?.title ?? id;
    try {
      if (action === 'stop') {
        await this.#client.stop(id);
        this.#say(`세션을 멈췄습니다: ${title} (Ctrl-b r로 이어서 작업합니다)`);
      } else {
        await this.#client.resume(id);
        this.#resuming.add(id);
        if (this.#visible().includes(id)) this.#notes.set(id, '이어서 작업하는 중');
        this.#say(`이어서 작업을 시작했습니다: ${title} · 켜지면 칸을 다시 엽니다`);
      }
      void this.#poll();
    } catch (error) {
      this.#say(`${action === 'stop' ? '멈추지' : '이어서 작업하지'} 못했습니다: ${messageOf(error)}`);
    }
  }

  async #rename(id: string, label: string): Promise<void> {
    try {
      await this.#client.rename(id, label);
      this.#say(label ? `이름을 바꿨습니다: ${label}` : '이름을 지웠습니다(제목은 마지막 요청입니다)');
      void this.#poll();
    } catch (error) {
      this.#say(`이름을 바꾸지 못했습니다: ${messageOf(error)}`);
    }
  }

  /**
   * 목록이 바뀐 것을 알린다(#864): 사람이 손댈 상태(권한·답·승인), 게이트 판정, 작업이 끝남.
   * 사이드바에 표시를 붙이고(본 뒤 지운다) 아래 줄에 알린다. 알림을 켰으면 벨을 울리고, 보고 있는 칸이 아닌 세션은 OS 알림(OSC 9)도 낸다
   */
  #announce(items: readonly DeskItem[]): void {
    const notices: Array<{ id: string; text: string }> = [];
    for (const item of items) {
      const now = statusOf(item);
      const before = this.#last.get(item.id);
      this.#last.set(item.id, now);
      if (!before) continue;
      const what = changeOf(before, now);
      if (what) notices.push({ id: item.id, text: `${backendLabel(item.backend)} · ${item.title} · ${what}` });
    }
    if (notices.length === 0) return;
    const focused = this.#focused();
    const flagged = new Set(this.#state.flagged ?? []);
    for (const notice of notices) if (notice.id !== focused) flagged.add(notice.id);
    this.#state = { ...this.#state, flagged: [...flagged], message: `알림: ${notices.map((notice) => notice.text).join(' / ')}` };
    if (!this.#notify) return;
    let out = '\x07';
    for (const notice of notices.filter((entry) => entry.id !== focused).slice(0, MAX_OS_NOTICES)) out += `\x1b]9;${oscText(`b-studio: ${notice.text}`)}\x07`;
    this.#io.write(out);
  }

  /**
   * 마우스(#874). 사이드바를 누르면 그 세션을 고르고(고른 세션을 한 번 더 누르면 연다), 칸을 누르면 그 칸을 고른다.
   * 휠은 그 칸의 복사 모드로 지난 출력을 올려 본다. 안쪽 CLI가 마우스를 켰으면 고른 칸 안의 마우스는 칸 좌표로 바꿔 CLI에 넘긴다
   */
  #mouse(event: Extract<Effect, { type: 'mouse' }>): void {
    if (!this.#mouseOn) return;
    const { button, x, y, release } = event;
    const wheel = (button & 64) !== 0 ? ((button & 1) === 0 ? -1 : 1) : 0;
    const press = !release && (button & 32) === 0;
    const size = this.#size();
    const side = sidebarView(this.#state, size);
    if (!this.#state.sidebarHidden && x < side.rect.w && y >= side.rect.y && y < side.rect.y + side.rect.h) {
      if (!press) return;
      const sessions = deskSessions(this.#state.items);
      if (wheel) {
        this.#state = { ...this.#state, selected: Math.max(0, Math.min(sessions.length - 1, this.#state.selected + wheel)) };
      } else {
        const row = side.rows[side.offset + (y - side.rect.y)];
        const space = row?.space === undefined ? undefined : deskSpaces(this.#state.items).find((entry) => entry.name === row.space);
        if (space) {
          // 스페이스를 누르면 그 스페이스 화면(카드)을 연다
          this.#state = { ...this.#state, selected: space.sessions.includes(this.#state.selected) ? this.#state.selected : space.sessions[0]!, view: 'space' };
          this.#clearSeen();
          this.#scheduleRender();
          return;
        }
        if (row?.item === undefined) return;
        if (row.item === this.#state.selected) {
          // 고른 세션을 한 번 더 누르면 Ctrl-b Enter와 같다
          this.#take(handleInput({ ...this.#state, prefix: true }, '\r'));
          return;
        }
        // 고르기만 한다. 이어서 Enter를 누르면 연다(Ctrl-b ↑↓로 고를 때와 같다)
        this.#state = { ...this.#state, selected: row.item, prefix: true, browsing: true, message: BROWSING };
      }
      this.#clearSeen();
      this.#scheduleRender();
      return;
    }
    if (this.#state.view === 'space') {
      if (!press) return;
      const sessions = deskSessions(this.#state.items);
      if (wheel) this.#state = { ...this.#state, selected: Math.max(0, Math.min(sessions.length - 1, this.#state.selected + wheel)) };
      else {
        const card = spaceScreen(this.#state, spaceRect(this.#state, size)).cards.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
        if (!card) return;
        // 고른 카드를 한 번 더 누르면 고른 칸에 연다(Enter와 같다)
        if (card.index === this.#state.selected) {
          this.#take(handleInput({ ...this.#state, prefix: true }, '\r'));
          return;
        }
        this.#state = { ...this.#state, selected: card.index };
      }
      this.#clearSeen();
      this.#scheduleRender();
      return;
    }
    const placed = placePanes(size.cols, size.rows, this.#state).panes.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
    if (!placed) return;
    const { slot, rect } = placed;
    const id = this.#state.slots[slot];
    const pane = id ? this.#panes.get(id) : undefined;
    const modes = pane?.modes();
    if (id && pane && modes?.mouse && !pane.inCopy && slot === this.#state.focus && y > rect.y) {
      // 칸 몸의 첫 줄은 칸 머리 다음 줄이다. 좌표는 1부터
      const column = x - rect.x + 1;
      const line = y - rect.y;
      const data = modes.sgrMouse ? `\x1b[<${button};${column};${line}${release ? 'm' : 'M'}` : x10Mouse(release ? 3 : button, column, line);
      if (data) this.#send(id, data);
      return;
    }
    if (!press) return;
    if (slot !== this.#state.focus) {
      // 다른 칸을 고르면 앞 칸의 복사 모드는 닫는다(복사 모드는 고른 칸의 것이다)
      if (this.#state.copy) this.#endCopy();
      this.#state = { ...this.#state, focus: slot };
    }
    if (wheel && id && pane) this.#wheel(id, pane, wheel);
    this.#clearSeen();
    this.#scheduleRender();
  }

  /** 휠로 지난 출력을 본다: 위로 굴리면 복사 모드로 들어가 올라가고, 맨 아래까지 내리면 나온다 */
  #wheel(id: string, pane: PaneTerminal, direction: 1 | -1): void {
    if (!pane.inCopy) {
      if (direction > 0) return;
      this.#copy(id, 'enter');
      this.#state = { ...this.#state, copy: {}, prefix: false, browsing: false };
    }
    pane.copyMove(direction * WHEEL_LINES);
    const status = pane.copyStatus();
    if (direction > 0 && status.line >= status.total) this.#endCopy();
    this.#prevFrame = [];
  }

  #endCopy(): void {
    const id = this.#focused();
    if (id) this.#panes.get(id)?.exitCopy();
    this.#state = { ...this.#state, copy: undefined };
    this.#prevFrame = [];
  }

  /** 복사 모드 조작. 보는 자리와 고른 범위는 칸 해석기가 든다 */
  #copy(id: string, action: Extract<Effect, { type: 'copy' }>['action'], text?: string): void {
    const pane = this.#panes.get(id);
    if (!pane) {
      this.#state = { ...this.#state, copy: undefined, message: '이 칸은 아직 출력을 받지 않았습니다' };
      return;
    }
    switch (action) {
      case 'enter':
        pane.enterCopy();
        break;
      case 'up':
        pane.copyMove(-1);
        break;
      case 'down':
        pane.copyMove(1);
        break;
      case 'pageUp':
        pane.copyPage(-1);
        break;
      case 'pageDown':
        pane.copyPage(1);
        break;
      case 'top':
        pane.copyTop();
        break;
      case 'bottom':
        pane.copyBottom();
        break;
      case 'mark':
        pane.copyMark();
        break;
      case 'search':
      case 'next':
        if (!pane.copySearch(action === 'search' ? text : undefined)) this.#state = { ...this.#state, message: '위쪽에서 찾지 못했습니다' };
        break;
      case 'yank': {
        const copied = pane.copyYank();
        pane.exitCopy();
        // 밖 터미널의 클립보드에 넣는다(OSC 52). 받지 않는 터미널도 있어 안내에 적는다
        this.#io.write(`\x1b]52;c;${Buffer.from(copied).toString('base64')}\x07`);
        const count = copied ? copied.split('\n').length : 0;
        this.#state = { ...this.#state, message: `${count}줄을 클립보드로 보냈습니다(터미널이 OSC 52를 받아야 붙여 넣을 수 있습니다)` };
        break;
      }
      case 'exit':
        pane.exitCopy();
        break;
    }
    this.#prevFrame = [];
  }

  #say(message: string): void {
    this.#state = { ...this.#state, message };
    this.#scheduleRender();
  }

  /** 지금 칸에 보이는 세션 */
  /**
   * 고른 칸에 그냥 셸을 연다(#873). desk가 직접 띄우는 로그인 셸이라 스튜디오와 관문을 거치지 않는다.
   * 칸 해석기·복사 모드·마우스·붙여넣기는 세션 칸과 같다
   */
  async #openShell(slot: number): Promise<void> {
    const id = `${SHELL_ID}${++this.#shellSeq}`;
    const dir = this.#shellCwd;
    const entry: { pty?: ShellPty; ended: boolean; dir: string } = { ended: false, dir };
    this.#shells.set(id, entry);
    const slots = [...this.#state.slots];
    slots[slot] = id;
    this.#state = { ...this.#state, slots, message: '그냥 셸을 열었습니다. 이 칸은 검증 밖이고, desk를 나가거나 칸을 비우면 끝납니다' };
    // 해석기를 먼저 만들어 칸 크기를 안다. 앞서 칸에 있던 셸은 여기서 끝난다
    this.#slotsChanged();
    this.#saveLayout();
    const size = this.#ensurePanes().find((entry) => entry.id === id)?.size ?? { cols: 80, rows: 24 };
    const env = shellEnvOf(this.#shellEnv);
    const file = env.SHELL || '/bin/sh';
    try {
      const pty = await this.#spawnShell(file, ['-l'], { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: dir, env });
      if (!this.#shells.has(id) || this.#restored) {
        // 띄우는 동안 칸을 비웠거나 desk를 나갔다
        pty.kill();
        return;
      }
      entry.pty = pty;
      this.#sizes.set(id, `${size.cols}x${size.rows}`);
      pty.onData((data) => {
        const pane = this.#panes.get(id);
        if (pane) void pane.write(data).then(() => this.#scheduleRender());
      });
      pty.onExit(({ exitCode }) => {
        entry.ended = true;
        this.#notes.set(id, `셸이 끝났습니다(${exitCode}) · Ctrl-b x로 칸을 비웁니다`);
        this.#scheduleRender();
      });
    } catch (error) {
      entry.ended = true;
      this.#notes.set(id, `셸을 띄우지 못했습니다: ${messageOf(error)}`);
    }
    this.#scheduleRender();
  }

  /** 셸 칸 비우기: 끝난 셸은 바로 비우고, 살아 있는 셸은 한 번 묻는다(셸에서 돌던 빌드·서버도 끝난다) */
  #closeShell(slot: number, id: string, confirmed: boolean): void {
    const shell = this.#shells.get(id);
    if (shell && !shell.ended && !confirmed) {
      this.#state = { ...this.#state, confirm: { action: 'close', id, title: '셸' } };
      return;
    }
    if (this.#state.slots[slot] !== id) return;
    const slots = [...this.#state.slots];
    slots[slot] = undefined;
    this.#state = { ...this.#state, slots, message: '셸을 끝내고 칸을 비웠습니다' };
    this.#slotsChanged();
    this.#saveLayout();
  }

  #visible(): string[] {
    return this.#state.slots.slice(0, this.#state.layout).filter((id): id is string => Boolean(id));
  }

  /** 칸 구성이 바뀌었다: 새 칸의 통로를 먼저 열고(늦게 붙은 칸이 출력을 놓치지 않게) 칸 크기에 맞춰 터미널을 연다 */
  #slotsChanged(): void {
    const visible = new Set(this.#visible());
    // 칸에서 빠진 세션의 해석기는 버린다(다시 열면 스튜디오가 최근 출력을 다시 보낸다). 세션과 CLI는 계속 돈다
    // 셸 칸은 칸 자리에서 사라졌을 때만 끝낸다(x로 비웠을 때). 칸 수를 줄이거나 크게 보기로 가린 셸은 계속 돌고 해석기도 출력을 받는다
    const held = new Set(this.#state.slots.filter((id): id is string => isShellId(id)));
    for (const [id, shell] of this.#shells) {
      if (held.has(id)) continue;
      if (!shell.ended) shell.pty?.kill();
      this.#shells.delete(id);
    }
    for (const [id, pane] of this.#panes) {
      if (visible.has(id) || held.has(id)) continue;
      pane.dispose();
      this.#panes.delete(id);
      this.#sizes.delete(id);
      this.#notes.delete(id);
      this.#closed.delete(id);
    }
    this.#prevFrame = [];
    // 해석기를 먼저 만들어 둔다: 통로가 열리자마자 오는 최근 출력을 받을 자리가 있어야 한다
    this.#ensurePanes();
    this.#syncStreams();
    this.#syncPanes();
  }

  /**
   * 칸에 있는 세션마다 해석기를 만들고, 화면에 놓인 칸은 그 크기에 맞춘다(스튜디오에는 알리지 않는다).
   * 크게 보기로 가려진 칸은 크기를 그대로 둔다. 그 세션은 통로로 계속 받고, 크게 보기를 풀면 원래 자리로 돌아온다
   */
  #ensurePanes(): Array<{ id: string; size: { cols: number; rows: number } }> {
    const { cols, rows } = this.#size();
    const shown = placePanes(cols, rows, this.#state).panes;
    const base = placePanes(cols, rows, { ...this.#state, zoom: false }).panes;
    const placed: Array<{ id: string; size: { cols: number; rows: number } }> = [];
    this.#state.slots.forEach((id, slot) => {
      if (!id || slot >= this.#state.layout) return;
      const rect = shown.find((entry) => entry.slot === slot)?.rect;
      let pane = this.#panes.get(id);
      if (!pane) {
        const first = terminalSize(rect ?? base.find((entry) => entry.slot === slot)!.rect);
        pane = new PaneTerminal(first.cols, first.rows, { truecolor: this.#truecolor });
        const sessionId = id;
        pane.onResponse((data) => {
          if (Date.now() < (this.#quietUntil.get(sessionId) ?? 0)) return;
          if (isShellId(sessionId)) this.#send(sessionId, data);
          else this.#client.input(sessionId, data).catch(() => {});
        });
        // 칸 안 CLI의 벨은 칸 머리에 보이고 밖 터미널 벨로 잇는다. 다시 받는 옛 출력의 벨은 울리지 않는다
        pane.onBell(() => {
          if (Date.now() < (this.#quietUntil.get(sessionId) ?? 0)) return;
          if (sessionId !== this.#focused()) this.#bells.add(sessionId);
          if (this.#notify) this.#io.write('\x07');
          this.#scheduleRender();
        });
        this.#panes.set(id, pane);
      }
      if (!rect) return;
      const size = terminalSize(rect);
      pane.resize(size.cols, size.rows);
      placed.push({ id, size });
    });
    return placed;
  }

  /** 해석기를 맞추고, 크기가 바뀐 칸만 스튜디오에 알린다(처음은 열기, 그다음은 크기) */
  #syncPanes(): void {
    clearTimeout(this.#resizeTimer);
    for (const { id, size } of this.#ensurePanes()) {
      if (isShellId(id)) {
        const key = `${size.cols}x${size.rows}`;
        const shell = this.#shells.get(id);
        if (!shell?.pty || shell.ended || this.#sizes.get(id) === key) continue;
        this.#sizes.set(id, key);
        shell.pty.resize(size.cols, size.rows);
        continue;
      }
      // 끝난 터미널은 창 크기를 바꿨다고 다시 띄우지 않는다(CLI가 새로 뜬다). 사람이 다시 고르면 연다
      if (this.#closed.has(id)) continue;
      const key = `${size.cols}x${size.rows}`;
      const previous = this.#sizes.get(id);
      if (previous === key) continue;
      this.#sizes.set(id, key);
      // 처음은 열기(이미 열린 터미널이면 스튜디오가 크기만 맞춘다), 그다음부터는 크기만 알린다
      const opening = previous === undefined;
      const request = opening ? this.#client.open(id, size.cols, size.rows) : this.#client.resize(id, size.cols, size.rows);
      request.catch((error: unknown) => {
        // 멈춘 세션이면 스튜디오가 409로 답한다. 이어서 작업하면 켜진 뒤 칸을 다시 연다
        const stopped = error instanceof StudioRequestError && error.status === 409 && this.#state.items.find((entry) => entry.id === id)?.state === 'stopped';
        this.#notes.set(id, stopped ? '멈춘 세션입니다 · Ctrl-b r로 이어서 작업합니다' : `${messageOf(error)} · Ctrl-b Enter로 다시 엽니다`);
        if (opening) this.#markClosed(id);
        this.#scheduleRender();
      });
    }
  }

  /** 터미널이 없다: 다음에 열 때는 열기를 보낸다(크기만 보내면 스튜디오가 조용히 무시한다) */
  #markClosed(id: string): void {
    this.#closed.add(id);
    this.#sizes.delete(id);
  }

  /** 칸에 있는 세션마다 통로 하나. 칸에서 빠진 세션의 통로만 닫고, 새로 들어온 세션의 통로만 연다 */
  #syncStreams(): void {
    const visible = new Set(this.#visible());
    for (const [id, entry] of this.#streams) {
      if (visible.has(id)) continue;
      entry.controller.abort();
      clearTimeout(entry.timer);
      this.#streams.delete(id);
      this.#quietUntil.delete(id);
    }
    for (const id of visible) if (!isShellId(id) && !this.#streams.has(id)) this.#openStream(id);
  }

  #openStream(id: string): void {
    // 통로를 새로 열면 스튜디오가 이 세션의 최근 출력부터 다시 보낸다. 앞 내용을 지우고 그것으로 다시 그린다
    this.#panes.get(id)?.restart();
    this.#quietUntil.set(id, Date.now() + REPLAY_QUIET_MS);
    const controller = new AbortController();
    const entry: { controller: AbortController; timer?: NodeJS.Timeout } = { controller };
    this.#streams.set(id, entry);
    this.#client
      .stream([id], (sessionId, message) => this.#onTerminal(sessionId, message), controller.signal)
      .then(() => {
        if (!controller.signal.aborted) throw new Error('스튜디오가 터미널 통로를 닫았습니다');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.#restored || this.#streams.get(id) !== entry) return;
        this.#say(`터미널 통로가 끊겼습니다: ${messageOf(error)} — 다시 붙는 중`);
        entry.timer = setTimeout(() => {
          if (this.#streams.get(id) !== entry) return;
          this.#streams.delete(id);
          if (!this.#visible().includes(id)) return;
          this.#openStream(id);
          // 스튜디오를 다시 띄웠으면 터미널이 없다. 이 칸을 다시 연다(열려 있으면 스튜디오가 크기만 맞춘다)
          if (!this.#closed.has(id)) this.#sizes.delete(id);
          this.#syncPanes();
        }, RECONNECT_MS);
      });
  }

  #onTerminal(id: string, message: DeskTerminalMessage): void {
    const pane = this.#panes.get(id);
    switch (message.kind) {
      case 'data':
        if (pane) void pane.write(Buffer.from(message.data, 'base64')).then(() => this.#scheduleRender());
        return;
      case 'status':
        if (message.state === 'open') {
          this.#notes.delete(id);
          this.#closed.delete(id);
        } else if (message.state === 'opening') this.#notes.set(id, '여는 중');
        else {
          this.#notes.set(id, `${message.message ?? '터미널이 닫혔습니다'} · Ctrl-b Enter로 다시 엽니다`);
          this.#markClosed(id);
        }
        break;
      case 'exit':
        this.#notes.set(id, `터미널이 끝났습니다${message.code === null ? '' : `(${message.code})`} · Ctrl-b Enter로 다시 엽니다`);
        this.#markClosed(id);
        break;
      case 'warning':
        this.#state = { ...this.#state, message: `⚠ ${message.message}` };
        break;
      case 'cli':
        break;
    }
    this.#scheduleRender();
  }

  async #poll(): Promise<void> {
    // 앞 요청이 끝나기 전에는 새로 묻지 않는다(느린 스튜디오에 요청이 쌓이고 늦게 온 옛 목록이 새 목록을 덮지 않게)
    if (this.#polling) return;
    this.#polling = true;
    try {
      const items = (await this.#client.agents()).items;
      // 서버는 손댈 것·작업 중을 위로 올려 순서를 자주 바꾼다. 고르던 세션을 그대로 고른다
      this.#state = { ...this.#state, items, selected: reselect(this.#state.items, this.#state.selected, items) };
      this.#announce(items);
      this.#reopenResumed(items);
      this.#clearSeen();
      this.#scheduleRender();
    } catch (error) {
      this.#say(`세션 목록을 받지 못했습니다: ${messageOf(error)}`);
    } finally {
      this.#polling = false;
    }
  }

  /** 이어서 작업한 세션이 켜졌으면 칸을 다시 연다. 켜지 못했으면 그만 기다린다 */
  #reopenResumed(items: readonly DeskItem[]): void {
    for (const id of [...this.#resuming]) {
      const item = items.find((entry) => entry.id === id);
      if (item && NOT_READY.includes(item.state)) continue;
      this.#resuming.delete(id);
      if (!item || !this.#visible().includes(id)) continue;
      if (item.state === 'error') {
        this.#notes.set(id, '이어서 작업하지 못했습니다 · 웹 화면에서 까닭을 보세요');
        continue;
      }
      this.#notes.delete(id);
      this.#closed.delete(id);
      this.#sizes.delete(id);
      this.#syncPanes();
    }
  }

  async #openPrompt(): Promise<void> {
    try {
      const [projects, rules] = await Promise.all([this.#client.projects(), this.#client.rules().catch(() => ({ allowed: [] as string[] }))]);
      const usable = projects.filter((project) => !project.error).map((project) => ({ id: project.id, name: project.name }));
      if (usable.length === 0) {
        this.#say('열 수 있는 프로젝트가 없습니다. 웹 화면에서 프로젝트를 먼저 여세요');
        return;
      }
      this.#state = {
        ...this.#state,
        message: undefined,
        prompt: {
          step: usable.length === 1 ? 'request' : 'project',
          projects: usable,
          projectIndex: 0,
          text: '',
          // 터미널로 띄울 수 없는 AI는 고를 수 없다(스튜디오가 거절한다)
          choices: ['rules', ...rules.allowed.filter((backend) => TERMINAL_BACKENDS.includes(backend))],
          choice: 0,
        },
      };
      this.#scheduleRender();
    } catch (error) {
      this.#say(`새 요청을 열지 못했습니다: ${messageOf(error)}`);
    }
  }

  #schedulePreview(text: string): void {
    clearTimeout(this.#previewTimer);
    if (!text.trim()) {
      if (this.#state.prompt) this.#state = { ...this.#state, prompt: { ...this.#state.prompt, preview: undefined } };
      return;
    }
    this.#previewTimer = setTimeout(() => {
      this.#client
        .preview(text)
        .then((preview) => {
          const prompt = this.#state.prompt;
          if (!prompt || prompt.text !== text) return;
          this.#state = { ...this.#state, prompt: { ...prompt, preview: previewLine(preview) } };
          this.#scheduleRender();
        })
        .catch(() => {});
    }, PREVIEW_DELAY_MS);
  }

  async #submit(projectId: string, request: string, choice: string): Promise<void> {
    try {
      const result = await this.#client.start({ projectId, request, choice });
      const slots = [...this.#state.slots];
      // 고른 칸에 셸이 돌고 있으면 덮지 않는다(셸은 x와 나가기로만 끝낸다). 세션은 사이드바에서 연다
      const shellTaken = isShellId(slots[this.#state.focus]);
      if (!shellTaken) slots[this.#state.focus] = result.session.id;
      const target = backendLabel(result.routing?.backend ?? (choice === 'rules' ? undefined : choice));
      const message = result.sendError
        ? `${target} 세션을 만들었지만 요청을 보내지 못했습니다: ${result.sendError}`
        : result.terminal?.pasteError
        ? `세션을 열었지만 첫 요청을 넣지 못했습니다: ${result.terminal.pasteError} — 칸에서 직접 치세요`
        : result.terminal
          ? `${target}로 보냈습니다`
          : `${target} 세션을 만들었습니다(이 스튜디오는 아직 터미널로 첫 요청을 넣지 않습니다)`;
      this.#state = { ...this.#state, prompt: undefined, slots, message: shellTaken ? `${message} · 고른 칸에 셸이 있어 칸에는 열지 않았습니다(사이드바에서 Ctrl-b Enter로 엽니다)` : message };
      this.#slotsChanged();
      this.#saveLayout();
      void this.#poll();
    } catch (error) {
      const prompt = this.#state.prompt;
      if (prompt) this.#state = { ...this.#state, prompt: { ...prompt, sending: false, preview: `보내지 못했습니다: ${messageOf(error)}` } };
    }
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (this.#frameTimer || this.#restored) return;
    this.#frameTimer = setTimeout(() => {
      this.#frameTimer = undefined;
      this.#render();
    }, FRAME_MS);
  }

  #render(): void {
    if (this.#restored) return;
    const views: PaneView[] = this.#state.slots.map((id) => {
      const pane = id ? this.#panes.get(id) : undefined;
      const note = id ? this.#notes.get(id) : undefined;
      // CLI가 커서를 숨겼으면 desk도 그리지 않는다(제 커서를 그리는 TUI에서 엉뚱한 자리에 보이지 않게). 복사 모드에서도 그리지 않는다
      const cursor = pane && !pane.inCopy && !pane.modes().cursorHidden ? { cursor: pane.cursor() } : {};
      const copy = pane?.inCopy ? pane.copyStatus() : undefined;
      const mode = copy ? { mode: `복사 모드 ${copy.line}/${copy.total}줄` } : {};
      const bell = id && this.#bells.has(id) ? { bell: true } : {};
      const shell = id && isShellId(id) ? this.#shells.get(id) : undefined;
      const title = shell ? { title: `셸 · 검증 밖 · ${basename(shell.dir) || shell.dir}` } : {};
      return { lines: pane ? pane.lines() : [], ...(pane ? { cols: pane.viewCols } : {}), ...cursor, ...mode, ...bell, ...title, ...(note ? { note } : {}) };
    });
    const frame = renderScreen(this.#state, this.#size(), views);
    // 바뀐 줄만 다시 쓴다. 지원하는 터미널에서는 한 장을 한 번에 바꾼다(동기 출력)
    let out = '\x1b[?2026h\x1b[?25l';
    frame.lines.forEach((line, row) => {
      if (this.#prevFrame[row] !== line) out += `\x1b[${row + 1};1H${line}`;
    });
    this.#prevFrame = frame.lines;
    if (frame.cursor) out += `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.#io.write(out);
  }

  #stop(code: number): void {
    this.#restore();
    // 다음에 띄울 때 되살릴 배치(바꿀 때마다 저장했지만 고른 칸은 나갈 때 남긴다)
    this.#saveLayout();
    this.#finish(code);
  }

  #restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    clearInterval(this.#pollTimer);
    clearTimeout(this.#frameTimer);
    clearTimeout(this.#previewTimer);
    clearTimeout(this.#pendingTimer);
    clearTimeout(this.#resizeTimer);
    for (const entry of this.#streams.values()) {
      entry.controller.abort();
      clearTimeout(entry.timer);
    }
    for (const pane of this.#panes.values()) pane.dispose();
    for (const shell of this.#shells.values()) if (!shell.ended) shell.pty?.kill();
    this.#io.setRaw(false);
    this.#io.write((this.#mouseOn ? MOUSE_OFF : '') + LEAVE_SCREEN);
  }
}

/** 알림을 가리는 상태 이름과 게이트 판정 */
function statusOf(item: DeskItem): { status: string; gate?: string } {
  const gate = gateStatus(item)?.label;
  return { status: agentStatus(item).label, ...(gate ? { gate } : {}) };
}

/** 알릴 만큼 바뀌었으면 그 문구. 손댈 상태가 먼저, 그다음 게이트 판정, 그다음 작업 끝남이다 */
export function changeOf(before: { status: string; gate?: string }, now: { status: string; gate?: string }): string | undefined {
  if (WAITING.includes(now.status) && now.status !== before.status) return now.status;
  if (now.gate && GATE_NOTICE[now.gate] && now.gate !== before.gate) return GATE_NOTICE[now.gate];
  if (before.status === '작업 중' && SETTLED.includes(now.status)) return '끝남';
  return undefined;
}

/** 옛 꼴(X10) 마우스 열. 좌표가 223을 넘으면 이 꼴로는 보낼 수 없다 */
function x10Mouse(button: number, column: number, line: number): string | undefined {
  if (column > 223 || line > 223) return undefined;
  return `\x1b[M${String.fromCharCode(32 + button, 32 + column, 32 + line)}`;
}

/** OSC 알림에 넣을 글: 제어 글자(알림을 일찍 끝내거나 다른 명령이 될 수 있다)를 빼고 줄인다 */
function oscText(text: string): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')].slice(0, 160).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

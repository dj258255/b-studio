/**
 * `studio desk`: herdr처럼 터미널 하나에서 여러 AI CLI를 나란히 쓰는 작업대(#837, ADR-183).
 *
 * 화면·키·스튜디오 손님은 따로 테스트한 순수 함수와 작은 객체이고, 여기서는 그것들을 잇는다:
 * 키 → handleInput → 할 일(입력 보내기, 칸 열기, 새 요청 …) → 스튜디오 API, 터미널 출력 → 칸 해석 → 화면 그리기.
 * 터미널을 대체 화면 버퍼로 바꾸고 raw 모드로 두므로, 어떤 길로 끝나든 되돌린다
 */
import { StudioClient, findStudio } from './client';
import { flushPending, handleInput, initialState, pasteFor, reselect, toInnerKeys, type DeskState, type Effect } from './keys';
import { PaneTerminal } from './pane';
import { previewLine, renderScreen, type PaneView } from './render';
import { computeLayout, terminalSize } from './screen';
import { backendLabel } from './sidebar';
import type { DeskTerminalMessage } from './types';

/** 사이드바를 새로 받는 주기 */
const POLL_MS = 1_500;
/** 화면을 다시 그리는 최소 간격 */
const FRAME_MS = 30;
/** 미리보기를 묻기 전에 기다리는 시간(쓰는 동안 매 글자 묻지 않게) */
const PREVIEW_DELAY_MS = 300;
/** 통로를 다시 열면 스튜디오가 최근 출력을 다시 보낸다. 그동안 칸 해석기가 내는 질의 응답은 CLI에 보내지 않는다(ADR-177 4) */
const REPLAY_QUIET_MS = 500;
/** 통로가 끊기면 다시 여는 간격 */
const RECONNECT_MS = 2_000;
/** 조각 끝의 Esc가 방향키의 앞인지 기다리는 시간. 지나면 Esc 하나로 본다 */
const ESC_WAIT_MS = 25;
/** 창 크기를 끌어 바꾸는 동안 스튜디오에 알리는 것을 미루는 시간(칸 안 해석기는 바로 맞춘다) */
const RESIZE_SETTLE_MS = 150;
/** 터미널로 띄울 수 있는 AI. 스튜디오 routed-session.ts의 terminalBackends와 같은 기준이다(desk가 붙는 launch는 이 컴퓨터 방식) */
const TERMINAL_BACKENDS: readonly string[] = ['claude-code', 'codex'];

// 밖 터미널의 bracketed paste를 켜서 붙여넣기를 표지로 받는다(붙인 글 안의 Ctrl-b를 명령으로 보지 않게, #860)
const ENTER_SCREEN = '\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J';
const LEAVE_SCREEN = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l';

export interface DeskOptions {
  port?: number;
}

/** desk가 부르는 스튜디오 API(테스트에서는 가짜를 넣는다) */
export type DeskClient = Pick<StudioClient, 'agents' | 'projects' | 'rules' | 'preview' | 'start' | 'open' | 'resize' | 'input' | 'stream'>;

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
  return new DeskApp(client, first, processIo()).run();
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
  #reconnectTimer: NodeJS.Timeout | undefined;
  #stream: AbortController | undefined;
  #streamKey = '';
  #replayUntil = 0;
  #restored = false;
  #finish: (code: number) => void = () => {};

  constructor(client: DeskClient, items: DeskState['items'], io: DeskIo) {
    this.#client = client;
    this.#io = io;
    this.#state = { ...initialState(), items };
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
    this.#io.write(ENTER_SCREEN);
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
    this.#scheduleRender();
  }

  #send(id: string, data: string): void {
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
      case 'open':
      case 'close':
      case 'layout':
        this.#slotsChanged();
        return;
      case 'quit':
        this.#stop(0);
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
    }
  }

  #say(message: string): void {
    this.#state = { ...this.#state, message };
    this.#scheduleRender();
  }

  /** 지금 칸에 보이는 세션 */
  #visible(): string[] {
    return this.#state.slots.slice(0, this.#state.layout).filter((id): id is string => Boolean(id));
  }

  /** 칸 구성이 바뀌었다: 통로를 먼저 열고(늦게 붙은 칸이 출력을 놓치지 않게) 칸 크기에 맞춰 터미널을 연다 */
  #slotsChanged(): void {
    const visible = new Set(this.#visible());
    // 칸에서 빠진 세션의 해석기는 버린다(다시 열면 스튜디오가 최근 출력을 다시 보낸다). 세션과 CLI는 계속 돈다
    for (const [id, pane] of this.#panes) {
      if (visible.has(id)) continue;
      pane.dispose();
      this.#panes.delete(id);
      this.#sizes.delete(id);
      this.#notes.delete(id);
      this.#closed.delete(id);
    }
    this.#prevFrame = [];
    // 해석기를 먼저 만들어 둔다: 통로가 열리자마자 오는 최근 출력을 받을 자리가 있어야 한다
    this.#ensurePanes();
    this.#restartStream();
    this.#syncPanes();
  }

  /** 보이는 칸마다 해석기를 만들고 칸 크기에 맞춘다(스튜디오에는 알리지 않는다) */
  #ensurePanes(): Array<{ id: string; size: { cols: number; rows: number } }> {
    const { cols, rows } = this.#size();
    const rects = computeLayout(cols, rows, this.#state.layout).panes;
    const placed: Array<{ id: string; size: { cols: number; rows: number } }> = [];
    this.#state.slots.forEach((id, slot) => {
      if (!id || slot >= this.#state.layout) return;
      const size = terminalSize(rects[slot]!);
      let pane = this.#panes.get(id);
      if (!pane) {
        pane = new PaneTerminal(size.cols, size.rows);
        const sessionId = id;
        pane.onResponse((data) => {
          if (Date.now() < this.#replayUntil) return;
          this.#client.input(sessionId, data).catch(() => {});
        });
        this.#panes.set(id, pane);
      }
      pane.resize(size.cols, size.rows);
      placed.push({ id, size });
    });
    return placed;
  }

  /** 해석기를 맞추고, 크기가 바뀐 칸만 스튜디오에 알린다(처음은 열기, 그다음은 크기) */
  #syncPanes(): void {
    clearTimeout(this.#resizeTimer);
    for (const { id, size } of this.#ensurePanes()) {
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
        this.#notes.set(id, `${messageOf(error)} · Ctrl-b Enter로 다시 엽니다`);
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

  #restartStream(): void {
    const ids = this.#visible();
    const key = ids.join(',');
    if (key === this.#streamKey && this.#stream) return;
    this.#stream?.abort();
    this.#stream = undefined;
    clearTimeout(this.#reconnectTimer);
    this.#streamKey = key;
    if (ids.length === 0) return;
    // 통로를 새로 열면 스튜디오가 최근 출력부터 다시 보낸다. 앞 내용을 지우고 그것으로 다시 그린다
    for (const id of ids) this.#panes.get(id)?.reset();
    this.#replayUntil = Date.now() + REPLAY_QUIET_MS;
    const controller = new AbortController();
    this.#stream = controller;
    this.#client
      .stream(ids, (id, message) => this.#onTerminal(id, message), controller.signal)
      .then(() => {
        if (!controller.signal.aborted) throw new Error('스튜디오가 터미널 통로를 닫았습니다');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.#restored) return;
        this.#say(`터미널 통로가 끊겼습니다: ${messageOf(error)} — 다시 붙는 중`);
        this.#stream = undefined;
        this.#reconnectTimer = setTimeout(() => {
          this.#streamKey = '';
          this.#restartStream();
          // 스튜디오를 다시 띄웠으면 터미널이 없다. 보이는 칸을 다시 연다(열려 있으면 스튜디오가 크기만 맞춘다)
          for (const id of this.#visible()) if (!this.#closed.has(id)) this.#sizes.delete(id);
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
      this.#scheduleRender();
    } catch (error) {
      this.#say(`세션 목록을 받지 못했습니다: ${messageOf(error)}`);
    } finally {
      this.#polling = false;
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
      slots[this.#state.focus] = result.session.id;
      const target = backendLabel(result.routing?.backend ?? (choice === 'rules' ? undefined : choice));
      const message = result.sendError
        ? `${target} 세션을 만들었지만 요청을 보내지 못했습니다: ${result.sendError}`
        : result.terminal?.pasteError
        ? `세션을 열었지만 첫 요청을 넣지 못했습니다: ${result.terminal.pasteError} — 칸에서 직접 치세요`
        : result.terminal
          ? `${target}로 보냈습니다`
          : `${target} 세션을 만들었습니다(이 스튜디오는 아직 터미널로 첫 요청을 넣지 않습니다)`;
      this.#state = { ...this.#state, prompt: undefined, slots, message };
      this.#slotsChanged();
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
      // CLI가 커서를 숨겼으면 desk도 그리지 않는다(제 커서를 그리는 TUI에서 엉뚱한 자리에 보이지 않게)
      const cursor = pane && !pane.modes().cursorHidden ? { cursor: pane.cursor() } : {};
      return { lines: pane ? pane.lines() : [], ...(pane ? { cols: pane.cols } : {}), ...cursor, ...(note ? { note } : {}) };
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
    this.#finish(code);
  }

  #restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    clearInterval(this.#pollTimer);
    clearTimeout(this.#frameTimer);
    clearTimeout(this.#previewTimer);
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#pendingTimer);
    clearTimeout(this.#resizeTimer);
    this.#stream?.abort();
    for (const pane of this.#panes.values()) pane.dispose();
    this.#io.setRaw(false);
    this.#io.write(LEAVE_SCREEN);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

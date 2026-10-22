/**
 * `studio desk`: herdr처럼 터미널 하나에서 여러 AI CLI를 나란히 쓰는 작업대(#837, ADR-183).
 *
 * 화면·키·스튜디오 손님은 따로 테스트한 순수 함수와 작은 객체이고, 여기서는 그것들을 잇는다:
 * 키 → handleInput → 할 일(입력 보내기, 칸 열기, 새 요청 …) → 스튜디오 API, 터미널 출력 → 칸 해석 → 화면 그리기.
 * 터미널을 대체 화면 버퍼로 바꾸고 raw 모드로 두므로, 어떤 길로 끝나든 되돌린다
 */
import { StudioClient, findStudio } from './client';
import { handleInput, initialState, type DeskState, type Effect } from './keys';
import { PaneTerminal } from './pane';
import { previewLine, renderScreen, type PaneView } from './render';
import { computeLayout, terminalSize } from './screen';
import { backendLabel, deskSessions } from './sidebar';
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

const ENTER_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J';
const LEAVE_SCREEN = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l';

export interface DeskOptions {
  port?: number;
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
  return new DeskApp(client, first).run();
}

class DeskApp {
  readonly #client: StudioClient;
  #state: DeskState;
  readonly #panes = new Map<string, PaneTerminal>();
  readonly #notes = new Map<string, string>();
  /** 칸마다 마지막으로 스튜디오에 알린 터미널 크기 */
  readonly #sizes = new Map<string, string>();
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

  constructor(client: StudioClient, items: DeskState['items']) {
    this.#client = client;
    this.#state = { ...initialState(), items };
  }

  run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      this.#finish = resolve;
    });
    const restore = () => this.#restore();
    process.once('exit', restore);
    const fatal = (error: unknown) => {
      this.#restore();
      console.error(`studio desk가 멈췄습니다: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(1);
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => this.#stop(0));

    process.stdout.write(ENTER_SCREEN);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.#onInput(chunk));
    process.stdin.resume();
    process.stdout.on('resize', () => {
      this.#prevFrame = [];
      this.#syncPanes();
      this.#render();
    });
    this.#pollTimer = setInterval(() => void this.#poll(), POLL_MS);
    this.#render();
    return done;
  }

  #size(): { cols: number; rows: number } {
    return { cols: Math.max(20, process.stdout.columns || 80), rows: Math.max(6, process.stdout.rows || 24) };
  }

  #onInput(chunk: string): void {
    const { state, effects } = handleInput(this.#state, chunk);
    this.#state = state;
    for (const effect of effects) this.#apply(effect);
    this.#scheduleRender();
  }

  #apply(effect: Effect): void {
    switch (effect.type) {
      case 'input':
        this.#client.input(effect.id, effect.data).catch((error: unknown) => this.#say(`입력을 보내지 못했습니다: ${messageOf(error)}`));
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
    for (const { id, size } of this.#ensurePanes()) {
      const key = `${size.cols}x${size.rows}`;
      const previous = this.#sizes.get(id);
      if (previous === key) continue;
      this.#sizes.set(id, key);
      // 처음은 열기(이미 열린 터미널이면 스튜디오가 크기만 맞춘다), 그다음부터는 크기만 알린다
      const request = previous === undefined ? this.#client.open(id, size.cols, size.rows) : this.#client.resize(id, size.cols, size.rows);
      request.catch((error: unknown) => {
        this.#notes.set(id, messageOf(error));
        this.#scheduleRender();
      });
    }
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
        if (message.state === 'open') this.#notes.delete(id);
        else this.#notes.set(id, message.state === 'opening' ? '여는 중' : (message.message ?? '터미널이 닫혔습니다'));
        break;
      case 'exit':
        this.#notes.set(id, `터미널이 끝났습니다${message.code === null ? '' : `(${message.code})`}`);
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
    try {
      const items = (await this.#client.agents()).items;
      const count = deskSessions(items).length;
      this.#state = { ...this.#state, items, selected: Math.max(0, Math.min(this.#state.selected, count - 1)) };
      this.#scheduleRender();
    } catch (error) {
      this.#say(`세션 목록을 받지 못했습니다: ${messageOf(error)}`);
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
        prompt: { step: usable.length === 1 ? 'request' : 'project', projects: usable, projectIndex: 0, text: '', choices: ['rules', ...rules.allowed], choice: 0 },
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
      const message = result.terminal?.pasteError
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
      return { lines: pane ? pane.lines() : [], ...(pane ? { cursor: pane.cursor() } : {}), ...(note ? { note } : {}) };
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
    process.stdout.write(out);
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
    this.#stream?.abort();
    for (const pane of this.#panes.values()) pane.dispose();
    try {
      process.stdin.setRawMode(false);
    } catch {
      // 이미 닫힌 입력
    }
    process.stdin.pause();
    process.stdout.write(LEAVE_SCREEN);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

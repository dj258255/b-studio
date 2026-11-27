import { createRequire } from 'node:module';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Unicode11Addon as Unicode11AddonType } from '@xterm/addon-unicode11';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

/**
 * 터미널 CLI 입력창에 쓰다 만 글을 저장하고 다시 열 때 입력창에 되살린다(ADR-237).
 *
 * 구조: 터미널 출력을 헤드리스 터미널(`@xterm/headless`)에 먹여 화면을 유지하고, 입력창 모양을 읽어(readClaudeInput) 몇 초마다 세션 상태 폴더에 저장한다.
 * 다시 열어 CLI가 떴다는 신호가 오면, 새 화면의 입력창이 **비어 있다고 읽히고** 붙여 넣기를 받는 상태일 때만 괄호 붙여 넣기로 넣는다. **Enter는 보내지 않는다.**
 * 하나라도 확신이 없으면(모르는 모양, 상한 초과, 이미 글이 있음, 신호 없음) 입력창에 넣지 않고 "쓰다 만 글"로 남겨 desk가 보여 준다.
 *
 * 키 입력을 기록해 재생하지 않는다(커서 이동·지우기·비밀번호까지 담는다). 화면에 보이는 입력창의 글만 읽는다.
 */

const require = createRequire(import.meta.url);
// 패키지가 CommonJS 진입점만 실제로 싣고 있어 require로 읽는다(apps/cli/src/desk/pane.ts와 같다)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11') as { Unicode11Addon: typeof Unicode11AddonType };

/** 읽어 저장하는 글의 상한(글자). 넘으면 읽은 것으로 치지 않는다(모름) */
export const MAX_DRAFT_CHARS = 20_000;
/** 입력창에 되살리는 글의 상한(글자). 넘으면 입력창에 넣지 않고 보여 주기만 한다 */
export const MAX_RESTORE_CHARS = 2_000;
/** 저장 파일을 읽을 때 받는 크기 상한(바이트). 읽기 전에 본다 */
const MAX_FILE_BYTES = 128 * 1024;
const FILE_VERSION = 1;

/** 입력창 읽기 결과. 모르면 unknown이고, 모르는 것은 저장도 복원도 하지 않는다 */
export type InputRead = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'unknown'; reason: string };

const RULE = /^─{10,}$/u;
/** 입력창 아래로 이만큼 줄까지만 상태 줄로 본다(그보다 많으면 입력창이 아닌 화면이다) */
const MAX_BELOW_RULE = 8;
/** 입력창 안의 최대 줄 수 */
const MAX_BOX_LINES = 40;

/**
 * Claude Code의 입력창을 화면 줄에서 읽는다. 기록한 실제 화면(2026-11, claude-code)의 모양:
 * 가로줄(`─` 열 개 이상만 있는 줄) → `❯ 글`(여러 줄이면 이어지는 줄은 두 칸 들여쓴다) → 가로줄 → 상태 줄들.
 * 이 모양이 아니면 모른다. 번호 선택지(`❯ 1. Yes`)는 입력창이 아니라 묻는 창이라 모른다.
 * `lines`는 화면의 줄이고 흐린 글(자리 표시 문구)은 비워서 준다(DraftScreen.lines)
 */
export function readClaudeInput(screen: readonly string[]): InputRead {
  // 화면 아래의 빈 줄은 뺀다(줄 수가 큰 화면에서 입력창 아래가 비어 있는 것은 이상한 것이 아니다)
  let end = screen.length;
  while (end > 0 && screen[end - 1]!.trim() === '') end -= 1;
  const lines = screen.slice(0, end);
  const rules: number[] = [];
  lines.forEach((line, index) => {
    if (RULE.test(line.trim())) rules.push(index);
  });
  // 마지막으로 보이는, 첫 줄이 ❯인 (위 가로줄, 아래 가로줄) 쌍
  for (let pair = rules.length - 2; pair >= 0; pair -= 1) {
    const top = rules[pair]!;
    const bottom = rules[pair + 1]!;
    const first = lines[top + 1];
    if (bottom - top < 2 || first === undefined || !(first === '❯' || first.startsWith('❯ '))) continue;
    if (lines.length - 1 - bottom > MAX_BELOW_RULE) return { kind: 'unknown', reason: '입력창 아래에 상태 줄이 아닌 것이 많다' };
    if (bottom - top - 1 > MAX_BOX_LINES) return { kind: 'unknown', reason: '입력창이 너무 길다' };
    const body = lines.slice(top + 1, bottom);
    const head = body[0]!.slice(1).replace(/^ /, '');
    // 번호가 붙은 선택지는 입력창이 아니라 묻는 창이다
    if (/^\d+[.)]\s/.test(head)) return { kind: 'unknown', reason: '선택지를 고르는 창이다' };
    const rest: string[] = [];
    for (const line of body.slice(1)) {
      if (line.trim() === '') {
        rest.push('');
        continue;
      }
      if (!line.startsWith('  ')) return { kind: 'unknown', reason: '입력창 안의 줄 모양을 모른다' };
      rest.push(line.slice(2));
    }
    const text = [head, ...rest].map((line) => line.replace(/\s+$/u, '')).join('\n').replace(/\s+$/u, '');
    if (text === '') return { kind: 'empty' };
    if ([...text].length > MAX_DRAFT_CHARS) return { kind: 'unknown', reason: '글이 너무 길다' };
    return { kind: 'text', text };
  }
  return { kind: 'unknown', reason: '입력창 모양을 찾지 못했다' };
}

/** 붙여 넣기 밖으로 새면 안 되는 문자: 제어 문자(ESC 포함), DEL, C1, 줄·문단 구분자. 탭은 공백으로 바꾼다 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** 붙여 넣을 글에서 ESC 등 제어 문자를 뺀다. 끼워 넣은 `ESC[201~`는 ESC가 빠져 글자로만 남는다 */
export function sanitizePasteText(text: string): string {
  return text.replace(/\t/g, ' ').replace(UNSAFE, '');
}

/**
 * 입력창에 되살리는 글을 보낼 바이트(괄호 붙여 넣기). `ESC[200~ 글 ESC[201~`만이다 — Enter(`\r`)도 줄바꿈도 없다.
 * 거를 것을 거르고 남은 글이 없으면 보낼 것이 없다(undefined)
 */
export function pasteBytes(text: string): string | undefined {
  const clean = sanitizePasteText(text);
  if (clean.trim() === '') return undefined;
  return `\x1b[200~${clean}\x1b[201~`;
}

/** 입력창에 되살려도 되는 글인가. 아니면 까닭을 돌려준다. 여러 줄은 줄바꿈이 CLI의 자동 줄바꿈인지 사람이 친 것인지 알 수 없어 넣지 않는다 */
export function restoreRefusal(text: string): string | undefined {
  if (text.includes('\n')) return '여러 줄이라 입력창에 넣지 않았습니다';
  if ([...text].length > MAX_RESTORE_CHARS) return `${MAX_RESTORE_CHARS}자가 넘어 입력창에 넣지 않았습니다`;
  if (sanitizePasteText(text) !== text) return '제어 문자가 있어 입력창에 넣지 않았습니다';
  return undefined;
}

/** 저장·표시하는 글에서 뺄 것: ESC를 포함한 제어 문자(줄바꿈은 남긴다), DEL, C1, 글 방향을 뒤집는 문자와 보이지 않는 문자, 줄·문단 구분자 */
const UNSAFE_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** 저장하거나 화면·API에 내보낼 글: 제어 문자·방향 문자를 뺀다(줄바꿈은 남는다) */
export function cleanDraftText(text: string): string {
  return text.replace(UNSAFE_KEEP_NEWLINE, '');
}

export interface DraftFile {
  version: 1;
  /** 마지막으로 읽은 입력창의 글. 입력창이 비면 없다 */
  live?: { text: string; savedAt: string };
  /** 입력창에 넣지 못해 desk에 보이는 글 */
  leftover?: { text: string; savedAt: string; reason: string };
}

/**
 * 저장 파일의 도장. 저장 파일은 작업 복사본 안(`.git/b-studio`)이라 에이전트가 쓸 수 있다 — 세션 상태 폴더 중 작업 복사본 밖의 보호된 자리가 없다
 * (복사본 세션은 상태 폴더가 작업 복사본 자체이고 `session.json`도 거기 있다). 그래서 글을 믿는 근거를 파일 밖에 둔다:
 * studio만 아는 열쇠(작업 복사본 밖, 0600)로 `HMAC(열쇠, 파일 경로·종류·글)`을 파일에 함께 적고, 읽을 때 도장이 맞지 않으면 버린다.
 * 에이전트가 글을 심거나 다른 세션의 파일을 옮겨 놓아도 도장이 맞지 않는다
 */
export interface DraftSeal {
  key: Buffer;
  /** 이 파일이 속한 자리(파일 경로). 다른 세션의 파일을 옮겨 놓은 것을 가린다 */
  context: string;
}

function macOf(seal: DraftSeal, kind: 'live' | 'leftover', text: string): string {
  return createHmac('sha256', seal.key).update(`${seal.context}\0${kind}\0${text}`).digest('hex');
}

function macMatches(seal: DraftSeal, kind: 'live' | 'leftover', text: string, mac: unknown): boolean {
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(macOf(seal, kind, text), 'hex'));
}

/** 저장 자리(파일과 그 폴더 둘)가 링크가 아닌지 본다. 링크면 던진다 — 에이전트가 자리를 링크로 바꿔 studio가 다른 파일을 쓰게 하지 못하게 한다 */
async function assertPlainPlace(file: string): Promise<void> {
  const dir = path.dirname(file);
  for (const place of [path.dirname(dir), dir]) {
    const info = await lstat(place).catch(() => undefined);
    if (info && !info.isDirectory()) throw new Error(`쓰다 만 글의 저장 자리가 폴더가 아니거나 링크입니다: ${place}`);
  }
  const info = await lstat(file).catch(() => undefined);
  if (info && !info.isFile()) throw new Error(`쓰다 만 글의 저장 파일이 일반 파일이 아닙니다: ${file}`);
}

function validEntry(value: unknown, kind: 'live' | 'leftover', seal: DraftSeal): { text: string; savedAt: string; reason?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string' || typeof record.savedAt !== 'string') return undefined;
  if (record.text === '' || [...record.text].length > MAX_DRAFT_CHARS) return undefined;
  // 제어 문자·방향 문자가 든 글은 읽지 않는다(우리가 쓴 글에는 없다)
  if (cleanDraftText(record.text) !== record.text) return undefined;
  if (!macMatches(seal, kind, record.text, record.mac)) return undefined;
  if (kind === 'leftover') return typeof record.reason === 'string' ? { text: record.text, savedAt: record.savedAt, reason: record.reason } : undefined;
  return { text: record.text, savedAt: record.savedAt };
}

/** 저장 파일을 읽는다. 없거나, 링크거나, 크거나, 모양·도장이 틀리면 없는 것으로 본다(믿을 수 없는 것을 입력창에 넣지 않는다). 크기는 읽기 전에 본다 */
export async function readDraftFile(file: string, seal: DraftSeal): Promise<DraftFile> {
  const empty: DraftFile = { version: FILE_VERSION };
  try {
    await assertPlainPlace(file);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return empty;
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) return empty;
    const body = parsed as Record<string, unknown>;
    const live = validEntry(body.live, 'live', seal);
    const leftover = validEntry(body.leftover, 'leftover', seal);
    return {
      version: FILE_VERSION,
      ...(live ? { live: { text: live.text, savedAt: live.savedAt } } : {}),
      ...(leftover ? { leftover: { text: leftover.text, savedAt: leftover.savedAt, reason: leftover.reason ?? '' } } : {}),
    };
  } catch {
    return empty;
  }
}

/**
 * 저장 파일을 쓴다(600, 예측할 수 없는 이름의 임시 파일을 `wx`로 새로 만들고 rename). 둘 다 비면 지운다.
 * 자리(파일·폴더)가 링크면 쓰지 않고 던진다. 경로로 chmod하지 않는다 — 링크를 따라가 다른 파일의 권한을 바꾸지 않게
 */
export async function writeDraftFile(file: string, data: DraftFile, seal: DraftSeal): Promise<void> {
  await assertPlainPlace(file);
  if (!data.live && !data.leftover) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await assertPlainPlace(file);
  const body = {
    version: FILE_VERSION,
    ...(data.live ? { live: { ...data.live, mac: macOf(seal, 'live', data.live.text) } } : {}),
    ...(data.leftover ? { leftover: { ...data.leftover, mac: macOf(seal, 'leftover', data.leftover.text) } } : {}),
  };
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(body)}\n`);
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** 터미널 출력을 먹여 화면을 유지하는 헤드리스 터미널. 입력창을 읽는 데만 쓴다 */
export class DraftScreen {
  readonly #term: HeadlessTerminal;

  constructor(size: { cols: number; rows: number }) {
    this.#term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 0, allowProposedApi: true });
    // 한글·이모지를 실제 터미널처럼 2칸으로 센다. 틀리면 줄바꿈 자리가 어긋나 입력창이 다르게 읽힌다
    this.#term.loadAddon(new Unicode11Addon());
    this.#term.unicode.activeVersion = '11';
  }

  write(chunk: Buffer | string): void {
    this.#term.write(chunk);
  }

  resize(size: { cols: number; rows: number }): void {
    this.#term.resize(size.cols, size.rows);
  }

  /** 쓴 것이 모두 해석될 때까지 기다린다(헤드리스 터미널의 쓰기는 비동기다) */
  flush(): Promise<void> {
    return new Promise((resolve) => this.#term.write('', resolve));
  }

  /** 화면에서 붙여 넣기(괄호 붙여 넣기 모드)를 받는 상태인가 */
  bracketedPaste(): boolean {
    return this.#term.modes.bracketedPasteMode;
  }

  /** 대체 화면(전체 화면 UI)이면 거짓이다. 입력창은 일반 화면에 있다 */
  isNormalScreen(): boolean {
    return this.#term.buffer.active.type === 'normal';
  }

  /** 화면의 줄들(오른쪽 공백은 뺀다). 흐린 글(자리 표시 문구)은 공백으로 비운다 */
  async lines(): Promise<string[]> {
    await this.flush();
    const buffer = this.#term.buffer.active;
    const out: string[] = [];
    let cell = buffer.getNullCell();
    for (let y = 0; y < this.#term.rows; y += 1) {
      const line = buffer.getLine(buffer.baseY + y);
      let text = '';
      if (line) {
        for (let x = 0; x < this.#term.cols; x += 1) {
          const got = line.getCell(x, cell);
          if (!got) break;
          cell = got;
          if (cell.getWidth() === 0) continue;
          text += cell.isDim() ? ' ' : cell.getChars() || ' ';
        }
      }
      out.push(text.replace(/\s+$/u, ''));
    }
    return out;
  }

  dispose(): void {
    this.#term.dispose();
  }
}

export interface DraftKeeperOptions {
  file: string;
  /** 저장 파일의 도장(열쇠는 작업 복사본 밖). 도장이 맞지 않는 글은 읽지 않는다 */
  seal: DraftSeal;
  size: { cols: number; rows: number };
  /** 터미널에 쓴다(복원이 입력창에 붙여 넣을 때만 쓴다) */
  write: (data: string) => void;
  /** 이 터미널이 지난 대화를 이어 붙여 열렸는가. 아니면 저장한 글을 입력창에 넣지 않고 보여 주기만 한다 */
  resumed: boolean;
  /** 보여 줄 "쓰다 만 글"이 바뀔 때(없어지면 undefined) */
  onLeftover?: (text: string | undefined) => void;
  /** 저장 파일을 쓰기 직전에 부른다(시험이 쓰기를 늦춰 닫기와의 경합을 재현한다) */
  beforeWrite?: () => Promise<void>;
  /** 몇 ms마다 바뀐 화면을 저장하나 */
  saveEveryMs?: number;
  /** CLI가 떴다는 신호가 오지 않으면 포기하는 시간 */
  signalTimeoutMs?: number;
  /** 입력창이 비어 보일 때까지 기다리는 시간과 확인 간격 */
  boxWaitMs?: number;
  pollMs?: number;
}

/** 닫는 중인 지킴이들의 마지막 저장. 세션 폴더를 지우기 전에 모두 끝나기를 기다린다(settleDraftStops) */
const inflightStops = new Set<Promise<void>>();

/** 닫는 중인 모든 지킴이의 마지막 저장이 끝나기를 기다린다. 세션 지우기가 폴더를 지우기 전에 부른다 */
export async function settleDraftStops(): Promise<void> {
  while (inflightStops.size > 0) await Promise.allSettled([...inflightStops]);
}

export type RestoreOutcome = 'none' | 'restored' | 'left';

/**
 * 한 터미널의 입력창 글을 지킨다. 화면을 먹이고(feed), 바뀌었으면 몇 초마다 저장하고, CLI가 뜨면(onCliUp) 저장해 둔 글을 되살린다.
 * 되살릴 글이 있는 동안(신호가 오기 전)은 저장하지 않는다 — 막 뜬 빈 화면이 저장해 둔 글을 지우면 안 된다
 */
export class DraftKeeper {
  readonly #screen: DraftScreen;
  readonly #options: Required<Pick<DraftKeeperOptions, 'saveEveryMs' | 'signalTimeoutMs' | 'boxWaitMs' | 'pollMs'>> & DraftKeeperOptions;
  #data: DraftFile = { version: FILE_VERSION };
  /** 입력창에 되살릴 글. 정해질 때까지(되살림·보여 주기·포기) 저장을 막는다 */
  #pending: string | undefined;
  #dirty = false;
  #stopped = false;
  /** 닫는 중. 되살리기는 멈추고 저장 파일은 그대로 둔다(다음에 열 때 다시 시도한다) */
  #closing = false;
  #timer: NodeJS.Timeout | undefined;
  #giveUp: NodeJS.Timeout | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #written = '';

  constructor(options: DraftKeeperOptions) {
    this.#options = { saveEveryMs: 5_000, signalTimeoutMs: 90_000, boxWaitMs: 10_000, pollMs: 250, ...options };
    this.#screen = new DraftScreen(options.size);
  }

  /** 저장 파일을 읽고 타이머를 건다. 열 때 한 번 부른다 */
  start(): Promise<void> {
    // CLI가 떴다는 신호가 파일 읽기보다 먼저 와도 onCliUp이 이 약속을 기다린다
    this.#ready = this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    this.#data = await readDraftFile(this.#options.file, this.#options.seal);
    this.#written = JSON.stringify(this.#data);
    if (this.#data.leftover) this.#options.onLeftover?.(this.#data.leftover.text);
    const saved = this.#data.live;
    if (saved) {
      if (this.#options.resumed) {
        this.#pending = saved.text;
        this.#giveUp = setTimeout(() => void this.#serial(() => this.#leaveIfPending(saved.text, 'CLI가 떴다는 신호가 오지 않았습니다')).catch(() => {}), this.#options.signalTimeoutMs);
        this.#giveUp.unref();
      } else {
        // 이어 붙인 대화가 없으면 이 글이 속한 대화가 아니다. 입력창에 넣지 않고 보여 준다
        await this.#serial(() => this.#leave(saved.text, '이어 붙인 대화가 없어 입력창에 넣지 않았습니다'));
      }
    }
    this.#timer = setInterval(() => {
      if (this.#dirty && !this.#closing) void this.saveNow().catch(() => {});
    }, this.#options.saveEveryMs);
    this.#timer.unref();
  }

  feed(chunk: Buffer): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#screen.write(chunk);
  }

  resize(size: { cols: number; rows: number }): void {
    if (this.#stopped) return;
    this.#screen.resize(size);
  }

  /** 지금 화면의 입력창을 읽어 저장한다. 되살릴 글이 정해지기 전이거나 입력창을 못 읽었으면 저장 파일을 그대로 둔다 */
  saveNow(): Promise<void> {
    return this.#serial(async () => {
      this.#dirty = false;
      if (this.#pending !== undefined) return;
      const read = await this.#read();
      if (read.kind === 'unknown') return;
      const data: DraftFile = { version: FILE_VERSION, ...(this.#data.leftover ? { leftover: this.#data.leftover } : {}) };
      if (read.kind === 'text') {
        data.live = { text: read.text, savedAt: new Date().toISOString() };
        // 새 글을 쓰기 시작했으면 앞의 "쓰다 만 글"은 넘어간 것이다
        if (data.leftover && data.leftover.text !== read.text) this.#dropLeftover(data);
      }
      await this.#persist(data);
    });
  }

  /** "쓰다 만 글"을 치운다(사용자가 요청을 보냈다) */
  clearLeftover(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#data.leftover) return;
      const data: DraftFile = { version: FILE_VERSION, ...(this.#data.live ? { live: this.#data.live } : {}) };
      this.#dropLeftover(data);
      await this.#persist(data);
    });
  }

  /**
   * CLI가 떴다는 신호. 저장해 둔 글이 있으면 새 화면의 입력창이 비어 보일 때 입력창에 붙여 넣는다.
   * 입력창이 비어 보이지 않거나 모르는 모양이거나 붙여 넣기를 받지 않으면 넣지 않고 "쓰다 만 글"로 남긴다
   */
  async onCliUp(): Promise<RestoreOutcome> {
    await this.#ready?.catch(() => {});
    const text = this.#pending;
    if (text === undefined) return 'none';
    return this.#serial(() => this.#restore(text));
  }

  /**
   * 터미널이 닫히거나 끝났다. 타이머를 멈추고, 마지막으로 한 번 저장하고, 진행 중이던 쓰기가 모두 끝나면 화면을 놓는다. 돌려주는 약속은 그때 끝난다.
   * 여러 번 불려도 같은 약속을 돌려준다. 닫은 뒤에는 새 쓰기가 시작되지 않는다(주기 저장·치우기·되살리기가 모두 건너뛴다)
   */
  stop(): Promise<void> {
    this.#stopping ??= this.#doStop();
    return this.#stopping;
  }

  async #doStop(): Promise<void> {
    this.#closing = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#giveUp) clearTimeout(this.#giveUp);
    this.#giveUp = undefined;
    const finished = (async () => {
      await this.#ready?.catch(() => {});
      await this.saveNow().catch(() => {});
      this.#stopped = true;
      // 앞서 줄 선 쓰기까지 모두 끝난 뒤에 놓는다
      await this.#chain;
      this.#screen.dispose();
    })();
    inflightStops.add(finished);
    try {
      await finished;
    } finally {
      inflightStops.delete(finished);
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task, task);
    this.#chain = next.catch(() => {});
    return next;
  }

  /**
   * 지금 화면의 Claude 입력창이 보이고 비어 있는가(정체 재촉이 보내기 직전에 묻는다, ADR-239). `empty`는 입력창 모양이 화면에 있고 글이 없으며 붙여 넣기를 받는 상태일 때뿐이다.
   * 쓰다 만 글이 있으면 `typed`, 입력창 모양이 없거나(권한·질문 창, 전체 화면, 아직 안 그려짐) 모르는 모양이거나 붙여 넣기를 받지 않으면 `unknown`이다. 모르면 보내지 않는다
   */
  async inputState(): Promise<'empty' | 'typed' | 'unknown'> {
    if (this.#stopped || this.#closing) return 'unknown';
    try {
      const read = await this.#read();
      if (read.kind === 'text') return 'typed';
      if (read.kind === 'unknown') return 'unknown';
      return this.#screen.bracketedPaste() ? 'empty' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async #read(): Promise<InputRead> {
    if (!this.#screen.isNormalScreen()) return { kind: 'unknown', reason: '전체 화면이다' };
    return readClaudeInput(await this.#screen.lines());
  }

  async #restore(text: string): Promise<RestoreOutcome> {
    if (this.#pending !== text || this.#closing) return 'none';
    const refused = restoreRefusal(text);
    if (refused) return this.#leave(text, refused);
    const bytes = pasteBytes(text);
    if (bytes === undefined) return this.#leave(text, '붙여 넣을 글이 없습니다');
    // 입력창이 그려지고 비어 있을 때까지 기다린다. 이미 글이 있거나 끝내 모르는 모양이면 넣지 않는다
    const deadline = Date.now() + this.#options.boxWaitMs;
    let read = await this.#read();
    while (read.kind === 'unknown' && Date.now() < deadline && !this.#closing) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs));
      read = await this.#read();
    }
    if (this.#closing) return 'none';
    if (read.kind === 'text') return this.#leave(text, '입력창에 이미 글이 있어 넣지 않았습니다');
    if (read.kind === 'unknown') return this.#leave(text, `입력창을 알아보지 못해 넣지 않았습니다(${read.reason})`);
    if (!this.#screen.bracketedPaste()) return this.#leave(text, 'CLI가 붙여 넣기를 받는 상태가 아니라 넣지 않았습니다');
    try {
      this.#options.write(bytes);
    } catch {
      return this.#leave(text, '터미널에 쓰지 못해 넣지 않았습니다');
    }
    // 넣은 글이 입력창에 보이는지 확인한다. 보이지 않으면 되살렸다고 말하지 않는다
    const checked = Date.now() + this.#options.boxWaitMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs));
      const after = await this.#read();
      if (after.kind === 'text' && after.text === text) break;
      if (Date.now() >= checked || this.#closing) return this.#leave(text, '넣은 글이 입력창에 보이지 않았습니다');
    }
    this.#pending = undefined;
    if (this.#giveUp) clearTimeout(this.#giveUp);
    await this.#persist({ version: FILE_VERSION, live: { text, savedAt: new Date().toISOString() } });
    return 'restored';
  }

  /** 신호를 기다리다 포기할 때: 그사이 정해졌으면 아무것도 하지 않는다 */
  async #leaveIfPending(text: string, reason: string): Promise<RestoreOutcome> {
    if (this.#pending !== text || this.#closing) return 'none';
    return this.#leave(text, reason);
  }

  /** 입력창에 넣지 못한 글을 "쓰다 만 글"로 남긴다 */
  async #leave(text: string, reason: string): Promise<RestoreOutcome> {
    this.#pending = undefined;
    if (this.#giveUp) clearTimeout(this.#giveUp);
    const leftover = { text, savedAt: new Date().toISOString(), reason };
    await this.#persist({ version: FILE_VERSION, leftover });
    this.#options.onLeftover?.(text);
    return 'left';
  }

  #dropLeftover(data: DraftFile): void {
    delete data.leftover;
    this.#options.onLeftover?.(undefined);
  }

  async #persist(data: DraftFile): Promise<void> {
    // 닫은 뒤에는 새 쓰기를 시작하지 않는다(세션 폴더가 지워지는 중일 수 있다)
    if (this.#stopped) return;
    const serialized = JSON.stringify(data);
    this.#data = data;
    if (serialized === this.#written) return;
    await this.#options.beforeWrite?.();
    await writeDraftFile(this.#options.file, data, this.#options.seal);
    this.#written = serialized;
  }
}

/**
 * desk의 키 처리. 상태와 받은 글자로 다음 상태와 할 일(effects)을 돌려주는 순수 함수다 — 네트워크·화면은 desk.ts가 한다.
 *
 * 앞글쇠는 Ctrl-b(tmux·herdr와 같다). 앞글쇠가 없으면 친 글자는 고른 칸의 CLI로 그대로 간다.
 * 앞글쇠 다음: 숫자(칸 고르기), ↑↓(사이드바, 앞글쇠가 이어지고 그동안 Ctrl-b는 새 앞글쇠다), Enter(고른 세션을 칸에 열기), n(새 요청), l(칸 수), x(칸 비우기), q(나가기),
 * Ctrl-b(Ctrl-b를 CLI로). 새 요청 입력 중에는 글자가 입력으로 간다.
 * 붙여넣기(bracketed paste 표지 사이)는 앞글쇠를 보지 않고 내용 그대로 칸에 간다(#860). 조각 끝에서 끊긴 이스케이프 열은 다음 조각까지 기다린다
 */
import type { PaneLayout } from './screen';
import { deskSessions } from './sidebar';
import type { DeskItem } from './types';

export const PREFIX = '\x02';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const UP_APP = '\x1bOA';
const DOWN_APP = '\x1bOB';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** 조각 끝에서 아직 끝나지 않은 이스케이프 열(방향키·붙여넣기 표지의 앞부분) */
const INCOMPLETE_ESCAPE = /^\x1b(\[[0-9;?]*[ -/]*|O)?$/;
const LAYOUTS: readonly PaneLayout[] = [1, 2, 4];
/** 칸 자리 수(4칸 배치까지) */
export const SLOT_COUNT = 4;
/** 사이드바를 고르는 중의 안내 */
const BROWSING = '사이드바 고르는 중: ↑↓로 옮기고 Enter로 칸에 엽니다. 다른 글쇠는 Ctrl-b 다음과 같습니다';

export interface PromptState {
  step: 'project' | 'request';
  projects: Array<{ id: string; name: string }>;
  projectIndex: number;
  text: string;
  /** 'rules'(규칙대로) 또는 직접 고를 백엔드 */
  choices: string[];
  choice: number;
  /** 미리보기 한 줄 */
  preview?: string;
  sending?: boolean;
}

export interface DeskState {
  items: DeskItem[];
  /** 사이드바에서 고른 항목(deskSessions 순서) */
  selected: number;
  layout: PaneLayout;
  /** 칸마다 연 세션 id. 길이는 늘 SLOT_COUNT다 */
  slots: Array<string | undefined>;
  focus: number;
  prefix: boolean;
  /** 앞글쇠 뒤 ↑↓로 사이드바를 고르는 중. 이때 다시 누른 Ctrl-b는 칸으로 보내지 않고 새 앞글쇠로 본다(#855) */
  browsing?: boolean;
  prompt?: PromptState;
  message?: string;
  /** 붙여넣기 표지 사이에 있다. sent는 이 붙여넣기의 앞부분을 이미 칸에 보냈는가 */
  pasting?: { sent: boolean };
  /** 조각 끝에서 끊겨 다음 조각을 기다리는 글. 오래 오지 않으면 flushPending으로 그대로 처리한다 */
  pending?: string;
}

export type Effect =
  | { type: 'input'; id: string; data: string }
  /** 붙여 넣은 글. part가 없으면 붙여넣기 하나 전체, 있으면 여러 조각으로 온 것의 앞·가운데·끝이다 */
  | { type: 'paste'; id: string; data: string; part?: 'start' | 'middle' | 'end' }
  | { type: 'open'; slot: number; id: string }
  /** 이미 칸에 있는 세션을 다시 골랐다: 터미널이 끝났거나 열지 못했으면 다시 연다 */
  | { type: 'reopen'; id: string }
  | { type: 'close'; slot: number; id: string }
  | { type: 'layout' }
  | { type: 'quit' }
  | { type: 'prompt' }
  | { type: 'preview'; text: string }
  | { type: 'submit'; projectId: string; request: string; choice: string };

export function initialState(): DeskState {
  return { items: [], selected: 0, layout: 1, slots: Array.from({ length: SLOT_COUNT }, () => undefined), focus: 0, prefix: false };
}

/** 받은 글자에서 키 하나를 꺼낸다: 방향키 같은 이스케이프 열, 아니면 글자 하나(서로게이트 쌍 포함) */
function nextKey(input: string, at: number): string {
  if (input[at] === ESC) {
    const csi = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O[@-~])/.exec(input.slice(at));
    if (csi) return csi[0];
    return ESC;
  }
  const code = input.codePointAt(at)!;
  return String.fromCodePoint(code);
}

export function handleInput(start: DeskState, chunk: string, final = false): { state: DeskState; effects: Effect[] } {
  let state: DeskState = start.pending ? { ...start, pending: undefined } : start;
  const input = (start.pending ?? '') + chunk;
  const effects: Effect[] = [];
  let forward = '';
  const flush = () => {
    const id = state.slots[state.focus];
    if (forward && id) effects.push({ type: 'input', id, data: forward });
    forward = '';
  };

  let at = 0;
  while (at < input.length) {
    if (state.pasting) {
      const end = input.indexOf(PASTE_END, at);
      let content: string;
      if (end >= 0) {
        content = input.slice(at, end);
        at = end + PASTE_END.length;
      } else {
        // 끝 표지의 앞부분으로 끝나면 그만큼은 다음 조각까지 둔다
        const hold = final ? 0 : heldTail(input.slice(at), PASTE_END);
        content = input.slice(at, input.length - hold);
        if (hold) state = { ...state, pending: input.slice(input.length - hold) };
        at = input.length;
      }
      state = pasteContent(state, content, end >= 0, effects);
      continue;
    }
    if (input.startsWith(PASTE_START, at)) {
      flush();
      at += PASTE_START.length;
      // 앞글쇠를 누른 채 붙여 넣었으면 앞글쇠는 버린다
      state = { ...state, prefix: false, browsing: false, pasting: { sent: false } };
      continue;
    }
    if (!final && input[at] === ESC && INCOMPLETE_ESCAPE.test(input.slice(at))) {
      state = { ...state, pending: input.slice(at) };
      break;
    }
    if (state.prompt) {
      const key = nextKey(input, at);
      at += key.length;
      state = promptKey(state, key, effects);
      continue;
    }
    if (state.prefix) {
      const key = nextKey(input, at);
      at += key.length;
      state = commandKey(state, key, effects);
      continue;
    }
    const char = input[at]!;
    if (char === PREFIX) {
      flush();
      state = { ...state, prefix: true, message: undefined };
      at += 1;
      continue;
    }
    forward += char;
    at += 1;
  }
  flush();
  return { state, effects };
}

/** 기다리던 글(pending)을 더 기다리지 않고 처리한다: 혼자 온 Esc는 Esc다 */
export function flushPending(state: DeskState): { state: DeskState; effects: Effect[] } {
  if (!state.pending) return { state, effects: [] };
  return handleInput(state, '', true);
}

/** text가 marker의 앞부분으로 끝나면 그 길이 */
function heldTail(text: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function pasteContent(state: DeskState, content: string, ended: boolean, effects: Effect[]): DeskState {
  const pasting = state.pasting!;
  const next: DeskState = ended ? { ...state, pasting: undefined } : { ...state, pasting: { sent: pasting.sent || content.length > 0 } };
  if (state.prompt) {
    // 요청 글에는 한 줄로 넣는다: 줄바꿈은 빈칸, 다른 제어 글자는 버린다
    const clean = content.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (!clean) return next;
    const text = state.prompt.text + clean;
    const last = effects.findIndex((effect) => effect.type === 'preview');
    if (last >= 0) effects.splice(last, 1);
    effects.push({ type: 'preview', text });
    return { ...next, prompt: { ...state.prompt, text } };
  }
  const id = state.slots[state.focus];
  if (!id) return next;
  const part = pasting.sent ? (ended ? 'end' : 'middle') : ended ? undefined : 'start';
  if (content || part === 'end') effects.push({ type: 'paste', id, data: content, ...(part ? { part } : {}) });
  return next;
}

/** 안쪽 CLI가 응용 커서 키 모드(DECCKM)를 켰으면 방향키·Home·End를 그 꼴(SS3)로 바꾼다 */
export function toInnerKeys(data: string, modes: { appCursor: boolean }): string {
  return modes.appCursor ? data.replace(/\x1b\[([ABCDHF])/g, '\x1bO$1') : data;
}

/** 칸에 넣을 붙여넣기. CLI가 bracketed paste를 켰을 때만 표지로 감싼다. 내용 안의 표지는 지워 붙여넣기를 일찍 끝내지 못하게 한다 */
export function pasteFor(effect: Extract<Effect, { type: 'paste' }>, bracketed: boolean): string {
  const clean = effect.data.split(PASTE_END).join('').split(PASTE_START).join('');
  if (!bracketed) return clean;
  const head = effect.part === undefined || effect.part === 'start' ? PASTE_START : '';
  const tail = effect.part === undefined || effect.part === 'end' ? PASTE_END : '';
  return head + clean + tail;
}

/** 목록을 새로 받았을 때 고르던 세션의 새 순번. 세션이 사라졌으면 같은 자리(범위 안)다 */
export function reselect(before: readonly DeskItem[], selected: number, after: readonly DeskItem[]): number {
  const id = deskSessions(before)[selected]?.id;
  const sessions = deskSessions(after);
  const index = id === undefined ? -1 : sessions.findIndex((entry) => entry.id === id);
  if (index >= 0) return index;
  return Math.max(0, Math.min(selected, sessions.length - 1));
}

function commandKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const done = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
  const sessions = deskSessions(state.items);
  if (key === PREFIX) {
    // 사이드바를 고르다가 습관대로 다시 누른 Ctrl-b는 새 앞글쇠다. 칸으로 보내면 다음 글자가 CLI 입력이 된다
    if (state.browsing) return { ...state, prefix: true, browsing: false, message: undefined };
    const id = state.slots[state.focus];
    if (id) effects.push({ type: 'input', id, data: PREFIX });
    return done;
  }
  if (/^[1-4]$/.test(key)) {
    const slot = Number(key) - 1;
    return slot < state.layout ? { ...done, focus: slot } : done;
  }
  if (key === UP || key === UP_APP) return { ...state, browsing: true, message: BROWSING, selected: Math.max(0, state.selected - 1) };
  if (key === DOWN || key === DOWN_APP) return { ...state, browsing: true, message: BROWSING, selected: Math.max(0, Math.min(sessions.length - 1, state.selected + 1)) };
  if (key === '\r' || key === '\n') {
    const item = sessions[state.selected];
    if (!item) return done;
    const already = state.slots.findIndex((id, slot) => id === item.id && slot < state.layout);
    if (already >= 0) {
      effects.push({ type: 'reopen', id: item.id });
      return { ...done, focus: already };
    }
    const slots = [...state.slots];
    slots[state.focus] = item.id;
    effects.push({ type: 'open', slot: state.focus, id: item.id });
    return { ...done, slots };
  }
  if (key === 'n') {
    effects.push({ type: 'prompt' });
    return done;
  }
  if (key === 'l') {
    const layout = LAYOUTS[(LAYOUTS.indexOf(state.layout) + 1) % LAYOUTS.length]!;
    // 줄어든 배치 밖의 칸은 비운다(세션은 계속 돈다)
    const slots = state.slots.map((id, slot) => (slot < layout ? id : undefined));
    effects.push({ type: 'layout' });
    return { ...done, layout, slots, focus: Math.min(state.focus, layout - 1) };
  }
  if (key === 'x') {
    const id = state.slots[state.focus];
    if (!id) return done;
    const slots = [...state.slots];
    slots[state.focus] = undefined;
    effects.push({ type: 'close', slot: state.focus, id });
    return { ...done, slots };
  }
  if (key === 'q') {
    effects.push({ type: 'quit' });
    return done;
  }
  if (key === ESC) return done;
  return { ...done, message: 'Ctrl-b 다음에는 숫자 · ↑↓ · Enter · n · l · x · q 를 씁니다' };
}

function promptKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const prompt = state.prompt!;
  if (key === ESC || key === '\x03') return { ...state, prompt: undefined, message: '새 요청을 닫았습니다' };
  if (prompt.step === 'project') {
    if (key === UP || key === UP_APP) return { ...state, prompt: { ...prompt, projectIndex: Math.max(0, prompt.projectIndex - 1) } };
    if (key === DOWN || key === DOWN_APP) return { ...state, prompt: { ...prompt, projectIndex: Math.min(prompt.projects.length - 1, prompt.projectIndex + 1) } };
    if (key === '\r' && prompt.projects[prompt.projectIndex]) return { ...state, prompt: { ...prompt, step: 'request' } };
    return state;
  }
  if (key === '\t') return { ...state, prompt: { ...prompt, choice: (prompt.choice + 1) % Math.max(1, prompt.choices.length) } };
  if (key === '\r') {
    const request = prompt.text.trim();
    const project = prompt.projects[prompt.projectIndex];
    if (!request || !project || prompt.sending) return state;
    effects.push({ type: 'submit', projectId: project.id, request, choice: prompt.choices[prompt.choice] ?? 'rules' });
    return { ...state, prompt: { ...prompt, sending: true } };
  }
  if (key === '\x7f' || key === '\b') {
    const text = [...prompt.text].slice(0, -1).join('');
    effects.push({ type: 'preview', text });
    return { ...state, prompt: { ...prompt, text } };
  }
  if (key.startsWith(ESC)) return state;
  // 붙여 넣은 줄바꿈은 보내기가 아니라 빈칸으로 둔다. 다른 제어 글자는 버린다
  const char = key === '\n' ? ' ' : key;
  if (char.codePointAt(0)! < 32) return state;
  const text = prompt.text + char;
  // 미리보기는 마지막 글자 기준 하나면 된다: 이 묶음에서 앞서 낸 미리보기를 바꾼다
  const last = effects.findIndex((effect) => effect.type === 'preview');
  if (last >= 0) effects.splice(last, 1);
  effects.push({ type: 'preview', text });
  return { ...state, prompt: { ...prompt, text } };
}

/**
 * desk의 키 처리. 상태와 받은 글자로 다음 상태와 할 일(effects)을 돌려주는 순수 함수다 — 네트워크·화면은 desk.ts가 한다.
 *
 * 앞글쇠는 Ctrl-b(tmux·herdr와 같다). 앞글쇠가 없으면 친 글자는 고른 칸의 CLI로 그대로 간다.
 * 앞글쇠 다음: 숫자(칸 고르기), ↑↓(사이드바, 앞글쇠가 이어지고 그동안 Ctrl-b는 새 앞글쇠다), Enter(고른 세션을 칸에 열기), n(새 요청), l(칸 수), x(칸 비우기), q(나가기),
 * Ctrl-b(Ctrl-b를 CLI로). 새 요청 입력 중에는 글자가 입력으로 간다
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
}

export type Effect =
  | { type: 'input'; id: string; data: string }
  | { type: 'open'; slot: number; id: string }
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

export function handleInput(start: DeskState, input: string): { state: DeskState; effects: Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  let forward = '';
  const flush = () => {
    const id = state.slots[state.focus];
    if (forward && id) effects.push({ type: 'input', id, data: forward });
    forward = '';
  };

  let at = 0;
  while (at < input.length) {
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
    if (already >= 0) return { ...done, focus: already };
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

/**
 * desk의 설정 화면(#890, 앞글쇠 다음 g). 웹의 계정 화면과 규칙표 편집을 터미널로 대신한다(ADR-186).
 *
 * 탭 넷: 계정(더하기·이름·그림·로그인·빼기), 라우팅 규칙(고치기·더하기·옮기기·지우기·기본값·저장·미리보기), 화면(팔레트·그림·움짤·색·마우스), 키·알림.
 * 여기는 상태와 받은 키로 다음 상태와 할 일(effects)을 돌려주는 순수 함수와 그리기뿐이다. 스튜디오 API와 desk.json 쓰기는 desk.ts가 한다.
 * 계정과 규칙은 스튜디오가 검사한다(이름 길이, 설정 폴더가 홈 아래인지, 규칙 꼴). 여기서는 빈 이름처럼 보내 볼 필요가 없는 것만 거른다
 */
import { parsePrefix, type DeskConfig, type DeskPrefix } from './config';
import { fit, fitAnsi, osc8, stringWidth } from './screen';
import { backendLabel } from './sidebar';
import { spriteLines, type Sprite } from './sprite';
import { bg, BOLD, fg, RESET, type Theme } from './theme';
import { badge, box } from './widgets';
import type { DeskAccount, DeskAccountStatus, DeskRule, DeskRules, DeskRuleTarget, DeskRuleWhen } from './types';

export type SettingsTab = 'accounts' | 'rules' | 'screen' | 'keys';

export const SETTINGS_TABS: ReadonlyArray<{ tab: SettingsTab; label: string }> = [
  { tab: 'accounts', label: '계정' },
  { tab: 'rules', label: '라우팅 규칙' },
  { tab: 'screen', label: '화면' },
  { tab: 'keys', label: '키·알림' },
];

export type RulesView = DeskRules;

export interface SettingsAccount extends DeskAccount {
  status?: DeskAccountStatus;
  /** 상태를 묻는 중 */
  checking?: boolean;
  /** 상태를 묻지 못한 까닭 */
  statusError?: string;
}

/** 로그인 창. manual은 사람이 터미널에서 칠 명령만 있는 CLI, failed는 시작하지 못한 것이다 */
export interface LoginView {
  accountId: string;
  name: string;
  state: 'starting' | 'running' | 'exited' | 'cancelled' | 'timeout' | 'manual' | 'failed';
  url?: string;
  code?: string;
  lines: string[];
  command?: string;
  note?: string;
  error?: string;
  /** 끝난 뒤 다시 잰 상태 */
  connected?: boolean;
  reason?: string;
}

export interface FieldOption {
  value: string;
  label: string;
}

export type Field =
  | { key: string; label: string; kind: 'text'; value: string; hint?: string }
  | { key: string; label: string; kind: 'choice'; options: FieldOption[]; value: string }
  | { key: string; label: string; kind: 'multi'; options: FieldOption[]; values: string[]; cursor: number };

export interface FormState {
  purpose: 'account-add' | 'account-rename' | 'rule' | 'rule-add' | 'fallback' | 'preview';
  /** 고치는 계정 id나 규칙 순번 */
  target?: string | number;
  title: string;
  fields: Field[];
  /** 고른 칸 */
  at: number;
  error?: string;
}

/** 그림 고르기. 목록의 빈 글('')은 "무작위"다 */
export interface PickerState {
  accountId: string;
  filter: string;
  index: number;
}

export type SettingsConfirm = { kind: 'remove-account'; id: string; name: string } | { kind: 'remove-rule'; index: number } | { kind: 'discard-rules' };

export interface SettingsState {
  tab: SettingsTab;
  /** 그 탭에서 고른 줄 */
  row: number;
  /** 계정·규칙을 처음 받는 중 */
  loading?: boolean;
  accounts: SettingsAccount[];
  accountsError?: string;
  /** 규칙에 쓸 수 있는 AI(서버가 허용한 것) */
  backends: string[];
  rules?: RulesView;
  defaultBackend?: string;
  rulesError?: string;
  /** 규칙을 고쳤지만 아직 저장하지 않았다 */
  rulesDirty?: boolean;
  /** desk.json에 있는 값(바꾸면 여기와 파일을 함께 바꾼다) */
  config: DeskConfig;
  /** 그림 폴더의 그림 파일(폴더 기준 상대 경로) */
  sprites: string[];
  form?: FormState;
  picker?: PickerState;
  /** 그림 고르기에서 미리 보는 그림. desk가 읽어 채운다 */
  previewSprite?: { file: string; sprite?: Sprite; error?: string };
  confirm?: SettingsConfirm;
  login?: LoginView;
  /** 규칙 미리보기: 쓴 요청과 결과 한 줄 */
  preview?: { text: string; pending?: boolean; result?: string };
  /** 아래 줄 알림(다음 키에서 지운다) */
  note?: string;
}

export type SettingsEffect =
  | { type: 'close' }
  | { type: 'account-add'; name: string; backend: string; configDir: string }
  | { type: 'account-update'; id: string; name?: string; sprite?: string }
  | { type: 'account-remove'; id: string }
  | { type: 'account-status'; id: string }
  | { type: 'login-start'; id: string }
  | { type: 'login-cancel'; id: string }
  | { type: 'open-url'; url: string }
  | { type: 'rules-save'; rules: RulesView }
  | { type: 'rules-reload' }
  | { type: 'preview'; text: string }
  | { type: 'config'; config: DeskConfig }
  | { type: 'sprite-preview'; file: string };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const SHIFT_UP = ['\x1b[1;2A', 'K'];
const SHIFT_DOWN = ['\x1b[1;2B', 'J'];
const SHIFT_TAB = '\x1b[Z';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];
const CTRL_C = '\x03';
const CTRL_U = '\x15';

/** 설정 폴더를 따로 둘 수 있는 CLI(스튜디오 ai-accounts.ts의 DIR_ENV와 같다) */
const ACCOUNT_BACKENDS: readonly string[] = ['claude-code', 'codex'];
/** 기본 계정이 쓰는 폴더(보이기만 한다) */
const DEFAULT_DIRS: Record<string, string> = { 'claude-code': '~/.claude', codex: '~/.codex' };
const MAX_KEYWORDS = 20;
const MAX_TEXT = 100;
const NAME_MAX = 60;
/** 로그인 창에 보일 CLI 출력 줄 수 */
const LOGIN_LINES = 8;
/** 탭 목록의 폭 */
const TAB_WIDTH = 14;
/** 입력 칸 이름의 폭 */
const LABEL_WIDTH = 12;

const INTENT_OPTIONS: FieldOption[] = [
  { value: '', label: '상관없음' },
  { value: 'build', label: '만들기' },
  { value: 'ask', label: '질문' },
];
const COMPLEXITY_OPTIONS: FieldOption[] = [
  { value: 'simple', label: '단순' },
  { value: 'normal', label: '보통' },
  { value: 'complex', label: '복잡' },
];
const RISK_OPTIONS: FieldOption[] = [
  { value: '', label: '상관없음' },
  { value: 'high', label: '위험' },
  { value: 'normal', label: '위험 아님' },
];
const COMPLEXITY_LABEL: Record<string, string> = { simple: '단순', normal: '보통', complex: '복잡' };

/** 고를 수 있는 앞글쇠: Ctrl-a부터 Ctrl-z까지, 다른 키와 같은 글자로 오는 c·h·i·j·m은 뺀다 */
export const PREFIXES: readonly DeskPrefix[] = 'abcdefghijklmnopqrstuvwxyz'
  .split('')
  .map((letter) => parsePrefix(`C-${letter}`))
  .filter((prefix): prefix is DeskPrefix => prefix !== undefined);
const DEFAULT_PREFIX: DeskPrefix = { key: '\x02', label: 'Ctrl-b' };

/** 화면·키 탭의 줄 하나: desk.json의 키 하나와 고를 수 있는 값 */
interface OptionRow {
  key: keyof DeskConfig;
  label: string;
  help: string;
  /** 바꾸면 desk가 바로 적용한다(아니면 다시 열 때) */
  live: boolean;
  options: ReadonlyArray<{ value: unknown; label: string }>;
  /** 설정에 값이 없을 때 쓰는 값 */
  fallback: unknown;
}

const SCREEN_ROWS: readonly OptionRow[] = [
  {
    key: 'theme',
    label: '팔레트',
    help: 'desk의 색입니다. 터미널 바탕이 밝으면 밝은 팔레트가 읽기 쉽습니다',
    live: true,
    options: [
      { value: 'dark', label: '어두운' },
      { value: 'light', label: '밝은' },
    ],
    fallback: 'dark',
  },
  {
    key: 'sprites',
    label: '카드 그림',
    help: '무작위는 계정 그림이나 이름 붙인 그림이 없는 세션에 그림 폴더(~/.config/b-studio/sprites/)에서 하나를 골라 줍니다',
    live: false,
    options: [
      { value: 'random', label: '무작위' },
      { value: 'named', label: '이름 붙인 그림만' },
      { value: 'off', label: '기본 그림만' },
    ],
    fallback: 'random',
  },
  {
    key: 'animate',
    label: '움짤',
    help: '카드 화면에서 GIF 그림을 움직입니다. 칸 화면이나 창이 포커스를 잃으면 멈춥니다',
    live: false,
    options: [
      { value: true, label: '움직임' },
      { value: false, label: '멈춤' },
    ],
    fallback: true,
  },
  {
    key: 'graphics',
    label: '그림 그리기',
    help: '자동은 Ghostty·kitty에서 Kitty 그래픽으로 선명하게, 그 밖에는 반칸 블록으로 그립니다(tmux 안에서는 반칸 블록)',
    live: false,
    options: [
      { value: 'auto', label: '자동' },
      { value: 'kitty', label: 'Kitty 그래픽' },
      { value: 'blocks', label: '반칸 블록' },
    ],
    fallback: 'auto',
  },
  {
    key: 'color',
    label: '색 깊이',
    help: '자동은 COLORTERM을 봅니다. 색이 이상하면 256색으로 낮춥니다',
    live: false,
    options: [
      { value: 'auto', label: '자동' },
      { value: 'truecolor', label: '24비트' },
      { value: '256', label: '256색' },
    ],
    fallback: 'auto',
  },
  {
    key: 'mouse',
    label: '마우스',
    help: '칸·카드 누르기와 휠 스크롤입니다. studio desk --no-mouse가 이 값보다 앞섭니다',
    live: false,
    options: [
      { value: true, label: '켬' },
      { value: false, label: '끔' },
    ],
    fallback: true,
  },
];

const KEY_ROWS: readonly OptionRow[] = [
  {
    key: 'prefix',
    label: '앞글쇠',
    help: '칸의 CLI 대신 desk가 받는 글쇠입니다. tmux 안에서 쓰면 tmux와 다른 글쇠(예: Ctrl-a)로 바꿉니다',
    live: true,
    options: PREFIXES.map((prefix) => ({ value: prefix, label: prefix.label })),
    fallback: DEFAULT_PREFIX,
  },
  {
    key: 'notify',
    label: '알림',
    help: '세션이 손댈 상태가 되거나 검증·작업이 끝나면 벨과 OS 알림을 냅니다(보고 있는 칸은 빼고). 끄면 아래 두 줄도 꺼집니다. studio desk --no-notify가 이 값보다 앞섭니다',
    live: false,
    options: [
      { value: true, label: '벨과 OS 알림' },
      { value: false, label: '끔' },
    ],
    fallback: true,
  },
  {
    key: 'notifyDone',
    label: '완료 알림',
    help: '보지 않는 칸의 세션이 일을 마치면 벨과 OS 알림을 냅니다. 꺼도 사이드바의 초록 "끝남"과 !는 남습니다',
    live: true,
    options: [
      { value: true, label: '켬' },
      { value: false, label: '끔' },
    ],
    fallback: true,
  },
  {
    key: 'notifyInput',
    label: '입력 알림',
    help: '보지 않는 칸의 세션이 권한·답·입력을 기다리면 벨과 OS 알림을 냅니다. 꺼도 사이드바 표시와 Ctrl-b j는 그대로입니다',
    live: true,
    options: [
      { value: true, label: '켬' },
      { value: false, label: '끔' },
    ],
    fallback: true,
  },
];

function optionRows(tab: SettingsTab): readonly OptionRow[] {
  return tab === 'screen' ? SCREEN_ROWS : tab === 'keys' ? KEY_ROWS : [];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === 'object' && typeof b === 'object') return (a as DeskPrefix).label === (b as DeskPrefix).label;
  return a === b;
}

function optionIndex(row: OptionRow, config: DeskConfig): number {
  const value = config[row.key] ?? row.fallback;
  return Math.max(0, row.options.findIndex((option) => sameValue(option.value, value)));
}

export function openSettings(input: { config: DeskConfig; sprites: string[] }): SettingsState {
  return { tab: 'accounts', row: 0, loading: true, accounts: [], backends: [], config: input.config, sprites: input.sprites };
}

/** 그 탭의 줄 수 */
function rowCount(state: SettingsState): number {
  if (state.tab === 'accounts') return state.accounts.length;
  if (state.tab === 'rules') return state.rules ? state.rules.rules.length + 1 : 0;
  return optionRows(state.tab).length;
}

/** 새 계정의 설정 폴더 제안: ~/.b-studio/accounts/<CLI>-<번호>. 이미 쓰는 번호는 건너뛴다 */
export function suggestConfigDir(backend: string, accounts: readonly DeskAccount[]): string {
  for (let n = 1; ; n++) {
    const tail = `/.b-studio/accounts/${backend}-${n}`;
    if (!accounts.some((account) => account.configDir?.endsWith(tail))) return `~${tail}`;
  }
}

/** 조건을 사람이 읽는 말로(스튜디오 describeWhen과 같은 말) */
export function describeWhen(when: DeskRuleWhen): string {
  const parts: string[] = [];
  if (when.intent) parts.push(when.intent === 'ask' ? '질문' : '만들기');
  if (when.complexity?.length) parts.push(when.complexity.map((item) => COMPLEXITY_LABEL[item] ?? item).join('·'));
  if (when.risk) parts.push(when.risk === 'high' ? '위험' : '위험 아님');
  if (when.keywords?.length) parts.push(`${when.keywords.map((keyword) => `"${keyword}"`).join(', ')} 포함`);
  return parts.length > 0 ? parts.join(' · ') : '모든 요청';
}

/** 보낼 곳: AI · 계정 · 모델 */
export function describeTarget(target: DeskRuleTarget, accounts: readonly DeskAccount[]): string {
  const account = target.accountId ? (accounts.find((entry) => entry.id === target.accountId)?.name ?? `계정 ${target.accountId}(목록에 없음)`) : undefined;
  return [backendLabel(target.backend), ...(account ? [account] : []), ...(target.model ? [target.model] : [])].join(' · ');
}

/** 규칙의 계정 고르기: 기본 계정과 그 AI에 더한 계정들 */
function accountOptions(backend: string, accounts: readonly DeskAccount[]): FieldOption[] {
  const base = accounts.find((account) => account.id === backend)?.name ?? '기본';
  return [{ value: '', label: `기본(${base})` }, ...accounts.filter((account) => account.backend === backend && account.id !== backend).map((account) => ({ value: account.id, label: account.name }))];
}

function backendOptions(backends: readonly string[]): FieldOption[] {
  return backends.map((backend) => ({ value: backend, label: backendLabel(backend) }));
}

function ruleForm(state: SettingsState, purpose: 'rule' | 'rule-add', rule: DeskRule, target: number): FormState {
  const backends = state.backends.length > 0 ? state.backends : [rule.backend];
  return {
    purpose,
    target,
    title: purpose === 'rule-add' ? '새 규칙' : `규칙 ${target + 1} 고치기`,
    at: 0,
    fields: [
      { key: 'intent', label: '하는 일', kind: 'choice', options: INTENT_OPTIONS, value: rule.when.intent ?? '' },
      { key: 'complexity', label: '복잡도', kind: 'multi', options: COMPLEXITY_OPTIONS, values: [...(rule.when.complexity ?? [])], cursor: 0 },
      { key: 'risk', label: '위험', kind: 'choice', options: RISK_OPTIONS, value: rule.when.risk ?? '' },
      { key: 'keywords', label: '낱말', kind: 'text', value: (rule.when.keywords ?? []).join(', '), hint: '쉼표로 나눕니다. 요청에 하나라도 있으면 맞습니다' },
      { key: 'backend', label: 'AI', kind: 'choice', options: backendOptions(backends), value: rule.backend },
      { key: 'accountId', label: '계정', kind: 'choice', options: accountOptions(rule.backend, state.accounts), value: rule.accountId ?? '' },
      { key: 'model', label: '모델', kind: 'text', value: rule.model ?? '', hint: '비우면 CLI 기본값' },
    ],
  };
}

function fallbackForm(state: SettingsState): FormState {
  const fallback = state.rules?.fallback;
  const backend = fallback?.backend ?? '';
  return {
    purpose: 'fallback',
    title: '기본값: 맞는 규칙이 없을 때',
    at: 0,
    fields: [
      { key: 'backend', label: 'AI', kind: 'choice', options: [{ value: '', label: `없음(서버 기본 ${backendLabel(state.defaultBackend)})` }, ...backendOptions(state.backends)], value: backend },
      { key: 'accountId', label: '계정', kind: 'choice', options: backend ? accountOptions(backend, state.accounts) : [{ value: '', label: '기본' }], value: fallback?.accountId ?? '' },
      { key: 'model', label: '모델', kind: 'text', value: fallback?.model ?? '', hint: '비우면 CLI 기본값' },
    ],
  };
}

function textOf(form: FormState, key: string): string {
  const field = form.fields.find((entry) => entry.key === key);
  return field?.kind === 'text' ? field.value : '';
}

function choiceOf(form: FormState, key: string): string {
  const field = form.fields.find((entry) => entry.key === key);
  return field?.kind === 'choice' ? field.value : '';
}

function multiOf(form: FormState, key: string): string[] {
  const field = form.fields.find((entry) => entry.key === key);
  return field?.kind === 'multi' ? field.values : [];
}

/** AI를 바꾸면 계정 고르기를 그 AI의 계정으로 바꾸고, 없는 계정이면 기본 계정으로 둔다 */
function refreshAccounts(form: FormState, accounts: readonly DeskAccount[]): FormState {
  const backend = choiceOf(form, 'backend');
  const options = backend ? accountOptions(backend, accounts) : [{ value: '', label: '기본' }];
  return {
    ...form,
    fields: form.fields.map((field) => {
      if (field.key !== 'accountId' || field.kind !== 'choice') return field;
      return { ...field, options, value: options.some((option) => option.value === field.value) ? field.value : '' };
    }),
  };
}

function setField(form: FormState, index: number, field: Field): FormState {
  return { ...form, error: undefined, fields: form.fields.map((entry, at) => (at === index ? field : entry)) };
}

/** 입력 칸에 넣을 글: 줄바꿈은 빈칸, 다른 제어 글자는 버린다 */
function cleanText(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** 파일 이름 안의 숫자를 수로 비교한다(pokemon/24.gif가 pokemon/239.gif 앞) */
const NATURAL = new Intl.Collator('en', { numeric: true });

/** 그림 고르기의 목록: 맨 앞은 무작위(''), 그다음 거른 파일(숫자는 수의 차례) */
export function pickerItems(state: SettingsState, picker: PickerState): string[] {
  const needle = picker.filter.toLowerCase();
  return ['', ...state.sprites.filter((file) => file.toLowerCase().includes(needle)).sort(NATURAL.compare)];
}

function previewEffect(file: string | undefined): SettingsEffect[] {
  return file ? [{ type: 'sprite-preview', file }] : [];
}

function selectedAccount(state: SettingsState): SettingsAccount | undefined {
  return state.tab === 'accounts' ? state.accounts[state.row] : undefined;
}

/** 키 하나. 닫으면 state가 없다 */
export function settingsKey(start: SettingsState, key: string): { state: SettingsState | undefined; effects: SettingsEffect[] } {
  const effects: SettingsEffect[] = [];
  // 알림은 다음 키에서 지운다
  const state: SettingsState = start.note ? { ...start, note: undefined } : start;
  if (state.confirm) return { state: confirmKey(state, key, effects), effects };
  if (state.form) return { state: formKey(state, key, effects), effects };
  if (state.picker) return { state: pickerKey(state, key, effects), effects };
  if (state.login) return { state: loginKey(state, key, effects), effects };

  if (key === ESC || key === 'q' || key === CTRL_C) {
    if (state.rulesDirty) return { state: { ...state, confirm: { kind: 'discard-rules' } }, effects };
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  if (key === '\t' || key === SHIFT_TAB) {
    const at = SETTINGS_TABS.findIndex((entry) => entry.tab === state.tab);
    const next = SETTINGS_TABS[(at + (key === '\t' ? 1 : SETTINGS_TABS.length - 1)) % SETTINGS_TABS.length]!;
    return { state: { ...state, tab: next.tab, row: 0 }, effects };
  }
  const count = rowCount(state);
  if (UP.includes(key)) return { state: { ...state, row: Math.max(0, state.row - 1) }, effects };
  if (DOWN.includes(key)) return { state: { ...state, row: Math.max(0, Math.min(count - 1, state.row + 1)) }, effects };
  if (state.tab === 'screen' || state.tab === 'keys') return { state: optionKey(state, key, effects), effects };
  // 계정과 규칙은 받은 뒤에 다룬다
  if (state.loading) return { state, effects };
  if (state.tab === 'accounts') return { state: accountsKey(state, key, effects), effects };
  return { state: rulesKey(state, key, effects), effects };
}

function accountsKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  if (key === 'a') {
    const backends = ACCOUNT_BACKENDS.filter((backend) => state.backends.includes(backend));
    if (backends.length === 0) return { ...state, note: '계정을 여럿 둘 수 있는 CLI(Claude·Codex)를 이 스튜디오가 쓰지 않습니다' };
    return {
      ...state,
      form: {
        purpose: 'account-add',
        title: '새 계정',
        at: 0,
        fields: [
          { key: 'name', label: '이름', kind: 'text', value: '', hint: '카드와 사용량에 보일 이름(예: 피오)' },
          { key: 'backend', label: 'CLI', kind: 'choice', options: backendOptions(backends), value: backends[0]! },
          { key: 'configDir', label: '설정 폴더', kind: 'text', value: '', hint: '비우면 ~/.b-studio/accounts/ 아래에 새로 둡니다(홈 아래만)' },
        ],
      },
    };
  }
  const account = selectedAccount(state);
  if (!account) return state;
  if (ENTER.includes(key) || key === 'e') {
    return { ...state, form: { purpose: 'account-rename', target: account.id, title: `${account.name} 이름 바꾸기`, at: 0, fields: [{ key: 'name', label: '이름', kind: 'text', value: account.name }] } };
  }
  if (key === 'x') {
    if (account.builtin || account.id === account.backend) return { ...state, note: '기본 계정은 지울 수 없습니다(이름과 그림만 바꿉니다)' };
    return { ...state, confirm: { kind: 'remove-account', id: account.id, name: account.name } };
  }
  if (key === 'r') {
    effects.push({ type: 'account-status', id: account.id });
    return { ...state, accounts: state.accounts.map((entry) => (entry.id === account.id ? { ...entry, checking: true, statusError: undefined } : entry)) };
  }
  if (key === 'l') {
    effects.push({ type: 'login-start', id: account.id });
    return { ...state, login: { accountId: account.id, name: account.name, state: 'starting', lines: [] } };
  }
  if (key === 'p') {
    const picker: PickerState = { accountId: account.id, filter: '', index: 0 };
    const items = pickerItems(state, picker);
    const index = Math.max(0, account.sprite ? items.indexOf(account.sprite) : 0);
    effects.push(...previewEffect(items[index]));
    return { ...state, picker: { ...picker, index }, previewSprite: undefined };
  }
  return state;
}

function rulesKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  const rules = state.rules;
  if (!rules) {
    if (key === 'R') effects.push({ type: 'rules-reload' });
    return state;
  }
  const onFallback = state.row >= rules.rules.length;
  const rule = rules.rules[state.row];
  if (ENTER.includes(key) || key === 'e') {
    if (onFallback) return { ...state, form: fallbackForm(state) };
    if (rule) return { ...state, form: ruleForm(state, 'rule', rule, state.row) };
    return state;
  }
  if (key === 'a') {
    if (state.backends.length === 0) return { ...state, note: '고를 수 있는 AI가 없습니다' };
    const at = onFallback ? rules.rules.length : state.row + 1;
    return { ...state, form: ruleForm(state, 'rule-add', { when: {}, backend: state.backends[0]! }, at) };
  }
  if (key === 'x') {
    if (onFallback) return { ...state, note: '기본값은 지우지 않고 Enter로 AI를 "없음"으로 바꿉니다' };
    return { ...state, confirm: { kind: 'remove-rule', index: state.row } };
  }
  if (SHIFT_UP.includes(key) || SHIFT_DOWN.includes(key)) {
    if (onFallback) return state;
    const to = state.row + (SHIFT_UP.includes(key) ? -1 : 1);
    if (to < 0 || to >= rules.rules.length) return state;
    const list = [...rules.rules];
    [list[state.row], list[to]] = [list[to]!, list[state.row]!];
    return { ...state, rules: { ...rules, rules: list }, row: to, rulesDirty: true };
  }
  if (key === 's') {
    effects.push({ type: 'rules-save', rules });
    return { ...state, note: '저장하는 중…' };
  }
  if (key === 'R') {
    effects.push({ type: 'rules-reload' });
    return { ...state, note: '저장한 규칙을 다시 읽는 중…' };
  }
  if (key === 't') {
    return { ...state, form: { purpose: 'preview', title: '미리보기: 이 요청은 어느 AI로 가나', at: 0, fields: [{ key: 'text', label: '요청', kind: 'text', value: state.preview?.text ?? '', hint: '저장한 규칙으로 고릅니다' }] } };
  }
  return state;
}

function optionKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  const row = optionRows(state.tab)[state.row];
  if (!row) return state;
  const step = LEFT.includes(key) ? -1 : RIGHT.includes(key) || ENTER.includes(key) || key === ' ' ? 1 : 0;
  if (step === 0) return state;
  const at = optionIndex(row, state.config);
  const value = row.options[(at + step + row.options.length) % row.options.length]!.value;
  const patch = { [row.key]: value } as DeskConfig;
  effects.push({ type: 'config', config: patch });
  return { ...state, config: { ...state.config, ...patch } };
}

function confirmKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState | undefined {
  const confirm = state.confirm!;
  const base = { ...state, confirm: undefined };
  if (!(key === 'y' || key === 'Y' || ENTER.includes(key))) return { ...base, note: '그만두었습니다' };
  if (confirm.kind === 'discard-rules') {
    effects.push({ type: 'close' });
    return undefined;
  }
  if (confirm.kind === 'remove-account') {
    effects.push({ type: 'account-remove', id: confirm.id });
    return base;
  }
  const rules = state.rules;
  if (!rules) return base;
  const list = rules.rules.filter((_, index) => index !== confirm.index);
  return { ...base, rules: { ...rules, rules: list }, rulesDirty: true, row: Math.min(state.row, list.length), note: '지웠습니다. s로 저장해야 반영됩니다' };
}

function loginKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  const login = state.login!;
  const running = login.state === 'running' || login.state === 'starting';
  if (key === 'c' && running) {
    effects.push({ type: 'login-cancel', id: login.accountId });
    return state;
  }
  if (key === 'o' && login.url) {
    effects.push({ type: 'open-url', url: login.url });
    return state;
  }
  if (key === ESC || key === 'q' || key === CTRL_C || (ENTER.includes(key) && !running)) {
    return { ...state, login: undefined, ...(running ? { note: `${login.name} 로그인은 뒤에서 계속 돕니다. l을 다시 누르면 창을 엽니다` } : {}) };
  }
  return state;
}

function pickerKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  const picker = state.picker!;
  const items = pickerItems(state, picker);
  const move = (to: number): SettingsState => {
    const index = Math.max(0, Math.min(items.length - 1, to));
    if (index !== picker.index) effects.push(...previewEffect(items[index]));
    return { ...state, picker: { ...picker, index } };
  };
  if (key === ESC || key === CTRL_C) return { ...state, picker: undefined, previewSprite: undefined, note: '그림을 바꾸지 않았습니다' };
  if (UP.includes(key)) return move(picker.index - 1);
  if (DOWN.includes(key)) return move(picker.index + 1);
  if (key === PAGE_UP) return move(picker.index - 10);
  if (key === PAGE_DOWN) return move(picker.index + 10);
  if (ENTER.includes(key)) {
    effects.push({ type: 'account-update', id: picker.accountId, sprite: items[picker.index] ?? '' });
    return { ...state, picker: undefined, previewSprite: undefined };
  }
  let filter = picker.filter;
  if (BACKSPACE.includes(key)) filter = [...filter].slice(0, -1).join('');
  else if (key === CTRL_U) filter = '';
  else if (!key.startsWith(ESC) && key.codePointAt(0)! >= 32) filter += key;
  else return state;
  // 거르면 맞는 첫 그림을 고른다(없으면 무작위)
  const next: PickerState = { ...picker, filter, index: 0 };
  const index = pickerItems(state, next).length > 1 ? 1 : 0;
  effects.push(...previewEffect(pickerItems(state, next)[index]));
  return { ...state, picker: { ...next, index } };
}

function formKey(state: SettingsState, key: string, effects: SettingsEffect[]): SettingsState {
  const form = state.form!;
  const field = form.fields[form.at]!;
  if (key === ESC || key === CTRL_C) return { ...state, form: undefined, note: '그만두었습니다' };
  if (ENTER.includes(key)) return submitForm(state, form, effects);
  if (DOWN.includes(key) || key === '\t') return { ...state, form: { ...form, at: Math.min(form.fields.length - 1, form.at + 1) } };
  if (UP.includes(key) || key === SHIFT_TAB) return { ...state, form: { ...form, at: Math.max(0, form.at - 1) } };
  if (field.kind === 'choice') {
    const step = LEFT.includes(key) ? -1 : RIGHT.includes(key) || key === ' ' ? 1 : 0;
    if (step === 0 || field.options.length === 0) return state;
    const at = Math.max(0, field.options.findIndex((option) => option.value === field.value));
    let next = setField(form, form.at, { ...field, value: field.options[(at + step + field.options.length) % field.options.length]!.value });
    if (field.key === 'backend') next = refreshAccounts(next, state.accounts);
    return { ...state, form: next };
  }
  if (field.kind === 'multi') {
    if (LEFT.includes(key)) return { ...state, form: setField(form, form.at, { ...field, cursor: Math.max(0, field.cursor - 1) }) };
    if (RIGHT.includes(key)) return { ...state, form: setField(form, form.at, { ...field, cursor: Math.min(field.options.length - 1, field.cursor + 1) }) };
    if (key !== ' ') return state;
    const value = field.options[field.cursor]!.value;
    const picked = field.values.includes(value) ? field.values.filter((entry) => entry !== value) : [...field.values, value];
    // 고른 것은 늘 보기 순서로 둔다
    return { ...state, form: setField(form, form.at, { ...field, values: field.options.map((option) => option.value).filter((entry) => picked.includes(entry)) }) };
  }
  if (BACKSPACE.includes(key)) return { ...state, form: setField(form, form.at, { ...field, value: [...field.value].slice(0, -1).join('') }) };
  if (key === CTRL_U) return { ...state, form: setField(form, form.at, { ...field, value: '' }) };
  if (key.startsWith(ESC)) return state;
  const text = cleanText(key);
  if (!text) return state;
  return { ...state, form: setField(form, form.at, { ...field, value: field.value + text }) };
}

/** 붙여 넣은 글: 고른 입력 칸이나 그림 거르기에 한 줄로 넣는다. 넣을 곳이 없으면 버린다 */
export function settingsPaste(state: SettingsState, text: string): SettingsState {
  const clean = cleanText(text);
  if (!clean) return state;
  if (state.form) {
    const field = state.form.fields[state.form.at];
    if (field?.kind !== 'text') return state;
    return { ...state, form: setField(state.form, state.form.at, { ...field, value: field.value + clean }) };
  }
  if (state.picker) return { ...state, picker: { ...state.picker, filter: state.picker.filter + clean, index: 0 } };
  return state;
}

function submitForm(state: SettingsState, form: FormState, effects: SettingsEffect[]): SettingsState {
  const fail = (error: string): SettingsState => ({ ...state, form: { ...form, error } });
  switch (form.purpose) {
    case 'account-add': {
      const name = textOf(form, 'name').trim();
      if (!name) return fail('이름을 적으세요');
      if ([...name].length > NAME_MAX) return fail(`이름은 ${NAME_MAX}자까지입니다`);
      const backend = choiceOf(form, 'backend');
      const configDir = textOf(form, 'configDir').trim() || suggestConfigDir(backend, state.accounts);
      effects.push({ type: 'account-add', name, backend, configDir });
      return { ...state, form: undefined, note: `${name} 계정을 더하는 중…` };
    }
    case 'account-rename': {
      const name = textOf(form, 'name').trim();
      if (!name) return fail('이름을 적으세요');
      if ([...name].length > NAME_MAX) return fail(`이름은 ${NAME_MAX}자까지입니다`);
      effects.push({ type: 'account-update', id: String(form.target), name });
      return { ...state, form: undefined };
    }
    case 'preview': {
      const text = textOf(form, 'text').trim();
      if (!text) return fail('요청을 적으세요');
      effects.push({ type: 'preview', text });
      return { ...state, form: undefined, preview: { text, pending: true } };
    }
    case 'fallback': {
      const rules = state.rules ?? { rules: [] };
      const backend = choiceOf(form, 'backend');
      const model = textOf(form, 'model').trim();
      if (model.length > MAX_TEXT) return fail(`모델은 ${MAX_TEXT}자까지입니다`);
      const accountId = choiceOf(form, 'accountId');
      const next: RulesView = { rules: rules.rules };
      if (backend) next.fallback = { backend, ...(model ? { model } : {}), ...(accountId ? { accountId } : {}) };
      return { ...state, form: undefined, rules: next, rulesDirty: true };
    }
    case 'rule':
    case 'rule-add': {
      const keywords = textOf(form, 'keywords')
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);
      if (keywords.length > MAX_KEYWORDS) return fail(`낱말은 ${MAX_KEYWORDS}개까지입니다`);
      if (keywords.some((keyword) => keyword.length > MAX_TEXT)) return fail(`낱말 하나는 ${MAX_TEXT}자까지입니다`);
      const model = textOf(form, 'model').trim();
      if (model.length > MAX_TEXT) return fail(`모델은 ${MAX_TEXT}자까지입니다`);
      const intent = choiceOf(form, 'intent');
      const risk = choiceOf(form, 'risk');
      const complexity = multiOf(form, 'complexity') as NonNullable<DeskRuleWhen['complexity']>;
      const accountId = choiceOf(form, 'accountId');
      const when: DeskRuleWhen = {
        ...(intent ? { intent: intent as 'build' | 'ask' } : {}),
        ...(complexity.length > 0 ? { complexity } : {}),
        ...(risk ? { risk: risk as 'high' | 'normal' } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
      };
      const rule: DeskRule = { when, backend: choiceOf(form, 'backend'), ...(model ? { model } : {}), ...(accountId ? { accountId } : {}) };
      const rules = state.rules ?? { rules: [] };
      const index = Number(form.target ?? rules.rules.length);
      const list = [...rules.rules];
      if (form.purpose === 'rule-add') list.splice(index, 0, rule);
      else list[index] = rule;
      return { ...state, form: undefined, rules: { ...rules, rules: list }, rulesDirty: true, row: index };
    }
  }
}

// ─── 그리기 ───

/** 아래 줄 안내: 지금 하는 일을 따른다 */
export function settingsHint(state: SettingsState): string {
  if (state.confirm) {
    const confirm = state.confirm;
    if (confirm.kind === 'remove-account') return ` ‹${confirm.name}› 계정을 목록에서 뺄까요? 설정 폴더(로그인·대화 기록)는 지우지 않습니다 · y 빼기 · 다른 키 그만두기`;
    if (confirm.kind === 'remove-rule') return ` 규칙 ${confirm.index + 1}을 지울까요? s로 저장해야 반영됩니다 · y 지우기 · 다른 키 그만두기`;
    return ' 저장하지 않은 규칙 변경이 있습니다. 버리고 닫을까요? · y 버리고 닫기 · 다른 키 돌아가기';
  }
  if (state.note) return ` ${state.note}`;
  if (state.form) return ' ↑↓ Tab 칸 옮기기 · ←→ 고르기 · Space 켜고 끄기 · Enter 저장 · Esc 그만두기';
  if (state.picker) return ' 글자로 거르기 · ↑↓ PgUp PgDn 고르기 · Enter 이 그림으로 · Esc 그만두기';
  if (state.login) return ' o 브라우저로 열기 · c 로그인 취소 · Esc 창 닫기(로그인은 뒤에서 계속)';
  if (state.loading) return ' 설정 불러오는 중… · Esc 닫기';
  if (state.tab === 'accounts') return ' 계정 · ↑↓ 고르기 · l 로그인 · a 더하기 · p 그림 · Enter 이름 · x 빼기 · r 상태 다시 확인 · Tab 탭 · u 사용량 · w 카드 · Esc 닫기';
  if (state.tab === 'rules') return ' 규칙 · ↑↓ 고르기 · Enter 고치기 · a 더하기 · s 저장 · t 미리보기 · x 지우기 · K J 옮기기 · R 되돌리기 · Tab 탭 · u 사용량 · w 카드 · Esc 닫기';
  return ' 설정 · ↑↓ 고르기 · ←→ Enter 값 바꾸기(바로 저장) · Tab 탭 · u 사용량 · w 카드 · Esc 닫기';
}

interface Pane {
  lines: string[];
  /** 내용 안의 커서 자리(칸, 줄) */
  cursor?: { x: number; y: number };
}

function statusLabel(account: SettingsAccount, theme: Theme): string {
  if (account.checking) return `${fg(theme, 'muted')}◐ 확인 중…${RESET}`;
  if (account.statusError) return `${fg(theme, 'yellow')}? 확인 못 함${RESET}`;
  const status = account.status;
  if (!status) return `${fg(theme, 'muted')}· 모름${RESET}`;
  if (status.connected) return `${fg(theme, 'green')}● 로그인됨${status.accountKind ? `(${status.accountKind})` : ''}${RESET}`;
  if (!status.installed) return `${fg(theme, 'red')}× CLI 없음${RESET}`;
  return `${fg(theme, 'yellow')}○ 로그인 필요${RESET}`;
}

/** 줄 하나를 고른 줄이면 바탕색으로 칠해 폭에 맞춘다 */
function rowLine(text: string, width: number, selected: boolean, theme: Theme): string {
  if (!selected) return fitAnsi(text, width);
  const back = bg(theme, 'active');
  return fitAnsi(back + text.replaceAll(RESET, RESET + back), width, back);
}

function accountsPane(state: SettingsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  if (state.accountsError) lines.push(`${fg(theme, 'red')}계정 목록을 받지 못했습니다: ${state.accountsError}${RESET}`, '');
  lines.push(`${muted}계정 ${state.accounts.length}개 · 계정마다 CLI의 설정 폴더(로그인·대화 기록)가 따로 있습니다${RESET}`, '');
  const nameWidth = Math.min(16, Math.max(6, ...state.accounts.map((account) => stringWidth(account.name))));
  state.accounts.forEach((account, index) => {
    const selected = index === state.row;
    const name = fit(account.name, nameWidth);
    const sprite = account.sprite ? `그림 ${account.sprite}` : `${muted}그림 무작위${RESET}`;
    const text = `${selected ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${BOLD}${name}${RESET} ${badge(backendLabel(account.backend), theme)} ${statusLabel(account, theme)}  ${sprite}`;
    lines.push(rowLine(text, width, selected, theme));
  });
  const account = state.accounts[state.row];
  if (account) {
    const detail = [
      ['설정 폴더', account.configDir ?? `${DEFAULT_DIRS[account.backend] ?? '기본 폴더'}(기본 계정)`],
      ['상태', account.statusError ?? account.status?.reason ?? (account.status?.connected ? '로그인됨' : account.status ? '' : 'r로 확인합니다')],
      ['그림', account.sprite ?? '무작위(그림 폴더에서 세션마다)'],
    ].filter(([, value]) => value);
    lines.push('', `${muted}${'─'.repeat(Math.max(0, width))}${RESET}`);
    for (const [label, value] of detail) lines.push(`${muted}${fit(label!, LABEL_WIDTH)}${RESET} ${value}`);
  }
  return { lines: lines.slice(0, height) };
}

function rulesPane(state: SettingsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  if (state.rulesError) lines.push(`${fg(theme, 'red')}${state.rulesError}${RESET}`);
  const rules = state.rules;
  if (!rules) {
    lines.push(`${muted}규칙을 받지 못했습니다. R로 다시 읽습니다${RESET}`);
    return { lines };
  }
  // 저장하지 않음 표시는 잘리지 않게 맨 앞에 둔다
  const dirty = state.rulesDirty ? `${fg(theme, 'yellow')}● 저장하지 않음(s로 저장)${RESET}  ` : '';
  lines.push(`${dirty}${muted}위에서부터 맞는 첫 규칙의 AI로 보냅니다. 로그인되지 않은 AI는 건너뜁니다${RESET}`, '');
  if (rules.rules.length === 0) lines.push(`${muted}  규칙이 없습니다. a로 더합니다${RESET}`);
  rules.rules.forEach((rule, index) => {
    const selected = index === state.row;
    const text = `${selected ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${muted}${String(index + 1).padStart(2)}${RESET}  ${describeWhen(rule.when)}  ${muted}→${RESET}  ${BOLD}${describeTarget(rule, state.accounts)}${RESET}`;
    lines.push(rowLine(text, width, selected, theme));
  });
  const onFallback = state.row >= rules.rules.length;
  const fallback = rules.fallback ? describeTarget(rules.fallback, state.accounts) : `없음(서버 기본 ${backendLabel(state.defaultBackend)})`;
  lines.push(rowLine(`${onFallback ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${muted}기본값${RESET} 맞는 규칙이 없으면  ${muted}→${RESET}  ${BOLD}${fallback}${RESET}`, width, onFallback, theme));
  if (state.preview) {
    lines.push('', `${muted}미리보기${RESET} "${state.preview.text}"`);
    lines.push(state.preview.pending ? `${muted}  묻는 중…${RESET}` : `  ${state.preview.result ?? ''}`);
    if (state.rulesDirty) lines.push(`${muted}  저장한 규칙으로 고른 결과입니다. 고친 것은 저장한 뒤 반영됩니다${RESET}`);
  }
  return { lines: lines.slice(0, height) };
}

function optionsPane(state: SettingsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const rows = optionRows(state.tab);
  const lines: string[] = [`${muted}바꾸면 desk.json에 바로 저장합니다${RESET}`, ''];
  rows.forEach((row, index) => {
    const selected = index === state.row;
    const value = row.options[optionIndex(row, state.config)]!.label;
    const when = row.live ? `${fg(theme, 'green')}바로 적용${RESET}` : `${muted}다시 열면 적용${RESET}`;
    const text = `${selected ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${fit(row.label, LABEL_WIDTH)} ${selected ? fg(theme, 'accent') : ''}‹ ${value} ›${RESET}  ${when}`;
    lines.push(rowLine(text, width, selected, theme));
  });
  const row = rows[state.row];
  if (row) lines.push('', `${muted}${row.help}${RESET}`);
  return { lines: lines.slice(0, height) };
}

function formPane(state: SettingsState, form: FormState, width: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [`${BOLD}${form.title}${RESET}`, ''];
  let cursor: Pane['cursor'];
  form.fields.forEach((field, index) => {
    const focused = index === form.at;
    const head = `${focused ? `${fg(theme, 'accent')}▸ ${BOLD}` : '  '}${fit(field.label, LABEL_WIDTH)}${RESET} `;
    const headWidth = 2 + LABEL_WIDTH + 1;
    let value: string;
    if (field.kind === 'text') {
      // 길면 끝부분을 보인다(커서가 칸 밖으로 나가지 않게)
      let shown = field.value;
      while (shown && stringWidth(shown) > width - headWidth - 1) shown = [...shown].slice(1).join('');
      value = shown || (field.hint ? `${muted}${field.hint}${RESET}` : '');
      if (focused) cursor = { x: headWidth + stringWidth(shown), y: lines.length };
    } else if (field.kind === 'choice') {
      const label = field.options.find((option) => option.value === field.value)?.label ?? field.value;
      value = `${focused ? fg(theme, 'accent') : ''}‹ ${label} ›${RESET}`;
    } else {
      value = field.options
        .map((option, at) => {
          const mark = field.values.includes(option.value) ? '[x]' : '[ ]';
          const text = `${mark} ${option.label}`;
          return focused && at === field.cursor ? `${bg(theme, 'active')}${fg(theme, 'accent')}${text}${RESET}` : text;
        })
        .join('  ');
      if (field.values.length === 0) value += `  ${muted}(고르지 않으면 상관없음)${RESET}`;
    }
    lines.push(head + value);
  });
  if (form.error) lines.push('', `${fg(theme, 'red')}${form.error}${RESET}`);
  return { lines, ...(cursor ? { cursor } : {}) };
}

function pickerPane(state: SettingsState, picker: PickerState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const account = state.accounts.find((entry) => entry.id === picker.accountId);
  const items = pickerItems(state, picker);
  const art = { cols: Math.min(28, Math.max(0, width - 40)), rows: Math.min(14, Math.max(0, height - 4)) };
  const listWidth = art.cols > 0 ? width - art.cols - 2 : width;
  const lines: string[] = [`${BOLD}${account?.name ?? ''} 그림 고르기${RESET} ${muted}· 그림 폴더 ${state.sprites.length}개${RESET}`, `거르기> ${picker.filter}`, ''];
  const listRows = Math.max(1, height - lines.length);
  const first = Math.max(0, Math.min(picker.index - Math.floor(listRows / 2), items.length - listRows));
  const list = items.slice(first, first + listRows).map((file, at) => {
    const index = first + at;
    const label = file || '무작위(그림 폴더에서 세션마다)';
    const current = (account?.sprite ?? '') === file ? `${muted} · 지금${RESET}` : '';
    return rowLine(`${index === picker.index ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${label}${current}`, listWidth, index === picker.index, theme);
  });
  if (state.sprites.length === 0) list.push(fit(`${''}  그림 폴더(~/.config/b-studio/sprites/)에 PNG·GIF가 없습니다`, listWidth));
  const preview = state.previewSprite;
  const selected = items[picker.index];
  const artLines =
    art.cols > 0 && art.rows > 0 && selected && preview?.file === selected
      ? preview.sprite
        ? spriteLines(preview.sprite, art.cols, art.rows, theme)
        : [fit(preview.error ? `읽지 못함: ${preview.error}` : '읽는 중…', art.cols)]
      : [];
  const body = list.map((line, at) => (art.cols > 0 ? `${line}  ${artLines[at] ?? ' '.repeat(art.cols)}` : line));
  for (let at = list.length; at < artLines.length; at++) body.push(`${' '.repeat(listWidth)}  ${artLines[at]}`);
  return { lines: [...lines, ...body], cursor: { x: stringWidth('거르기> ' + picker.filter), y: 1 } };
}

/** OSC 8 링크: 누를 수 있는 터미널(Ghostty·iTerm2·kitty …)에서 열린다. 링크 글은 주소 그대로다 */
function link(url: string): string {
  const safe = url.replace(/[\u0000-\u001f\u007f]/g, '');
  return osc8(safe, safe);
}

function loginPane(login: LoginView, width: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const state: Record<LoginView['state'], string> = {
    starting: `${muted}시작하는 중…${RESET}`,
    running: `${fg(theme, 'accent')}◐ 진행 중${RESET} ${muted}브라우저에서 로그인을 마치면 저절로 끝납니다${RESET}`,
    exited: login.connected ? `${fg(theme, 'green')}● 로그인됨${RESET}` : `${fg(theme, 'yellow')}끝났지만 로그인되지 않았습니다${login.reason ? `: ${login.reason}` : ''}${RESET}`,
    cancelled: `${muted}취소했습니다${RESET}`,
    timeout: `${fg(theme, 'yellow')}10분이 지나 그만두었습니다. l로 다시 합니다${RESET}`,
    manual: `${fg(theme, 'yellow')}이 CLI는 터미널에서 직접 로그인합니다${RESET}`,
    failed: `${fg(theme, 'red')}로그인을 시작하지 못했습니다${login.error ? `: ${login.error}` : ''}${RESET}`,
  };
  const lines: string[] = [`${BOLD}로그인: ${login.name}${RESET}`, '', `${fit('상태', LABEL_WIDTH)} ${state[login.state]}`];
  if (login.url) lines.push(`${fit('주소', LABEL_WIDTH)} ${link(login.url)}`, `${' '.repeat(LABEL_WIDTH)} ${muted}o로 브라우저에서 엽니다(터미널에 따라 Cmd·Ctrl+클릭도 됩니다)${RESET}`);
  if (login.code) lines.push(`${fit('코드', LABEL_WIDTH)} ${BOLD}${login.code}${RESET}`);
  if (login.command) lines.push(`${fit('명령', LABEL_WIDTH)} ${login.command}`);
  if (login.note) lines.push(`${muted}${login.note}${RESET}`);
  if (login.lines.length > 0) {
    lines.push('', `${muted}CLI 출력${RESET}`);
    for (const line of login.lines.slice(-LOGIN_LINES)) lines.push(`${muted}  ${line}${RESET}`);
  }
  return { lines: lines.map((line) => fitAnsi(line, width)) };
}

/** 설정 화면 본문(머리 줄과 아래 줄 사이). 둥근 테두리 안에 왼쪽 탭, 오른쪽 내용이다 */
export function renderSettings(state: SettingsState, size: { w: number; h: number }, theme: Theme): { lines: string[]; cursor?: { x: number; y: number } } {
  const inner = { w: Math.max(0, size.w - 4), h: Math.max(0, size.h - 2) };
  const contentWidth = Math.max(0, inner.w - TAB_WIDTH - 3);
  const muted = fg(theme, 'muted');
  let pane: Pane;
  if (state.loading) pane = { lines: [`${muted}불러오는 중…${RESET}`] };
  else if (state.form) pane = formPane(state, state.form, contentWidth, theme);
  else if (state.picker) pane = pickerPane(state, state.picker, contentWidth, inner.h, theme);
  else if (state.login) pane = loginPane(state.login, contentWidth, theme);
  else if (state.tab === 'accounts') pane = accountsPane(state, contentWidth, inner.h, theme);
  else if (state.tab === 'rules') pane = rulesPane(state, contentWidth, inner.h, theme);
  else pane = optionsPane(state, contentWidth, inner.h, theme);

  const rows: string[] = [];
  for (let y = 0; y < inner.h; y++) {
    const tab = SETTINGS_TABS[y - 1];
    let left = '';
    if (tab) {
      const current = tab.tab === state.tab;
      left = current ? `${bg(theme, 'active')}${fg(theme, 'accent')}${BOLD}▸ ${tab.label}${RESET}` : `${muted}  ${tab.label}${RESET}`;
    }
    rows.push(`${fitAnsi(left, TAB_WIDTH)} ${fg(theme, 'border')}│${RESET} ${fitAnsi(pane.lines[y] ?? '', contentWidth)}`);
  }
  const lines = box(rows, size.w, theme, { title: '설정', focused: true });
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  const cursor = pane.cursor && pane.cursor.y < inner.h ? { x: 2 + TAB_WIDTH + 3 + Math.min(pane.cursor.x, contentWidth - 1), y: 1 + pane.cursor.y } : undefined;
  return { lines: lines.slice(0, size.h).map((line) => fitAnsi(line, size.w)), ...(cursor ? { cursor } : {}) };
}

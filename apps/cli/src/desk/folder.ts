/**
 * 폴더 열기 화면(#916, 앞글쇠 다음 a): 이 컴퓨터의 폴더를 프로젝트로 등록한다. 웹의 폴더 선택 모달과 폴더 열기 미리보기가 하던 일이다.
 *
 * 경로를 쓰면 그 폴더의 하위 폴더를 스튜디오(`GET /api/folders`)에서 받아 거르고, Tab으로 채운다. Enter면 스튜디오가 그 폴더를 살펴
 * 무엇을 할지 제안하고(`POST /api/projects/open`), 한 번 더 답하면 파일을 쓰고 등록한다(`apply: true`). desk와 스튜디오는 같은 컴퓨터라
 * `~`는 스튜디오가 펼친다. 키(folderKey)는 화면 상태만 바꾸고 할 일(FolderEffect)을 돌려준다. 스튜디오를 부르는 일은 desk.ts가 한다
 */
import { fit, fitAnsi, stringWidth } from './screen';
import { BOLD, fg, RESET, type Theme } from './theme';
import { box } from './widgets';

/** 하위 폴더 하나(스튜디오의 FolderChild) */
export interface FolderChildView {
  name: string;
  path: string;
  hasChildren: boolean;
  /** git, nextjs, studio-yaml, registered … */
  hints: string[];
}

/** 폴더 하나의 목록(스튜디오의 FolderListing에서 쓰는 것) */
export interface FolderListingView {
  /** 스튜디오가 푼 절대 경로 */
  path: string;
  parent?: string;
  children: FolderChildView[];
  truncated: boolean;
  totalCount: number;
}

/** 폴더 열기 제안(스튜디오의 FolderProposal에서 쓰는 것) */
export interface FolderProposalView {
  detection: {
    folder: string;
    name: string;
    hasSpec: boolean;
    services: Array<{ name: string; template: string; path: string; port: number }>;
    infra: Array<{ name: string }>;
    defaultInfra: string[];
    warnings: string[];
  };
  files: Array<{ path: string }>;
  registeredId?: string;
}

export interface FolderState {
  /** 입력 칸의 경로(사람이 쓴 꼴 그대로: ~/…) */
  text: string;
  /** 받은 목록. listed 폴더의 것이다 */
  listing?: FolderListingView;
  /** 마지막으로 청한 폴더(입력의 폴더 부분). 늦게 온 다른 폴더의 목록은 버린다 */
  listed: string;
  loading?: boolean;
  error?: string;
  /** 거른 하위 폴더 중 고른 줄. -1이면 고르지 않았다 */
  row: number;
  /** 있으면 등록을 묻는 단계다 */
  proposal?: FolderProposalView;
  /** 스튜디오에 제안·등록을 청하고 답을 기다리는 중 */
  sending?: boolean;
  /** 새 요청(Ctrl-b n)의 프로젝트 고르기에서 왔다. 등록하면 그 프로젝트로 새 요청을 이어 연다 */
  from?: 'prompt';
  /** 처음 연 뒤 아직 아무것도 치지 않았다. 이때만 받은 홈 경로로 입력 칸을 채운다(#945: 비운 칸을 다시 채우지 않는다) */
  seed?: boolean;
}

export type FolderEffect =
  /** 이 폴더의 하위 폴더를 받는다. 빈 경로는 홈이다 */
  | { type: 'list'; path: string }
  /** 이 폴더를 열면 무엇을 할지 묻는다(아직 쓰지 않는다) */
  | { type: 'propose'; path: string }
  /** 파일을 쓰고 등록한다 */
  | { type: 'register'; path: string }
  | { type: 'close' };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];

export function openFolder(from?: 'prompt'): { state: FolderState; effects: FolderEffect[] } {
  return { state: { text: '', listed: '', loading: true, row: -1, seed: true, ...(from ? { from } : {}) }, effects: [{ type: 'list', path: '' }] };
}

/** 입력의 폴더 부분: 끝이 /면 그 폴더, 아니면 마지막 / 앞(뿌리는 /). / 가 없으면 빈 경로(홈)다 */
export function dirOf(text: string): string {
  const at = text.lastIndexOf('/');
  if (at < 0) return '';
  if (at === 0) return '/';
  return text.slice(0, at);
}

/** 입력의 마지막 / 뒤(하위 폴더를 거를 앞부분) */
function partOf(text: string): string {
  return text.slice(text.lastIndexOf('/') + 1);
}

/** 쓴 앞부분으로 거른 하위 폴더. 목록을 받는 중이거나 다른 폴더의 목록이면 비어 있다 */
export function folderMatches(state: FolderState): FolderChildView[] {
  if (state.loading || !state.listing || state.listed !== dirOf(state.text)) return [];
  const part = partOf(state.text).toLowerCase();
  return state.listing.children.filter((child) => child.name.toLowerCase().startsWith(part));
}

/** 받은 목록을 넣는다. 처음 연 뒤(아직 치지 않은 빈 입력)에만 그 폴더 경로로 입력 칸을 채운다. 사람이 비운 칸은 그대로 둔다(#945) */
export function applyListing(state: FolderState, requested: string, listing: FolderListingView): FolderState {
  if (requested !== state.listed) return state;
  if (state.text === '' && state.seed) {
    const text = listing.path === '/' ? '/' : `${listing.path}/`;
    return { ...state, text, listing, listed: dirOf(text), loading: false, error: undefined, row: -1, seed: undefined };
  }
  return { ...state, listing, loading: false, error: undefined };
}

/** 목록을 받지 못했다 */
export function listingFailed(state: FolderState, requested: string, error: string): FolderState {
  if (requested !== state.listed) return state;
  return { ...state, listing: undefined, loading: false, error };
}

/**
 * 채워진 경로 뒤에 새 경로를 쓰기 시작했으면 새 경로만 남긴다(#945): `…/me//private` → `/private`, `…/me/~/blog` → `~/blog`.
 * 편집기의 파일 열기 칸과 같다. 맨 앞의 `//`는 그대로 둔다
 */
export function restartPath(text: string): string {
  const tilde = Math.max(text.lastIndexOf('/~/'), text.endsWith('/~') ? text.length - 2 : -1);
  const slashes = text.lastIndexOf('//');
  if (tilde > 0 && tilde + 1 > slashes) return text.slice(tilde + 1);
  if (slashes > 0) return text.slice(slashes + 1);
  return text;
}

/** 입력이 바뀌었다: 고른 줄을 풀고, 폴더 부분이 바뀌었으면 그 목록을 청한다 */
function retype(state: FolderState, typed: string, effects: FolderEffect[]): FolderState {
  const text = restartPath(typed);
  const next: FolderState = { ...state, text, row: -1, error: undefined, seed: undefined };
  const dir = dirOf(text);
  if (dir === state.listed) return next;
  effects.push({ type: 'list', path: dir });
  return { ...next, listed: dir, loading: true };
}

/** 여러 이름이 함께 가진 앞부분 */
function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    while (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/** 이 하위 폴더로 들어간다: 입력의 폴더 부분은 사람이 쓴 꼴(~ 등) 그대로 두고 이름을 잇는다 */
function enter(state: FolderState, child: FolderChildView, effects: FolderEffect[]): FolderState {
  const head = state.text.slice(0, state.text.lastIndexOf('/') + 1);
  return retype(state, `${head}${child.name}/`, effects);
}

/** 이 경로로 열 때 넘길 값: 끝의 /는 뗀다(뿌리 /는 그대로) */
function target(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

/** 이 제안으로 등록할 수 있는가: 이미 등록했거나, studio.yaml이 있거나, 만들 파일이 있어야 한다 */
export function registrable(proposal: FolderProposalView): boolean {
  return proposal.registeredId !== undefined || proposal.detection.hasSpec || proposal.files.length > 0;
}

/** 키 하나. state가 undefined면 화면을 닫았다 */
export function folderKey(state: FolderState, key: string): { state: FolderState | undefined; effects: FolderEffect[] } {
  const effects: FolderEffect[] = [];
  if (state.sending) return { state, effects };

  if (state.proposal) {
    const proposal = state.proposal;
    if (key === ESC) return { state: { ...state, proposal: undefined }, effects };
    if ((key === 'y' || key === 'Y' || ENTER.includes(key)) && registrable(proposal)) {
      effects.push({ type: 'register', path: proposal.detection.folder });
      return { state: { ...state, sending: true }, effects };
    }
    return { state, effects };
  }

  if (key === ESC || key === '\x03') {
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  const matches = folderMatches(state);
  if (UP.includes(key)) return { state: { ...state, row: Math.max(-1, state.row - 1) }, effects };
  if (DOWN.includes(key)) return { state: { ...state, row: Math.min(matches.length - 1, state.row + 1) }, effects };
  if (key === '\t') {
    const picked = matches[state.row];
    if (picked) return { state: enter(state, picked, effects), effects };
    if (matches.length === 1) return { state: enter(state, matches[0]!, effects), effects };
    const common = commonPrefix(matches.map((child) => child.name));
    if (common.length > partOf(state.text).length) {
      const head = state.text.slice(0, state.text.lastIndexOf('/') + 1);
      return { state: retype(state, head + common, effects), effects };
    }
    return { state, effects };
  }
  if (ENTER.includes(key)) {
    const picked = matches[state.row];
    const path = picked ? picked.path : target(state.text);
    if (!path) return { state, effects };
    effects.push({ type: 'propose', path });
    return { state: { ...state, sending: true, error: undefined }, effects };
  }
  if (BACKSPACE.includes(key)) return { state: retype(state, Array.from(state.text).slice(0, -1).join(''), effects), effects };
  if (key === '\x15') return { state: retype(state, '', effects), effects };
  if (key.startsWith(ESC) || key.length === 0 || /[\u0000-\u001f\u007f]/.test(key)) return { state, effects };
  return { state: retype(state, state.text + key, effects), effects };
}

/** 붙여 넣은 경로: 줄바꿈과 제어 글자는 버리고 한 줄로 잇는다 */
export function folderPaste(state: FolderState, text: string): { state: FolderState; effects: FolderEffect[] } {
  const effects: FolderEffect[] = [];
  if (state.sending || state.proposal) return { state, effects };
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!clean) return { state, effects };
  return { state: retype(state, state.text + clean, effects), effects };
}

const HINT_LABEL: Record<string, string> = {
  git: 'git',
  nextjs: 'Next.js',
  vite: 'Vite',
  'spring-boot': 'Spring Boot',
  fastapi: 'FastAPI',
  compose: 'compose',
  'studio-yaml': 'studio.yaml',
  registered: '등록됨',
};

function browsePane(state: FolderState, width: number, height: number, theme: Theme): { lines: string[]; cursor?: { x: number; y: number } } {
  const muted = fg(theme, 'muted');
  const head = ' 경로> ';
  let text = state.text;
  while (text && stringWidth(head + text) > width - 1) text = Array.from(text).slice(1).join('');
  const lines: string[] = [fitAnsi(`${BOLD}${head}${RESET}${text}`, width), ''];
  const cursor = { x: stringWidth(head + text), y: 0 };
  if (state.error) lines.push(fitAnsi(`${fg(theme, 'red')} ${state.error}${RESET}`, width));
  else if (state.loading) lines.push(fitAnsi(`${muted} 폴더를 읽는 중…${RESET}`, width));
  else if (state.listing) {
    const matches = folderMatches(state);
    const total = state.listing.truncated ? `${state.listing.children.length}/${state.listing.totalCount}` : String(state.listing.children.length);
    lines.push(fitAnsi(`${muted} ${state.listing.path} · 하위 폴더 ${total}${matches.length !== state.listing.children.length ? ` · 맞는 것 ${matches.length}` : ''}${RESET}`, width));
    const room = Math.max(1, height - lines.length);
    const offset = Math.max(0, Math.min(state.row - room + 1, matches.length - room));
    for (const [index, child] of matches.slice(offset, offset + room).entries()) {
      const selected = offset + index === state.row;
      const hints = child.hints.map((hint) => HINT_LABEL[hint] ?? hint).join(' · ');
      const name = `${selected ? `${fg(theme, 'accent')}▸ ${BOLD}` : '  '}${child.name}${child.hasChildren ? '/' : ''}${RESET}`;
      lines.push(fitAnsi(` ${name}${hints ? `  ${fg(theme, child.hints.includes('registered') ? 'teal' : 'muted')}${hints}${RESET}` : ''}`, width));
    }
    if (matches.length === 0) lines.push(fitAnsi(`${muted}  맞는 하위 폴더가 없습니다. Enter면 쓴 경로를 엽니다${RESET}`, width));
  }
  return { lines, cursor };
}

function proposalPane(state: FolderState, proposal: FolderProposalView, width: number, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const { detection } = proposal;
  const lines = [fitAnsi(` ${BOLD}${fg(theme, 'text')}${detection.name}${RESET}  ${muted}${detection.folder}${RESET}`, width), ''];
  if (proposal.registeredId !== undefined) lines.push(fitAnsi(`${fg(theme, 'teal')} 이미 등록한 폴더입니다(${proposal.registeredId}). 그대로 엽니다${RESET}`, width));
  else if (detection.hasSpec) lines.push(fit(' studio.yaml이 있어 그대로 씁니다(아무 파일도 만들지 않습니다)', width));
  const services = detection.services.map((service) => `${service.name}(${service.template}${service.port ? `, :${service.port}` : ''}${service.path !== '.' ? `, ${service.path}` : ''})`);
  if (services.length) lines.push(fit(` 서비스: ${services.join(' · ')}`, width));
  if (detection.infra.length) {
    const on = new Set(detection.defaultInfra);
    lines.push(fit(` 부가 서비스: ${detection.infra.map((service) => `${service.name}${on.has(service.name) ? '' : '(기본으로 끔)'}`).join(' · ')}`, width));
  }
  if (proposal.files.length) lines.push(fit(` 만들 파일: ${proposal.files.map((file) => file.path).join(' · ')} (git 추적에서 뺍니다)`, width));
  for (const warning of detection.warnings) lines.push(fitAnsi(`${fg(theme, 'yellow')} ▲ ${warning}${RESET}`, width));
  lines.push('');
  if (state.sending) lines.push(fitAnsi(`${muted} 등록하는 중…${RESET}`, width));
  else if (registrable(proposal)) lines.push(fitAnsi(`${fg(theme, 'accent')} y · Enter 등록하고 열기${RESET}${muted} · Esc 경로로 돌아가기${RESET}`, width));
  else lines.push(fitAnsi(`${fg(theme, 'red')} 이 폴더는 등록할 수 없습니다(돌릴 서비스도 studio.yaml도 없습니다)${RESET}${muted} · Esc 경로로 돌아가기${RESET}`, width));
  return lines;
}

export function renderFolder(state: FolderState, size: { w: number; h: number }, theme: Theme): { lines: string[]; cursor?: { x: number; y: number } } {
  const inner = { w: Math.max(0, size.w - 4), h: Math.max(0, size.h - 2) };
  let body: string[];
  let cursor: { x: number; y: number } | undefined;
  if (state.proposal) body = proposalPane(state, state.proposal, inner.w, theme);
  else {
    const pane = browsePane(state, inner.w, inner.h, theme);
    body = pane.lines;
    cursor = pane.cursor;
    if (state.sending) body.push('', fitAnsi(`${fg(theme, 'muted')} 폴더를 살피는 중…${RESET}`, inner.w));
  }
  const rows = Array.from({ length: inner.h }, (_, y) => body[y] ?? '');
  const lines = box(rows, size.w, theme, { title: '폴더 열기(프로젝트로 등록)', focused: true });
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  const at = cursor && cursor.y < inner.h && !state.sending ? { x: 2 + Math.min(cursor.x, inner.w - 1), y: 1 + cursor.y } : undefined;
  return { lines: lines.slice(0, size.h).map((line) => fitAnsi(line, size.w)), ...(at ? { cursor: at } : {}) };
}

export function folderHint(state: FolderState): string {
  if (state.proposal) return ' 폴더 열기 · y·Enter 등록 · Esc 돌아가기';
  return ' 폴더 열기 · 경로 쓰기(~ 됨) · Enter 이 폴더 열기 · Tab 채우기 · ↑↓ 하위 폴더 · Ctrl-u 지우기 · Esc 닫기';
}

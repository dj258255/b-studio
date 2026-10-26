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
    /** 지원 스택이 아닐 때만 있다(#946): 코드·테스트만으로 등록하는 제안. 옛 스튜디오는 주지 않는다 */
    workspace?: WorkspaceSuggestionView;
  };
  files: Array<{ path: string }>;
  registeredId?: string;
}

/** 코드·테스트만 등록 제안(스튜디오의 WorkspaceSuggestion에서 쓰는 것) */
export interface WorkspaceSuggestionView {
  language: string;
  image: string;
  candidates: Array<{ label: string; source: string; command: string[] }>;
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
  /** 코드·테스트만 등록(#946)에서 고른 줄. 후보 수와 같으면 직접 쓰기 줄이다. 없으면 첫 줄(후보가 없으면 직접 쓰기) */
  pick?: number;
  /** 직접 쓰기 줄에 친 테스트 명령 */
  custom?: string;
}

export type FolderEffect =
  /** 이 폴더의 하위 폴더를 받는다. 빈 경로는 홈이다 */
  | { type: 'list'; path: string }
  /** 이 폴더를 열면 무엇을 할지 묻는다(아직 쓰지 않는다) */
  | { type: 'propose'; path: string }
  /** 파일을 쓰고 등록한다. workspace는 코드·테스트만 등록(#946)에서 고른 테스트 명령이다 */
  | { type: 'register'; path: string; workspace?: { test: string[] } }
  | { type: 'close' };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];

export function openFolder(from?: 'prompt'): { state: FolderState; effects: FolderEffect[] } {
  return { state: { text: '', listed: '', loading: true, row: -1, ...(from ? { from } : {}) }, effects: [{ type: 'list', path: '' }] };
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

/** 받은 목록을 넣는다. 처음(빈 입력)이면 그 폴더 경로로 입력 칸을 채운다 */
export function applyListing(state: FolderState, requested: string, listing: FolderListingView): FolderState {
  if (requested !== state.listed) return state;
  if (state.text === '') {
    const text = listing.path === '/' ? '/' : `${listing.path}/`;
    return { ...state, text, listing, listed: dirOf(text), loading: false, error: undefined, row: -1 };
  }
  return { ...state, listing, loading: false, error: undefined };
}

/** 목록을 받지 못했다 */
export function listingFailed(state: FolderState, requested: string, error: string): FolderState {
  if (requested !== state.listed) return state;
  return { ...state, listing: undefined, loading: false, error };
}

/** 입력이 바뀌었다: 고른 줄을 풀고, 폴더 부분이 바뀌었으면 그 목록을 청한다 */
function retype(state: FolderState, text: string, effects: FolderEffect[]): FolderState {
  const next: FolderState = { ...state, text, row: -1, error: undefined };
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

/** 코드·테스트만 등록을 고를 단계인가(#946): 바로 등록할 수 없고 스튜디오가 제안을 줬다 */
function workspaceOf(proposal: FolderProposalView): WorkspaceSuggestionView | undefined {
  return registrable(proposal) ? undefined : proposal.detection.workspace;
}

/** 고른 줄. 후보가 없으면 직접 쓰기 줄(0)이다 */
function pickOf(state: FolderState, workspace: WorkspaceSuggestionView): number {
  return Math.min(state.pick ?? 0, workspace.candidates.length);
}

/** 고른 테스트 명령. 직접 쓰기 줄이면 sh -c 꼴, 비었으면 없다 */
function chosenTest(state: FolderState, workspace: WorkspaceSuggestionView): string[] | undefined {
  const pick = pickOf(state, workspace);
  const candidate = workspace.candidates[pick];
  if (candidate) return candidate.command;
  const text = (state.custom ?? '').trim();
  return text ? ['sh', '-c', text] : undefined;
}

/** 코드·테스트만 등록 단계의 키 */
function workspaceKey(state: FolderState, proposal: FolderProposalView, workspace: WorkspaceSuggestionView, key: string, effects: FolderEffect[]): FolderState {
  const pick = pickOf(state, workspace);
  const onCustom = pick === workspace.candidates.length;
  if (UP.includes(key)) return { ...state, pick: Math.max(0, pick - 1) };
  if (DOWN.includes(key)) return { ...state, pick: Math.min(workspace.candidates.length, pick + 1) };
  if (ENTER.includes(key) || (!onCustom && (key === 'y' || key === 'Y'))) {
    const test = chosenTest(state, workspace);
    if (!test) return state;
    effects.push({ type: 'register', path: proposal.detection.folder, workspace: { test } });
    return { ...state, sending: true };
  }
  if (!onCustom) return state;
  const custom = state.custom ?? '';
  if (BACKSPACE.includes(key)) return { ...state, custom: Array.from(custom).slice(0, -1).join('') };
  if (key === '\x15') return { ...state, custom: '' };
  if (key.startsWith(ESC) || key.length === 0 || /[\u0000-\u001f\u007f]/.test(key)) return state;
  return { ...state, custom: custom + key };
}

/** 키 하나. state가 undefined면 화면을 닫았다 */
export function folderKey(state: FolderState, key: string): { state: FolderState | undefined; effects: FolderEffect[] } {
  const effects: FolderEffect[] = [];
  if (state.sending) return { state, effects };

  if (state.proposal) {
    const proposal = state.proposal;
    if (key === ESC) return { state: { ...state, proposal: undefined, pick: undefined, custom: undefined }, effects };
    const workspace = workspaceOf(proposal);
    if (workspace) return { state: workspaceKey(state, proposal, workspace, key, effects), effects };
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
  if (state.sending) return { state, effects };
  const workspace = state.proposal ? workspaceOf(state.proposal) : undefined;
  if (state.proposal) {
    // 코드·테스트만 등록의 직접 쓰기 줄이면 붙여 넣은 명령을 한 줄로 넣는다(#946)
    if (!workspace || pickOf(state, workspace) !== workspace.candidates.length) return { state, effects };
    const command = text.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return { state: { ...state, custom: `${state.custom ?? ''}${command}` }, effects };
  }
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
  const workspace = workspaceOf(proposal);
  // 코드·테스트만 등록 단계는 "찾지 못했다"는 경고를 아래 안내가 대신한다
  if (!workspace) for (const warning of detection.warnings) lines.push(fitAnsi(`${fg(theme, 'yellow')} ▲ ${warning}${RESET}`, width));
  if (workspace) {
    lines.push(...workspacePane(state, workspace, width, theme));
    return lines;
  }
  lines.push('');
  if (state.sending) lines.push(fitAnsi(`${muted} 등록하는 중…${RESET}`, width));
  else if (registrable(proposal)) lines.push(fitAnsi(`${fg(theme, 'accent')} y · Enter 등록하고 열기${RESET}${muted} · Esc 경로로 돌아가기${RESET}`, width));
  else lines.push(fitAnsi(`${fg(theme, 'red')} 이 폴더는 등록할 수 없습니다(돌릴 서비스도 studio.yaml도 없습니다)${RESET}${muted} · Esc 경로로 돌아가기${RESET}`, width));
  return lines;
}

/** 코드·테스트만 등록 단계(#946): 테스트 명령 고르기와 게이트가 확인하는 것 */
function workspacePane(state: FolderState, workspace: WorkspaceSuggestionView, width: number, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const accent = fg(theme, 'accent');
  const pick = pickOf(state, workspace);
  const lines = [
    ...wrapWords('Next.js·Vite·Spring Boot·FastAPI 앱이 아니어서 코드·테스트만으로 등록할 수 있습니다', width).map((line) => fitAnsi(`${fg(theme, 'teal')}${line}${RESET}`, width)),
    fitAnsi(`${muted} 언어 ${workspace.language} · 컨테이너 ${workspace.image}${RESET}`, width),
    '',
    fit(' 게이트가 완료를 확인할 테스트 명령을 고르세요', width),
  ];
  const labelWidth = Math.max(10, ...workspace.candidates.map((candidate) => stringWidth(candidate.label)));
  for (const [index, candidate] of workspace.candidates.entries()) {
    const selected = index === pick;
    const label = candidate.label + ' '.repeat(Math.max(0, labelWidth - stringWidth(candidate.label)));
    lines.push(fitAnsi(` ${selected ? `${accent}▸ ${BOLD}` : '  '}${label}${RESET}  ${muted}${candidate.source}${RESET}`, width));
  }
  const onCustom = pick === workspace.candidates.length;
  lines.push(fitAnsi(` ${onCustom ? `${accent}▸ ${BOLD}` : '  '}직접 쓰기>${RESET} ${state.custom ?? ''}${onCustom ? `${accent}▏${RESET}` : ''}`, width));
  lines.push('');
  if (state.sending) lines.push(fitAnsi(`${muted} 등록하는 중…${RESET}`, width));
  else if (chosenTest(state, workspace)) lines.push(fitAnsi(`${accent} ${onCustom ? 'Enter' : 'y·Enter'} 이 명령으로 등록${RESET}${muted} · ↑↓ 고르기 · Esc 돌아가기${RESET}`, width));
  else lines.push(fitAnsi(`${muted} 테스트 명령을 쓰면 등록할 수 있습니다 · ↑↓ 고르기 · Esc 돌아가기${RESET}`, width));
  lines.push('');
  for (const line of wrapWords('게이트가 확인하는 것: 고른 테스트 명령(종료 코드 0이어야 통과)과 시크릿 같은 공통 검사. 띄울 서비스가 없어 화면·API 확인은 하지 않습니다', width)) lines.push(fitAnsi(`${muted}${line}${RESET}`, width));
  for (const line of wrapWords('만들 파일: studio.yaml · compose.b-studio.yaml · Dockerfile.b-studio (git 추적에서 뺍니다)', width)) lines.push(fitAnsi(`${muted}${line}${RESET}`, width));
  return lines;
}

/** 낱말 사이에서 줄을 나눈다. 줄마다 앞에 빈칸 하나를 둔다(다른 줄과 들여쓰기를 맞춘다) */
function wrapWords(text: string, width: number): string[] {
  const room = Math.max(10, width - 1);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && stringWidth(next) > room) {
      lines.push(` ${line}`);
      line = word;
    } else line = next;
  }
  if (line) lines.push(` ${line}`);
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
  if (state.proposal && workspaceOf(state.proposal)) return ' 폴더 열기 · ↑↓ 테스트 명령 고르기 · y·Enter 등록 · Esc 돌아가기';
  if (state.proposal) return ' 폴더 열기 · y·Enter 등록 · Esc 돌아가기';
  return ' 폴더 열기 · 경로 쓰기(~ 됨) · Enter 이 폴더 열기 · Tab 채우기 · ↑↓ 하위 폴더 · Ctrl-u 지우기 · Esc 닫기';
}

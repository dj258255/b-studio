/**
 * 실행·배포·미리보기·저장소 화면(#895, 앞글쇠 다음 v): 웹 세션 화면의 실행·화면·저장소 탭이 하던 일을 터미널로 옮긴다.
 *
 * 고른 세션 하나의 이벤트(`/api/sessions/:id/events`)를 받아 서비스 상태·로그·자원·배포 진행을 접고(applyRuntimeEvent),
 * 키(runtimeKey)는 화면 상태만 바꾸고 할 일(RuntimeEffect)을 돌려준다. 스튜디오를 부르는 일은 desk.ts가 한다.
 * 브라우저가 있어야 보이는 것(앱 화면, 원격 브라우저, 디자인 비교, 요소 고르기)은 주소만 보이고 시스템 브라우저로 연다
 * QA 탭(#916)은 탐색형 QA다: 목표 문장을 주면 스튜디오가 AI로 앱 화면을 눌러 보며 문제를 찾는다. 화면 사진은 주소로만 보이고 브라우저로 연다
 */
import { fit, fitAnsi, stringWidth } from './screen';
import { bg, BOLD, fg, RESET, type ColorToken, type Theme } from './theme';
import { bar, box } from './widgets';
import type { DeskDeployStatus, DeskPull, DeskQaRun, DeskQaStart, DeskRepoList, DeskService, DeskServiceState, DeskSessionEvent, DeskSessionView, DeskSubmission } from './types';

export type RuntimeTab = 'services' | 'logs' | 'deploy' | 'preview' | 'repo' | 'qa';

export const RUNTIME_TABS: ReadonlyArray<{ tab: RuntimeTab; label: string }> = [
  { tab: 'services', label: '실행' },
  { tab: 'logs', label: '로그' },
  { tab: 'deploy', label: '배포' },
  { tab: 'preview', label: '미리보기' },
  { tab: 'repo', label: '저장소' },
  { tab: 'qa', label: 'QA' },
];

/** 쌓아 두는 로그 줄 수. 웹 화면(LOG_LIMIT)과 같다 */
export const RUNTIME_LOG_LIMIT = 1000;
/** 배포 진행 줄 수. 스튜디오의 DEPLOY_LOG_LIMIT와 같다 */
const DEPLOY_LINES = 200;
const TAB_WIDTH = 13;

export interface RuntimeLog {
  service: string;
  text: string;
  at: string;
}

export type RepoView = 'presubmit' | 'issues' | 'pulls';

export type RuntimeConfirm =
  | { kind: 'service'; service: string; on: boolean }
  | { kind: 'deploy'; sha: string; shortSha: string; label: string }
  | { kind: 'rollback'; releaseId: string; label: string }
  /** 끝난 탐색형 QA를 studio.yaml의 화면 확인으로 덧붙일지 */
  | { kind: 'qa-save'; service: string };

/** 탐색형 QA 탭(#916) */
export interface RuntimeQa {
  /** 마지막 실행. null이면 돌린 적이 없고, undefined면 아직 받지 않았다 */
  run?: DeskQaRun | null;
  loading?: boolean;
  error?: string;
  /** 새 실행의 입력. service는 화면이 있는 서비스(previewServices) 중 몇 번째인지 */
  form?: { service: number; goal: string; startPath: string; confirmText: string; field: 'goal' | 'path' | 'confirm' };
  /** 시작을 보내 놓고 답을 기다린다 */
  starting?: boolean;
}

export interface RuntimeState {
  /** 세션 id와 머리에 보일 이름 */
  id: string;
  title: string;
  tab: RuntimeTab;
  /** 지금 탭에서 고른 줄 */
  row: number;
  /** 세션 이벤트를 아직 받지 못했다(스냅샷 전) */
  snapshot?: DeskSessionView;
  /** 이벤트 통로를 열지 못했거나 끊겼다 */
  error?: string;
  logs: RuntimeLog[];
  /** 이 서비스의 로그만 본다 */
  logService?: string;
  /** 로그에서 찾는 글. editing이면 아직 쓰는 중이다 */
  search?: { text: string; editing: boolean };
  /** 로그를 아래에서 몇 줄 올려 보는지. 0이면 새 줄을 따라간다 */
  scroll: number;
  deploy: { status?: DeskDeployStatus; loading?: boolean; error?: string; result?: string };
  /** 서비스마다 받은 미리보기 주소 */
  previews: Record<string, { url?: string; loading?: boolean; error?: string }>;
  repo: { view: RepoView; state: 'open' | 'closed'; submission?: DeskSubmission; issues?: DeskRepoList; pulls?: DeskRepoList; loading?: boolean; error?: string };
  confirm?: RuntimeConfirm;
  /** 아래 줄에 잠깐 보일 알림 */
  note?: string;
  /** 탐색형 QA 탭(#916). 처음 들어갈 때 마지막 실행을 받는다 */
  qa?: RuntimeQa;
}

export type RuntimeEffect =
  | { type: 'close' }
  | { type: 'load-deploys' }
  | { type: 'deploy'; sha: string }
  | { type: 'rollback'; releaseId: string }
  | { type: 'service'; service: string; on: boolean }
  | { type: 'boot' }
  /** 미리보기 주소를 받는다. open이면 받은 뒤 브라우저로 연다 */
  | { type: 'preview'; service: string; open: boolean }
  | { type: 'open-url'; url: string }
  | { type: 'load-repo'; view: RepoView; state: 'open' | 'closed' }
  /** 탐색형 QA(#916): 마지막 실행 받기, 시작, 멈추기, 화면 확인으로 저장, 그 동작의 화면 사진 열기 */
  | { type: 'qa-load' }
  | { type: 'qa-start'; input: DeskQaStart }
  | { type: 'qa-stop' }
  | { type: 'qa-save'; service: string }
  | { type: 'qa-artifact'; artifact: string };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const SHIFT_TAB = '\x1b[Z';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];
const LEFT = ['\x1b[D', '\x1bOD'];
const RIGHT = ['\x1b[C', '\x1bOC'];

export function openRuntime(id: string, title: string): RuntimeState {
  return { id, title, tab: 'services', row: 0, logs: [], scroll: 0, deploy: {}, previews: {}, repo: { view: 'presubmit', state: 'open' } };
}

// ─── 이벤트 접기 ───

function patchSnapshot(state: RuntimeState, patch: Partial<DeskSessionView>): RuntimeState {
  if (!state.snapshot) return state;
  return { ...state, snapshot: { ...state.snapshot, ...patch } };
}

/** 세션 이벤트 하나를 접는다. 이 화면이 쓰지 않는 이벤트면 받은 상태를 그대로 돌려준다 */
export function applyRuntimeEvent(state: RuntimeState, event: DeskSessionEvent): RuntimeState {
  const snapshot = state.snapshot;
  switch (event.type) {
    case 'snapshot': {
      // 다시 연결하면 스튜디오가 스냅샷부터 기록 전체를 다시 보낸다. 로그를 처음부터 받는다
      const next = (event as { snapshot: DeskSessionView }).snapshot;
      return { ...state, snapshot: { ...next, services: next.services ?? [], checkpoints: next.checkpoints ?? [] }, logs: [], error: undefined };
    }
    case 'status': {
      const { status, error } = event as { status: string; error?: string };
      return patchSnapshot(state, { status, error });
    }
    case 'service': {
      if (!snapshot) return state;
      const change = event as { service: string; state: DeskServiceState; url?: string; previewUrl?: string; detail?: string };
      const services = snapshot.services.map((service): DeskService => {
        if (service.name !== change.service) return service;
        // 다시 띄우는 동안에는 앞 주소를 두고, 멈추면 주소를 지운다
        const stopped = change.state === 'stopped';
        const next: DeskService = { ...service, state: change.state };
        delete next.url;
        delete next.previewUrl;
        delete next.detail;
        const url = stopped ? undefined : (change.url ?? service.url);
        const previewUrl = stopped ? undefined : (change.previewUrl ?? service.previewUrl);
        if (url) next.url = url;
        if (previewUrl) next.previewUrl = previewUrl;
        if (change.detail) next.detail = change.detail;
        return next;
      });
      // 주소가 바뀌었을 수 있다. 받아 둔 미리보기 주소를 버린다
      const previews = { ...state.previews };
      delete previews[change.service];
      return { ...state, snapshot: { ...snapshot, services }, previews };
    }
    case 'log': {
      const { service, text, at } = event as RuntimeLog;
      const logs = state.logs.length >= RUNTIME_LOG_LIMIT ? state.logs.slice(state.logs.length - RUNTIME_LOG_LIMIT + 1) : [...state.logs];
      logs.push({ service, text, at });
      // 올려 보는 중이면 보던 줄이 그대로 보이게 한 줄 더 올린다
      return { ...state, logs, scroll: state.scroll > 0 ? state.scroll + 1 : 0 };
    }
    case 'usage': {
      const { at, services } = event as { at: string; services: NonNullable<DeskSessionView['usage']>['services'] };
      return patchSnapshot(state, { usage: { at, services } });
    }
    case 'sandbox_link': {
      const { link } = event as { link?: DeskSessionView['sandboxLink'] };
      if (!snapshot) return state;
      const next = { ...snapshot };
      if (link) next.sandboxLink = link;
      else delete next.sandboxLink;
      return { ...state, snapshot: next };
    }
    case 'checkpoint': {
      const { checkpoint } = event as { checkpoint: DeskSessionView['checkpoints'][number] };
      if (!snapshot) return state;
      return { ...state, snapshot: { ...snapshot, checkpoints: [checkpoint, ...snapshot.checkpoints] } };
    }
    case 'deploy_started': {
      const { action, target, at } = event as { action: 'deploy' | 'rollback'; target: string; at: string };
      return { ...patchSnapshot(state, { deploying: { action, target, startedAt: at, lines: [] } }), deploy: { ...state.deploy, result: undefined } };
    }
    case 'deploy_log': {
      const deploying = snapshot?.deploying;
      if (!deploying) return state;
      const { line } = event as { line: string };
      return patchSnapshot(state, { deploying: { ...deploying, lines: [...deploying.lines.slice(-(DEPLOY_LINES - 1)), line] } });
    }
    case 'deploy_finished': {
      const { action, label } = event as { action: 'deploy' | 'rollback'; label: string };
      const result = action === 'deploy' ? `배포했습니다: ${label}` : `되돌렸습니다: ${label}`;
      return { ...patchSnapshot(state, { deploying: undefined }), deploy: { ...state.deploy, result } };
    }
    case 'deploy_failed': {
      const { action, error } = event as { action: 'deploy' | 'rollback'; error: string };
      return { ...patchSnapshot(state, { deploying: undefined }), deploy: { ...state.deploy, result: `${action === 'deploy' ? '배포' : '되돌리기'}에 실패했습니다: ${error}` } };
    }
    default:
      return state;
  }
}

// ─── 키 ───

/** 미리보기 탭에 놓을 서비스: 화면이 있는(browser) 서비스 */
export function previewServices(state: RuntimeState): DeskService[] {
  return (state.snapshot?.services ?? []).filter((service) => service.preview === 'browser');
}

/** 로그 탭에 보일 줄(서비스·찾는 글로 거른 것) */
export function visibleLogs(state: RuntimeState): RuntimeLog[] {
  const needle = state.search?.text.toLowerCase();
  return state.logs.filter((log) => (!state.logService || log.service === state.logService) && (!needle || log.text.toLowerCase().includes(needle)));
}

function releases(state: RuntimeState) {
  return state.deploy.status?.state.releases ?? [];
}

function repoItems(state: RuntimeState): Array<{ url: string }> {
  if (state.repo.view === 'issues') return state.repo.issues?.issues ?? [];
  if (state.repo.view === 'pulls') return state.repo.pulls?.pulls ?? [];
  return state.repo.submission?.items.map(() => ({ url: '' })) ?? [];
}

function rowCount(state: RuntimeState): number {
  switch (state.tab) {
    case 'services':
      return state.snapshot?.services.length ?? 0;
    case 'deploy':
      return releases(state).length;
    case 'preview':
      return previewServices(state).length;
    case 'repo':
      return repoItems(state).length;
    case 'qa':
      return state.qa?.run?.actions.length ?? 0;
    default:
      return 0;
  }
}

/** 탭에 들어갈 때 할 일: 처음 보는 배포·저장소는 불러오고, 미리보기는 아직 받지 않은 주소를 받는다 */
function enterTab(state: RuntimeState, tab: RuntimeTab, effects: RuntimeEffect[]): RuntimeState {
  const next: RuntimeState = { ...state, tab, row: 0, confirm: undefined, note: undefined, search: state.search?.editing ? undefined : state.search };
  if (tab === 'deploy' && !state.deploy.status && !state.deploy.loading) {
    effects.push({ type: 'load-deploys' });
    return { ...next, deploy: { ...state.deploy, loading: true } };
  }
  if (tab === 'repo') return loadRepoIfNeeded(next, effects);
  if (tab === 'qa' && state.qa?.run === undefined && !state.qa?.loading) {
    effects.push({ type: 'qa-load' });
    return { ...next, qa: { ...state.qa, loading: true } };
  }
  if (tab === 'preview') {
    for (const service of previewServices(state)) {
      if (service.state === 'ready' && !state.previews[service.name]) effects.push({ type: 'preview', service: service.name, open: false });
    }
  }
  return next;
}

function repoLoaded(state: RuntimeState): boolean {
  if (state.repo.view === 'presubmit') return state.repo.submission !== undefined;
  return (state.repo.view === 'issues' ? state.repo.issues : state.repo.pulls) !== undefined;
}

function loadRepoIfNeeded(state: RuntimeState, effects: RuntimeEffect[]): RuntimeState {
  if (repoLoaded(state) || state.repo.loading) return state;
  effects.push({ type: 'load-repo', view: state.repo.view, state: state.repo.state });
  return { ...state, repo: { ...state.repo, loading: true } };
}

/** 키 하나. state가 undefined면 화면을 닫았다 */
export function runtimeKey(start: RuntimeState, key: string): { state: RuntimeState | undefined; effects: RuntimeEffect[] } {
  const effects: RuntimeEffect[] = [];
  const state: RuntimeState = start.note ? { ...start, note: undefined } : start;

  if (state.confirm) {
    const confirm = state.confirm;
    const base = { ...state, confirm: undefined };
    if (key !== 'y' && key !== 'Y' && !ENTER.includes(key)) return { state: base, effects };
    if (confirm.kind === 'service') effects.push({ type: 'service', service: confirm.service, on: confirm.on });
    else if (confirm.kind === 'qa-save') effects.push({ type: 'qa-save', service: confirm.service });
    else if (confirm.kind === 'deploy') effects.push({ type: 'deploy', sha: confirm.sha });
    else effects.push({ type: 'rollback', releaseId: confirm.releaseId });
    return { state: base, effects };
  }

  if (state.search?.editing) {
    const text = state.search.text;
    if (key === ESC) return { state: { ...state, search: undefined, scroll: 0 }, effects };
    if (ENTER.includes(key)) return { state: { ...state, search: text ? { text, editing: false } : undefined, scroll: 0 }, effects };
    if (BACKSPACE.includes(key)) return { state: { ...state, search: { text: Array.from(text).slice(0, -1).join(''), editing: true } }, effects };
    if (key.startsWith(ESC) || key.length === 0 || /[\u0000-\u001f]/.test(key)) return { state, effects };
    return { state: { ...state, search: { text: text + key, editing: true } }, effects };
  }

  if (state.qa?.form) return { state: qaFormKey(state, key, effects), effects };

  if (key === ESC || key === 'q' || key === 'v') {
    // 로그에서 찾는 중이면 Esc는 찾기만 지운다
    if (key === ESC && state.tab === 'logs' && state.search) return { state: { ...state, search: undefined, scroll: 0 }, effects };
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  if (key === '\t' || key === SHIFT_TAB) {
    const at = RUNTIME_TABS.findIndex((entry) => entry.tab === state.tab);
    const next = RUNTIME_TABS[(at + (key === '\t' ? 1 : RUNTIME_TABS.length - 1)) % RUNTIME_TABS.length]!.tab;
    return { state: enterTab(state, next, effects), effects };
  }
  if (/^[1-6]$/.test(key)) {
    const next = RUNTIME_TABS[Number(key) - 1]!.tab;
    return { state: next === state.tab ? state : enterTab(state, next, effects), effects };
  }

  if (state.tab === 'logs') return { state: logsKey(state, key, effects), effects };

  const count = rowCount(state);
  if (UP.includes(key)) return { state: { ...state, row: Math.max(0, state.row - 1) }, effects };
  if (DOWN.includes(key)) return { state: { ...state, row: Math.max(0, Math.min(count - 1, state.row + 1)) }, effects };

  switch (state.tab) {
    case 'services':
      return { state: servicesKey(state, key, effects), effects };
    case 'deploy':
      return { state: deployKey(state, key, effects), effects };
    case 'preview':
      return { state: previewKey(state, key, effects), effects };
    case 'repo':
      return { state: repoKey(state, key, effects), effects };
    case 'qa':
      return { state: qaKey(state, key, effects), effects };
  }
  return { state, effects };
}

/** QA 탭의 키(폼 밖): n 새 실행, x 멈추기, s 저장(묻기), r 다시 받기, Enter·o 고른 동작의 화면 사진 */
function qaKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const run = state.qa?.run ?? undefined;
  if (key === 'r') {
    effects.push({ type: 'qa-load' });
    return { ...state, qa: { ...state.qa, loading: true } };
  }
  if (key === 'n') {
    if (run?.status === 'running' || state.qa?.starting) return { ...state, note: '탐색형 QA가 도는 중입니다. x로 멈춘 뒤 새로 시작합니다' };
    if (previewServices(state).length === 0) return { ...state, note: '화면이 있는 서비스가 없어 탐색형 QA를 돌릴 수 없습니다' };
    const last = run ? Math.max(0, previewServices(state).findIndex((service) => service.name === run.service)) : 0;
    return { ...state, qa: { ...state.qa, form: { service: last, goal: run?.goal.goal ?? '', startPath: run?.goal.startPath ?? '/', confirmText: run?.goal.confirmText ?? '', field: 'goal' } } };
  }
  if (key === 'x') {
    if (run?.status !== 'running') return { ...state, note: '도는 탐색형 QA가 없습니다' };
    effects.push({ type: 'qa-stop' });
    return { ...state, note: '멈추라고 알렸습니다' };
  }
  if (key === 's') {
    if (!run || run.status !== 'done') return { ...state, note: '끝난 탐색형 QA가 있어야 저장합니다' };
    if (run.actions.length === 0) return { ...state, note: '저장할 동작이 없습니다' };
    return { ...state, confirm: { kind: 'qa-save', service: run.service } };
  }
  if (key === 'o' || ENTER.includes(key)) {
    const action = run?.actions[state.row];
    if (!action) return state;
    if (!action.artifact) return { ...state, note: `${action.index}번째 동작에는 화면 사진이 없습니다` };
    effects.push({ type: 'qa-artifact', artifact: action.artifact });
  }
  return state;
}

/** 새 실행의 폼: Enter로 다음 칸(마지막 칸이면 시작), ↑↓로 칸 옮기기, ←→로 서비스, Esc로 그만두기 */
function qaFormKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const qa = state.qa!;
  const form = qa.form!;
  const fields = ['goal', 'path', 'confirm'] as const;
  const at = fields.indexOf(form.field);
  const services = previewServices(state);
  const set = (patch: Partial<typeof form>) => ({ ...state, note: undefined, qa: { ...qa, form: { ...form, ...patch } } });
  if (key === ESC || key === '\x03') return { ...state, qa: { ...qa, form: undefined } };
  if (UP.slice(0, 2).includes(key)) return set({ field: fields[Math.max(0, at - 1)]! });
  if (DOWN.slice(0, 2).includes(key)) return set({ field: fields[Math.min(fields.length - 1, at + 1)]! });
  if (LEFT.includes(key)) return set({ service: (form.service + services.length - 1) % Math.max(1, services.length) });
  if (RIGHT.includes(key)) return set({ service: (form.service + 1) % Math.max(1, services.length) });
  if (ENTER.includes(key)) {
    if (!form.goal.trim()) return { ...set({ field: 'goal' }), note: '무엇을 확인할지 목표를 써야 시작합니다' };
    if (form.field !== 'confirm') return set({ field: fields[at + 1]! });
    const service = services[form.service];
    if (!service) return { ...state, note: '화면이 있는 서비스가 없습니다' };
    const startPath = form.startPath.trim() || '/';
    effects.push({
      type: 'qa-start',
      input: { service: service.name, goal: form.goal.trim(), startPath: startPath.startsWith('/') ? startPath : `/${startPath}`, ...(form.confirmText.trim() ? { confirmText: form.confirmText.trim() } : {}) },
    });
    return { ...state, row: 0, qa: { ...qa, form: undefined, starting: true, error: undefined } };
  }
  const name = form.field === 'goal' ? 'goal' : form.field === 'path' ? 'startPath' : 'confirmText';
  if (BACKSPACE.includes(key)) return set({ [name]: Array.from(form[name]).slice(0, -1).join('') });
  if (key.startsWith(ESC) || key.length === 0 || /[\u0000-\u001f\u007f]/.test(key)) return state;
  return set({ [name]: form[name] + key });
}

const SLEEPING = new Set(['dormant', 'stopped', 'idle_stopped']);

function servicesKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const service = state.snapshot?.services[state.row];
  if (key === 'b') {
    const status = state.snapshot?.status ?? '';
    if (!SLEEPING.has(status)) return { ...state, note: '샌드박스가 이미 켜져 있거나 켜는 중입니다' };
    effects.push({ type: 'boot' });
    return { ...state, note: '샌드박스를 켜는 중입니다' };
  }
  if (!service) return state;
  if (key === 'l') return { ...state, tab: 'logs', row: 0, logService: service.name, scroll: 0 };
  if (key === 'o') {
    if (service.preview !== 'browser') return { ...state, note: `${service.name}에는 열어 볼 화면이 없습니다` };
    effects.push({ type: 'preview', service: service.name, open: true });
    return state;
  }
  if (key === ' ' || ENTER.includes(key)) {
    if (service.state === 'off') {
      effects.push({ type: 'service', service: service.name, on: true });
      return { ...state, note: `${service.name}를 켜는 중입니다` };
    }
    return { ...state, confirm: { kind: 'service', service: service.name, on: false } };
  }
  return state;
}

function logsKey(state: RuntimeState, key: string, _effects: RuntimeEffect[]): RuntimeState {
  const total = visibleLogs(state).length;
  const scrollBy = (by: number) => ({ ...state, scroll: Math.max(0, Math.min(Math.max(0, total - 1), state.scroll + by)) });
  if (key === '/') return { ...state, search: { text: '', editing: true } };
  if (UP.includes(key)) return scrollBy(1);
  if (DOWN.includes(key)) return scrollBy(-1);
  if (key === PAGE_UP) return scrollBy(10);
  if (key === PAGE_DOWN) return scrollBy(-10);
  if (key === 'G' || key === '\x1b[F' || key === '\x1b[4~') return { ...state, scroll: 0 };
  if (key === 'g' || key === '\x1b[H' || key === '\x1b[1~') return { ...state, scroll: Math.max(0, total - 1) };
  if (key === 's') {
    // 서비스를 하나씩 돌아가며 고르고, 끝 다음은 모두
    const names = (state.snapshot?.services ?? []).map((service) => service.name);
    const at = state.logService ? names.indexOf(state.logService) : -1;
    const next = names[at + 1];
    return { ...state, logService: next, scroll: 0 };
  }
  if (key === 'c') return { ...state, logService: undefined, search: undefined, scroll: 0 };
  return state;
}

function deployKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const snapshot = state.snapshot;
  if (key === 'r') {
    effects.push({ type: 'load-deploys' });
    return { ...state, deploy: { ...state.deploy, loading: true } };
  }
  if (key === 'o' || ENTER.includes(key)) {
    const url = Object.values(state.deploy.status?.urls ?? {})[0];
    if (!url) return { ...state, note: '운영 주소가 아직 없습니다' };
    effects.push({ type: 'open-url', url });
    return state;
  }
  if (key !== 'd' && key !== 'b') return state;
  if (!snapshot?.hasDeploy) return { ...state, note: '이 프로젝트의 studio.yaml에 deploy 절이 없습니다' };
  if (!snapshot.experimental) return { ...state, note: '운영 배포는 실험 기능입니다(B_STUDIO_EXPERIMENTAL=1로 띄우세요)' };
  if (snapshot.deploying) return { ...state, note: '배포가 도는 중입니다. 끝난 뒤에 하세요' };
  if (key === 'd') {
    const head = snapshot.checkpoints[0];
    if (!head) return { ...state, note: '배포할 체크포인트가 없습니다' };
    return { ...state, confirm: { kind: 'deploy', sha: head.sha, shortSha: head.shortSha, label: head.message } };
  }
  const release = releases(state)[state.row];
  if (!release || release.status !== 'previous') return { ...state, note: '되돌릴 이전 릴리스(이전)를 ↑↓로 고르세요' };
  return { ...state, confirm: { kind: 'rollback', releaseId: release.id, label: release.source.label } };
}

function previewKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const service = previewServices(state)[state.row];
  if (!service) return state;
  if (key === 'r') {
    effects.push({ type: 'preview', service: service.name, open: false });
    return { ...state, previews: { ...state.previews, [service.name]: { loading: true } } };
  }
  if (key !== 'o' && !ENTER.includes(key)) return state;
  if (service.state !== 'ready') return { ...state, note: `${service.name}가 아직 준비되지 않았습니다` };
  const url = state.previews[service.name]?.url;
  // 받아 둔 주소는 바로 연다. 게이트웨이 주소는 1회용이라 o는 늘 새로 받는다
  if (url && ENTER.includes(key) && !service.previewUrl) effects.push({ type: 'open-url', url });
  else effects.push({ type: 'preview', service: service.name, open: true });
  return state;
}

function repoKey(state: RuntimeState, key: string, effects: RuntimeEffect[]): RuntimeState {
  const views: Record<string, RepoView> = { c: 'presubmit', i: 'issues', p: 'pulls' };
  const view = views[key];
  // 받는 중 표시는 보는 목록마다다. 다른 목록으로 가면 그 목록을 따로 받는다
  if (view) return loadRepoIfNeeded({ ...state, row: 0, repo: { ...state.repo, view, error: undefined, loading: false } }, effects);
  if (key === 'x' && state.repo.view !== 'presubmit') {
    // 열린 것과 닫힌 것을 오간다. 목록을 다시 받는다
    const next = state.repo.state === 'open' ? 'closed' : 'open';
    effects.push({ type: 'load-repo', view: state.repo.view, state: next });
    return { ...state, row: 0, repo: { ...state.repo, state: next, loading: true } };
  }
  if (key === 'r') {
    effects.push({ type: 'load-repo', view: state.repo.view, state: state.repo.state });
    return { ...state, repo: { ...state.repo, loading: true } };
  }
  if ((key === 'o' || ENTER.includes(key)) && state.repo.view !== 'presubmit') {
    const url = repoItems(state)[state.row]?.url;
    if (url) effects.push({ type: 'open-url', url });
  }
  return state;
}

/** 붙여 넣은 글: 로그에서 찾는 글을 쓰는 중일 때만 받는다 */
export function runtimePaste(state: RuntimeState, text: string): RuntimeState {
  const form = state.qa?.form;
  if (form) {
    // QA 폼의 칸에는 한 줄로 넣는다
    const clean = text.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    const name = form.field === 'goal' ? 'goal' : form.field === 'path' ? 'startPath' : 'confirmText';
    return { ...state, qa: { ...state.qa, form: { ...form, [name]: form[name] + clean } } };
  }
  if (!state.search?.editing) return state;
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '');
  return { ...state, search: { text: state.search.text + clean, editing: true } };
}

// ─── 그리기 ───

/** 로그 줄의 색: 오류는 빨강, 경고는 노랑, 그 밖은 기본 */
export function logColor(text: string): ColorToken | undefined {
  if (/\b(ERROR|FATAL|SEVERE|PANIC)\b|Exception|Traceback|\berror:/i.test(text) && !/\b0 errors?\b/i.test(text)) return 'red';
  if (/\bWARN(ING)?\b/i.test(text)) return 'yellow';
  return undefined;
}

/** OSC 8 링크: 누를 수 있는 터미널에서 열린다. 링크 글은 주소 그대로다 */
function link(url: string): string {
  const safe = url.replace(/[\u0000-\u001f\u007f]/g, '');
  return `\x1b]8;;${safe}\x07${safe}\x1b]8;;\x07`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}

const SERVICE_STATE: Record<DeskServiceState, { label: string; color: ColorToken; mark: string }> = {
  starting: { label: '띄우는 중', color: 'yellow', mark: '◐' },
  probing: { label: '준비 확인 중', color: 'yellow', mark: '◐' },
  ready: { label: '준비됨', color: 'green', mark: '●' },
  failed: { label: '실패', color: 'red', mark: '×' },
  stopped: { label: '멈춤', color: 'muted', mark: '○' },
  off: { label: '꺼 둠', color: 'muted', mark: '○' },
};

const SESSION_STATUS: Record<string, string> = {
  ready: '켜짐',
  booting: '켜는 중',
  dormant: '잠듦(b로 켜기)',
  stopped: '멈춤(b로 켜기)',
  error: '오류',
  running: '작업 중',
};

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function day(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

interface Pane {
  lines: string[];
  cursor?: { x: number; y: number };
}

/** 고른 줄은 바탕만 바꾼다 */
function row(text: string, selected: boolean, width: number, theme: Theme): string {
  if (!selected) return text;
  // 줄 안의 색 끝(RESET)이 바탕까지 지우지 않게 바탕을 다시 칠한다
  const active = bg(theme, 'active');
  return `${active}${fitAnsi(text.split(RESET).join(RESET + active), width, active)}${RESET}`;
}

/** 고른 줄이 보이게 목록을 내린다 */
function windowed<T>(items: readonly T[], selected: number, height: number): { items: T[]; offset: number } {
  if (height <= 0) return { items: [], offset: 0 };
  const offset = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return { items: items.slice(offset, offset + height), offset };
}

function servicesPane(state: RuntimeState, snapshot: DeskSessionView, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  lines.push(`${muted}샌드박스${RESET} ${SESSION_STATUS[snapshot.status] ?? snapshot.status}${snapshot.error ? ` ${fg(theme, 'red')}${snapshot.error}${RESET}` : ''}`);
  if (snapshot.sandboxLink) lines.push(`${fg(theme, 'red')}× 샌드박스에 닿지 않습니다: ${snapshot.sandboxLink.reason}${RESET}`);
  lines.push('');
  if (snapshot.services.length === 0) lines.push(`${muted}이 세션에는 서비스가 없습니다${RESET}`);
  const usage = new Map((snapshot.usage?.services ?? []).map((entry) => [entry.service, entry]));
  const barWidth = Math.max(4, Math.min(16, Math.floor((width - 44) / 2)));
  snapshot.services.forEach((service, at) => {
    const look = SERVICE_STATE[service.state] ?? SERVICE_STATE.stopped;
    const head = `${fg(theme, look.color)}${look.mark}${RESET} ${BOLD}${service.name}${RESET} ${muted}${service.template}${RESET}  ${fg(theme, look.color)}${look.label}${RESET}${service.url ? `  ${muted}${service.url}${RESET}` : ''}`;
    lines.push(row(head, at === state.row, width, theme));
    if (service.detail) lines.push(`  ${fg(theme, service.state === 'failed' ? 'red' : 'muted')}${service.detail}${RESET}`);
    const measured = usage.get(service.name);
    if (measured && (measured.cpuPercent !== undefined || measured.memoryBytes !== undefined)) {
      const cpuMax = (measured.cpuLimit ?? 1) * 100;
      const cpu = measured.cpuPercent ?? 0;
      const parts = [`  ${muted}CPU${RESET} ${bar((cpu / cpuMax) * 100, barWidth, theme)} ${Math.round(cpu)}%`];
      if (measured.memoryBytes !== undefined) {
        const limit = measured.memoryLimitBytes;
        const memory = limit ? `${bar((measured.memoryBytes / limit) * 100, barWidth, theme)} ${formatBytes(measured.memoryBytes)} / ${formatBytes(limit)}` : formatBytes(measured.memoryBytes);
        parts.push(`${muted}메모리${RESET} ${memory}`);
      }
      if (measured.restartCount) parts.push(`${fg(theme, 'yellow')}다시 시작 ${measured.restartCount}번${RESET}`);
      lines.push(parts.join('  '));
    }
  });
  return { lines: lines.slice(0, height) };
}

function logsPane(state: RuntimeState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const filters = [state.logService ? `서비스 ${state.logService}` : '모든 서비스', state.search && !state.search.editing ? `찾기 "${state.search.text}"` : '', state.scroll > 0 ? `${state.scroll}줄 위` : '새 줄 따라가는 중'].filter(Boolean);
  const head = state.search?.editing ? `찾기> ${state.search.text}` : `${muted}${filters.join(' · ')}${RESET}`;
  const lines = [head];
  const logs = visibleLogs(state);
  const room = Math.max(0, height - 1);
  if (logs.length === 0) {
    lines.push(`${muted}${state.logs.length === 0 ? '아직 로그가 없습니다' : '맞는 줄이 없습니다'}${RESET}`);
    return { lines, ...(state.search?.editing ? { cursor: { x: stringWidth(`찾기> ${state.search.text}`), y: 0 } } : {}) };
  }
  const end = Math.max(0, logs.length - state.scroll);
  const shown = logs.slice(Math.max(0, end - room), end);
  const nameWidth = Math.min(12, Math.max(...shown.map((log) => stringWidth(log.service)), 3));
  const needle = state.search && !state.search.editing ? state.search.text : '';
  for (const log of shown) {
    const color = logColor(log.text);
    let text = log.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (needle) {
      // 찾은 곳만 바탕을 칠한다(대소문자 무시)
      const at = text.toLowerCase().indexOf(needle.toLowerCase());
      if (at >= 0) text = `${text.slice(0, at)}${bg(theme, 'active')}${fg(theme, 'yellow')}${text.slice(at, at + needle.length)}${RESET}${color ? fg(theme, color) : ''}${text.slice(at + needle.length)}`;
    }
    lines.push(`${muted}${clock(log.at)}${RESET} ${fg(theme, 'accent')}${fit(log.service, nameWidth)}${RESET} ${color ? fg(theme, color) : ''}${text}${RESET}`);
  }
  return { lines, ...(state.search?.editing ? { cursor: { x: stringWidth(`찾기> ${state.search.text}`), y: 0 } } : {}) };
}

const RELEASE_LABEL: Record<string, { label: string; color: ColorToken }> = {
  active: { label: '지금 운영', color: 'green' },
  previous: { label: '이전', color: 'accent' },
  retired: { label: '정리됨', color: 'muted' },
  failed: { label: '실패', color: 'red' },
};

function deployPane(state: RuntimeState, snapshot: DeskSessionView, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  if (!snapshot.hasDeploy) {
    lines.push(`${muted}이 프로젝트의 studio.yaml에 deploy 절이 없습니다. deploy 절을 쓰면 여기서 운영 배포를 합니다${RESET}`);
    return { lines };
  }
  if (!snapshot.experimental) lines.push(`${fg(theme, 'yellow')}운영 배포는 실험 기능입니다(B_STUDIO_EXPERIMENTAL=1)${RESET}`);
  const head = snapshot.checkpoints[0];
  lines.push(`${muted}배포할 체크포인트${RESET} ${head ? `${head.shortSha} ${head.message}` : '없음'}`);
  if (state.deploy.result) lines.push(state.deploy.result.includes('실패') ? `${fg(theme, 'red')}${state.deploy.result}${RESET}` : `${fg(theme, 'green')}${state.deploy.result}${RESET}`);
  if (snapshot.deploying) {
    const deploying = snapshot.deploying;
    lines.push(`${fg(theme, 'accent')}◐ ${deploying.action === 'deploy' ? '배포' : '되돌리기'} 도는 중${RESET} ${muted}${deploying.target}${RESET}`);
    for (const line of deploying.lines.slice(-6)) lines.push(`  ${muted}${line}${RESET}`);
  }
  if (state.deploy.error) lines.push(`${fg(theme, 'red')}${state.deploy.error}${RESET}`);
  const status = state.deploy.status;
  if (!status) {
    lines.push(`${muted}${state.deploy.loading ? '배포 상태를 받는 중…' : '배포 상태를 아직 받지 않았습니다(r)'}${RESET}`);
    return { lines: lines.slice(0, height) };
  }
  lines.push('');
  const urls = Object.entries(status.urls);
  if (urls.length === 0) lines.push(`${muted}운영 주소가 아직 없습니다${RESET}`);
  for (const [service, url] of urls) lines.push(`${muted}운영${RESET} ${service} ${link(url)}`);
  if (status.containers.length > 0) lines.push(`${muted}컨테이너${RESET} ${status.containers.map((container) => `${container.name} ${container.state}`).join(' · ')}`);
  lines.push('');
  const list = releases(state);
  if (list.length === 0) lines.push(`${muted}릴리스가 아직 없습니다. d로 처음 배포합니다${RESET}`);
  const shown = windowed(list, state.row, Math.max(0, height - lines.length));
  shown.items.forEach((release, at) => {
    const look = RELEASE_LABEL[release.status] ?? RELEASE_LABEL.retired!;
    const text = `${fg(theme, look.color)}${fit(look.label, 10)}${RESET} ${muted}${day(release.createdAt)}${RESET} ${release.source.label}${release.error ? ` ${fg(theme, 'red')}${release.error}${RESET}` : ''}`;
    lines.push(row(text, shown.offset + at === state.row, width, theme));
  });
  return { lines: lines.slice(0, height) };
}

function previewPane(state: RuntimeState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  const services = previewServices(state);
  if (services.length === 0) lines.push(`${muted}미리 볼 화면이 없습니다(브라우저로 여는 서비스가 없습니다)${RESET}`);
  services.forEach((service, at) => {
    const look = SERVICE_STATE[service.state] ?? SERVICE_STATE.stopped;
    const preview = state.previews[service.name];
    let address = `${muted}${service.state === 'ready' ? '주소를 받는 중…' : look.label}${RESET}`;
    if (preview?.url) address = link(preview.url);
    else if (preview?.error) address = `${fg(theme, 'red')}${preview.error}${RESET}`;
    else if (service.state === 'ready' && !preview) address = `${muted}Enter로 주소 받기${RESET}`;
    const text = `${fg(theme, look.color)}${look.mark}${RESET} ${BOLD}${service.name}${RESET} ${muted}${service.template}${RESET}  ${address}`;
    lines.push(row(text, at === state.row, width, theme));
  });
  lines.push('');
  lines.push(`${muted}원격 브라우저·QA·디자인 비교·요소 고르기는 브라우저가 있어야 해서 터미널에서는 보이지 않습니다.${RESET}`);
  lines.push(`${muted}앱 주소를 브라우저로 열어 확인하세요. 링크를 누르거나 o를 누르면 이 컴퓨터의 브라우저가 열립니다.${RESET}`);
  return { lines: lines.slice(0, height) };
}

const REPO_REASON: Record<string, string> = {
  no_remote: '이 프로젝트에는 원격 저장소(origin)가 없습니다',
  unsupported_host: 'GitHub·Gitea가 아닌 원격 저장소라 목록을 받지 못합니다',
  no_token: '토큰이 없습니다. B_STUDIO_GITHUB_TOKEN을 두거나 gh auth login으로 로그인하세요',
  rate_limited: 'API 사용량 한도에 걸렸습니다. 잠시 뒤 r로 다시 받으세요',
  error: '목록을 받지 못했습니다',
};

const CHECK_MARK: Record<string, { mark: string; color: ColorToken }> = {
  pass: { mark: '✓', color: 'green' },
  warn: { mark: '▲', color: 'yellow' },
  fail: { mark: '×', color: 'red' },
  skip: { mark: '·', color: 'muted' },
};

function repoPane(state: RuntimeState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const tabs: Array<[RepoView, string, string]> = [
    ['presubmit', 'c', '올리기 전 점검'],
    ['issues', 'i', '이슈'],
    ['pulls', 'p', 'PR'],
  ];
  const lines = [tabs.map(([view, key, label]) => (view === state.repo.view ? `${fg(theme, 'accent')}${BOLD}${key} ${label}${RESET}` : `${muted}${key} ${label}${RESET}`)).join('   ') + (state.repo.view === 'presubmit' ? '' : `   ${muted}${state.repo.state === 'open' ? '열린 것' : '닫힌 것'} (x로 바꾸기)${RESET}`)];
  lines.push('');
  if (state.repo.error) lines.push(`${fg(theme, 'red')}${state.repo.error}${RESET}`);
  if (state.repo.view === 'presubmit') {
    const report = state.repo.submission;
    if (!report) {
      lines.push(`${muted}${state.repo.loading ? '점검하는 중…' : '점검 결과를 아직 받지 않았습니다(r)'}${RESET}`);
      return { lines };
    }
    lines.push(`${BOLD}점검 ${report.score.passed}/${report.score.total} 통과${RESET}`);
    for (const item of report.items) {
      const look = CHECK_MARK[item.status] ?? CHECK_MARK.skip!;
      lines.push(`${fg(theme, look.color)}${look.mark} ${item.title}${RESET} ${muted}${item.reason}${RESET}`);
    }
    return { lines: lines.slice(0, height) };
  }
  const list = state.repo.view === 'issues' ? state.repo.issues : state.repo.pulls;
  if (!list) {
    lines.push(`${muted}${state.repo.loading ? '받는 중…' : '아직 받지 않았습니다(r)'}${RESET}`);
    return { lines };
  }
  if (!list.ok) {
    lines.push(`${fg(theme, 'yellow')}${REPO_REASON[list.reason ?? 'error'] ?? REPO_REASON.error}${RESET}`);
    if (list.detail) lines.push(`${muted}${list.detail}${RESET}`);
    return { lines };
  }
  if (list.remote) lines.push(`${muted}${list.remote.display}${RESET}`);
  const items = (state.repo.view === 'issues' ? list.issues : list.pulls) ?? [];
  if (items.length === 0) lines.push(`${muted}${state.repo.view === 'issues' ? '이슈' : 'PR'}가 없습니다${RESET}`);
  const shown = windowed(items, state.row, Math.max(0, height - lines.length));
  shown.items.forEach((item, at) => {
    const pull = 'draft' in item ? (item as DeskPull) : undefined;
    const check = pull?.checkStatus === 'success' ? `${fg(theme, 'green')}✓${RESET} ` : pull?.checkStatus === 'failure' ? `${fg(theme, 'red')}×${RESET} ` : pull?.checkStatus === 'pending' ? `${fg(theme, 'yellow')}◐${RESET} ` : '';
    const labels = item.labels.length > 0 ? ` ${muted}[${item.labels.join(', ')}]${RESET}` : '';
    const text = `${check}#${item.number} ${item.title}${pull?.draft ? ` ${muted}(초안)${RESET}` : ''}${labels} ${muted}${item.author} · ${day(item.updatedAt)}${RESET}`;
    lines.push(row(text, shown.offset + at === state.row, width, theme));
  });
  return { lines: lines.slice(0, height) };
}

export function renderRuntime(state: RuntimeState, size: { w: number; h: number }, theme: Theme, _now = Date.now()): { lines: string[]; cursor?: { x: number; y: number } } {
  const inner = { w: Math.max(0, size.w - 4), h: Math.max(0, size.h - 2) };
  const contentWidth = Math.max(0, inner.w - TAB_WIDTH - 3);
  const muted = fg(theme, 'muted');
  let pane: Pane;
  const snapshot = state.snapshot;
  if (!snapshot) pane = { lines: [state.error ? `${fg(theme, 'red')}${state.error}${RESET}` : `${muted}세션에 연결하는 중…${RESET}`] };
  else if (state.tab === 'services') pane = servicesPane(state, snapshot, contentWidth, inner.h, theme);
  else if (state.tab === 'logs') pane = logsPane(state, contentWidth, inner.h, theme);
  else if (state.tab === 'deploy') pane = deployPane(state, snapshot, contentWidth, inner.h, theme);
  else if (state.tab === 'preview') pane = previewPane(state, contentWidth, inner.h, theme);
  else if (state.tab === 'qa') pane = qaPane(state, contentWidth, inner.h, theme, _now);
  else pane = repoPane(state, contentWidth, inner.h, theme);
  if (snapshot && state.error) pane = { ...pane, lines: [`${fg(theme, 'red')}${state.error}${RESET}`, ...pane.lines].slice(0, inner.h) };

  const rows: string[] = [];
  for (let y = 0; y < inner.h; y++) {
    const tab = RUNTIME_TABS[y - 1];
    let left = '';
    if (tab) {
      const current = tab.tab === state.tab;
      const label = `${y} ${tab.label}`;
      left = current ? `${bg(theme, 'active')}${fg(theme, 'accent')}${BOLD}▸ ${label}${RESET}` : `${muted}  ${label}${RESET}`;
    }
    rows.push(`${fitAnsi(left, TAB_WIDTH)} ${fg(theme, 'border')}│${RESET} ${fitAnsi(pane.lines[y] ?? '', contentWidth)}`);
  }
  const lines = box(rows, size.w, theme, { title: `실행 · ${state.title}`, focused: true });
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  const cursor = pane.cursor && pane.cursor.y < inner.h ? { x: 2 + TAB_WIDTH + 3 + Math.min(pane.cursor.x, contentWidth - 1), y: 1 + pane.cursor.y } : undefined;
  return { lines: lines.slice(0, size.h).map((line) => fitAnsi(line, size.w)), ...(cursor ? { cursor } : {}) };
}

/** 아래 줄 안내 */
export function runtimeHint(state: RuntimeState): string {
  const confirm = state.confirm;
  if (confirm) {
    if (confirm.kind === 'service') return ` ${confirm.service}를 끌까요? 다시 켤 때까지 그 서비스는 돌지 않습니다 · y 끄기 · 다른 키 그만두기`;
    if (confirm.kind === 'deploy') return ` 체크포인트 ${confirm.shortSha}(${confirm.label})를 운영에 배포할까요? · y 배포 · 다른 키 그만두기`;
    if (confirm.kind === 'qa-save') return ` 이 실행의 동작을 studio.yaml의 화면 확인(pageChecks, ${confirm.service})으로 덧붙일까요? 다음 검증부터 게이트가 돌립니다 · y 저장 · 다른 키 그만두기`;
    return ` 운영을 ${confirm.label}(${confirm.releaseId}) 릴리스로 되돌릴까요? · y 되돌리기 · 다른 키 그만두기`;
  }
  if (state.note) return ` ${state.note}`;
  if (state.search?.editing) return ' 찾을 글을 쓰고 Enter · Esc 그만두기';
  const common = 'Tab·1~6 탭 · Esc 닫기';
  if (state.qa?.form) return ' Enter 다음 칸(마지막 칸이면 시작) · ↑↓ 칸 옮기기 · ←→ 서비스 · Esc 그만두기';
  switch (state.tab) {
    case 'services':
      return ` ↑↓ 고르기 · Enter 끄고 켜기 · l 로그 · o 브라우저로 열기 · b 샌드박스 켜기 · ${common}`;
    case 'logs':
      return ` ↑↓ PgUp PgDn 올려 보기 · G 따라가기 · / 찾기 · s 서비스 · c 거르기 지우기 · ${common}`;
    case 'deploy':
      return ` d 최신 체크포인트 배포 · ↑↓ 고르고 b 되돌리기 · o 운영 주소 열기 · r 다시 받기 · ${common}`;
    case 'preview':
      return ` ↑↓ 고르기 · Enter·o 브라우저로 열기 · r 주소 다시 받기 · ${common}`;
    case 'qa':
      return ` n 새 QA · x 멈추기 · s 화면 확인으로 저장 · ↑↓ 동작 · Enter 그 동작의 화면 사진 · r 다시 받기 · ${common}`;
    default:
      return ` c 점검 · i 이슈 · p PR · x 열린·닫힌 · ↑↓ Enter 브라우저로 열기 · r 다시 받기 · ${common}`;
  }
}

// ─── 탐색형 QA 탭(#916) ───

const STOP_REASON: Record<string, string> = {
  finish: '목표 완료 선언',
  max_actions: '최대 동작 수 도달',
  max_time: '시간 상한 도달',
  repeated_screen: '같은 화면에서 같은 조작 반복',
  no_tool_call: '도구 호출 없이 끝남',
};
const VERDICT: Record<string, { label: string; color: ColorToken }> = {
  pass: { label: '통과', color: 'green' },
  fail: { label: '문제 발견', color: 'red' },
  inconclusive: { label: '점검을 마치지 못함', color: 'yellow' },
};
const SEVERITY: Record<string, ColorToken> = { blocker: 'red', major: 'red', minor: 'yellow' };

function qaFormPane(state: RuntimeState, width: number, theme: Theme): Pane {
  const form = state.qa!.form!;
  const muted = fg(theme, 'muted');
  const services = previewServices(state);
  const service = services[form.service]?.name ?? '(없음)';
  const lines = [`${BOLD}새 탐색형 QA${RESET} ${muted}· AI가 앱 화면을 직접 눌러 보며 목표를 따라가고 문제를 찾습니다(모델 호출에 토큰을 씁니다)${RESET}`, ''];
  lines.push(`  서비스      ${fg(theme, 'accent')}‹ ${service} ›${RESET} ${muted}(←→)${RESET}`);
  const field = (key: 'goal' | 'path' | 'confirm', label: string, value: string, hint: string) => {
    const on = form.field === key;
    lines.push(`${on ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${label}${' '.repeat(Math.max(1, 12 - stringWidth(label)))}${value || `${muted}${hint}${RESET}`}`);
  };
  field('goal', '목표', form.goal, '예: 상품 목록에서 상세로 가서 댓글을 쓰고 지운다');
  field('path', '시작 경로', form.startPath, '/');
  field('confirm', '확인 문구', form.confirmText, '(선택) 끝났을 때 화면에 있어야 할 글');
  const row = form.field === 'goal' ? 3 : form.field === 'path' ? 4 : 5;
  const value = form.field === 'goal' ? form.goal : form.field === 'path' ? form.startPath : form.confirmText;
  return { lines: lines.map((line) => fitAnsi(line, width)), cursor: { x: 14 + stringWidth(value), y: row } };
}

function qaPane(state: RuntimeState, width: number, height: number, theme: Theme, now: number): Pane {
  const qa = state.qa;
  const muted = fg(theme, 'muted');
  if (qa?.form) return qaFormPane(state, width, theme);
  const lines: string[] = [];
  if (qa?.error) lines.push(`${fg(theme, 'red')}${qa.error}${RESET}`);
  if (qa?.starting) lines.push(`${muted}시작하는 중…${RESET}`);
  const run = qa?.run;
  if (run === undefined) return { lines: [...lines, `${muted}${qa?.loading ? '불러오는 중…' : 'r로 마지막 실행을 받습니다'}${RESET}`] };
  if (run === null) {
    lines.push(
      `${muted}탐색형 QA를 돌린 적이 없습니다. n으로 시작합니다.${RESET}`,
      '',
      `${muted}목표 문장을 주면 AI가 앱 화면을 직접 눌러 보며 따라가고, 콘솔 오류·실패한 요청·접근성 문제와 눈에 띈 문제를 모읍니다.${RESET}`,
      `${muted}끝난 실행은 s로 studio.yaml의 화면 확인으로 저장해 다음 검증부터 게이트가 돌리게 합니다.${RESET}`,
    );
    return { lines: lines.map((line) => fitAnsi(line, width)) };
  }
  const verdict = run.result ? VERDICT[run.result.status] : undefined;
  const elapsed = Math.max(0, Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000));
  const status =
    run.status === 'running'
      ? `${fg(theme, 'accent')}◐ 도는 중 ${elapsed}초${RESET}`
      : verdict
        ? `${fg(theme, verdict.color)}${BOLD}${verdict.label}${RESET}`
        : `${muted}끝남${RESET}`;
  lines.push(`${BOLD}${run.service}${RESET} ${muted}·${RESET} ${run.goal.goal} ${muted}· 시작 ${run.goal.startPath}${RESET}  ${status}`);
  if (run.result) lines.push(`${muted}${run.result.reason} · ${STOP_REASON[run.result.stoppedBy] ?? run.result.stoppedBy} · ${elapsed}초${RESET}`);
  if (run.error) lines.push(`${fg(theme, 'red')}${run.error}${RESET}`);
  const diagnostics = run.result?.diagnostics;
  if (diagnostics) {
    const parts = [
      `콘솔 오류 ${diagnostics.consoleErrors.length}`,
      `페이지 오류 ${diagnostics.pageErrors.length}`,
      `실패한 요청 ${diagnostics.failedRequests.length}`,
      `막힌 요청 ${diagnostics.blockedRequests.length}`,
      `가로 넘침 ${diagnostics.horizontalOverflowPx}px`,
      `접근성 ${diagnostics.accessibilityViolations.length}`,
    ];
    lines.push(`${muted}진단: ${parts.join(' · ')}${RESET}`);
    for (const line of [...diagnostics.consoleErrors, ...diagnostics.pageErrors, ...diagnostics.failedRequests].slice(0, 3)) lines.push(`  ${fg(theme, 'red')}${line}${RESET}`);
  }
  if (run.findings.length > 0) {
    lines.push('', `${BOLD}모델이 화면에서 본 문제 ${run.findings.length}건${RESET}`);
    for (const finding of run.findings.slice(0, 6)) {
      lines.push(`  ${fg(theme, SEVERITY[finding.severity] ?? 'muted')}${finding.severity}${RESET} ${finding.summary}${finding.where ? ` ${muted}· ${finding.where}${RESET}` : ''}`);
    }
  }
  const rejections = run.expectedRejections ?? [];
  const unmet = run.result?.unmetRejections ?? [];
  if (rejections.length || unmet.length) lines.push(`${muted}미리 알린 거절 시험 ${rejections.length}건${unmet.length ? ` · 거절 응답이 없던 것 ${unmet.length}건(진짜 문제일 수 있습니다)` : ''}${RESET}`);
  lines.push('', `${BOLD}동작 ${run.actions.length}${RESET}`);
  const room = Math.max(1, height - lines.length - 1);
  const shown = windowed(run.actions, state.row, room);
  shown.items.forEach((action, index) => {
    const mark = action.ok ? `${fg(theme, 'green')}✓${RESET}` : `${fg(theme, 'red')}×${RESET}`;
    const signals = action.newDiagnosticsCount ? ` ${fg(theme, 'yellow')}진단 +${action.newDiagnosticsCount}${RESET}` : '';
    const photo = action.artifact ? ` ${muted}사진${RESET}` : '';
    const text = `  ${String(action.index).padStart(2)} ${mark} ${action.tool}${action.detail ? ` ${muted}· ${action.detail}${RESET}` : ''}${signals}${photo}`;
    lines.push(row(fitAnsi(text, width), shown.offset + index === state.row, width, theme));
  });
  if (run.status === 'running' && run.texts.length) lines.push(`${muted}  ${run.texts.at(-1)}${RESET}`);
  return { lines: lines.map((line) => fitAnsi(line, width)) };
}

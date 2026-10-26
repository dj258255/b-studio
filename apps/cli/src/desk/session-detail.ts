/**
 * 세션 자세히(#891, 카드 화면의 i 또는 앞글쇠 다음 i): 웹 세션 화면에만 있던 관리 기능을 터미널로 옮긴다.
 * 탭 세 개다.
 *  - 체크포인트: 게이트를 지나 남긴 체크포인트(시각, 메시지, 검증, 다시 검증 결과). Enter로 바뀐 파일(+/-)과 파일마다 diff를 보고,
 *    u로 되돌리고(묻는다), v로 다시 검증한다.
 *  - 확인·리뷰: 게이트의 "확인 필요" 사유와 AI 리뷰 라운드의 지적. x로 막는 지적을 오탐으로 닫는다(까닭을 쓴다), a로 리뷰를 (다시) 돌린다.
 *  - 올리기: 올리기 전 점검과 이미 열린 PR. p로 PR까지, b로 브랜치만 올린다(묻는다). 결과 주소는 링크(OSC 8)로 보인다.
 * D는 세션 기록을 지운다(두 번 묻는다, 되돌릴 수 없다). 키는 순수 함수(detailKey)이고 서버 호출은 desk가 한다(action)
 */
import { backendLabel } from './sidebar';
import { fit, fitAnsi, osc8 } from './screen';
import { bg, BOLD, fg, RESET, type Theme } from './theme';
import type { DeskItem } from './types';

/** 세션 스냅숏(studio-events.ts의 SessionSnapshot)에서 desk가 쓰는 것 */
export interface DetailSnapshot {
  id: string;
  status: string;
  running: boolean;
  checkpoints: DetailCheckpoint[];
  reverifications?: Array<{ sha: string; shortSha: string; ok: boolean; summary: string; finishedAt: string; platformFailure?: string }>;
  review?: DetailReview;
  repository?: { remote: string; base: string; branch: string; pullRequestUrl?: string; compareUrl?: string; canCreatePullRequest: boolean };
}

export interface DetailCheckpoint {
  sha: string;
  shortSha: string;
  message: string;
  createdAt: string;
  files: string[];
  passedStages?: string[];
  verify?: string;
  incomplete?: string;
}

export interface DetailFinding {
  severity: string;
  file: string;
  line?: number;
  title: string;
  detail: string;
}

export interface DetailReview {
  state: string;
  maxRounds: number;
  rounds: Array<{ round: number; status: string; findings?: DetailFinding[]; humanResolutions?: Record<number, { reason: string; at: string }>; startedAt: string; error?: string }>;
}

/** 올리기 전 점검(ExportPreview) */
export interface DetailExportPreview {
  title: string;
  canCreate: boolean;
  existingPullRequest?: string;
  issues: number[];
  checks: Array<{ id: string; ok: boolean | 'unknown'; detail: string }>;
}

/** 올린 결과(ExportResult) */
export interface DetailExportResult {
  sha: string;
  commits: number;
  forced: boolean;
  pullRequest?: { url: string; created: boolean; updated?: boolean };
  pullRequestError?: string;
}

export interface PatchFile {
  path: string;
  added: number;
  removed: number;
  lines: string[];
}

export type DetailTab = 'checkpoints' | 'review' | 'export';
const TABS: readonly DetailTab[] = ['checkpoints', 'review', 'export'];
const TAB_LABEL: Record<DetailTab, string> = { checkpoints: '체크포인트', review: '확인·리뷰', export: '올리기' };

export type DetailConfirm =
  | { action: 'restore'; sha: string; label: string }
  | { action: 'delete'; step: 1 | 2 }
  | { action: 'review' }
  | { action: 'export'; pullRequest: boolean }
  /** 확인 선언 변경 허용을 켤지(#916). 끌 때는 묻지 않는다 */
  | { action: 'checkChanges' };

export interface DetailState {
  id: string;
  title: string;
  backend?: string;
  /** 게이트가 알린 개입 까닭(확인 필요의 첫 어긋남, 검증 실패 요약) */
  reason?: string;
  attention?: string;
  tab: DetailTab;
  /** 지금 탭에서 고른 줄(체크포인트, 또는 닫을 수 있는 리뷰 지적) */
  selected: number;
  scroll: number;
  loading?: boolean;
  snapshot?: DetailSnapshot;
  error?: string;
  /** 고른 체크포인트의 바뀐 파일. file이 있으면 그 파일의 diff를 scroll부터 본다 */
  patch?: { sha: string; shortSha: string; files: PatchFile[]; selected: number; file?: number; scroll: number; loading?: boolean; error?: string };
  confirm?: DetailConfirm;
  /** 리뷰 지적을 오탐으로 닫을 까닭을 쓰는 중 */
  resolving?: { round: number; findingIndex: number; text: string };
  preview?: DetailExportPreview;
  previewError?: string;
  /** 올린 결과 한 줄과 주소 */
  result?: { text: string; url?: string };
  /** 서버에 보내 놓고 답을 기다리는 일. 그동안 다른 동작 키는 받지 않는다 */
  busy?: string;
  message?: string;
  /** 다음 요청에 확인 선언 변경 허용이 켜져 있다(#916, ADR-164) */
  checkChangesArmed?: boolean;
}

export type DetailAction =
  | { kind: 'load' }
  | { kind: 'patch'; sha: string }
  | { kind: 'restore'; sha: string }
  | { kind: 'reverify'; sha: string }
  | { kind: 'delete' }
  | { kind: 'exportPreview' }
  | { kind: 'export'; pullRequest: boolean }
  | { kind: 'review'; restart: boolean }
  | { kind: 'resolve'; round: number; findingIndex: number; reason: string }
  /** 이 세션의 다음 요청 하나에서 확인 선언의 변경을 받아들일지(#916) */
  | { kind: 'checkChanges'; allow: boolean };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const PAGE_UP = ['\x1b[5~', 'b'];
const PAGE_DOWN = ['\x1b[6~', ' ', 'f'];
const PAGE = 10;

/** git diff를 파일마다 나눈다: 경로, 더한 줄·뺀 줄 수, 그 파일의 줄 */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of text.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = { path: head[2]!, added: 0, removed: 0, lines: [line] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  // 끝의 빈 줄(마지막 줄바꿈)은 버린다
  for (const file of files) while (file.lines.length > 1 && file.lines.at(-1) === '') file.lines.pop();
  return files;
}

/** 고른 세션의 자세히를 연다. 세션은 desk가 불러온다(load) */
export function openDetail(item: DeskItem): DetailState {
  return {
    id: item.id,
    title: item.title,
    ...(item.backend ? { backend: item.backend } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    // 개입 사유 문자열만 옮긴다. 터미널 CLI의 주의 객체(#926)는 자세히 화면이 쓰지 않는다
    ...(typeof item.attention === 'string' ? { attention: item.attention } : {}),
    ...(item.checkChangesArmed ? { checkChangesArmed: true } : {}),
    tab: 'checkpoints',
    selected: 0,
    scroll: 0,
    loading: true,
  };
}

const BLOCKING = new Set(['blocker', 'major']);

/** 닫을 수 있는 리뷰 지적: 새 라운드부터, 아직 사람이 닫지 않은 막는 지적 */
function openFindings(review: DetailReview | undefined): Array<{ round: number; findingIndex: number }> {
  const out: Array<{ round: number; findingIndex: number }> = [];
  for (const round of [...(review?.rounds ?? [])].sort((a, b) => b.round - a.round)) {
    (round.findings ?? []).forEach((finding, findingIndex) => {
      if (BLOCKING.has(finding.severity) && !round.humanResolutions?.[findingIndex]) out.push({ round: round.round, findingIndex });
    });
  }
  return out;
}

function rows(state: DetailState): number {
  if (state.tab === 'checkpoints') return state.snapshot?.checkpoints.length ?? 0;
  if (state.tab === 'review') return openFindings(state.snapshot?.review).length;
  return 0;
}

/** 세션 자세히의 키. detail이 없으면 닫는다. action이 있으면 desk가 서버에 보낸다 */
export function detailKey(state: DetailState, key: string): { detail?: DetailState; action?: DetailAction } {
  const base: DetailState = state.message ? { ...state, message: undefined } : state;

  if (state.resolving) {
    const resolving = state.resolving;
    if (key === ESC || key === '\x03') return { detail: { ...base, resolving: undefined, message: '그만두었습니다' } };
    if (key === '\r') {
      const reason = resolving.text.trim();
      if (!reason) return { detail: { ...base, message: '까닭을 써야 닫습니다' } };
      return { detail: { ...base, resolving: undefined, busy: '지적을 닫는 중' }, action: { kind: 'resolve', round: resolving.round, findingIndex: resolving.findingIndex, reason } };
    }
    if (key === '\x7f' || key === '\b') return { detail: { ...base, resolving: { ...resolving, text: [...resolving.text].slice(0, -1).join('') } } };
    if (key.startsWith(ESC)) return { detail: base };
    const char = key === '\n' ? ' ' : key;
    if (char.codePointAt(0)! < 32) return { detail: base };
    return { detail: { ...base, resolving: { ...resolving, text: resolving.text + char } } };
  }

  if (state.confirm) {
    const confirm = state.confirm;
    const yes = key === 'y' || key === 'Y' || key === '\r';
    if (!yes) return { detail: { ...base, confirm: undefined, message: '그만두었습니다' } };
    const done = { ...base, confirm: undefined };
    switch (confirm.action) {
      case 'restore':
        return { detail: { ...done, busy: '되돌리는 중' }, action: { kind: 'restore', sha: confirm.sha } };
      case 'delete':
        if (confirm.step === 1) return { detail: { ...base, confirm: { action: 'delete', step: 2 } } };
        return { detail: { ...done, busy: '지우는 중' }, action: { kind: 'delete' } };
      case 'review':
        return { detail: { ...done, busy: 'AI 리뷰를 시작하는 중' }, action: { kind: 'review', restart: Boolean(state.snapshot?.review) } };
      case 'export':
        return { detail: { ...done, busy: '올리는 중', result: undefined }, action: { kind: 'export', pullRequest: confirm.pullRequest } };
      case 'checkChanges':
        return { detail: { ...done, busy: '확인 선언 변경 허용을 켜는 중' }, action: { kind: 'checkChanges', allow: true } };
    }
  }

  if (state.patch) {
    const patch = state.patch;
    if (patch.file !== undefined) {
      const length = patch.files[patch.file]?.lines.length ?? 0;
      const to = (scroll: number) => ({ detail: { ...base, patch: { ...patch, scroll: Math.max(0, Math.min(Math.max(0, length - 1), scroll)) } } });
      if (key === ESC || key === 'q') return { detail: { ...base, patch: { ...patch, file: undefined, scroll: 0 } } };
      if (UP.includes(key)) return to(patch.scroll - 1);
      if (DOWN.includes(key)) return to(patch.scroll + 1);
      if (PAGE_UP.includes(key)) return to(patch.scroll - PAGE);
      if (PAGE_DOWN.includes(key)) return to(patch.scroll + PAGE);
      if (key === 'g') return to(0);
      if (key === 'G') return to(length);
      return { detail: base };
    }
    if (key === ESC || key === 'q') return { detail: { ...base, patch: undefined } };
    if (UP.includes(key)) return { detail: { ...base, patch: { ...patch, selected: Math.max(0, patch.selected - 1) } } };
    if (DOWN.includes(key)) return { detail: { ...base, patch: { ...patch, selected: Math.max(0, Math.min(patch.files.length - 1, patch.selected + 1)) } } };
    if ((key === '\r' || key === '\n') && patch.files[patch.selected]) return { detail: { ...base, patch: { ...patch, file: patch.selected, scroll: 0 } } };
    return { detail: base };
  }

  if (key === ESC || key === 'q' || key === '\x03') return {};
  if (key === '\t' || key === '\x1b[Z') {
    const tab = TABS[(TABS.indexOf(state.tab) + (key === '\t' ? 1 : TABS.length - 1)) % TABS.length]!;
    const next: DetailState = { ...base, tab, selected: 0, scroll: 0 };
    if (tab === 'export' && !state.preview && !state.previewError && state.snapshot?.repository) return { detail: next, action: { kind: 'exportPreview' } };
    return { detail: next };
  }
  if (key === 'r') return { detail: { ...base, loading: true }, action: { kind: 'load' } };
  if (UP.includes(key)) return { detail: { ...base, selected: Math.max(0, state.selected - 1) } };
  if (DOWN.includes(key)) return { detail: { ...base, selected: Math.max(0, Math.min(rows(state) - 1, state.selected + 1)) } };

  // 여기부터는 서버에 무언가를 보내는 키다. 앞서 보낸 것의 답을 기다리는 중이면 받지 않는다
  const acting = ['\r', '\n', 'u', 'v', 'D', 'x', 'a', 'p', 'b', 'c'].includes(key);
  if (acting && state.busy) return { detail: { ...base, message: `${state.busy}입니다. 끝난 뒤 다시 누르세요` } };
  const snapshot = state.snapshot;
  if (acting && !snapshot) return { detail: { ...base, message: '세션을 아직 불러오지 못했습니다(r로 다시 부릅니다)' } };

  if (key === 'c') {
    // 확인 선언 변경 허용(#916): 켜는 것은 검증 기준을 바꿀 수 있어 묻고, 끄는 것은 바로 한다
    if (state.checkChangesArmed) return { detail: { ...base, busy: '확인 선언 변경 허용을 끄는 중' }, action: { kind: 'checkChanges', allow: false } };
    return { detail: { ...base, confirm: { action: 'checkChanges' } } };
  }

  if (key === 'D') {
    if (snapshot!.running) return { detail: { ...base, message: '실행 중인 세션은 지울 수 없습니다. 먼저 멈춘 뒤(Ctrl-b p) 지웁니다' } };
    return { detail: { ...base, confirm: { action: 'delete', step: 1 } } };
  }

  if (state.tab === 'checkpoints') {
    const checkpoint = snapshot?.checkpoints[state.selected];
    if (!acting) return { detail: base };
    if (!checkpoint) return { detail: { ...base, message: '체크포인트가 없습니다' } };
    if (key === '\r' || key === '\n') {
      return { detail: { ...base, patch: { sha: checkpoint.sha, shortSha: checkpoint.shortSha, files: [], selected: 0, scroll: 0, loading: true } }, action: { kind: 'patch', sha: checkpoint.sha } };
    }
    if (key === 'u') return { detail: { ...base, confirm: { action: 'restore', sha: checkpoint.sha, label: checkpoint.shortSha } } };
    if (key === 'v') return { detail: { ...base, busy: '다시 검증을 시작하는 중' }, action: { kind: 'reverify', sha: checkpoint.sha } };
    return { detail: base };
  }

  if (state.tab === 'review') {
    if (key === 'x') {
      const target = openFindings(snapshot?.review)[state.selected];
      if (!target) return { detail: { ...base, message: '닫을 막는 지적이 없습니다' } };
      return { detail: { ...base, resolving: { ...target, text: '' } } };
    }
    if (key === 'a') return { detail: { ...base, confirm: { action: 'review' } } };
    return { detail: base };
  }

  if (key === 'p' || key === 'b') {
    if (!snapshot?.repository) return { detail: { ...base, message: '원본 프로젝트가 Git 저장소가 아니어서 올릴 곳이 없습니다' } };
    if (snapshot.running) return { detail: { ...base, message: '작업이 끝난 뒤에 올릴 수 있습니다' } };
    return { detail: { ...base, confirm: { action: 'export', pullRequest: key === 'p' } } };
  }
  return { detail: base };
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 체크포인트가 어떤 검증을 지났나 */
function verifyLabel(checkpoint: DetailCheckpoint, theme: Theme): string {
  const turn = checkpoint.incomplete === 'max_turns' ? ` ${fg(theme, 'yellow')}· 턴 상한${RESET}` : '';
  if (checkpoint.verify === 'light') return `${fg(theme, 'yellow')}가볍게 확인${RESET}${turn}`;
  if (checkpoint.verify === 'docs') return `${fg(theme, 'muted')}문서만(게이트 없음)${RESET}${turn}`;
  if (checkpoint.verify === 'unverified') return `${fg(theme, 'yellow')}검증 없이 남김${RESET}${turn}`;
  if (checkpoint.passedStages?.length) return `${fg(theme, 'green')}검증 통과(${checkpoint.passedStages.join('·')})${RESET}${turn}`;
  return `${fg(theme, 'muted')}검증 기록 없음${RESET}${turn}`;
}

/** 선택 표시와 줄 바탕 */
function pick(selected: boolean, text: string, theme: Theme): string {
  return selected ? `${bg(theme, 'active')}${fg(theme, 'accent')}▸${RESET}${bg(theme, 'active')} ${text.replaceAll(RESET, RESET + bg(theme, 'active'))}` : `  ${text}`;
}

/** 본문 줄과 고른 줄의 자리(보이게 굴린다) */
function checkpointBody(state: DetailState, theme: Theme): { lines: string[]; focus: number } {
  const snapshot = state.snapshot!;
  if (snapshot.checkpoints.length === 0) return { lines: [` ${fg(theme, 'muted')}아직 체크포인트가 없습니다. 요청이 게이트를 지나면 여기 남습니다${RESET}`], focus: 0 };
  const lines: string[] = [];
  let focus = 0;
  // 체크포인트마다 가장 최근의 다시 검증 결과
  const reverified = new Map<string, NonNullable<DetailSnapshot['reverifications']>[number]>();
  for (const record of snapshot.reverifications ?? []) if (!reverified.has(record.sha)) reverified.set(record.sha, record);
  snapshot.checkpoints.forEach((checkpoint, index) => {
    if (index === state.selected) focus = lines.length;
    const text = `${fg(theme, 'accent')}${checkpoint.shortSha}${RESET}  ${fg(theme, 'muted')}${shortTime(checkpoint.createdAt)}${RESET}  ${checkpoint.message.split('\n')[0]}  ${verifyLabel(checkpoint, theme)} ${fg(theme, 'muted')}· 파일 ${checkpoint.files.length}${RESET}`;
    lines.push(pick(index === state.selected, text, theme));
    const record = reverified.get(checkpoint.sha);
    if (record) {
      const what = record.platformFailure
        ? `${fg(theme, 'yellow')}다시 검증을 끝내지 못함(플랫폼): ${record.platformFailure}`
        : record.ok
          ? `${fg(theme, 'green')}다시 검증 통과: ${record.summary}`
          : `${fg(theme, 'red')}다시 검증 실패: ${record.summary}`;
      lines.push(`      ${what}${RESET} ${fg(theme, 'muted')}${shortTime(record.finishedAt)}${RESET}`);
    }
  });
  return { lines, focus };
}

function patchBody(state: DetailState, theme: Theme): { lines: string[]; focus: number } {
  const patch = state.patch!;
  const muted = fg(theme, 'muted');
  if (patch.loading) return { lines: [` ${muted}${patch.shortSha}의 diff를 불러오는 중…${RESET}`], focus: 0 };
  if (patch.error) return { lines: [` ${fg(theme, 'red')}diff를 불러오지 못했습니다: ${patch.error}${RESET}`], focus: 0 };
  if (patch.file !== undefined) {
    const file = patch.files[patch.file]!;
    const colored = file.lines.map((line) => {
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('new file') || line.startsWith('deleted file')) return ` ${muted}${line}${RESET}`;
      if (line.startsWith('@@')) return ` ${fg(theme, 'teal')}${line}${RESET}`;
      if (line.startsWith('+')) return ` ${fg(theme, 'green')}${line}${RESET}`;
      if (line.startsWith('-')) return ` ${fg(theme, 'red')}${line}${RESET}`;
      return ` ${line}`;
    });
    return { lines: [` ${BOLD}${file.path}${RESET} ${muted}(${patch.shortSha})${RESET}`, '', ...colored.slice(patch.scroll)], focus: 0 };
  }
  if (patch.files.length === 0) return { lines: [` ${muted}${patch.shortSha}에서 바뀐 파일이 없습니다${RESET}`], focus: 0 };
  const lines = [` ${BOLD}${patch.shortSha}에서 바뀐 파일 ${patch.files.length}개${RESET}`, ''];
  let focus = 0;
  patch.files.forEach((file, index) => {
    if (index === patch.selected) focus = lines.length;
    lines.push(pick(index === patch.selected, `${file.path}  ${fg(theme, 'green')}+${file.added}${RESET} ${fg(theme, 'red')}-${file.removed}${RESET}`, theme));
  });
  return { lines, focus };
}

const STATE_LABEL: Record<string, string> = { running: '도는 중', passed: '통과', capped: '라운드 상한', resolved: '사람이 확인함', stopped: '멈춤' };
const ROUND_LABEL: Record<string, string> = {
  running: '리뷰 중',
  passed: '통과',
  blocked_continue: '막는 지적 있음, 고치는 중',
  blocked_capped: '막는 지적 있음, 상한에 걸림',
  resolved_by_human: '사람이 닫음',
  fixing: '고치는 중',
  fix_failed: '고침이 게이트를 못 지남',
  error: '오류',
};

function reviewBody(state: DetailState, theme: Theme): { lines: string[]; focus: number } {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  if (state.attention === 'needs_review' && state.reason) {
    lines.push(` ${fg(theme, 'yellow')}확인 필요: ${state.reason}${RESET}`);
    lines.push(` ${muted}게이트는 통과했지만 요청과 확인(테스트)이 어긋난다고 알렸습니다. 어느 쪽이 맞는지 정해 요청이나 테스트를 고칩니다${RESET}`, '');
  } else if (state.attention === 'gate_failed' && state.reason) {
    lines.push(` ${fg(theme, 'red')}검증 실패: ${state.reason}${RESET}`, '');
  }
  // 확인 선언 변경 허용(#916, ADR-164): 확인이 틀려 실패할 때 그 선언을 고치는 요청에 켠다
  lines.push(
    state.checkChangesArmed
      ? ` ${fg(theme, 'yellow')}확인 선언 변경 허용: 켜짐${RESET} ${muted}· 다음 요청 하나는 studio.yaml의 바뀐 확인 선언으로 검증합니다(c 끄기)${RESET}`
      : ` ${muted}확인 선언 변경 허용: 꺼짐 · 확인(테스트 선언)이 틀려 실패하면 c로 켜고 그 선언을 고쳐 달라고 요청합니다${RESET}`,
    '',
  );
  const review = state.snapshot!.review;
  if (!review) {
    lines.push(` ${muted}AI 리뷰를 돌린 적이 없습니다. PR을 만든 뒤 a로 돌립니다${RESET}`);
    return { lines, focus: 0 };
  }
  lines.push(` ${BOLD}AI 리뷰${RESET} · ${STATE_LABEL[review.state] ?? review.state} · 라운드 ${review.rounds.length}/${review.maxRounds}`);
  const open = openFindings(review);
  const chosen = open[state.selected];
  let focus = 0;
  for (const round of [...review.rounds].sort((a, b) => b.round - a.round)) {
    lines.push('', ` ${fg(theme, 'text')}${round.round}라운드${RESET} ${muted}· ${ROUND_LABEL[round.status] ?? round.status}${round.error ? ` · ${round.error}` : ''}${RESET}`);
    if (!round.findings?.length) {
      lines.push(`   ${muted}지적 없음${RESET}`);
      continue;
    }
    round.findings.forEach((finding, index) => {
      const closed = round.humanResolutions?.[index];
      const blocking = BLOCKING.has(finding.severity);
      const severity = `${fg(theme, closed ? 'muted' : blocking ? 'red' : 'muted')}${finding.severity}${RESET}`;
      const where = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
      const tail = closed ? ` ${muted}· 오탐으로 닫음: ${closed.reason}${RESET}` : '';
      const isChosen = chosen?.round === round.round && chosen.findingIndex === index;
      if (isChosen) focus = lines.length;
      lines.push(` ${pick(isChosen, `${severity}  ${where}  ${finding.title}${tail}`, theme)}`);
      if (isChosen) lines.push(`      ${muted}${finding.detail.replace(/\s+/g, ' ')}${RESET}`);
    });
  }
  return { lines, focus };
}

function exportBody(state: DetailState, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const repository = state.snapshot!.repository;
  if (!repository) return [` ${muted}원본 프로젝트가 Git 저장소가 아니어서 올릴 곳이 없습니다${RESET}`];
  const lines = [` 브랜치 ${BOLD}${repository.branch}${RESET} → ${repository.base} ${muted}· ${repository.remote}${RESET}`];
  if (repository.pullRequestUrl) lines.push(` 열린 PR: ${osc8(repository.pullRequestUrl, repository.pullRequestUrl)}`);
  lines.push('');
  if (state.previewError) lines.push(` ${fg(theme, 'red')}점검을 불러오지 못했습니다: ${state.previewError}${RESET}`);
  else if (!state.preview) lines.push(` ${muted}올리기 전 점검을 불러오는 중…${RESET}`);
  else {
    const preview = state.preview;
    lines.push(` PR 제목: ${BOLD}${preview.title}${RESET}`);
    if (preview.issues.length) lines.push(` 이을 이슈: ${preview.issues.map((issue) => `#${issue}`).join(' ')}`);
    if (preview.existingPullRequest && preview.existingPullRequest !== repository.pullRequestUrl) lines.push(` 같은 브랜치의 PR: ${osc8(preview.existingPullRequest, preview.existingPullRequest)}`);
    lines.push('');
    for (const check of preview.checks) {
      const mark = check.ok === true ? `${fg(theme, 'green')}✓` : check.ok === false ? `${fg(theme, 'red')}✗` : `${fg(theme, 'yellow')}?`;
      lines.push(`  ${mark} ${check.detail}${RESET}`);
    }
    if (!preview.canCreate) {
      lines.push('', ` ${fg(theme, 'yellow')}토큰이 없거나 호스트가 지원하지 않아 PR은 만들 수 없습니다. b로 브랜치만 올립니다${RESET}`);
      if (repository.compareUrl) lines.push(` 비교 주소: ${osc8(repository.compareUrl, repository.compareUrl)}`);
    }
  }
  if (state.result) {
    lines.push('', ` ${BOLD}${state.result.text}${RESET}`);
    if (state.result.url) lines.push(` ${osc8(state.result.url, state.result.url)}`);
  }
  return lines;
}

const HINTS: Record<DetailTab, string> = {
  checkpoints: ' ↑↓ 고르기 · Enter 바뀐 파일 · u 되돌리기 · v 다시 검증 · Tab 다음 탭 · D 세션 지우기 · r 다시 부르기 · Esc 닫기',
  review: ' ↑↓ 막는 지적 고르기 · x 오탐으로 닫기 · a AI 리뷰 (다시) 돌리기 · c 확인 선언 변경 허용 · Tab 다음 탭 · D 세션 지우기 · Esc 닫기',
  export: ' p PR까지 올리기 · b 브랜치만 올리기 · Tab 다음 탭 · D 세션 지우기 · r 다시 부르기 · Esc 닫기',
};

/** 아래 줄: 묻는 중이면 물음, 쓰는 중이면 입력, 알림이 있으면 알림, 아니면 키 안내 */
function footer(state: DetailState): string {
  if (state.resolving) return ` 오탐으로 닫을 까닭(Enter 보내기 · Esc 그만둠)> ${state.resolving.text}`;
  const confirm = state.confirm;
  if (confirm) {
    switch (confirm.action) {
      case 'restore':
        return ` ${confirm.label} 체크포인트로 되돌릴까요? 그 뒤의 변경은 작업 복사본에서 사라집니다(체크포인트 기록은 남습니다) · y 되돌리기 · 다른 키 그만두기`;
      case 'delete':
        return confirm.step === 1
          ? ` ‹${state.title}› 세션의 기록과 작업 복사본을 지울까요? · y 다음 · 다른 키 그만두기`
          : ` 정말 지울까요? 지운 세션은 되돌릴 수 없습니다 · y 지우기 · 다른 키 그만두기`;
      case 'review':
        return ` AI 리뷰를 ${state.snapshot?.review ? '다시 ' : ''}돌릴까요? 리뷰어 호출에 토큰을 씁니다 · y 돌리기 · 다른 키 그만두기`;
      case 'checkChanges':
        return ` 다음 요청 하나에서 studio.yaml의 확인 선언(tests·pageChecks …) 변경을 받아들일까요? 그 요청의 검증이 바뀐 선언으로 돕니다(바뀐 것은 기록에 남습니다) · y 켜기 · 다른 키 그만두기`;
      case 'export':
        return confirm.pullRequest ? ` 브랜치를 올리고 PR을 만들까요(이미 있으면 본문을 고칩니다)? · y 올리기 · 다른 키 그만두기` : ` 브랜치만 올릴까요? PR은 만들지 않습니다 · y 올리기 · 다른 키 그만두기`;
    }
  }
  if (state.message) return ` ${state.message}`;
  if (state.busy) return ` ${state.busy}…`;
  if (state.patch) return state.patch.file !== undefined ? ' ↑↓ 굴리기 · PgUp PgDn 쪽 · g G 처음과 끝 · Esc 파일 목록' : ' ↑↓ 파일 고르기 · Enter 그 파일 diff · Esc 체크포인트 목록';
  return HINTS[state.tab];
}

/** 세션 자세히의 줄(정확히 height줄, 줄마다 width칸). 첫 줄은 탭, 맨 아래 줄은 물음·입력·안내다 */
export function sessionDetailLines(state: DetailState, options: { theme: Theme; width: number; height: number; now: number }): string[] {
  const { theme, width, height } = options;
  const tab = (name: DetailTab) =>
    state.tab === name ? `${bg(theme, 'active')}${BOLD}${fg(theme, 'accent')} ${TAB_LABEL[name]} ${RESET}` : `${fg(theme, 'muted')} ${TAB_LABEL[name]} ${RESET}`;
  const who = state.backend ? `${backendLabel(state.backend)} · ` : '';
  const head = fitAnsi(` ${BOLD}세션 자세히${RESET} ${fg(theme, 'muted')}${who}${RESET}${state.title}  ${TABS.map(tab).join(' ')}${state.loading ? `  ${fg(theme, 'muted')}불러오는 중…${RESET}` : ''}`, width);

  let body: { lines: string[]; focus: number };
  if (state.error) body = { lines: [` ${fg(theme, 'red')}세션을 불러오지 못했습니다: ${state.error}${RESET}`, ' r로 다시 부릅니다'], focus: 0 };
  else if (!state.snapshot) body = { lines: [` ${fg(theme, 'muted')}불러오는 중…${RESET}`], focus: 0 };
  else if (state.patch && state.tab === 'checkpoints') body = patchBody(state, theme);
  else if (state.tab === 'checkpoints') body = checkpointBody(state, theme);
  else if (state.tab === 'review') body = reviewBody(state, theme);
  else body = { lines: exportBody(state, theme), focus: 0 };

  const room = Math.max(0, height - 3);
  // 고른 줄이 보이게 굴린다(diff 보기는 patch.scroll이 이미 굴렸다)
  const start = Math.max(0, Math.min(body.focus - Math.floor(room / 2), body.lines.length - room));
  const lines = [head, ' '.repeat(width), ...body.lines.slice(start, start + room).map((line) => fitAnsi(line, width))];
  while (lines.length < height - 1) lines.push(' '.repeat(width));
  lines.length = Math.max(0, height - 1);
  if (height > 0) lines.push(fit(footer(state), width));
  return lines;
}

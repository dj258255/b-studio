/**
 * 기록 화면(#891, 앞글쇠 다음 h): 웹의 AI별 결과표와 프로젝트 토큰 보고서를 터미널로 옮긴다.
 * 탭 두 개다. AI별 결과는 AI × 계정마다 요청 수·게이트 통과율·평균 토큰·비용과 최근 실패를, 토큰 보고서는 프로젝트·기간마다
 * 합계와 세션별·모델별 토큰·비용 막대를 보인다. 키는 순수 함수(recordsKey)이고, 불러오기는 desk가 한다(load)
 */
import { compactTokens, backendLabel, totalTokens } from './sidebar';
import { fit, fitAnsi, stringWidth } from './screen';
import { bg, BOLD, fg, RESET, type ColorToken, type Theme } from './theme';
import type { DeskUsage } from './types';

/** 스튜디오 AI별 결과표(routing-types.ts의 RoutingStats)에서 desk가 쓰는 것 */
export interface RecordsStats {
  rows: Array<{ backend: string; model: string; runs: number; passed: number; failed: number; errors: number; passRate?: number; medianCostUsd?: number }>;
  excluded: { asks: number; unfinished: number };
  byAccount?: RecordsAccountRow[];
  recentFailures?: RecordsFailure[];
}

export interface RecordsAccountRow {
  backend: string;
  accountId?: string;
  runs: number;
  passed: number;
  failed: number;
  errors: number;
  passRate?: number;
  averageTokens?: number;
  averageCostUsd?: number;
}

export interface RecordsFailure {
  sessionId: string;
  backend: string;
  accountId?: string;
  request: string;
  at?: string;
  outcome: 'failed' | 'errors';
}

/** 스튜디오 프로젝트 토큰 보고서(project-token-types.ts의 ProjectTokenReport)에서 desk가 쓰는 것 */
export interface RecordsReport {
  projectId: string;
  projectName: string;
  generatedAt: string;
  sessions: number;
  requests: Array<{ sessionId: string; kind: string; request: string; at?: string; usage: DeskUsage; costUsd?: number; result: string }>;
  totals: DeskUsage;
  estimatedCostUsd?: number;
  usageByModel: Record<string, DeskUsage>;
  modelCosts: Record<string, number>;
}

export type RecordsRange = 'all' | '7d' | '30d';
const RANGES: readonly RecordsRange[] = ['all', '7d', '30d'];
const RANGE_LABEL: Record<RecordsRange, string> = { all: '전체 기간', '7d': '최근 7일', '30d': '최근 30일' };
const RANGE_DAYS: Record<Exclude<RecordsRange, 'all'>, number> = { '7d': 7, '30d': 30 };

export interface RecordsState {
  tab: 'ai' | 'tokens';
  /** 본문을 굴린 줄 수(탭 줄은 굴리지 않는다) */
  scroll: number;
  projects: Array<{ id: string; name: string }>;
  projectIndex: number;
  range: RecordsRange;
  stats?: RecordsStats;
  statsError?: string;
  report?: RecordsReport;
  reportError?: string;
  loading?: boolean;
  /** 계정 id → 이름(desk가 계정 목록으로 채운다) */
  names?: Record<string, string>;
}

export type RecordsLoad = { kind: 'stats' } | { kind: 'report'; projectId: string; from?: string };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const LEFT = ['\x1b[D', '\x1bOD', 'h'];
const RIGHT = ['\x1b[C', '\x1bOC', 'l'];
const PAGE = 10;

/** 기간의 시작 시각(ISO). 전체 기간이면 없다 */
export function rangeFrom(range: RecordsRange, now: number): string | undefined {
  return range === 'all' ? undefined : new Date(now - RANGE_DAYS[range] * 86_400_000).toISOString();
}

/** 기록 화면을 연다: AI별 결과 탭, 토큰 보고서의 프로젝트는 고른 세션의 프로젝트 */
export function openRecords(projects: RecordsState['projects'], projectName?: string): RecordsState {
  const index = projects.findIndex((project) => project.name === projectName);
  return { tab: 'ai', scroll: 0, projects, projectIndex: Math.max(0, index), range: 'all', loading: true };
}

function reportLoad(state: RecordsState, now: number): RecordsLoad | undefined {
  const project = state.projects[state.projectIndex];
  if (!project) return undefined;
  const from = rangeFrom(state.range, now);
  return { kind: 'report', projectId: project.id, ...(from ? { from } : {}) };
}

/** 기록 화면의 키. records가 없으면 닫는다. load가 있으면 desk가 그것을 불러와 채운다 */
export function recordsKey(state: RecordsState, key: string, now: number): { records?: RecordsState; load?: RecordsLoad } {
  if (key === ESC || key === 'q' || key === '\x03') return {};
  if (key === '\t' || key === '\x1b[Z' || key === '1' || key === '2') {
    const tab = key === '1' ? 'ai' : key === '2' ? 'tokens' : state.tab === 'ai' ? 'tokens' : 'ai';
    const next: RecordsState = { ...state, tab, scroll: 0 };
    if (tab === state.tab) return { records: next };
    // 이미 받은 것은 다시 부르지 않는다(r로 다시 부른다)
    if (tab === 'tokens' && !state.report && !state.reportError) {
      const load = reportLoad(next, now);
      return { records: { ...next, ...(load ? { loading: true } : {}) }, ...(load ? { load } : {}) };
    }
    if (tab === 'ai' && !state.stats && !state.statsError) return { records: { ...next, loading: true }, load: { kind: 'stats' } };
    return { records: next };
  }
  if (key === 'r') {
    if (state.tab === 'ai') return { records: { ...state, loading: true }, load: { kind: 'stats' } };
    const load = reportLoad(state, now);
    return { records: load ? { ...state, loading: true } : state, ...(load ? { load } : {}) };
  }
  if (UP.includes(key)) return { records: { ...state, scroll: Math.max(0, state.scroll - 1) } };
  if (DOWN.includes(key)) return { records: { ...state, scroll: state.scroll + 1 } };
  if (key === '\x1b[5~' || key === 'b') return { records: { ...state, scroll: Math.max(0, state.scroll - PAGE) } };
  if (key === '\x1b[6~' || key === ' ' || key === 'f') return { records: { ...state, scroll: state.scroll + PAGE } };
  if (state.tab === 'tokens' && state.projects.length > 0 && (LEFT.includes(key) || RIGHT.includes(key))) {
    const by = LEFT.includes(key) ? -1 : 1;
    const projectIndex = (state.projectIndex + by + state.projects.length) % state.projects.length;
    const next: RecordsState = { ...state, projectIndex, scroll: 0, report: undefined, reportError: undefined };
    const load = reportLoad(next, now);
    return { records: { ...next, loading: true }, ...(load ? { load } : {}) };
  }
  if (state.tab === 'tokens' && key === 'd') {
    const range = RANGES[(RANGES.indexOf(state.range) + 1) % RANGES.length]!;
    const next: RecordsState = { ...state, range, scroll: 0 };
    const load = reportLoad(next, now);
    return { records: { ...next, ...(load ? { loading: true } : {}) }, ...(load ? { load } : {}) };
  }
  return { records: state };
}

/** 한 칸을 8단계로 나눠 차는 막대. 빈 곳은 어두운 바탕이다 */
export function fillBar(fraction: number, width: number, theme: Theme, color: ColorToken): string {
  if (width <= 0) return '';
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const partial = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][rest]!;
  return `${fg(theme, color)}${bg(theme, 'active')}${'█'.repeat(full)}${partial}${' '.repeat(width - full - (rest ? 1 : 0))}${RESET}`;
}

/** 통과율의 색: 80% 이상 초록, 50% 이상 노랑, 그 아래 빨강 */
function passColor(rate: number): ColorToken {
  if (rate >= 0.8) return 'green';
  if (rate >= 0.5) return 'yellow';
  return 'red';
}

function cost(value: number | undefined): string {
  return value === undefined ? '-' : `$${value.toFixed(2)}`;
}

/** 왼쪽을 width칸에 맞추고 오른쪽 칸들을 붙인다 */
function cell(text: string, width: number): string {
  return fit(text, width);
}

function rightCell(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? fit(text, width) : ' '.repeat(width - w) + text;
}

function shortTime(iso: string | undefined): string {
  if (!iso) return '     ';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '     ';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 옛 서버(계정별 묶음이 없음)면 AI별 줄을 백엔드로 모아 대신한다 */
function accountRows(stats: RecordsStats): RecordsAccountRow[] {
  if (stats.byAccount) return stats.byAccount;
  const merged = new Map<string, RecordsAccountRow>();
  for (const row of stats.rows) {
    const known = merged.get(row.backend) ?? { backend: row.backend, runs: 0, passed: 0, failed: 0, errors: 0 };
    known.runs += row.runs;
    known.passed += row.passed;
    known.failed += row.failed;
    known.errors += row.errors;
    merged.set(row.backend, known);
  }
  return [...merged.values()].map((row) => {
    const judged = row.passed + row.failed + row.errors;
    return judged > 0 ? { ...row, passRate: row.passed / judged } : row;
  });
}

function aiLines(state: RecordsState, theme: Theme, width: number, names: Readonly<Record<string, string>>): string[] {
  if (state.statsError) return [` ${fg(theme, 'red')}불러오지 못했습니다: ${state.statsError}${RESET}`, ' r로 다시 부릅니다'];
  if (!state.stats) return [` ${fg(theme, 'muted')}불러오는 중…${RESET}`];
  const rows = accountRows(state.stats);
  const muted = fg(theme, 'muted');
  if (rows.length === 0) return [` ${muted}아직 끝난 만들기 요청이 없습니다. 요청이 게이트를 지나면 여기 쌓입니다${RESET}`];
  const nameWidth = Math.max(14, Math.min(24, Math.floor(width * 0.28)));
  const barWidth = Math.max(6, Math.min(20, width - nameWidth - 40));
  const lines = [` ${muted}${cell('AI · 계정', nameWidth)} ${rightCell('요청', 5)}  ${cell('게이트 통과율', barWidth + 5)}  ${rightCell('평균 토큰', 9)}  ${rightCell('평균 비용', 9)}${RESET}`];
  for (const row of rows) {
    // 옛 서버는 계정을 모른다. 그때는 AI 이름만 쓴다
    const label = !state.stats.byAccount ? backendLabel(row.backend) : `${backendLabel(row.backend)} · ${row.accountId ? (names[row.accountId] ?? row.accountId) : '기본'}`;
    const rate = row.passRate;
    const meter = rate === undefined ? `${muted}${cell('판정 없음', barWidth + 5)}${RESET}` : `${fillBar(rate, barWidth, theme, passColor(rate))} ${rightCell(`${Math.round(rate * 100)}%`, 4)}`;
    lines.push(
      ` ${cell(label, nameWidth)} ${rightCell(String(row.runs), 5)}  ${meter}  ${rightCell(row.averageTokens === undefined ? '-' : compactTokens(row.averageTokens), 9)}  ${rightCell(cost(row.averageCostUsd), 9)}`,
    );
  }
  const failures = state.stats.recentFailures ?? [];
  if (failures.length > 0) {
    lines.push('', ` ${BOLD}${fg(theme, 'text')}최근 실패${RESET}`);
    for (const failure of failures) {
      const account = failure.accountId ? ` · ${names[failure.accountId] ?? failure.accountId}` : '';
      const what = failure.outcome === 'failed' ? `${fg(theme, 'red')}검증 실패${RESET}` : `${fg(theme, 'yellow')}오류${RESET}`;
      lines.push(`  ${muted}${shortTime(failure.at)}${RESET}  ${cell(`${backendLabel(failure.backend)}${account}`, 16)}  ${what}  ${failure.request.replace(/\s+/g, ' ')}`);
    }
  }
  const { asks, unfinished } = state.stats.excluded;
  if (asks || unfinished) lines.push('', ` ${muted}질문 ${asks}건과 끝나지 않은 실행 ${unfinished}건은 넣지 않았습니다. 플랫폼(도커·샌드박스) 실패도 AI 성적에 넣지 않습니다${RESET}`);
  return lines;
}

function tokenLines(state: RecordsState, theme: Theme, width: number, titles: Readonly<Record<string, string>>): string[] {
  const muted = fg(theme, 'muted');
  const project = state.projects[state.projectIndex];
  const head = ` 프로젝트 ‹${project?.name ?? '없음'}› ${muted}(←→ 바꾸기)${RESET} · ${RANGE_LABEL[state.range]} ${muted}(d 바꾸기)${RESET}`;
  if (!project) return [head, '', ` ${muted}프로젝트가 없습니다${RESET}`];
  if (state.reportError) return [head, '', ` ${fg(theme, 'red')}불러오지 못했습니다: ${state.reportError}${RESET}`, ' r로 다시 부릅니다'];
  const report = state.report;
  if (!report) return [head, '', ` ${muted}불러오는 중…${RESET}`];
  const total = totalTokens(report.totals);
  const lines = [head, '', ` ${BOLD}합계 ${compactTokens(total)} 토큰 · ${cost(report.estimatedCostUsd)} · 세션 ${report.sessions} · 요청 ${report.requests.length}${RESET}`];
  if (report.requests.length === 0) return [...lines, '', ` ${muted}이 기간에 요청이 없습니다${RESET}`];

  // 세션별: 요청을 세션마다 모은다. 제목은 desk가 아는 세션 이름, 모르면 그 세션의 첫 요청 글
  const sessions = new Map<string, { title: string; tokens: number; cost?: number }>();
  for (const request of report.requests) {
    const known = sessions.get(request.sessionId) ?? { title: titles[request.sessionId] ?? request.request.replace(/\s+/g, ' '), tokens: 0 };
    known.tokens += totalTokens(request.usage);
    if (request.costUsd !== undefined) known.cost = (known.cost ?? 0) + request.costUsd;
    sessions.set(request.sessionId, known);
  }
  const nameWidth = Math.max(12, Math.min(28, Math.floor(width * 0.3)));
  const barWidth = Math.max(6, Math.min(30, width - nameWidth - 26));
  const row = (name: string, tokens: number, money: number | undefined, max: number) =>
    `  ${cell(name, nameWidth)} ${fillBar(max > 0 ? tokens / max : 0, barWidth, theme, 'accent')} ${rightCell(compactTokens(tokens), 7)}  ${rightCell(cost(money), 8)}`;
  const bySession = [...sessions.values()].sort((a, b) => b.tokens - a.tokens);
  const sessionMax = bySession[0]?.tokens ?? 0;
  lines.push('', ` ${BOLD}${fg(theme, 'text')}세션별${RESET}`, ...bySession.map((entry) => row(entry.title, entry.tokens, entry.cost, sessionMax)));

  const byModel = Object.entries(report.usageByModel)
    .map(([model, usage]) => ({ model, tokens: totalTokens(usage), cost: report.modelCosts[model] }))
    .sort((a, b) => b.tokens - a.tokens);
  if (byModel.length > 0) {
    const modelMax = byModel[0]!.tokens;
    lines.push('', ` ${BOLD}${fg(theme, 'text')}모델별${RESET}`, ...byModel.map((entry) => row(entry.model, entry.tokens, entry.cost, modelMax)));
  }
  lines.push('', ` ${muted}비용은 공식 단가로 환산한 추정치이며 구독 요금과 다릅니다${RESET}`);
  return lines;
}

/** 탭 줄: 고른 탭은 강조 바탕 */
function tabLine(state: RecordsState, theme: Theme, width: number): string {
  const tab = (name: string, on: boolean) => (on ? `${bg(theme, 'active')}${BOLD}${fg(theme, 'accent')} ${name} ${RESET}` : `${fg(theme, 'muted')} ${name} ${RESET}`);
  const loading = state.loading ? `  ${fg(theme, 'muted')}불러오는 중…${RESET}` : '';
  return fitAnsi(` ${BOLD}기록${RESET}  ${tab('AI별 결과', state.tab === 'ai')} ${tab('토큰 보고서', state.tab === 'tokens')}${loading}`, width);
}

export const RECORDS_HINT = ' 기록 · Tab 탭 바꾸기 · ↑↓ 굴리기 · ←→ 프로젝트 · d 기간 · r 다시 부르기 · Esc 닫기';

/**
 * 기록 화면의 줄(정확히 height줄, 줄마다 width칸). 첫 줄은 탭, 둘째 줄은 비우고, 나머지는 굴릴 수 있는 본문이다.
 * names는 계정 id → 이름, titles는 세션 id → desk가 아는 제목이다
 */
type RecordsDrawOptions = { theme: Theme; width: number; height: number; now: number; names?: Readonly<Record<string, string>>; titles?: Readonly<Record<string, string>> };

function bodyOf(state: RecordsState, options: RecordsDrawOptions): string[] {
  return state.tab === 'ai' ? aiLines(state, options.theme, options.width, options.names ?? {}) : tokenLines(state, options.theme, options.width, options.titles ?? {});
}

/** 더 굴릴 수 없는 자리. desk가 키를 받은 뒤 scroll을 이 값으로 줄여, 끝에서 더 내린 만큼 다시 올려야 하는 일이 없게 한다 */
export function recordsScrollLimit(state: RecordsState, options: RecordsDrawOptions): number {
  return Math.max(0, bodyOf(state, options).length - Math.max(0, options.height - 2));
}

export function recordsLines(
  state: RecordsState,
  options: RecordsDrawOptions,
): string[] {
  const { theme, width, height } = options;
  const body = bodyOf(state, options);
  const room = Math.max(0, height - 2);
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, body.length - room)));
  const lines = [tabLine(state, theme, width), ' '.repeat(width), ...body.slice(scroll, scroll + room).map((line) => fitAnsi(line, width))];
  while (lines.length < height) lines.push(' '.repeat(width));
  return lines.slice(0, height);
}

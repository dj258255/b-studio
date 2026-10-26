/**
 * 사용량 화면(#889, #936): 맨 위에 제목과 요약 한 줄(CLI마다 읽은 계정 수, 주간 평균, 기준 시각)과 오늘·7일 합계,
 * 그 아래 계정마다 한 줄인 표(이름·CLI·요금제·5시간·주간·다시 차는 때·상태)를 두어 계정끼리 한눈에 견준다.
 * 고른 계정 하나만 표 아래에 그림 카드로 자세히 보인다(막대, 다시 차는 시각, 바닥나는 때 추정, 그 CLI의 오늘·7일).
 * 세션 카드(스페이스 화면)의 사용량 막대도 여기서 잇는다: 세션의 계정, 없으면 그 CLI의 기본 계정(id가 CLI 이름)이다
 */
import { ART_NARROW, artSize, resetText } from './cards';
import type { DeskState } from './keys';
import type { KittyImages } from './kitty';
import { fit, fitAnsi, stringWidth, stripAnsi, type Rect } from './screen';
import { backendLabel, compactTokens } from './sidebar';
import { defaultSprite, frameAt, spriteLines, type Sprite } from './sprite';
import { bg, BOLD, DEFAULT_THEME, fg, RESET, type ColorToken, type Theme } from './theme';
import type { DeskAccountLimits, DeskItem, DeskLimits, DeskLimitWindow, DeskSpend, DeskSpendRow, DeskSpendTotals } from './types';
import { badge, bar, box, spread } from './widgets';

/** 카드 폭의 상한(넓은 화면에서 막대가 너무 길어지지 않게) */
const CARD_MAX = 96;
/** 5시간·주간 막대를 나란히 두는 글 폭의 하한 */
const SIDE_BY_SIDE_MIN = 44;
/** 경고 칩을 다는 쓴 비율 */
const WARN_CHIP_AT = 80;
/** 바닥나는 때를 추정하려면 창이 열린 뒤 이만큼 지나야 한다 */
const PROJECT_MIN_ELAPSED_MS = 30 * 60_000;
/** 바닥나는 때를 추정하려면 이만큼은 써야 한다(%) */
const PROJECT_MIN_USED = 5;
/** 고른 계정의 카드에 보이는 그 CLI의 오늘 모델 줄 수 */
const SPEND_ROWS = 3;
/** 표의 막대 폭 상한 */
const TABLE_BAR_MAX = 16;
/** 표의 열 사이 */
const TABLE_GAP = 2;
/** 표 아래 카드를 두려면 표가 차지할 수 있어야 하는 줄 수(머리줄 포함) */
const TABLE_MIN_ROWS = 3;
/** 요약에 적는 CLI의 차례 */
const BACKEND_ORDER = ['claude-code', 'codex', 'gemini'];

/** 사용량 화면의 그림 자리 열쇠. 세션 id와 섞이지 않게 앞에 acct:를 붙인다 */
export function usageSpriteKey(accountId: string): string {
  return `acct:${accountId}`;
}

/** 계정의 5시간·주간 창(카드 막대 꼴). 읽은 창이 없으면 없다 */
export function toDeskLimits(account: DeskAccountLimits): DeskLimits | undefined {
  const pick = (kind: 'five_hour' | 'weekly'): DeskLimitWindow | undefined => {
    const window = account.windows.find((entry) => entry.kind === kind);
    return window ? { usedPercent: window.usedPercent, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) } : undefined;
  };
  const fiveHour = pick('five_hour');
  const weekly = pick('weekly');
  if (!fiveHour && !weekly) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

/** 세션 id마다의 사용량 막대: 세션의 계정, 없으면 그 CLI의 기본 계정. 계정을 모르거나 읽은 창이 없으면 빠진다 */
export function sessionLimits(items: readonly DeskItem[], accounts: readonly DeskAccountLimits[]): Record<string, DeskLimits> {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const result: Record<string, DeskLimits> = {};
  for (const item of items) {
    const id = item.accountId ?? item.backend;
    const account = id ? byId.get(id) : undefined;
    const limits = account ? toDeskLimits(account) : undefined;
    if (limits) result[item.id] = limits;
  }
  return result;
}

function hhmm(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 요약 한 줄: "Claude 1/2 연결 · Codex 1/1 연결 · Gemini · 주간 평균 58% · 11:36 기준". 한도가 없는 CLI는 이름만 */
export function usageSummary(accounts: readonly DeskAccountLimits[]): string {
  const backends = [...new Set(accounts.map((account) => account.backend))].sort((a, b) => order(a) - order(b));
  const parts = backends.map((backend) => {
    const mine = accounts.filter((account) => account.backend === backend);
    if (mine.every((account) => account.status === 'unsupported')) return backendLabel(backend);
    const read = mine.filter((account) => account.windows.length > 0).length;
    return `${backendLabel(backend)} ${read}/${mine.length} 연결`;
  });
  const weekly = accounts.flatMap((account) => account.windows.filter((window) => window.kind === 'weekly').map((window) => window.usedPercent));
  if (weekly.length) parts.push(`주간 평균 ${Math.round(weekly.reduce((sum, value) => sum + value, 0) / weekly.length)}%`);
  const latest = accounts.map((account) => account.fetchedAt).filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value))).sort().at(-1);
  if (latest) parts.push(`${hhmm(latest)} 기준`);
  return parts.join(' · ');
}

function order(backend: string): number {
  const at = BACKEND_ORDER.indexOf(backend);
  return at < 0 ? BACKEND_ORDER.length : at;
}

/** 상태 표시(Nerd Font 없이 일반 기호). 다 쓴 계정은 어느 창을 다 썼는지 적는다 */
export function limitStatus(account: DeskAccountLimits): { mark: string; label: string; color: ColorToken } {
  switch (account.status) {
    case 'ok':
      return { mark: '✓', label: '여유', color: 'green' };
    case 'warn':
      return { mark: '▲', label: '주의', color: 'yellow' };
    case 'exhausted': {
      const spent = [...account.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
      const which = spent?.kind === 'weekly' ? '주간 ' : spent?.kind === 'five_hour' ? '5시간 ' : '';
      return { mark: '×', label: `${which}다 씀`, color: 'red' };
    }
    case 'idle':
      return { mark: '☾', label: '쉬는 중', color: 'purple' };
    case 'unsupported':
      return { mark: '·', label: '해당 없음', color: 'muted' };
    default:
      return { mark: '?', label: '모름', color: 'muted' };
  }
}

const WINDOW_LABEL: Record<'five_hour' | 'weekly', string> = { five_hour: '5시간', weekly: '주간' };
const WINDOW_MINUTES: Record<'five_hour' | 'weekly', number> = { five_hour: 300, weekly: 10_080 };

type Window = DeskAccountLimits['windows'][number];

/** 가까우면 "14:20", 하루를 넘으면 "10/29 14:20" */
function whenText(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return at - now < 86_400_000 ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** 다시 차는 때. 하루 안이면 시각을 덧붙인다: "1시간 50분 뒤(13:50)" */
function resetLine(iso: string | undefined, now: number): string {
  const text = resetText(iso, now);
  const at = iso ? Date.parse(iso) : NaN;
  if (!text || !Number.isFinite(at) || at - now <= 60_000 || at - now >= 86_400_000) return text;
  return `${text}(${whenText(at, now)})`;
}

/**
 * 지금 속도면 다시 차기 전에 바닥나는 때(ms). 창이 열린 뒤의 평균 속도로 셈한 추정이다.
 * 창이 열린 지 얼마 안 됐거나 거의 안 썼으면(표본이 적다), 다 썼거나, 다시 찰 때까지 넉넉하면 없다
 */
export function exhaustAt(window: Window, now: number): number | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const minutes = window.kind === 'other' ? window.minutes : WINDOW_MINUTES[window.kind];
  if (!Number.isFinite(reset) || !minutes || reset <= now) return undefined;
  const elapsed = now - (reset - minutes * 60_000);
  const used = window.usedPercent;
  if (elapsed < PROJECT_MIN_ELAPSED_MS || used < PROJECT_MIN_USED || used >= 100) return undefined;
  const at = now + Math.round(((100 - used) * elapsed) / used);
  return at < reset ? at : undefined;
}

function projectionText(window: Window, now: number): string | undefined {
  const at = exhaustAt(window, now);
  return at === undefined ? undefined : `이 속도면 ${whenText(at, now)}에 다 씀(추정)`;
}

/** 80%를 넘었고 아직 다 쓰지 않은 창의 경고 칩 */
function warnChip(window: Window, theme: Theme): { text: string; width: number } | undefined {
  if (window.usedPercent < WARN_CHIP_AT || window.usedPercent >= 100) return undefined;
  const label = `${WARN_CHIP_AT}% 넘음`;
  return { text: `${bg(theme, 'yellow')}${fg(theme, 'chrome')} ${label} ${RESET}`, width: stringWidth(label) + 2 };
}

/** 창 하나의 줄들: 이름과 %(오른쪽 맞춤), 막대, 다시 차는 때, 그리고 바닥날 것 같으면 그 추정 */
function windowBlock(window: Window, width: number, theme: Theme, now: number): string[] {
  const muted = fg(theme, 'muted');
  const label = WINDOW_LABEL[window.kind as 'five_hour' | 'weekly'] ?? `${window.minutes ?? '?'}분`;
  const percent = `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
  const chip = warnChip(window, theme);
  const left = `${muted}${label}${RESET}${chip && stringWidth(label) + chip.width + percent.length + 2 <= width ? ` ${chip.text}` : ''}`;
  const head = spread(left, `${BOLD}${fg(theme, 'text')}${percent}${RESET}`, width, percent.length);
  const lines = [head, bar(window.usedPercent, width, theme), fitAnsi(`${muted}${resetLine(window.resetsAt, now)}${RESET}`, width)];
  const projection = projectionText(window, now);
  if (projection) lines.push(fitAnsi(`${fg(theme, 'yellow')}${projection}${RESET}`, width));
  return lines;
}

/** 창 줄들: 넓으면 5시간·주간을 나란히, 좁으면 창마다 "이름 막대 %" 한 줄과 다시 차는 때 한 줄(바닥날 것 같으면 그 추정 한 줄) */
function windowLines(account: DeskAccountLimits, width: number, theme: Theme, now: number): string[] {
  const muted = fg(theme, 'muted');
  const windows = account.windows.filter((window) => window.kind !== 'other').sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0));
  if (account.status === 'unsupported') return [`${muted}5시간·주간 한도가 없는 CLI입니다(해당 없음)${RESET}`];
  if (windows.length === 0) return [account.error ? `${fg(theme, 'yellow')}읽지 못함${RESET} ${account.error}` : `${muted}아직 읽은 값이 없습니다${RESET}`];
  const lines: string[] = [];
  if (windows.length === 1 || width >= SIDE_BY_SIDE_MIN) {
    const gap = 3;
    const each = Math.floor((width - gap * (windows.length - 1)) / windows.length);
    const blocks = windows.map((window) => windowBlock(window, each, theme, now));
    const rows = Math.max(...blocks.map((block) => block.length));
    for (let row = 0; row < rows; row++) lines.push(blocks.map((block) => block[row] ?? ' '.repeat(each)).join(' '.repeat(gap)));
  } else {
    for (const window of windows) {
      const label = WINDOW_LABEL[window.kind as 'five_hour' | 'weekly'];
      const percent = `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
      const chip = warnChip(window, theme);
      const room = width - stringWidth(label) - percent.length - 2;
      const withChip = chip && room - chip.width - 1 >= 6 ? chip : undefined;
      const barWidth = Math.max(1, room - (withChip ? withChip.width + 1 : 0));
      lines.push(`${muted}${label}${RESET} ${withChip ? `${withChip.text} ` : ''}${bar(window.usedPercent, barWidth, theme)} ${BOLD}${percent}${RESET}`);
      lines.push(`${muted}${resetLine(window.resetsAt, now)}${RESET}`);
      const projection = projectionText(window, now);
      if (projection) lines.push(`${fg(theme, 'yellow')}${projection}${RESET}`);
    }
  }
  if (account.error) lines.push(`${muted}${account.error}${RESET}`);
  return lines;
}

/** 가장 많이 쓴 창의 %. 한도가 없거나 읽은 창이 없으면 -1 */
function tightness(account: DeskAccountLimits): number {
  if (account.status === 'unsupported' || account.windows.length === 0) return -1;
  return Math.max(...account.windows.map((window) => window.usedPercent));
}

/** 가장 빠듯한 계정부터(같으면 원래 차례). 한도가 없거나 읽지 못한 계정은 뒤로 간다 */
export function byTightness(accounts: readonly DeskAccountLimits[]): DeskAccountLimits[] {
  return [...accounts].sort((a, b) => tightness(b) - tightness(a));
}

/** 사이드바 맨 아래 한 줄: " 한도 Claude 5시간 82% · 13:50". 읽은 한도가 없으면 없다 */
export function tightestLine(accounts: readonly DeskAccountLimits[], width: number, theme: Theme = DEFAULT_THEME, now = Date.now()): string | undefined {
  const account = byTightness(accounts)[0];
  if (!account || tightness(account) < 0) return undefined;
  const window = [...account.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!;
  const label = WINDOW_LABEL[window.kind as 'five_hour' | 'weekly'] ?? `${window.minutes ?? '?'}분`;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const when = Number.isFinite(reset) && reset > now ? ` · ${reset - now < 86_400_000 ? whenText(reset, now) : `${new Date(reset).getMonth() + 1}/${new Date(reset).getDate()}`}` : '';
  const color = fg(theme, limitStatus(account).color);
  return fitAnsi(` ${fg(theme, 'muted')}한도${RESET} ${color}${backendLabel(account.backend)} ${label} ${Math.round(window.usedPercent)}%${RESET}${fg(theme, 'muted')}${when}${RESET}`, width);
}

export interface UsageCardInput {
  account: DeskAccountLimits;
  selected: boolean;
  sprite: Sprite;
  frame?: number;
  kitty?: KittyImages;
  /** 오늘·7일 쓴 양. 있으면 그 계정 CLI의 합계와 모델 줄을 카드 끝에 붙인다 */
  spend?: DeskSpend;
}

/** 계정 카드 한 장(테두리 포함). 줄마다 정확히 width칸이다 */
export function usageCardLines(card: UsageCardInput, width: number, theme: Theme = DEFAULT_THEME, now = Date.now()): string[] {
  const { account } = card;
  const art = artSize(width);
  const text = Math.max(1, width - 4 - art.cols - 2);
  const status = limitStatus(account);
  const statusText = `${fg(theme, status.color)}${status.mark} ${status.label}${RESET}`;
  const recommended = account.recommended ? ` ${bg(theme, 'accent')}${fg(theme, 'chrome')} 추천 ${RESET}` : '';
  const title = `${BOLD}${fg(theme, 'text')}${account.name ?? account.id}${RESET} ${badge(backendLabel(account.backend), theme)}${recommended}`;
  const muted = fg(theme, 'muted');
  const plan = [account.plan, account.stale ? '지난 값' : undefined].filter(Boolean).join(' · ');
  const body = [spread(title, statusText, text, stringWidth(`${status.mark} ${status.label}`)), plan ? `${muted}${plan}${RESET}` : '', ...windowLines(account, text, theme, now)];
  if (card.spend) body.push(...backendSpendLines(card.spend, account.backend, text, theme));
  while (body.length < art.rows) body.push('');
  const frame = card.frame ?? 0;
  const picture = card.kitty ? card.kitty.art(card.sprite, frame, art.cols, art.rows) : spriteLines(card.sprite, art.cols, art.rows, theme, frame);
  const inner = body.map((line, row) => `${picture[row] ?? ' '.repeat(art.cols)}  ${fitAnsi(line, text)}`);
  return box(inner, width, theme, { focused: card.selected });
}

function costText(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}

/** "$5.00 추정 포함 · 300만 토큰", 단가가 없는 모델이 섞였으면 "300만 토큰 · 합계 비용 없음" */
function totalsText(totals: DeskSpendTotals): string {
  const tokens = `${compactTokens(totals.tokens)} 토큰`;
  if (totals.costUsd !== undefined) return `${costText(totals.costUsd)}${totals.estimated ? ' 추정 포함' : ''} · ${tokens}`;
  // 단가가 없는 모델이 섞이면 합계 비용을 내지 않는다(일부만 더하면 실제보다 싸 보인다)
  return totals.missingPrice ? `${tokens} · 합계 비용 없음` : tokens;
}

/** 쓴 양 몇 줄(#925): 오늘·7일 합계, 오늘 많이 쓴 모델 줄(models가 false면 뺀다), 단가가 없으면 그 안내 */
export function spendLines(spend: DeskSpend, width: number, theme: Theme = DEFAULT_THEME, options: { models?: boolean } = {}): string[] {
  const muted = fg(theme, 'muted');
  const text = fg(theme, 'text');
  const lines = [fitAnsi(`  ${muted}오늘${RESET} ${BOLD}${text}${totalsText(spend.today)}${RESET}   ${muted}7일${RESET} ${text}${totalsText(spend.week)}${RESET}`, width)];
  const rows = options.models === false ? [] : spend.today.rows.slice(0, SPEND_ROWS);
  const modelWidth = Math.min(28, Math.max(0, ...rows.map((row) => stringWidth(row.model))));
  for (const row of rows) {
    const cost = row.costUsd === undefined ? `${muted}단가 없음${RESET}` : `${costText(row.costUsd)}${row.estimated ? ` ${muted}추정${RESET}` : ''}`;
    const backend = backendLabel(row.backend);
    const model = fit(row.model, modelWidth);
    const tokens = compactTokens(row.tokens).padStart(6);
    lines.push(fitAnsi(`    ${muted}${backend}${' '.repeat(Math.max(1, 8 - stringWidth(backend)))}${RESET}${model}  ${text}${tokens}${RESET}  ${cost}`, width));
  }
  if (spend.priceError) lines.push(fitAnsi(`  ${fg(theme, 'yellow')}${spend.priceError}${RESET}`, width));
  else if (spend.today.missingPrice || spend.week.missingPrice) lines.push(fitAnsi(`  ${muted}단가 없음: 비용을 보려면 B_STUDIO_TOKEN_PRICES_JSON에 모델 단가를 넣으세요${RESET}`, width));
  return lines;
}

/** 줄들만 더한 합계(CLI 하나 몫). 비용을 모르는 줄이 섞이면 합계 비용을 내지 않는다 */
function sumRows(rows: readonly DeskSpendRow[]): DeskSpendTotals {
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const missingPrice = rows.some((row) => row.costUsd === undefined);
  const cost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  return { tokens, ...(missingPrice ? {} : { costUsd: cost }), estimated: rows.some((row) => row.estimated), missingPrice, rows: [...rows] };
}

/**
 * 고른 계정의 카드 끝 몇 줄: 그 CLI의 오늘·7일과 오늘 많이 쓴 모델. 쓴 양은 CLI·모델별로만 모으므로
 * 같은 CLI의 다른 계정 몫도 섞여 있다("Claude 전체"). 그 CLI가 쓴 것이 없으면 없다
 */
function backendSpendLines(spend: DeskSpend, backend: string, width: number, theme: Theme): string[] {
  const today = spend.today.rows.filter((row) => row.backend === backend);
  const week = spend.week.rows.filter((row) => row.backend === backend);
  if (today.length === 0 && week.length === 0) return [];
  const muted = fg(theme, 'muted');
  const text = fg(theme, 'text');
  const lines = ['', fitAnsi(`${muted}${backendLabel(backend)} 전체${RESET}  ${muted}오늘${RESET} ${text}${totalsText(sumRows(today))}${RESET}  ${muted}7일${RESET} ${text}${totalsText(sumRows(week))}${RESET}`, width)];
  const rows = today.slice(0, SPEND_ROWS);
  const modelWidth = Math.min(28, Math.max(0, ...rows.map((row) => stringWidth(row.model))));
  for (const row of rows) {
    const cost = row.costUsd === undefined ? `${muted}단가 없음${RESET}` : `${costText(row.costUsd)}${row.estimated ? ` ${muted}추정${RESET}` : ''}`;
    lines.push(fitAnsi(`  ${fit(row.model, modelWidth)}  ${text}${compactTokens(row.tokens).padStart(6)}${RESET}  ${cost}`, width));
  }
  return lines;
}

/** 표의 다시 차는 때: 하루 안이면 "1시간 50분 뒤", 넘으면 "3일 뒤"(정확한 시각은 카드에) */
function shortReset(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  if (at - now < 86_400_000) return resetText(iso, now);
  return `${Math.floor((at - now) / 86_400_000)}일 뒤`;
}

/** 표의 열 구성. 좁으면 뒤의 구성으로 물러난다 */
interface TableColumns {
  plan: boolean;
  reset: boolean;
  bars: boolean;
  ai: boolean;
}
const TABLE_FALLBACK: readonly TableColumns[] = [
  { plan: true, reset: true, bars: true, ai: true },
  { plan: false, reset: true, bars: true, ai: true },
  { plan: false, reset: false, bars: true, ai: true },
  { plan: false, reset: false, bars: false, ai: true },
  { plan: false, reset: false, bars: false, ai: false },
];
/** 막대를 두려면 칸마다 이만큼은 있어야 한다 */
const TABLE_BAR_MIN = 6;
const PERCENT_WIDTH = 4;
const RESET_WIDTH = 13;
const STATUS_WIDTH = 12;
const AI_WIDTH = 6;

interface TableLayout extends TableColumns {
  name: number;
  planWidth: number;
  bar: number;
}

/** 폭에 맞는 표 배치. 이름 칸은 남는 폭에서 줄인다(최소 4칸) */
function tableLayout(accounts: readonly DeskAccountLimits[], width: number): TableLayout {
  const nameWant = Math.max(4, Math.min(12, Math.max(...accounts.map((account) => stringWidth(account.name ?? account.id)))));
  const planWant = Math.max(stringWidth('요금제'), Math.min(10, Math.max(...accounts.map((account) => stringWidth(account.plan ?? '')))));
  // 앞 표시(2) + 이름 + 각 열(앞에 틈) + 상태
  const fixed = (columns: TableColumns, name: number) =>
    2 + name + (columns.ai ? TABLE_GAP + AI_WIDTH : 0) + (columns.plan ? TABLE_GAP + planWant : 0) + 2 * (TABLE_GAP + PERCENT_WIDTH) + (columns.reset ? TABLE_GAP + RESET_WIDTH : 0) + TABLE_GAP + STATUS_WIDTH;
  for (const columns of TABLE_FALLBACK) {
    const rest = width - fixed(columns, nameWant);
    if (columns.bars) {
      const bar = Math.min(TABLE_BAR_MAX, Math.floor((rest - 2) / 2));
      if (bar >= TABLE_BAR_MIN) return { ...columns, name: nameWant, planWidth: planWant, bar };
      continue;
    }
    if (rest >= 0) return { ...columns, name: nameWant, planWidth: planWant, bar: 0 };
  }
  const last = TABLE_FALLBACK.at(-1)!;
  return { ...last, name: Math.max(4, nameWant + width - fixed(last, nameWant)), planWidth: planWant, bar: 0 };
}

/** 칸 하나를 정확히 width칸으로(ANSI 포함 글은 보이는 폭으로 맞춘다) */
function cell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const shown = stringWidth(stripAnsi(text));
  if (shown > width) return fitAnsi(text, width);
  const pad = ' '.repeat(width - shown);
  return align === 'right' ? pad + text : text + pad;
}

/** 표의 창 칸: "막대 37%". 그 창이 없으면 ─ */
function windowCell(window: Window | undefined, layout: TableLayout, theme: Theme): string {
  const width = (layout.bars ? layout.bar + 1 : 0) + PERCENT_WIDTH;
  if (!window) return cell(`${fg(theme, 'muted')}─${RESET}`, width);
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const tone = used >= 100 ? 'red' : used >= WARN_CHIP_AT ? 'yellow' : 'text';
  const percent = cell(`${BOLD}${fg(theme, tone)}${used}%${RESET}`, PERCENT_WIDTH, 'right');
  return layout.bars ? `${bar(window.usedPercent, layout.bar, theme)} ${percent}` : percent;
}

/** 표의 머리줄 */
function tableHeader(layout: TableLayout, theme: Theme): string {
  const muted = fg(theme, 'muted');
  const windowWidth = (layout.bars ? layout.bar + 1 : 0) + PERCENT_WIDTH;
  const parts = [`  ${cell('계정', layout.name)}`];
  if (layout.ai) parts.push(cell('AI', AI_WIDTH));
  if (layout.plan) parts.push(cell('요금제', layout.planWidth));
  parts.push(cell('5시간', windowWidth), cell('주간', windowWidth));
  if (layout.reset) parts.push(cell('다시 참', RESET_WIDTH));
  parts.push(cell('상태', STATUS_WIDTH));
  return `${muted}${parts.join(' '.repeat(TABLE_GAP))}${RESET}`;
}

/** 계정 한 줄. 고른 줄은 앞에 ▸와 굵은 이름 */
function tableRow(account: DeskAccountLimits, selected: boolean, layout: TableLayout, theme: Theme, now: number): string {
  const muted = fg(theme, 'muted');
  const name = account.name ?? account.id;
  const mark = selected ? `${fg(theme, 'accent')}▸${RESET} ` : '  ';
  const parts = [`${mark}${cell(selected ? `${BOLD}${fg(theme, 'text')}${name}${RESET}` : `${fg(theme, 'text')}${name}${RESET}`, layout.name)}`];
  if (layout.ai) parts.push(cell(`${muted}${backendLabel(account.backend)}${RESET}`, AI_WIDTH));
  if (layout.plan) parts.push(cell(`${muted}${account.plan ?? ''}${RESET}`, layout.planWidth));
  const find = (kind: 'five_hour' | 'weekly') => (account.status === 'unsupported' ? undefined : account.windows.find((window) => window.kind === kind));
  parts.push(windowCell(find('five_hour'), layout, theme), windowCell(find('weekly'), layout, theme));
  if (layout.reset) {
    const tightest = [...account.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    parts.push(cell(`${muted}${account.status === 'unsupported' ? '' : shortReset(tightest?.resetsAt, now)}${RESET}`, RESET_WIDTH));
  }
  const status = account.status === 'unknown' && account.windows.length === 0 && account.error ? { mark: '!', label: '읽지 못함', color: 'yellow' as ColorToken } : limitStatus(account);
  parts.push(cell(`${fg(theme, status.color)}${status.mark} ${status.label}${RESET}`, STATUS_WIDTH));
  return parts.join(' '.repeat(TABLE_GAP));
}

export interface UsageScreen {
  lines: string[];
  /** 화면에 보이는 계정 줄과 그 자리(화면 좌표, 한 줄씩) */
  cards: Array<{ index: number; rect: Rect }>;
}

/** 계정의 그림: 사용량 화면의 그림 자리, 없으면 desk의 기본 그림 */
export function accountSprite(account: DeskAccountLimits, sprites: Readonly<Record<string, Sprite>> = {}): Sprite {
  return sprites[usageSpriteKey(account.id)] ?? defaultSprite(account.backend);
}

/** 사용량 화면. rect는 본문 자리(칸들이 놓이던 곳)다 */
export function usageScreen(state: DeskState, rect: Rect, now = Date.now()): UsageScreen {
  const theme = state.theme ?? DEFAULT_THEME;
  const muted = fg(theme, 'muted');
  const blank = ' '.repeat(rect.w);
  const usage = state.usage;
  const accounts = usage?.accounts ?? [];
  const lines: string[] = [];
  const cards: UsageScreen['cards'] = [];
  const summary = accounts.length ? usageSummary(accounts) : '';
  lines.push(fitAnsi(`  ${BOLD}${fg(theme, 'text')}사용량${RESET}  ${muted}${summary}${RESET}`, rect.w));
  const notes = [usage?.warning, usage?.error].filter((note): note is string => Boolean(note));
  for (const note of notes) lines.push(fitAnsi(`  ${fg(theme, 'yellow')}${note}${RESET}`, rect.w));
  if (usage?.spend && accounts.length) lines.push(...spendLines(usage.spend, rect.w, theme, { models: false }));
  lines.push(blank);
  if (accounts.length === 0) {
    const empty = usage?.unsupported
      ? '사용량을 알려 주지 않는 스튜디오입니다. 스튜디오를 새 판으로 다시 띄우세요(pnpm studio stop 뒤 pnpm studio)'
      : !usage
        ? '사용량을 읽는 중…'
        : usage.error
          ? ''
          : '사용량을 볼 계정이 없습니다';
    if (empty) lines.push(fit(`  ${empty}`, rect.w));
    while (lines.length < rect.h) lines.push(blank);
    return { lines: lines.slice(0, rect.h), cards };
  }

  const selected = Math.max(0, Math.min(accounts.length - 1, state.usageSelected ?? 0));
  const tableWidth = Math.max(1, rect.w - 1);
  const layout = tableLayout(accounts, tableWidth);
  const account = accounts[selected]!;
  const sprite = accountSprite(account, state.sprites);
  const cardWidth = Math.min(CARD_MAX, Math.max(ART_NARROW.cols + 10, rect.w - 2));
  const card = usageCardLines(
    { account, selected: true, sprite, frame: frameAt(sprite, state.spriteClock ?? 0), ...(state.kitty ? { kitty: state.kitty } : {}), ...(usage?.spend ? { spend: usage.spend } : {}) },
    cardWidth,
    theme,
    now,
  );
  // 표(머리줄 + 계정 줄)를 먼저 다 두고, 남는 자리에 고른 계정의 카드를 둔다. 카드를 두면 표가 너무 줄면 카드를 뺀다
  const room = rect.h - lines.length;
  const withCard = room - (card.length + 1) >= Math.min(TABLE_MIN_ROWS, accounts.length + 1);
  const tableRoom = withCard ? Math.min(accounts.length + 1, room - card.length - 1) : room;
  const rows = Math.max(0, tableRoom - 1);
  let first = 0;
  if (rows > 0 && selected >= rows) first = selected - rows + 1;
  lines.push(fitAnsi(` ${tableHeader(layout, theme)}`, rect.w));
  for (let index = first; index < accounts.length && index < first + rows; index++) {
    cards.push({ index, rect: { x: rect.x, y: rect.y + lines.length, w: rect.w, h: 1 } });
    lines.push(fitAnsi(` ${tableRow(accounts[index]!, index === selected, layout, theme, now)}`, rect.w));
  }
  if (withCard) {
    lines.push(blank);
    for (const line of card) lines.push(fitAnsi(` ${line}`, rect.w));
  }
  const shown = lines.slice(0, rect.h);
  while (shown.length < rect.h) shown.push(blank);
  return { lines: shown, cards: cards.filter((entry) => entry.rect.y < rect.y + rect.h) };
}

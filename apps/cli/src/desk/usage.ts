/**
 * 사용량 화면(#889): 계정마다 카드 하나. 카드는 왼쪽에 그림, 오른쪽에 이름·CLI 배지·추천·상태, 플랜, 5시간·주간 막대와 %,
 * 그 아래 다시 차는 때를 놓는다. 맨 위에는 제목과 요약 한 줄(CLI마다 읽은 계정 수, 주간 평균, 기준 시각)을 둔다.
 * 세션 카드(스페이스 화면)의 사용량 막대도 여기서 잇는다: 세션의 계정, 없으면 그 CLI의 기본 계정(id가 CLI 이름)이다
 */
import { ART_NARROW, artSize, resetText } from './cards';
import type { DeskState } from './keys';
import type { KittyImages } from './kitty';
import { fit, fitAnsi, stringWidth, type Rect } from './screen';
import { backendLabel } from './sidebar';
import { defaultSprite, frameAt, spriteLines, type Sprite } from './sprite';
import { bg, BOLD, DEFAULT_THEME, fg, RESET, type ColorToken, type Theme } from './theme';
import type { DeskAccountLimits, DeskItem, DeskLimits, DeskLimitWindow } from './types';
import { badge, bar, box, spread } from './widgets';

/** 카드 폭의 상한(넓은 화면에서 막대가 너무 길어지지 않게) */
const CARD_MAX = 96;
/** 5시간·주간 막대를 나란히 두는 글 폭의 하한 */
const SIDE_BY_SIDE_MIN = 44;
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

/** 창 하나의 세 줄: 이름과 %(오른쪽 맞춤), 막대, 다시 차는 때 */
function windowBlock(window: DeskAccountLimits['windows'][number], width: number, theme: Theme, now: number): [string, string, string] {
  const muted = fg(theme, 'muted');
  const label = WINDOW_LABEL[window.kind as 'five_hour' | 'weekly'] ?? `${window.minutes ?? '?'}분`;
  const percent = `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
  const head = spread(`${muted}${label}${RESET}`, `${BOLD}${fg(theme, 'text')}${percent}${RESET}`, width, percent.length);
  return [head, bar(window.usedPercent, width, theme), fitAnsi(`${muted}${resetText(window.resetsAt, now)}${RESET}`, width)];
}

/** 창 줄들: 넓으면 5시간·주간을 나란히(세 줄), 좁으면 창마다 "이름 막대 %" 한 줄과 다시 차는 때 한 줄 */
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
    for (let row = 0; row < 3; row++) lines.push(blocks.map((block) => block[row]).join(' '.repeat(gap)));
  } else {
    for (const window of windows) {
      const label = WINDOW_LABEL[window.kind as 'five_hour' | 'weekly'];
      const percent = `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
      const barWidth = Math.max(1, width - stringWidth(label) - percent.length - 2);
      lines.push(`${muted}${label}${RESET} ${bar(window.usedPercent, barWidth, theme)} ${BOLD}${percent}${RESET}`);
      lines.push(`${muted}${resetText(window.resetsAt, now)}${RESET}`);
    }
  }
  if (account.error) lines.push(`${muted}${account.error}${RESET}`);
  return lines;
}

export interface UsageCardInput {
  account: DeskAccountLimits;
  selected: boolean;
  sprite: Sprite;
  frame?: number;
  kitty?: KittyImages;
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
  while (body.length < art.rows) body.push('');
  const frame = card.frame ?? 0;
  const picture = card.kitty ? card.kitty.art(card.sprite, frame, art.cols, art.rows) : spriteLines(card.sprite, art.cols, art.rows, theme, frame);
  const inner = body.map((line, row) => `${picture[row] ?? ' '.repeat(art.cols)}  ${fitAnsi(line, text)}`);
  return box(inner, width, theme, { focused: card.selected });
}

export interface UsageScreen {
  lines: string[];
  /** 화면에 보이는 카드와 그 자리(화면 좌표) */
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

  const cardWidth = Math.min(CARD_MAX, Math.max(ART_NARROW.cols + 10, rect.w - 2));
  const selected = Math.max(0, Math.min(accounts.length - 1, state.usageSelected ?? 0));
  const rendered = accounts.map((account, index) => {
    const sprite = accountSprite(account, state.sprites);
    return usageCardLines(
      { account, selected: index === selected, sprite, frame: frameAt(sprite, state.spriteClock ?? 0), ...(state.kitty ? { kitty: state.kitty } : {}) },
      cardWidth,
      theme,
      now,
    );
  });
  // 고른 카드가 보이게 위 카드를 건너뛴다
  const room = rect.h - lines.length;
  let first = 0;
  const span = (from: number, to: number) => rendered.slice(from, to + 1).reduce((sum, card) => sum + card.length, 0);
  while (first < selected && span(first, selected) > room) first++;
  for (let index = first; index < rendered.length && lines.length < rect.h; index++) {
    const top = lines.length;
    for (const line of rendered[index]!) lines.push(fitAnsi(` ${line}`, rect.w));
    cards.push({ index, rect: { x: rect.x + 1, y: rect.y + top, w: cardWidth, h: rendered[index]!.length } });
  }
  const shown = lines.slice(0, rect.h);
  while (shown.length < rect.h) shown.push(blank);
  return { lines: shown, cards: cards.filter((card) => card.rect.y < rect.y + rect.h) };
}


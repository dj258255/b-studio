/**
 * 스페이스 화면(#887): 고른 세션이 든 스페이스(프로젝트)의 세션마다 카드 하나. 카드는 왼쪽에 픽셀 그림, 오른쪽에
 * 이름·AI 배지·상태, 지금 하는 일(도구와 대상, 기다리면 그 까닭), 할 일 진행·문맥 창, 서브에이전트, 마지막 답, 게이트·토큰,
 * (있으면) 5시간·주간 사용량 막대를 놓는다. 고른 카드는 테두리를 강조색으로 그리고 서브에이전트·범위·마지막 답을 펼친다.
 * 화면 폭에 따라 1~2열이고, 높이가 모자라면 마지막 답, 할 일·문맥, 사용량 차례로 줄을 뺀다(#921)
 */
import type { DeskState } from './keys';
import { fit, fitAnsi, stringWidth, type Rect } from './screen';
import { agentStatus, backendLabel, compactTokens, deskSessions, deskSpaces, detailLines, gateStatus, subagentName, totalTokens } from './sidebar';
import type { KittyImages } from './kitty';
import { defaultSprite, frameAt, spriteLines, type Sprite } from './sprite';
import { BOLD, DEFAULT_THEME, fg, RESET, type Theme } from './theme';
import type { DeskItem, DeskLimits, DeskLimitWindow } from './types';
import { badge, bar, box, contextColor, spread, statusColor, statusText, TONE_COLOR } from './widgets';

/** 카드 두 열을 놓는 카드 폭의 하한 */
const CARD_MIN = 52;
/** 카드 폭의 상한(넓은 화면에서 한 열일 때 막대와 글이 너무 벌어지지 않게) */
const CARD_MAX = 84;
/** 그림 자리(칸 × 줄). 카드가 넓으면 크게, 좁으면 작게 둔다. 그림은 카드 높이를 채운다(#902) */
export const ART_WIDE = { cols: 14, rows: 7 } as const;
export const ART_NARROW = { cols: 12, rows: 5 } as const;
/** 큰 그림 자리를 쓰는 카드 폭의 하한 */
const ART_WIDE_MIN = 64;

export function artSize(cardWidth: number): { cols: number; rows: number } {
  return cardWidth >= ART_WIDE_MIN ? ART_WIDE : ART_NARROW;
}
/** 고른 카드에 펼치는 줄의 상한 */
const DETAIL_MAX = 8;
/** 고른 카드에 마지막 답을 이어 펼치는 줄의 상한 */
const LAST_MORE = 2;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 카드의 그림: 세션 id, AI 이름, default 차례로 찾고, 없으면 desk의 기본 그림 */
export function spriteFor(item: DeskItem, sprites: Readonly<Record<string, Sprite>> = {}): Sprite {
  return sprites[item.id] ?? (item.backend ? sprites[item.backend] : undefined) ?? sprites.default ?? defaultSprite(item.backend);
}

/** 다시 차는 때: 하루 안이면 "1시간 50분 뒤", 아니면 "10/26(월) 02:00"(이 컴퓨터 시각) */
export function resetText(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const left = at - now;
  if (left <= 60_000) return '곧 다시 참';
  if (left < 86_400_000) {
    const hours = Math.floor(left / 3_600_000);
    const minutes = Math.floor((left % 3_600_000) / 60_000);
    return `${hours ? `${hours}시간 ` : ''}${minutes}분 뒤`;
  }
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAY[date.getDay()]}) ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 마지막 활동에서 지난 시간: "방금", "3분 전", "2시간 전", "4일 전" */
function since(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const gone = Math.max(0, now - at);
  if (gone < 60_000) return '방금';
  if (gone < 3_600_000) return `${Math.floor(gone / 60_000)}분 전`;
  if (gone < 86_400_000) return `${Math.floor(gone / 3_600_000)}시간 전`;
  return `${Math.floor(gone / 86_400_000)}일 전`;
}

/** 지난 시간을 짧게: "20초", "2분", "1시간" */
function elapsed(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const gone = Math.max(0, now - at);
  if (gone < 60_000) return `${Math.floor(gone / 1000)}초`;
  if (gone < 3_600_000) return `${Math.floor(gone / 60_000)}분`;
  return `${Math.floor(gone / 3_600_000)}시간`;
}

/** CLI 도구 이름을 우리말로. 모르는 도구(MCP 등)는 그대로 둔다 */
const TOOL_LABEL: Record<string, string> = {
  Edit: '편집',
  MultiEdit: '편집',
  NotebookEdit: '편집',
  apply_patch: '편집',
  Write: '쓰기',
  Read: '읽기',
  Bash: '실행',
  shell: '실행',
  exec_command: '실행',
  Grep: '찾기',
  Glob: '찾기',
  WebFetch: '웹',
  WebSearch: '웹',
  Agent: '맡김',
  Task: '맡김',
  TodoWrite: '할 일',
  TaskCreate: '할 일',
  TaskUpdate: '할 일',
};

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

/**
 * 지금 하는 일. 권한·답·입력을 기다리면 그 까닭을 먼저, 아니면 지금 쓰는 도구와 대상(#921),
 * 그것도 없으면 메인 에이전트의 마지막 활동, 그것도 없으면 마지막 활동 때
 */
function nowLine(item: DeskItem, theme: Theme, now: number): string {
  const status = agentStatus(item);
  const waiting = item.terminal?.waiting;
  if (item.terminal?.message && waiting && waiting !== 'idle') {
    return `${fg(theme, statusColor(status))}${status.label}${RESET} ${fg(theme, 'muted')}·${RESET} ${item.terminal.message}`;
  }
  const label = `${fg(theme, 'muted')}지금${RESET} `;
  if (item.now) {
    const ago = elapsed(item.now.at, now);
    return label + `${toolLabel(item.now.tool)}${item.now.target ? ` ${item.now.target}` : ''}${ago ? `${fg(theme, 'muted')} · ${ago}${RESET}` : ''}`;
  }
  const main = item.agents?.find((agent) => agent.kind === 'main');
  if (main?.activity) return label + main.activity;
  const ago = since(item.lastActivityAt, now);
  return label + `${fg(theme, 'muted')}${ago ? `마지막 활동 ${ago}` : '기록 없음'}${RESET}`;
}

/** 할 일 진행과 문맥 창 막대를 한 줄에. 문맥은 오른쪽에 붙이고 할 일은 남는 폭에 맞춘다 */
function progressLine(item: DeskItem, width: number, theme: Theme): string {
  const muted = fg(theme, 'muted');
  const todos = item.todos && item.todos.total > 0 ? `${muted}할 일${RESET} ${BOLD}${item.todos.done}/${item.todos.total}${RESET}${item.todos.current ? ` ${item.todos.current}` : ''}` : '';
  if (!item.context) return todos;
  const pct = Math.round(Math.max(0, Math.min(100, item.context.usedPct)));
  const barWidth = width >= 48 ? 10 : 5;
  const context = `${muted}문맥${RESET} ${bar(pct, barWidth, theme, contextColor)} ${fg(theme, contextColor(pct))}${pct}%${RESET}`;
  const contextWidth = stringWidth('문맥 ') + barWidth + 1 + String(pct).length + 1;
  if (!todos) return context;
  return spread(todos, context, width, contextWidth);
}

/** 마지막 답 한 줄 */
function lastLine(item: DeskItem, theme: Theme): string {
  return item.lastMessage ? `${fg(theme, 'muted')}답${RESET} ${oneLine(item.lastMessage)}` : '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 글을 보이는 폭 width칸씩 자른다(넓은 글자는 두 칸) */
function chunks(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const char of text) {
    if (stringWidth(line + char) > width) {
      out.push(line);
      line = '';
    }
    line += char;
  }
  if (line) out.push(line);
  return out;
}

/** 고른 카드에 이어 펼치는 마지막 답: 첫 줄(카드 몸에 보인 것) 다음부터 두 줄까지, 넘치면 끝에 … */
function lastMore(item: DeskItem, width: number): string[] {
  if (!item.lastMessage) return [];
  const [, ...rest] = chunks(`답 ${oneLine(item.lastMessage)}`, width);
  const shown = rest.slice(0, LAST_MORE);
  if (rest.length > LAST_MORE && shown.length) shown[shown.length - 1] = `${fit(shown.at(-1)!, width - 1).trimEnd()}…`;
  return shown;
}

/** 서브에이전트 요약: 작업 중인 수와 그 하나의 맡은 일·도구. 없으면 모델 */
function agentsLine(item: DeskItem, theme: Theme): string {
  const subagents = (item.agents ?? []).filter((agent) => agent.kind === 'subagent');
  const muted = fg(theme, 'muted');
  if (subagents.length === 0) return item.capabilities?.model ? `${muted}모델${RESET} ${item.capabilities.model}` : '';
  const working = subagents.filter((agent) => agent.state === 'working');
  if (working.length === 0) return `${muted}↳ 서브에이전트 ${subagents.length}개 쉼${RESET}`;
  const first = working[0]!;
  const doing = first.tool ?? first.activity;
  return `${fg(theme, 'accent')}↳${RESET} 서브에이전트 ${working.length}개 작업 중 · ${subagentName(first)}${doing ? `: ${doing}` : ''}`;
}

/** 게이트·체크포인트·토큰·비용·칸 */
function factsLine(item: DeskItem, slot: number | undefined, theme: Theme): string {
  const muted = fg(theme, 'muted');
  const parts: string[] = [];
  const gate = gateStatus(item);
  if (gate) parts.push(`${muted}검증${RESET} ${fg(theme, TONE_COLOR[gate.tone])}${gate.label}${RESET}`);
  if (item.gate && item.gate.checkpoints > 0) parts.push(`${muted}체크포인트${RESET} ${item.gate.checkpoints}`);
  if (item.tokens && totalTokens(item.tokens) > 0) parts.push(`${muted}토큰${RESET} ${compactTokens(totalTokens(item.tokens))}`);
  if (item.costUsd !== undefined && item.costUsd > 0) parts.push(`$${item.costUsd.toFixed(2)}`);
  if (slot) parts.push(`${fg(theme, 'accent')}칸 ${slot}${RESET}`);
  return parts.length ? parts.join(`${muted} · ${RESET}`) : `${muted}검증 기록 없음${RESET}`;
}

/** 사용량 두 줄: 5시간·주간 막대와 %, 그 아래 다시 차는 때 */
function limitLines(limits: DeskLimits | undefined, width: number, theme: Theme, now: number): [string, string] {
  const muted = fg(theme, 'muted');
  const windows: Array<[string, DeskLimitWindow]> = [];
  if (limits?.fiveHour) windows.push(['5시간', limits.fiveHour]);
  if (limits?.weekly) windows.push(['주간', limits.weekly]);
  if (windows.length === 0) return [`${muted}사용량 정보 없음${RESET}`, ''];
  const gap = 2;
  const half = Math.floor((width - gap * (windows.length - 1)) / windows.length);
  const tops: string[] = [];
  const bottoms: string[] = [];
  for (const [label, window] of windows) {
    const percent = `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
    const barWidth = Math.max(1, half - stringWidth(label) - percent.length - 2);
    tops.push(fitAnsi(`${muted}${label}${RESET} ${bar(window.usedPercent, barWidth, theme)} ${BOLD}${percent}${RESET}`, half));
    bottoms.push(fitAnsi(`${muted}${resetText(window.resetsAt, now)}${RESET}`, half));
  }
  return [tops.join(' '.repeat(gap)), bottoms.join(' '.repeat(gap))];
}

export interface CardInput {
  item: DeskItem;
  selected: boolean;
  flagged: boolean;
  /** 끝났지만 아직 보지 않은 세션(#922). 쉬는 CLI를 초록 "끝남"으로 보인다 */
  unseen?: boolean;
  slot?: number;
  limits?: DeskLimits;
  /** 이 화면의 카드 가운데 하나라도 사용량이 있으면 모든 카드에 사용량 두 줄 자리를 둔다(높이를 맞춘다) */
  withLimits: boolean;
  /** 할 일·문맥 줄 자리. 없으면 이 카드에 그 값이 있을 때만 둔다(#921) */
  withProgress?: boolean;
  /** 마지막 답 줄 자리. 없으면 이 카드에 마지막 답이 있을 때만 둔다 */
  withLast?: boolean;
  sprite: Sprite;
  /** 움짤의 보일 프레임 번호(없으면 첫 프레임) */
  frame?: number;
  /** 있으면 그림을 Kitty 그래픽으로 그린다(없으면 반칸 블록) */
  kitty?: KittyImages;
}

/** 카드 안쪽의 줄 수: 글 줄(기본 4, 사용량 2, 할 일·문맥과 마지막 답은 있으면 1씩)과 그림 높이 가운데 큰 것 */
export function baseRows(withLimits: boolean, art: { rows: number } = ART_WIDE, extra = 0): number {
  return Math.max((withLimits ? 6 : 4) + extra, art.rows);
}

/** 카드 한 장의 줄(테두리 포함). 줄마다 정확히 width칸이다 */
export function cardLines(card: CardInput, width: number, theme: Theme = DEFAULT_THEME, now = Date.now()): string[] {
  const { item } = card;
  const art = artSize(width);
  const withProgress = card.withProgress ?? Boolean((item.todos && item.todos.total > 0) || item.context);
  const withLast = card.withLast ?? Boolean(item.lastMessage);
  const rows = baseRows(card.withLimits, art, Number(withProgress) + Number(withLast));
  const text = Math.max(1, width - 4 - art.cols - 2);
  const status = agentStatus(item, { unseen: card.unseen ?? false });
  const statusWidth = stringWidth(status.label) + 2;
  const flag = card.flagged ? ` ${fg(theme, 'yellow')}!${RESET}` : '';
  const title = `${BOLD}${fg(theme, 'text')}${item.title}${RESET} ${badge(backendLabel(item.backend), theme)}${flag}`;
  const body = [spread(title, statusText(status, theme), text, statusWidth), nowLine(item, theme, now)];
  if (withProgress) body.push(progressLine(item, text, theme));
  body.push(agentsLine(item, theme));
  if (withLast) body.push(lastLine(item, theme));
  body.push(factsLine(item, card.slot, theme));
  if (card.withLimits) body.push(...limitLines(card.limits, text, theme, now));
  while (body.length < rows) body.push('');
  const frame = card.frame ?? 0;
  const picture = card.kitty ? card.kitty.art(card.sprite, frame, art.cols, art.rows) : spriteLines(card.sprite, art.cols, art.rows, theme, frame);
  const inner = body.map((line, row) => `${picture[row] ?? ' '.repeat(art.cols)}  ${fitAnsi(line, text)}`);
  if (card.selected) {
    const pad = ' '.repeat(art.cols + 2);
    if (withLast) for (const more of lastMore(item, text)) inner.push(`${pad}${fitAnsi(more, text)}`);
    for (const detail of detailLines(item).slice(0, DETAIL_MAX)) {
      let line = detail.text;
      for (const tone of detail.tones) line = line.replace(tone.text, `${fg(theme, TONE_COLOR[tone.tone])}${tone.text}${RESET}`);
      inner.push(`${pad}${fitAnsi(line, text)}`);
    }
  }
  return box(inner, width, theme, { focused: card.selected });
}

/** 스페이스 화면에 놓일 세션들(고른 세션이 든 스페이스). 스페이스 화면이 아니어도 돌려준다 */
export function spaceItems(state: DeskState): DeskItem[] {
  const sessions = deskSessions(state.items);
  const space = deskSpaces(state.items).find((entry) => entry.sessions.includes(state.selected));
  return space ? space.sessions.map((index) => sessions[index]!) : [];
}

/** 카드에서 뺄 수 있는 줄 자리 */
interface LineSlots {
  limits: boolean;
  progress: boolean;
  last: boolean;
}
/** 높이가 모자랄 때 줄을 빼는 차례: 마지막 답, 할 일·문맥, 사용량 */
const DROP_ORDER: ReadonlyArray<keyof LineSlots> = ['last', 'progress', 'limits'];

export interface SpaceScreen {
  /** 본문 자리에 놓을 줄. 줄마다 정확히 본문 폭이다 */
  lines: string[];
  /** 화면에 보이는 카드와 그 자리(화면 좌표). 마우스로 누른 카드를 가릴 때 쓴다 */
  cards: Array<{ index: number; rect: Rect }>;
}

/** 스페이스 화면. rect는 본문 자리(칸들이 놓이던 곳)다 */
export function spaceScreen(state: DeskState, rect: Rect, now = Date.now()): SpaceScreen {
  const theme = state.theme ?? DEFAULT_THEME;
  const muted = fg(theme, 'muted');
  const sessions = deskSessions(state.items);
  const lines: string[] = [];
  const cards: SpaceScreen['cards'] = [];
  const blank = ' '.repeat(rect.w);
  const space = deskSpaces(state.items).find((entry) => entry.sessions.includes(state.selected));
  if (!space) {
    lines.push(
      fit('', rect.w),
      fit('  세션이 없습니다.', rect.w),
      fit('', rect.w),
      fit('  처음이면 a 를 눌러 내 폴더를 프로젝트로 등록합니다(경로를 쓰고 Tab으로 채우고 Enter).', rect.w),
      fit('  등록한 프로젝트가 있으면 n 으로 새 요청을 보냅니다. AI의 터미널이 칸에 열리고 여기 카드가 생깁니다.', rect.w),
    );
    while (lines.length < rect.h) lines.push(blank);
    return { lines, cards };
  }
  lines.push(fitAnsi(`  ${BOLD}${fg(theme, 'text')}${space.name}${RESET}  ${muted}에이전트 ${space.sessions.length}${RESET}`, rect.w), blank);

  const slotOf = new Map<string, number>();
  state.slots.forEach((id, slot) => {
    if (id && slot < state.layout) slotOf.set(id, slot + 1);
  });
  const flagged = new Set(state.flagged ?? []);
  const unseen = new Set(state.unseenDone ?? []);
  const spaceSessions = space.sessions.map((index) => sessions[index]!);
  const columns = rect.w - 2 >= CARD_MIN * 2 + 1 ? 2 : 1;
  const cardWidth = Math.min(CARD_MAX, Math.max(ART_NARROW.cols + 8, Math.floor((rect.w - 2 - (columns - 1)) / columns)));
  // 줄 자리는 스페이스의 카드 하나라도 그 값이 있으면 모든 카드에 둔다(높이를 맞춘다)
  let slots: LineSlots = {
    limits: spaceSessions.some((item) => state.limits?.[item.id] !== undefined),
    progress: spaceSessions.some((item) => Boolean((item.todos && item.todos.total > 0) || item.context)),
    last: spaceSessions.some((item) => Boolean(item.lastMessage)),
  };
  const render = (with_: LineSlots) =>
    space.sessions.map((index) => {
      const item = sessions[index]!;
      const slot = slotOf.get(item.id);
      const limits = state.limits?.[item.id];
      const sprite = spriteFor(item, state.sprites);
      const art = { frame: frameAt(sprite, state.spriteClock ?? 0), ...(state.kitty ? { kitty: state.kitty } : {}) };
      return {
        index,
        lines: cardLines(
          {
            item,
            selected: index === state.selected,
            flagged: flagged.has(item.id),
            unseen: unseen.has(item.id),
            withLimits: with_.limits,
            withProgress: with_.progress,
            withLast: with_.last,
            sprite,
            ...art,
            ...(slot ? { slot } : {}),
            ...(limits ? { limits } : {}),
          },
          cardWidth,
          theme,
          now,
        ),
      };
    });
  // 고른 카드가 든 줄(grid row)의 높이가 남은 자리보다 크면 낮은 순위 줄부터 뺀다. 뺀 뒤에도 높이가 그대로인 줄(그림이 더 높다)은 되살린다
  const room = rect.h - lines.length;
  const rowHeight = (with_: LineSlots) => {
    const cardsOf = render(with_);
    const at = cardsOf.findIndex((card) => card.index === state.selected);
    const start = at < 0 ? 0 : at - (at % columns);
    return Math.max(...cardsOf.slice(start, start + columns).map((card) => card.lines.length));
  };
  if (rowHeight(slots) > room) {
    const dropped: Array<keyof LineSlots> = [];
    for (const key of DROP_ORDER) {
      if (!slots[key]) continue;
      slots = { ...slots, [key]: false };
      dropped.push(key);
      if (rowHeight(slots) <= room) break;
    }
    for (const key of dropped.reverse()) {
      const back = { ...slots, [key]: true };
      if (rowHeight(back) <= Math.max(room, rowHeight(slots))) slots = back;
    }
  }
  const rendered = render(slots);
  // 카드를 줄(grid row)로 묶는다. 한 줄의 높이는 그 줄에서 가장 긴 카드다
  const gridRows: Array<typeof rendered> = [];
  for (let at = 0; at < rendered.length; at += columns) gridRows.push(rendered.slice(at, at + columns));
  const heights = gridRows.map((row) => Math.max(...row.map((card) => card.lines.length)));
  // 고른 카드가 든 줄이 보이게 위 줄을 건너뛴다
  const target = gridRows.findIndex((row) => row.some((card) => card.index === state.selected));
  let first = 0;
  const span = (from: number, to: number) => heights.slice(from, to + 1).reduce((sum, height) => sum + height, 0);
  while (target >= 0 && first < target && span(first, target) > room) first++;
  for (let row = first; row < gridRows.length && lines.length < rect.h; row++) {
    const top = lines.length;
    for (let y = 0; y < heights[row]!; y++) {
      const parts = gridRows[row]!.map((card) => card.lines[y] ?? ' '.repeat(cardWidth));
      lines.push(fitAnsi(` ${parts.join(' ')}`, rect.w));
    }
    gridRows[row]!.forEach((card, column) => {
      cards.push({ index: card.index, rect: { x: rect.x + 1 + column * (cardWidth + 1), y: rect.y + top, w: cardWidth, h: card.lines.length } });
    });
  }
  const shown = lines.slice(0, rect.h);
  while (shown.length < rect.h) shown.push(blank);
  return { lines: shown, cards: cards.filter((card) => card.rect.y < rect.y + rect.h) };
}

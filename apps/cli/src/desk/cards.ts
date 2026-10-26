/**
 * 스페이스 화면(#887, #934). 맨 위에 확인 필요 줄(권한·질문·입력을 기다리거나 검증에 실패한 세션, 스페이스와 상관없이 번호),
 * 그 아래 고른 세션이 든 스페이스(프로젝트)의 세션마다 카드 하나. 카드는 왼쪽에 픽셀 그림, 오른쪽에 짧은 줄 몇 개다:
 * 머리(이름·AI·상태·"23분째"), 지금(도구와 대상 · "13초 전", 도는 도구는 "6분째", 조용하면 "⚠ 4분째 소식 없음"),
 * 할 일 막대와 남은 시간(추정)·문맥 창, 서브에이전트(각자 "4분째"), 마지막 답, 계정 한도가 80%를 넘었을 때만 경고 한 줄.
 * 고른 카드는 테두리를 강조색으로 그리고 마지막 답·나머지 서브에이전트·검증과 토큰·범위를 펼친다.
 * 화면 폭에 따라 1~2열이고, 높이가 모자라면 마지막 답, 할 일·문맥, 한도 경고 차례로 줄을 뺀다
 */
import type { DeskState } from './keys';
import { fit, fitAnsi, stringWidth, type Rect } from './screen';
import { agentStatus, attentionKind, backendLabel, compactTokens, deniedWrites, deskSessions, deskSpaces, detailLines, gateStatus, subagentName, totalTokens, type StatusBadge } from './sidebar';
import type { KittyImages } from './kitty';
import { defaultSprite, frameAt, spriteLines, type Sprite } from './sprite';
import { BOLD, DEFAULT_THEME, fg, RESET, type ColorToken, type Theme } from './theme';
import type { DeskAgent, DeskItem, DeskLimits, DeskLimitWindow } from './types';
import { badge, bar, box, contextColor, spread, statusColor, statusText, TONE_COLOR, wrapWords } from './widgets';

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

/** 지난 때를 "13초 전", "3분 전", "2시간 전", "4일 전"으로 */
function agoText(iso: string | undefined, now: number): string {
  const gone = goneMs(iso, now);
  if (gone === undefined) return '';
  if (gone < 60_000) return `${Math.floor(gone / 1000)}초 전`;
  if (gone < 3_600_000) return `${Math.floor(gone / 60_000)}분 전`;
  if (gone < 86_400_000) return `${Math.floor(gone / 3_600_000)}시간 전`;
  return `${Math.floor(gone / 86_400_000)}일 전`;
}

/** 이어진 시간을 "20초째", "23분째", "1시간 4분째"로 */
function forText(iso: string | undefined, now: number): string {
  const gone = goneMs(iso, now);
  if (gone === undefined) return '';
  return `${spanText(gone)}째`;
}

function spanText(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}초`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}분`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

function goneMs(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined;
}

/** 작업 중인데 이만큼 소식이 없으면 멈춘 듯으로 본다(도구가 도는 동안은 제외) */
export const STALE_MS = 3 * 60_000;

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
 * 넘치는 글을 낱말 사이에서 자르고 …를 붙인다. 보이는 폭(넓은 글자는 두 칸)이 width를 넘지 않는다.
 * 자를 자리 가까이(뒤쪽 40% 안)에 빈칸이 없으면 글자 단위로 자른다
 */
export function clipWords(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? '…' : '';
  let cut = '';
  for (const char of text) {
    if (stringWidth(cut + char) > width - 1) break;
    cut += char;
  }
  const space = cut.lastIndexOf(' ');
  if (space > 0 && stringWidth(cut.slice(0, space)) >= (width - 1) * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** 한 줄의 조각. flex인 조각은 넘칠 때 뒤에서부터 낱말 경계로 줄인다 */
interface Seg {
  text: string;
  color?: ColorToken;
  bold?: boolean;
  flex?: boolean;
}

/** 조각을 width칸 한 줄로. 넘치면 flex 조각을 뒤에서부터 줄이고, 그래도 넘치면 끝을 자른다 */
function compose(segs: readonly Seg[], width: number, theme: Theme): string {
  const parts = segs.filter((seg) => seg.text).map((seg) => ({ ...seg }));
  let over = parts.reduce((sum, seg) => sum + stringWidth(seg.text), 0) - width;
  for (let at = parts.length - 1; at >= 0 && over > 0; at--) {
    const seg = parts[at]!;
    if (!seg.flex) continue;
    const before = stringWidth(seg.text);
    seg.text = clipWords(seg.text, Math.max(1, before - over));
    over -= before - stringWidth(seg.text);
  }
  const line = parts.map((seg) => `${seg.bold ? BOLD : ''}${seg.color ? fg(theme, seg.color) : ''}${seg.text}${seg.bold || seg.color ? RESET : ''}`).join('');
  return fitAnsi(line, width);
}

const SEP: Seg = { text: ' · ', color: 'muted' };

/**
 * 카드 머리의 상태(#934). 사람이 손댈 것(권한·답·입력) > 오류 > 검증 실패·확인 필요 > 작업 중 > 검증 중 > 그 밖.
 * 검증 실패를 구석이 아니라 머리에 올려, "CLI 대기"(흐림)와 "실패"(빨강)가 한 카드에 엇갈려 보이지 않게 한다
 */
export function headStatus(item: DeskItem, unseen = false): StatusBadge {
  const status = agentStatus(item, { unseen });
  if (status.tone === 'warn' || status.tone === 'fail') return status;
  if (item.gate?.state === 'failed' || item.attention === 'gate_failed') return { label: '검증 실패', tone: 'fail' };
  if (item.attention === 'needs_review') return { label: '확인 필요', tone: 'warn' };
  if (item.state === 'working' || status.tone === 'busy') return status;
  if (item.gate?.state === 'verifying') return { label: '검증 중', tone: 'busy' };
  // 쓰기가 거절된 채 끝난 요청은 성공처럼 보이지 않게 한다(#956). "끝냈습니다"라는 답만으로는 바뀐 것이 있는지 모른다
  const denied = deniedWrites(item);
  if (denied > 0) return { label: `쓰기 ${denied}번 거절`, tone: 'fail' };
  // 끝난 세션은 결과를 머리에 올린다(#944). 흐린 "CLI 대기"나 안 본 "끝남"만으로는 통과했는지 모른다(#956)
  if ((status.tone === 'muted' || status.tone === 'ok') && item.gate?.state === 'passed') return { label: '검증 통과', tone: 'ok' };
  return status;
}

/** 끝난 요청을 게이트가 판정하지 않았다(#956). 마지막 답이 있는데 판정이 없으면 "검증하지 않음"으로 적는다. 옛 서버(gate 없음)는 모른다 */
function unverified(item: DeskItem): boolean {
  return item.gate?.state === 'none' && Boolean(item.lastMessage) && item.state !== 'working' && agentStatus(item).tone !== 'busy';
}

/** 이 세션이 지금 사람을 기다리거나 실패해 손댈 것인가(확인 필요 줄에 올린다) */
function needsAttention(item: DeskItem): boolean {
  const status = headStatus(item);
  return status.tone === 'warn' || status.tone === 'fail';
}

/** 마지막 소식 시각: 지금 도구의 때와 마지막 활동 가운데 늦은 것 */
function lastSignal(item: DeskItem): number | undefined {
  const times = [item.now?.at, item.lastActivityAt].map((iso) => (iso ? Date.parse(iso) : NaN)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : undefined;
}

/**
 * 지금 줄(#934). 기다리면 그 까닭, 검증에 실패했으면 그 까닭, 도구가 돌면 "실행 pnpm test · 6분째",
 * 끝난 도구면 "편집 a.ts · 13초 전". 작업 중인데 도구도 돌지 않고 3분 넘게 조용하면 "⚠ 4분째 소식 없음"
 */
function nowLine(item: DeskItem, width: number, theme: Theme, now: number): string {
  const head = headStatus(item);
  const waiting = item.terminal?.waiting;
  // 기다림·실패는 머리에 이미 상태가 있으니 여기에는 까닭만 그 색으로 적는다
  if (head.tone === 'warn' && waiting && waiting !== 'idle') {
    // 기다리는 동안 도구가 거절·실패했으면 그것을 먼저 적는다(#953). 묻는 것은 확인 필요 줄에 있다
    if (item.now?.error) return errorLine(item.now, width, theme);
    return compose([{ text: '› ', color: statusColor(head) }, { text: item.terminal?.message ? oneLine(item.terminal.message) : '그 칸에서 답하면 이어서 합니다', color: statusColor(head), flex: true }], width, theme);
  }
  const noCheck: Seg[] = unverified(item) ? [SEP, { text: '검증하지 않음', color: 'muted' }] : [];
  if (deniedWrites(item) > 0) {
    // 쓰기가 거절된 채 끝났다(#956): 거절 까닭과, 검증하지 않았으면 그 사실
    const why = item.now?.error ?? item.reason;
    return compose([{ text: '› ', color: 'red' }, { text: why ? oneLine(why) : '쓰기가 막혀 바뀐 것이 없을 수 있습니다', color: 'red', flex: true }, ...noCheck], width, theme);
  }
  if (head.tone === 'fail' || head.label === '확인 필요') {
    return compose([{ text: '› ', color: statusColor(head) }, { text: item.reason ? oneLine(item.reason) : '세션 자세히(i)에서 까닭을 봅니다', color: statusColor(head), flex: true }], width, theme);
  }
  if (item.state === 'booting') return compose([{ text: '› 샌드박스와 서비스를 띄우는 중', color: 'muted', flex: true }], width, theme);
  const quiet = lastSignal(item);
  const stale = isStale(item, now);
  const staleSeg: Seg = { text: `⚠ ${spanText(now - (quiet ?? now))}째 소식 없음`, color: 'yellow' };
  // 검증을 통과했어도 거절된 쓰기가 있었으면 남긴다(#956). 끝난 카드의 결과 줄에 붙인다
  const settled = item.state !== 'working' && agentStatus(item).tone !== 'busy';
  const deniedSeg: Seg[] = settled && (item.turnDenied ?? 0) > 0 ? [SEP, { text: `쓰기 ${item.turnDenied}번 거절`, color: 'yellow' }] : [];
  const tail = [...deniedSeg, ...noCheck];
  // 거절·실패한 도구는 정상 진행처럼 "· 17초 전"을 붙이지 않고 까닭을 빨강으로(#953)
  if (item.now?.error) return errorLine(item.now, width, theme);
  if (item.now) {
    const what: Seg[] = [{ text: toolLabel(item.now.tool) }, ...(item.now.target ? [{ text: ` ${oneLine(item.now.target)}`, flex: true }] : [])];
    const when: Seg = item.now.running ? { text: forText(item.now.at, now), color: 'accent' } : stale ? staleSeg : { text: agoText(item.now.at, now), color: 'muted' };
    return compose([...what, SEP, when, ...tail], width, theme);
  }
  const main = item.agents?.find((agent) => agent.kind === 'main');
  if (main?.activity) return compose([{ text: oneLine(main.activity), flex: true }, ...(stale ? [SEP, staleSeg] : []), ...tail], width, theme);
  if (stale) return compose([staleSeg], width, theme);
  const since = agoText(item.lastActivityAt, now);
  return compose([{ text: since ? `마지막 활동 ${since}` : '기록 없음', color: 'muted', flex: true }, ...tail], width, theme);
}

/** 작업 중인데 도구도 돌지 않고 3분 넘게 소식이 없다(멈춘 듯) */
function isStale(item: DeskItem, now: number): boolean {
  const quiet = lastSignal(item);
  return item.state === 'working' && !item.now?.running && quiet !== undefined && now - quiet > STALE_MS;
}

/** 거절·실패한 도구 줄: "실행 pnpm test · 거절됨: …"(까닭은 빨강). 넘치면 까닭보다 대상을 먼저 줄이고, 대상을 다 줄여도 넘치면 대상을 뺀다 */
function errorLine(now: NonNullable<DeskItem['now']>, width: number, theme: Theme): string {
  const why: Seg = { text: oneLine(now.error ?? ''), color: 'red', flex: true };
  const label = toolLabel(now.tool);
  const room = width - stringWidth(label) - stringWidth(SEP.text) - stringWidth(why.text) - 1;
  const target: Seg[] = now.target && room >= 6 ? [{ text: ` ${clipWords(oneLine(now.target), room)}` }] : [];
  return compose([{ text: label }, ...target, SEP, why], width, theme);
}

/** 남은 시간을 추정하기 전에 지나야 하는 시간. 시작 몇십 초 만의 속도로 셈하면 크게 틀린다(#944) */
const REMAIN_AFTER_MS = 2 * 60_000;

/**
 * 남은 시간 추정: 작업 중(사람을 기다리거나 오류가 아님)이고, 소식이 이어지고, 요청을 시작한 지 2분이 지났고, 끝낸 할 일이 둘 이상일 때만.
 * 지금까지의 한 항목 평균 × 남은 수
 */
export function remainingText(item: DeskItem, now: number): string {
  const todos = item.todos;
  const spent = goneMs(item.workingSince, now);
  if (!todos || spent === undefined || todos.done < 2 || todos.done >= todos.total) return '';
  if (spent < REMAIN_AFTER_MS || agentStatus(item).label !== '작업 중') return '';
  // 소식이 끊겼으면 속도를 알 수 없다(#956). 그대로 셈하면 남은 시간이 계속 늘어난다
  if (isStale(item, now)) return '';
  const left = (spent / todos.done) * (todos.total - todos.done);
  if (left < 60_000) return '1분 안에 끝남(추정)';
  return `약 ${spanText(Math.round(left / 60_000) * 60_000)} 남음(추정)`;
}

/** 지금 항목을 이보다 좁게만 보일 수 있으면 빼다 */
const CURRENT_MIN = 8;

/**
 * 할 일 막대·진행·남은 시간·지금 항목, 오른쪽에 문맥 창. 좁으면 문맥은 막대 없이 %만, 지금 항목은 자리가 남을 때만 둔다.
 * 남은 시간은 지금 항목보다 먼저 자리를 받는다
 */
function progressLine(item: DeskItem, width: number, theme: Theme, now: number): string {
  let context = '';
  let contextWidth = 0;
  if (item.context) {
    const pct = Math.round(Math.max(0, Math.min(100, item.context.usedPct)));
    const barWidth = width >= 56 ? 6 : 0;
    context = `${fg(theme, 'muted')}문맥${RESET} ${barWidth ? `${bar(pct, barWidth, theme, contextColor)} ` : ''}${fg(theme, contextColor(pct))}${pct}%${RESET}`;
    contextWidth = stringWidth('문맥 ') + (barWidth ? barWidth + 1 : 0) + String(pct).length + 1;
  }
  const todos = item.todos && item.todos.total > 0 ? item.todos : undefined;
  if (!todos) return context ? fitAnsi(' '.repeat(Math.max(0, width - contextWidth)) + context, width) : '';
  const room = context ? width - contextWidth - 2 : width;
  const barWidth = room >= 36 ? 8 : 5;
  const count = `${todos.done}/${todos.total}`;
  const remain = remainingText(item, now);
  let left = room - barWidth - 1 - count.length;
  const segs: Seg[] = [];
  if (remain && left >= 3 + stringWidth(remain)) {
    segs.push(SEP, { text: remain, color: 'muted' });
    left -= 3 + stringWidth(remain);
  }
  if (todos.current && left >= CURRENT_MIN + 1) segs.unshift({ text: ` ${oneLine(todos.current)}`, flex: true });
  const line = `${bar((todos.done / todos.total) * 100, barWidth, theme, () => 'accent')} ${BOLD}${count}${RESET}${compose(segs, Math.max(0, room - barWidth - 1 - count.length), theme)}`;
  if (!context) return fitAnsi(line, width);
  return spread(line, context, width, contextWidth);
}

/** 마지막 답 한 줄. 고른 카드는 다음 줄에 이어 펼치므로 낱말 사이에서 줄을 나눈다(#944: "이 / 제"처럼 낱말을 가르지 않는다) */
function lastLine(item: DeskItem, width: number, theme: Theme, continued = false): string {
  if (!item.lastMessage) return '';
  if (continued) return `${fg(theme, 'muted')}답${RESET}${fitAnsi(lastWrapped(item, width)[0]!.slice(1), width - 1)}`;
  return compose([{ text: '답 ', color: 'muted' }, { text: oneLine(item.lastMessage), flex: true }], width, theme);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 고른 카드의 마지막 답을 낱말 사이에서 나눈 줄들("답 "으로 시작). 첫 줄과 이어 펼치는 두 줄까지, 넘치면 끝에 … */
function lastWrapped(item: DeskItem, width: number): string[] {
  return wrapWords(`답 ${oneLine(item.lastMessage ?? '')}`, width, 1 + LAST_MORE);
}

/** 고른 카드에 이어 펼치는 마지막 답: 첫 줄(카드 몸에 보인 것) 다음부터 두 줄까지 */
function lastMore(item: DeskItem, width: number): string[] {
  if (!item.lastMessage) return [];
  return lastWrapped(item, width).slice(1);
}

/** 카드 몸에 한 줄씩 보이는 작업 중 서브에이전트의 수 */
const SUBAGENT_SHOWN = 2;

function subagentsOf(item: DeskItem): DeskAgent[] {
  return (item.agents ?? []).filter((agent) => agent.kind === 'subagent');
}

/** 서브에이전트 줄: 작업 중인 것을 둘까지 "↳ 종류 맡긴 일 · 도구 · 4분째"(멈춘 듯이면 그것), 나머지는 "외 N개", 다 끝났으면 한 줄 */
function subagentLines(item: DeskItem, width: number, theme: Theme, now: number, selected = false): string[] {
  const subagents = subagentsOf(item);
  if (subagents.length === 0) return [];
  const working = subagents.filter((agent) => agent.state === 'working');
  // 고른 카드는 끝난 서브에이전트를 하나씩 펼치므로 묶음 줄을 두지 않는다(같은 것을 두 번 그리지 않는다, #944)
  if (working.length === 0 && selected) return [];
  if (working.length === 0) return [compose([{ text: `↳ 서브에이전트 ${subagents.length}개 끝남`, color: 'muted' }], width, theme)];
  const lines = working.slice(0, SUBAGENT_SHOWN).map((agent) => {
    const quiet = goneMs(agent.lastAt, now);
    const when: Seg | undefined =
      quiet !== undefined && quiet > STALE_MS
        ? { text: `⚠ ${spanText(quiet)}째 소식 없음`, color: 'yellow' }
        : agent.startedAt
          ? { text: forText(agent.startedAt, now), color: 'muted' }
          : undefined;
    const doing = agent.tool ?? agent.activity;
    return compose(
      [{ text: '↳ ', color: 'accent' }, { text: subagentName(agent), flex: true }, ...(doing ? [SEP, { text: oneLine(doing), flex: true }] : []), ...(when ? [SEP, when] : [])],
      width,
      theme,
    );
  });
  if (working.length > SUBAGENT_SHOWN) lines.push(compose([{ text: `↳ 외 ${working.length - SUBAGENT_SHOWN}개 작업 중`, color: 'muted' }], width, theme));
  return lines;
}

/** 이 계정의 한도가 80%를 넘었을 때만 한 줄 경고(#934). 막대는 사용량 화면에 둔다 */
function limitWarning(limits: DeskLimits | undefined, width: number, theme: Theme, now: number): string {
  const windows: Array<[string, DeskLimitWindow]> = [];
  if (limits?.fiveHour) windows.push(['5시간', limits.fiveHour]);
  if (limits?.weekly) windows.push(['주간', limits.weekly]);
  const tight = windows.filter(([, window]) => window.usedPercent >= 80).sort((a, b) => b[1].usedPercent - a[1].usedPercent)[0];
  if (!tight) return '';
  const [label, window] = tight;
  const pct = Math.round(Math.min(100, window.usedPercent));
  const reset = resetText(window.resetsAt, now);
  return compose([{ text: `⚠ 이 계정 ${label} ${pct}%`, color: pct >= 95 ? 'red' : 'yellow' }, ...(reset ? [SEP, { text: `${reset} 다시 참`, color: 'muted' as const, flex: true }] : [])], width, theme);
}

/** 고른 카드에 펼치는 사실: 검증·체크포인트·토큰·비용 */
function factsLine(item: DeskItem, width: number, theme: Theme): string {
  const parts: Seg[][] = [];
  const gate = gateStatus(item);
  if (gate) parts.push([{ text: '검증 ', color: 'muted' }, { text: gate.label, color: TONE_COLOR[gate.tone] }]);
  if (item.tokens && totalTokens(item.tokens) > 0) parts.push([{ text: `토큰 ${compactTokens(totalTokens(item.tokens))}` }]);
  if (item.costUsd !== undefined && item.costUsd > 0) parts.push([{ text: `$${item.costUsd.toFixed(2)}` }]);
  if (item.gate && item.gate.checkpoints > 0) parts.push([{ text: `체크포인트 ${item.gate.checkpoints}` }]);
  // 넘치면 뒤의 것부터 통째로 뺀다(숫자를 반쯤 자르지 않는다)
  const width_ = (segs: Seg[][]) => segs.flat().reduce((sum, seg) => sum + stringWidth(seg.text), 0) + 3 * Math.max(0, segs.length - 1);
  while (parts.length > 1 && width_(parts) > width) parts.pop();
  return parts.length ? compose(parts.flatMap((segs, at) => (at ? [SEP, ...segs] : segs)), width, theme) : '';
}

export interface CardInput {
  item: DeskItem;
  selected: boolean;
  flagged: boolean;
  /** 끝났지만 아직 보지 않은 세션(#922). 쉬는 CLI를 초록 "끝남"으로 보인다 */
  unseen?: boolean;
  slot?: number;
  limits?: DeskLimits;
  /** 한도 경고 줄 자리. 이 화면의 카드 하나라도 경고가 있으면 모든 카드에 둔다(#934) */
  withLimits: boolean;
  /** 할 일·문맥 줄 자리. 없으면 이 카드에 그 값이 있을 때만 둔다(#921) */
  withProgress?: boolean;
  /** 마지막 답 줄 자리. 없으면 이 카드에 마지막 답이 있을 때만 둔다 */
  withLast?: boolean;
  /** 안쪽 줄 수의 하한. 같은 줄(grid row)의 카드 높이를 맞출 때 쓴다 */
  minRows?: number;
  sprite: Sprite;
  /** 움짤의 보일 프레임 번호(없으면 첫 프레임) */
  frame?: number;
  /** 있으면 그림을 Kitty 그래픽으로 그린다(없으면 반칸 블록) */
  kitty?: KittyImages;
}

/** 카드 안쪽의 줄 수: 글 줄(머리·지금 2, 한도 경고·할 일·답은 있으면 1씩, 서브에이전트 줄)과 그림 높이 가운데 큰 것 */
export function baseRows(withLimits: boolean, art: { rows: number } = ART_WIDE, extra = 0): number {
  return Math.max(2 + Number(withLimits) + extra, art.rows);
}

/** 카드 한 장의 줄(테두리 포함). 줄마다 정확히 width칸이다 */
export function cardLines(card: CardInput, width: number, theme: Theme = DEFAULT_THEME, now = Date.now()): string[] {
  const { item } = card;
  const art = artSize(width);
  const withProgress = card.withProgress ?? Boolean((item.todos && item.todos.total > 0) || item.context);
  const withLast = card.withLast ?? Boolean(item.lastMessage);
  const text = Math.max(1, width - 4 - art.cols - 2);
  const head = headStatus(item, card.unseen ?? false);
  // 작업 중이고 시작 시각을 알면 "작업 23분째"로 줄여 제목에 자리를 남긴다
  const running = item.state === 'working' && head.label === '작업 중' ? forText(item.workingSince, now) : '';
  const status = running ? { ...head, label: `작업 ${running}` } : head;
  const right = statusText(status, theme);
  const rightWidth = stringWidth(status.label) + 2;
  const left = compose(
    [{ text: item.title, color: 'text', bold: true, flex: true }, { text: ' ' }],
    Math.max(1, text - rightWidth - 1 - stringWidth(backendLabel(item.backend)) - 2 - (card.slot ? 4 : 0) - (card.flagged ? 2 : 0)),
    theme,
  ).trimEnd();
  const title = `${left} ${badge(backendLabel(item.backend), theme)}${card.slot ? `${fg(theme, 'accent')} 칸${card.slot}${RESET}` : ''}${card.flagged ? ` ${fg(theme, 'yellow')}!${RESET}` : ''}`;
  const body = [spread(title, right, text, rightWidth), nowLine(item, text, theme, now)];
  if (withProgress) body.push(progressLine(item, text, theme, now));
  const subagents = subagentLines(item, text, theme, now, card.selected);
  body.push(...subagents);
  if (card.withLimits) body.push(limitWarning(card.limits, text, theme, now));
  // 마지막 답은 맨 끝: 고른 카드에서 펼친 답이 바로 이어진다
  if (withLast) body.push(lastLine(item, text, theme, card.selected));
  if (card.selected) {
    // 펼친 줄은 몸 바로 뒤에 잇는다. 그림 높이까지 빈 줄로 채운 뒤에 붙이면 마지막 답이 빈 줄을 건너 이어진다(#944)
    if (withLast) body.push(...lastMore(item, text));
    // 카드 몸에 이미 보인 서브에이전트(작업 중인 앞의 둘)는 다시 그리지 않는다
    const shown = new Set(subagentsOf(item).filter((agent) => agent.state === 'working').slice(0, SUBAGENT_SHOWN).map((agent) => agent.id));
    for (const detail of detailLines({ ...item, agents: (item.agents ?? []).filter((agent) => !shown.has(agent.id)) }).slice(0, DETAIL_MAX)) {
      // 넘치면 낱말 사이에서 자른다("턴 끝 게"처럼 다음 낱말의 앞 글자를 남기지 않는다)
      let line = clipWords(detail.text, text);
      for (const tone of detail.tones) line = line.replace(tone.text, `${fg(theme, TONE_COLOR[tone.tone])}${tone.text}${RESET}`);
      body.push(line);
    }
    const facts = factsLine(item, text, theme);
    if (facts) body.push(facts);
  }
  const rows = Math.max(body.length, art.rows, card.minRows ?? 0);
  while (body.length < rows) body.push('');
  const frame = card.frame ?? 0;
  const picture = card.kitty ? card.kitty.art(card.sprite, frame, art.cols, art.rows) : spriteLines(card.sprite, art.cols, art.rows, theme, frame);
  const inner = body.map((line, row) => `${picture[row] ?? ' '.repeat(art.cols)}  ${fitAnsi(line, text)}`);
  return box(inner, width, theme, { focused: card.selected });
}

/** 확인 필요 줄에 올리는 세션 하나(#934) */
export interface NeedsYouEntry {
  item: DeskItem;
  /** deskSessions 순서의 자리(state.selected 값) */
  index: number;
  status: StatusBadge;
}

/** 숫자키로 고를 수 있는 확인 필요 항목의 상한 */
export const NEEDS_YOU_MAX = 9;

/**
 * 확인 필요(#934): 권한·질문·입력을 기다리거나 오류·검증 실패·확인 필요인 세션을 스페이스와 상관없이 모은다.
 * 사람을 기다리는 것이 먼저, 같은 정도면 받은 차례다. 스페이스 화면 맨 위에 번호를 달아 보이고 숫자키로 고른다
 */
export function needsYou(state: Pick<DeskState, 'items'>): NeedsYouEntry[] {
  return deskSessions(state.items)
    .map((item, index) => ({ item, index, status: headStatus(item) }))
    .filter((entry) => needsAttention(entry.item))
    .map((entry, order) => ({ entry, order, rank: entry.status.tone === 'warn' && attentionKind(entry.item) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ entry }) => entry)
    .slice(0, NEEDS_YOU_MAX);
}

/** 확인 필요 줄에 한 번에 보이는 항목 수. 넘치면 "외 N개" */
const NEEDS_YOU_SHOWN = 3;

/** 스페이스 화면 맨 위의 확인 필요 줄. 없으면 빈 배열 */
function needsYouLines(state: DeskState, width: number, theme: Theme): string[] {
  const list = needsYou(state);
  if (list.length === 0) return [];
  const lines = [compose([{ text: `  확인 필요 ${list.length}`, color: 'yellow', bold: true }, { text: '  숫자로 고르고 Enter로 그 칸에 열기', color: 'muted' }], width, theme)];
  for (const [at, entry] of list.slice(0, NEEDS_YOU_SHOWN).entries()) {
    const picked = entry.index === state.selected;
    // 쓰기가 거절된 채 끝난 세션은 거절 까닭을 적는다(#956)
    const why = entry.item.terminal?.message ?? entry.item.reason ?? (deniedWrites(entry.item) > 0 ? entry.item.now?.error : undefined);
    lines.push(
      compose(
        [
          { text: picked ? ' › ' : '   ', color: 'accent' },
          { text: `${at + 1}  `, color: 'accent', bold: true },
          { text: entry.item.title, bold: picked, flex: true },
          { text: ` · ${entry.item.projectName}  `, color: 'muted' },
          { text: entry.status.label, color: statusColor(entry.status) },
          ...(why ? [SEP, { text: oneLine(why), flex: true }] : []),
        ],
        width,
        theme,
      ),
    );
  }
  if (list.length > NEEDS_YOU_SHOWN) lines.push(compose([{ text: `   외 ${list.length - NEEDS_YOU_SHOWN}개 · 숫자 ${NEEDS_YOU_SHOWN + 1}~${list.length}로 고르기`, color: 'muted' }], width, theme));
  return lines;
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
/** 높이가 모자랄 때 줄을 빼는 차례: 마지막 답, 할 일·문맥, 한도 경고 */
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
  // 확인 필요 줄(#934): 손댈 세션이 있으면 스페이스와 상관없이 맨 위에
  const needs = needsYouLines(state, rect.w, theme);
  if (needs.length) lines.push(...needs, blank);
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
    limits: spaceSessions.some((item) => limitWarning(state.limits?.[item.id], 80, theme, now) !== ''),
    progress: spaceSessions.some((item) => Boolean((item.todos && item.todos.total > 0) || item.context)),
    last: spaceSessions.some((item) => Boolean(item.lastMessage)),
  };
  const draw = (with_: LineSlots, minRows: (at: number) => number, folded = false) =>
    space.sessions.map((index, at) => {
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
            selected: !folded && index === state.selected,
            flagged: flagged.has(item.id),
            unseen: unseen.has(item.id),
            withLimits: with_.limits,
            withProgress: with_.progress,
            withLast: with_.last,
            minRows: minRows(at),
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
  // 같은 줄(grid row)의 카드는 높이를 맞춘다: 서브에이전트 줄 수가 카드마다 다르다
  const render = (with_: LineSlots) => {
    // 몸 줄 수는 펼치지 않은 꼴로 잰다(고른 카드의 펼친 줄로 옆 카드를 늘리지 않는다)
    const natural = draw(with_, () => 0, true).map((card) => card.lines.length - 2);
    const rowMax = (at: number) => Math.max(...natural.slice(at - (at % columns), at - (at % columns) + columns));
    return draw(with_, rowMax);
  };
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
  // 카드가 다 들어가지 않으면 맨 아래 한 줄에 몇 장이 더 있는지 알린다(#944). 좁은 화면에서 한 장만 보이면 나머지가 있는지 몰랐다
  const overflow = span(0, heights.length - 1) > room;
  const limit = rect.h - (overflow ? 1 : 0);
  while (target >= 0 && first < target && span(first, target) > room - (overflow ? 1 : 0)) first++;
  for (let row = first; row < gridRows.length && lines.length < limit; row++) {
    const top = lines.length;
    for (let y = 0; y < heights[row]!; y++) {
      const parts = gridRows[row]!.map((card) => card.lines[y] ?? ' '.repeat(cardWidth));
      lines.push(fitAnsi(` ${parts.join(' ')}`, rect.w));
    }
    gridRows[row]!.forEach((card, column) => {
      cards.push({ index: card.index, rect: { x: rect.x + 1 + column * (cardWidth + 1), y: rect.y + top, w: cardWidth, h: card.lines.length } });
    });
  }
  const shown = lines.slice(0, limit);
  while (shown.length < limit) shown.push(blank);
  if (overflow) {
    const above = gridRows.slice(0, first).reduce((sum, row) => sum + row.length, 0);
    const whole = cards.filter((card) => card.rect.y + card.rect.h <= rect.y + limit).length;
    const below = rendered.length - above - whole;
    const parts = [...(above ? [`↑ 위에 카드 ${above}장`] : []), ...(below ? [`↓ 카드 ${below}장 더`] : []), '←→ 고르기'];
    shown.push(fitAnsi(`  ${muted}${parts.join(' · ')}${RESET}`, rect.w));
  }
  return { lines: shown, cards: cards.filter((card) => card.rect.y < rect.y + limit) };
}

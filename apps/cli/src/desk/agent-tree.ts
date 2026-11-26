/**
 * 에이전트 나무 목록(앞글쇠 다음 m, 카드 화면에서는 m): 세션 하나가 부모 줄이고 그 세션이 띄운 서브에이전트가 들여쓴 자식 줄(├ └)이다.
 * 여러 에이전트가 각각 무엇을 하는지 한 화면에서 훑는 곳이다. 카드는 작업 중인 서브에이전트를 셋까지만 한 줄씩 보이지만, 여기는 모두 보인다.
 * 부모 줄: 상태·제목·AI·지금 하는 일(카드의 지금 줄과 같은 글)·경과. 자식 줄: 상태·종류와 맡긴 일·지금 도구·경과("N분째 소식 없음"은 카드와 같은 규칙),
 * 끝난 것은 결과 한 줄. 서브에이전트가 없는 세션은 부모 줄만이다(Codex처럼 서브에이전트 정보가 없는 세션도 그렇다).
 * 범위는 고른 세션이 든 스페이스이고 Tab으로 전체 스페이스로 바꾼다. 키를 받아 다음 상태와 고른 세션을 돌려주는 순수 함수다(고른 세션을 칸에 여는 일은 keys.ts가 한다).
 * 이 화면은 보기만 한다: 서브에이전트를 멈추거나 조종하지 않는다
 */
import { agentQuiet, agoText, clipWords, forText, nowLine, oneLine, spaceItems, spanText, subagentsOf, toolLineLabel } from './cards';
import type { DeskState } from './keys';
import { fitAnsi, stringWidth, stripAnsi, type Rect } from './screen';
import { backendLabel, deskSessions, headStatus, subagentName } from './sidebar';
import { BOLD, DEFAULT_THEME, fg, RESET, type Theme } from './theme';
import type { DeskAgent, DeskItem } from './types';
import { badge, statusColor, statusMark } from './widgets';

export interface AgentTreeState {
  /** 고른 줄의 자리(줄 목록에서). 고른 줄의 session·agent가 목록에 있으면 그 줄을 따라간다 */
  index: number;
  /** 고른 줄의 세션 id와 서브에이전트 id(부모 줄이면 없다). 새 목록을 받아 줄 순서가 바뀌어도 같은 줄을 고른다 */
  session?: string;
  agent?: string;
  /** 모든 스페이스를 본다(아니면 고른 세션이 든 스페이스) */
  all: boolean;
}

export interface TreeRow {
  item: DeskItem;
  /** 없으면 부모 줄(세션) */
  agent?: DeskAgent;
  /** 이 세션의 마지막 자식 줄(└) */
  last?: boolean;
}

/** 목록이 보는 desk 상태 */
type TreeSource = Pick<DeskState, 'items' | 'selected' | 'tree' | 'slots' | 'layout'>;

const ESC = '\x1b';
const PAGE = 5;

export function openAgentTree(): AgentTreeState {
  return { index: 0, all: false };
}

/** 줄 목록: 세션마다 부모 줄 하나와 서브에이전트마다 자식 줄 하나. 메인 에이전트는 세션 자신이라 줄이 아니다 */
export function treeRows(state: TreeSource): TreeRow[] {
  const sessions = state.tree?.all ? deskSessions(state.items) : spaceItems(state as DeskState);
  return sessions.flatMap((item) => {
    const subs = subagentsOf(item);
    return [{ item }, ...subs.map((agent, at) => ({ item, agent, last: at === subs.length - 1 }))];
  });
}

/** 고른 줄의 자리. 고른 세션·서브에이전트가 목록에 있으면 그 줄, 없으면 index를 범위 안으로 */
function cursorAt(tree: AgentTreeState, rows: readonly TreeRow[]): number {
  if (rows.length === 0) return 0;
  const found = tree.session === undefined ? -1 : rows.findIndex((row) => row.item.id === tree.session && row.agent?.id === tree.agent);
  return found >= 0 ? found : Math.max(0, Math.min(rows.length - 1, tree.index));
}

/** 키 하나. 닫으면 state가 없고, Enter로 고르면 chosen이 그 세션 id다. 자식 줄이면 agent가 그 서브에이전트 id다(활동 기록으로 들어간다) */
export function treeKey(source: TreeSource, key: string): { state?: AgentTreeState; chosen?: string; agent?: string; help?: true } {
  const tree = source.tree!;
  const rows = treeRows(source);
  const at = cursorAt(tree, rows);
  const move = (to: number) => {
    const index = Math.max(0, Math.min(rows.length - 1, to));
    const row = rows[index];
    return { state: { ...tree, index: Math.max(0, index), session: row?.item.id, agent: row?.agent?.id } };
  };
  if (key === ESC || key === '\x03' || key === 'm') return {};
  if (key === '\r' || key === '\n') {
    const row = rows[at];
    return row ? { chosen: row.item.id, ...(row.agent ? { agent: row.agent.id } : {}) } : { state: tree };
  }
  if (key === '\x1b[A' || key === '\x1bOA' || key === 'k' || key === '\x10') return move(at - 1);
  if (key === '\x1b[B' || key === '\x1bOB' || key === 'j' || key === '\x0e') return move(at + 1);
  if (key === '\x1b[5~') return move(at - PAGE);
  if (key === '\x1b[6~') return move(at + PAGE);
  if (key === '\x1b[H' || key === '\x1b[1~') return move(0);
  if (key === '\x1b[F' || key === '\x1b[4~') return move(rows.length - 1);
  // 범위를 바꾸면 줄이 달라지니 맨 위부터 본다
  if (key === '\t') return { state: { index: 0, all: !tree.all } };
  if (key === '?') return { state: tree, help: true };
  return { state: tree };
}

export const TREE_HINT = ' 에이전트 나무 · ↑↓ 고르기 · Enter 세션은 칸에, 서브에이전트는 활동 기록 · Tab 범위 · Esc 닫기 · ? 모든 키';

/** 줄 오른쪽에 두는 글과 그 폭 */
interface Right {
  text: string;
  color: 'muted' | 'accent' | 'yellow';
}

function parentLine(row: TreeRow, selected: boolean, width: number, theme: Theme, now: number, showSpace: boolean): string {
  const { item } = row;
  const head = headStatus(item);
  const cursor = selected ? `${fg(theme, 'accent')}›${RESET} ` : '  ';
  const mark = `${statusMark(head, theme)} `;
  const label = backendLabel(item.backend);
  const since = item.state === 'working' && head.label === '작업 중' ? forText(item.workingSince, now) : agoText(item.lastActivityAt, now);
  const right: Right | undefined = since ? { text: item.state === 'working' && head.label === '작업 중' ? `작업 ${since}` : since, color: 'muted' } : undefined;
  const rightWidth = right ? stringWidth(right.text) + 1 : 0;
  const room = Math.max(1, width - 4 - rightWidth);
  // 제목이 먼저 자리를 잡고, 지금 하는 일은 남는 자리에서 줄인다
  const badgeText = `${badge(label, theme)}`;
  const badgeWidth = stringWidth(label) + 2;
  const spaceNote = showSpace ? ` ${item.projectName}` : '';
  const titleMax = Math.max(4, Math.min(stringWidth(item.title), Math.floor(room * 0.35)));
  const title = clip(item.title, titleMax);
  const used = stringWidth(title) + 1 + badgeWidth;
  const spaceText = spaceNote && used + stringWidth(spaceNote) + 3 < room ? spaceNote : '';
  const nowRoom = room - used - stringWidth(spaceText) - 3;
  const nowPlain = oneLine(stripAnsi(nowLine(item, 400, theme, now)));
  // 거절·실패·사람을 기다리는 까닭은 색으로 눈에 띄게
  const alarm = item.now?.error ? 'red' : head.tone === 'warn' || head.tone === 'fail' ? statusColor(head) : undefined;
  const nowText = nowRoom >= 6 ? clip(nowPlain, nowRoom) : '';
  const mid =
    `${selected ? BOLD : ''}${title}${RESET} ${badgeText}` +
    (spaceText ? `${fg(theme, 'muted')}${spaceText}${RESET}` : '') +
    (nowText ? `${fg(theme, 'muted')} · ${RESET}${alarm ? fg(theme, alarm) : ''}${nowText}${RESET}` : '');
  const left = `${cursor}${mark}${fitAnsi(mid, room)}`;
  return right ? fitAnsi(`${left} ${fg(theme, right.color)}${right.text}${RESET}`, width) : fitAnsi(left, width);
}

function childLine(row: TreeRow, selected: boolean, width: number, theme: Theme, now: number): string {
  const agent = row.agent!;
  const cursor = selected ? `${fg(theme, 'accent')}›${RESET} ` : '  ';
  const branch = `${fg(theme, 'border')}  ${row.last ? '└' : '├'} ${RESET}`;
  const quiet = agentQuiet(agent, now);
  const mark =
    agent.state === 'done' ? `${fg(theme, 'teal')}✓${RESET}` : agent.state === 'working' ? `${fg(theme, quiet !== undefined ? 'yellow' : 'accent')}◐${RESET}` : `${fg(theme, 'muted')}○${RESET}`;
  const right: Right | undefined =
    quiet !== undefined
      ? { text: `⚠ ${spanText(quiet)}째 소식 없음`, color: 'yellow' }
      : agent.state === 'working' && agent.startedAt
        ? { text: forText(agent.startedAt, now), color: 'accent' }
        : agent.state === 'done' && agent.startedAt && agent.lastAt
          ? { text: spanText(Math.max(0, Date.parse(agent.lastAt) - Date.parse(agent.startedAt))), color: 'muted' }
          : agent.state === 'idle'
            ? { text: '대기', color: 'muted' }
            : undefined;
  const rightWidth = right && stringWidth(right.text) > 0 ? stringWidth(right.text) + 1 : 0;
  const prefixWidth = 2 + 4 + 2;
  const room = Math.max(1, width - prefixWidth - rightWidth);
  const doing = agent.state === 'working' ? (agent.tool ? toolLineLabel(agent.tool) : agent.activity) : undefined;
  const result = agent.state === 'done' && agent.result ? oneLine(agent.result) : undefined;
  const name = subagentName(agent) || '서브에이전트';
  // 종류와 맡긴 일은 도구·결과보다 먼저 자리를 잡는다
  const tail = doing ? oneLine(doing) : result ? `결과 ${result}` : '';
  const nameMax = tail ? Math.max(8, Math.min(stringWidth(name), Math.floor(room * 0.6))) : room;
  const nameText = clip(name, nameMax);
  const tailRoom = room - stringWidth(nameText) - 3;
  const tailText = tail && tailRoom >= 6 ? clip(tail, tailRoom) : '';
  const body = `${nameText}${tailText ? `${fg(theme, 'muted')} · ${RESET}${tailText}` : ''}`;
  const left = `${cursor}${branch}${mark} ${fitAnsi(body, room)}`;
  return right && rightWidth ? fitAnsi(`${left} ${fg(theme, right.color)}${right.text}${RESET}`, width) : fitAnsi(left, width);
}

/** 넘치는 글을 폭에 맞게 낱말 사이에서 …로 줄인다(한글은 두 칸) */
const clip = clipWords;

/** 본문 자리에 그리는 줄(정확히 rect.h줄, 줄마다 rect.w칸) */
export function renderAgentTree(state: TreeSource & { theme?: Theme }, rect: Pick<Rect, 'w' | 'h'>, now = Date.now()): { lines: string[] } {
  const theme = state.theme ?? DEFAULT_THEME;
  const tree = state.tree!;
  const rows = treeRows(state);
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  const sessionCount = new Set(rows.map((row) => row.item.id)).size;
  const subs = rows.filter((row) => row.agent);
  const working = subs.filter((row) => row.agent!.state === 'working').length;
  const space = tree.all ? '전체 스페이스' : (spaceItems(state as DeskState)[0]?.projectName ?? '스페이스');
  lines.push(fitAnsi(` ${BOLD}${fg(theme, 'text')}에이전트${RESET} ${muted}${space} · 세션 ${sessionCount} · 서브에이전트 ${subs.length}${working ? ` · 작업 중 ${working}` : ''}${RESET}`, rect.w));
  if (rows.length === 0) {
    lines.push(fitAnsi(`${muted}   에이전트가 없습니다. n 으로 새 요청을 보내면 여기 보입니다${RESET}`, rect.w));
  } else {
    const at = cursorAt(tree, rows);
    const total = rows.length;
    // 한 화면에 다 들어가지 않으면 맨 아래 한 줄을 위·아래 알림에 쓴다
    const overflow = total > rect.h - 1;
    const room = Math.max(1, rect.h - 1 - (overflow ? 1 : 0));
    const offset = Math.max(0, Math.min(at - room + 1, total - room));
    for (const [index, row] of rows.slice(offset, offset + room).entries()) {
      const selected = offset + index === at;
      lines.push(row.agent ? childLine(row, selected, rect.w, theme, now) : parentLine(row, selected, rect.w, theme, now, tree.all));
    }
    if (overflow) {
      const above = offset;
      const below = total - offset - room;
      const parts = [...(above ? [`↑ 위에 ${above}줄`] : []), ...(below > 0 ? [`↓ 아래 ${below}줄`] : []), '↑↓ 고르기'];
      lines.push(fitAnsi(`  ${muted}${parts.join(' · ')}${RESET}`, rect.w));
    }
  }
  while (lines.length < rect.h) lines.push(' '.repeat(rect.w));
  return { lines: lines.slice(0, rect.h) };
}

/**
 * desk 사이드바(#887): 스페이스(프로젝트) 목록이 중심이다. 스페이스마다 소속 세션 가운데 가장 급한 상태를 점 하나로 보이고,
 * 고른 세션이 든 스페이스 아래에만 그 세션들을 한 줄씩 짧게 편다. 세션의 자세한 내용(지금 하는 일, 서브에이전트, 게이트, 토큰)은 스페이스 화면의 카드에 있다
 */
import { fit, fitAnsi } from './screen';
import { fg, RESET, DEFAULT_THEME, type ColorToken, type Theme } from './theme';
import type { DeskAgent, DeskItem, DeskUsage } from './types';
import { statusMark } from './widgets';

export type Tone = 'warn' | 'busy' | 'ok' | 'fail' | 'muted';

export interface StatusBadge {
  label: string;
  tone: Tone;
  /** 같은 급함 안에서 종류를 가르는 색(답 기다림은 보라, 입력 필요는 청록, #921). 없으면 tone의 색 */
  color?: ColorToken;
}

export interface SidebarRow {
  /** 색이 섞인 줄. 보이는 폭은 정확히 사이드바 폭이다 */
  text: string;
  /** 고른 세션의 줄이면 true(바탕색으로 그린다) */
  selected: boolean;
  /** 세션 줄이면 그 세션의 순서(deskSessions 순서). 사이드바를 내릴 때와 마우스로 누를 때 쓴다 */
  item?: number;
  /** 스페이스 줄이면 그 스페이스 이름. 누르면 그 스페이스 화면을 연다 */
  space?: string;
  /** "+ 폴더 열기" 줄(#916). 누르면 폴더 열기 화면을 연다 */
  action?: 'folder';
}

/** 세션 하나의 자세한 줄에 붙일 색(카드가 쓴다) */
export interface DetailLine {
  text: string;
  tones: Array<{ text: string; tone: Tone }>;
}

/** 자세한 줄에 올리는 서브에이전트 수의 상한 */
const SUBAGENT_LINES = 6;
const AGENT_STATE: Record<DeskAgent['state'], { label: string; tone: Tone }> = {
  working: { label: '작업 중', tone: 'busy' },
  done: { label: '끝남', tone: 'ok' },
  idle: { label: '대기', tone: 'muted' },
};

export function totalTokens(usage: DeskUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 한 줄에 맞는 토큰 수: 950, 5.1천, 1.2만, 2.5억 */
export function compactTokens(value: number): string {
  const one = (n: number) => (Math.floor(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${one(value / 1_000)}천`;
  if (value < 100_000_000) return `${one(value / 10_000)}만`;
  return `${one(value / 100_000_000)}억`;
}

/** 고른 카드에 펼치는 줄: 서브에이전트마다 한 줄(여섯까지), 그리고 할 수 있는 범위 두 줄(#843) */
export function detailLines(item: DeskItem): DetailLine[] {
  const lines: DetailLine[] = [];
  const subagents = (item.agents ?? []).filter((agent) => agent.kind === 'subagent');
  for (const agent of subagents.slice(0, SUBAGENT_LINES)) {
    const state = AGENT_STATE[agent.state];
    const parts = [...(agent.tool ? [agent.tool] : []), `토큰 ${totalTokens(agent.tokens).toLocaleString('ko-KR')}`, ...(agent.activity ? [agent.activity] : [])];
    lines.push({ text: `↳ ${subagentName(agent)} ${state.label} · ${parts.join(' · ')}`, tones: [{ text: state.label, tone: state.tone }] });
  }
  if (subagents.length > SUBAGENT_LINES) lines.push({ text: `↳ 외 ${subagents.length - SUBAGENT_LINES}개`, tones: [] });
  const capabilities = item.capabilities;
  if (capabilities) {
    const tools = capabilities.tools === 'cli-default' ? 'CLI 기본' : capabilities.tools.join(', ');
    lines.push({ text: `도구 ${tools} · 쓰기 ${capabilities.writeScope}`, tones: [] });
    lines.push({ text: `권한 ${capabilities.permission}`, tones: [] });
  }
  return lines;
}

/** 서브에이전트를 부르는 말: 종류와 맡긴 일(#921). 옛 서버는 이름만 준다 */
export function subagentName(agent: DeskAgent): string {
  return [agent.type ?? agent.name, agent.description].filter(Boolean).join(' ');
}

const BACKEND_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  commandcode: 'Command Code',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  api: 'API',
  demo: '데모',
};

export function backendLabel(backend: string | undefined): string {
  if (!backend) return 'AI';
  return BACKEND_LABEL[backend] ?? backend;
}

/**
 * desk가 다루는 세션: 칸에 열 수 있는 것만(계획 승인 같은 세션 밖 항목은 뺀다). 같은 스페이스(프로젝트)끼리 모으고,
 * 스페이스 차례는 받은 목록에서 처음 나온 차례다(서버가 손댈 것을 먼저 준다). 스페이스 안에서는 받은 차례 그대로다
 */
export function deskSessions(items: readonly DeskItem[]): DeskItem[] {
  const sessions = items.filter((item) => !item.id.startsWith('plan:'));
  const order = new Map<string, number>();
  for (const item of sessions) if (!order.has(item.projectName)) order.set(item.projectName, order.size);
  return sessions
    .map((item, index) => ({ item, index }))
    .sort((a, b) => order.get(a.item.projectName)! - order.get(b.item.projectName)! || a.index - b.index)
    .map((entry) => entry.item);
}

export interface Space {
  name: string;
  /** 이 스페이스의 세션 순서(deskSessions 순서) */
  sessions: number[];
  /** 소속 세션 가운데 가장 급한 상태 */
  status: StatusBadge;
}

/** 급한 차례: 사람이 손댈 것 > 오류 > 작업 중 > 괜찮음 > 쉼 */
const URGENCY: Record<Tone, number> = { warn: 4, fail: 3, busy: 2, ok: 1, muted: 0 };

export function deskSpaces(items: readonly DeskItem[], unseen: ReadonlySet<string> = new Set()): Space[] {
  const spaces: Space[] = [];
  deskSessions(items).forEach((item, index) => {
    let space = spaces.at(-1);
    if (space?.name !== item.projectName) {
      space = { name: item.projectName, sessions: [], status: agentStatus(item, { unseen: unseen.has(item.id) }) };
      spaces.push(space);
    }
    space.sessions.push(index);
    const status = agentStatus(item, { unseen: unseen.has(item.id) });
    if (URGENCY[status.tone] > URGENCY[space.status.tone]) space.status = status;
  });
  return spaces;
}

/** 터미널 CLI가 사람을 부른 까닭. terminal.waiting(#920), 옛 서버의 개입 사유 문자열 차례로 본다 */
export function attentionKind(item: DeskItem): 'permission' | 'question' | 'input' | 'approval' | 'idle' | undefined {
  if (item.terminal?.waiting) return item.terminal.waiting;
  if (item.attention === 'question') return 'question';
  if (item.attention === 'approval') return 'approval';
  return undefined;
}

/** 기다림의 글과 색: 권한은 노랑(급함의 색), 답은 보라, 입력 필요는 청록(#921) */
const ATTENTION: Record<'permission' | 'question' | 'input' | 'approval', { label: string; color?: ColorToken }> = {
  permission: { label: '권한 대기' },
  question: { label: '답 기다림', color: 'purple' },
  input: { label: '입력 필요', color: 'teal' },
  approval: { label: '승인 대기' },
};

/**
 * 에이전트가 지금 무엇을 하는가. 사람이 손대야 하는 것(권한·답·입력)을 먼저 본다.
 * unseen이면 끝났지만 아직 보지 않은 세션이다(#922): 쉬는 CLI를 "끝남"(초록)으로 보이고, 본 뒤에는 흐린 "CLI 대기"다
 */
export function agentStatus(item: DeskItem, options: { unseen?: boolean } = {}): StatusBadge {
  const kind = attentionKind(item);
  if (kind && kind !== 'idle') {
    const { label, color } = ATTENTION[kind];
    return { label, tone: 'warn', ...(color ? { color } : {}) };
  }
  if (item.state === 'working') return { label: '작업 중', tone: 'busy' };
  if (item.state === 'booting') return { label: '켜는 중', tone: 'busy' };
  if (item.state === 'error') return { label: '오류', tone: 'fail' };
  if (item.state === 'stopped') return { label: '멈춤', tone: 'muted' };
  // 작업 카드 계획이 끝나 자원을 돌려준 레인(#868)
  if (item.state === 'done') return { label: '끝남', tone: 'ok' };
  if (item.state === 'dormant') return { label: '꺼짐', tone: 'muted' };
  if (options.unseen) return { label: '끝남', tone: 'ok' };
  if (item.terminal?.cli === 'up') return { label: 'CLI 대기', tone: 'muted' };
  return { label: '쉼', tone: 'muted' };
}

/** 급한 정도(#922): 권한·질문·입력 4 > 오류·검증 실패·확인 필요 3 > 끝남(안 봄) 2 > 작업 중 1 > 쉼 0 */
export function urgencyRank(item: DeskItem, unseen: boolean): number {
  const status = agentStatus(item, { unseen });
  if (status.tone === 'warn') return 4;
  const gate = gateStatus(item);
  if (status.tone === 'fail' || gate?.tone === 'fail' || gate?.tone === 'warn') return 3;
  if (unseen && status.tone === 'ok') return 2;
  if (status.tone === 'busy') return 1;
  return 0;
}

/** 급한 순으로 놓는다. 같은 정도면 받은 차례다. 스페이스 차례는 deskSessions가 처음 나온 차례로 잡으니 가장 급한 세션이 든 스페이스가 위로 온다 */
export function byUrgency(items: readonly DeskItem[], unseen: ReadonlySet<string>): DeskItem[] {
  return items
    .map((item, index) => ({ item, index, rank: urgencyRank(item, unseen.has(item.id)) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/** 앞 목록의 차례를 지킨다(고르는 동안 커서 밑 줄이 움직이지 않게, #922). 내용은 새 목록 것이고 새 항목은 끝에 받은 차례로 둔다 */
export function keepOrder(before: readonly DeskItem[], after: readonly DeskItem[]): DeskItem[] {
  const at = new Map(before.map((item, index) => [item.id, index]));
  return after
    .map((item, index) => ({ item, index, at: at.get(item.id) ?? before.length + index }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.item);
}

/** 게이트가 마지막으로 무엇을 판정했는가. 서버가 gate를 주지 않으면 개입 사유에서 실패·확인 필요만 읽는다 */
export function gateStatus(item: DeskItem): StatusBadge | undefined {
  if (item.attention === 'needs_review') return { label: '확인 필요', tone: 'warn' };
  if (item.gate) {
    if (item.gate.state === 'verifying') return { label: '검증 중', tone: 'busy' };
    if (item.gate.state === 'passed') return { label: '통과', tone: 'ok' };
    if (item.gate.state === 'failed') return { label: '실패', tone: 'fail' };
    return undefined;
  }
  if (item.attention === 'gate_failed') return { label: '실패', tone: 'fail' };
  return undefined;
}

/**
 * 사이드바 줄. 스페이스마다 한 줄(가장 급한 상태 점, 이름, 세션 수)이고, 고른 세션이 든 스페이스 아래에만 세션을 한 줄씩 편다.
 * slots는 세션 id → 열린 칸 번호(1부터), flagged는 알린 뒤 아직 보지 않은 세션(!로 보인다, #864), unseen은 끝났지만 아직 보지 않은 세션(#922)
 */
export function sidebarRows(
  items: readonly DeskItem[],
  selected: number,
  slots: ReadonlyMap<string, number>,
  width: number,
  flagged: ReadonlySet<string> = new Set(),
  theme: Theme = DEFAULT_THEME,
  unseen: ReadonlySet<string> = new Set(),
): SidebarRow[] {
  const sessions = deskSessions(items);
  const muted = fg(theme, 'muted');
  const folder: SidebarRow = { text: fitAnsi(`${fg(theme, 'accent')} + 폴더 열기${RESET}`, width), selected: false, action: 'folder' };
  if (sessions.length === 0) {
    return [
      { text: fit(' 세션이 없습니다', width), selected: false },
      { text: fit(' Ctrl-b n 으로 새 요청', width), selected: false },
      { text: fit('', width), selected: false },
      folder,
    ];
  }
  const rows: SidebarRow[] = [{ text: fitAnsi(`${muted} 스페이스${RESET}`, width), selected: false }];
  const current = sessions[selected]?.projectName;
  for (const space of deskSpaces(items, unseen)) {
    const open = space.name === current;
    const count = `${muted}${space.sessions.length}${RESET}`;
    const head = `${open ? fg(theme, 'text') : ''} ${statusMark(space.status, theme)} ${open ? '\x1b[1m' : ''}${space.name}${RESET}`;
    rows.push({ text: spreadPlain(head, count, String(space.sessions.length).length, width), selected: false, space: space.name });
    if (!open) continue;
    for (const index of space.sessions) {
      const item = sessions[index]!;
      const slot = slots.get(item.id);
      const flag = flagged.has(item.id) ? `${fg(theme, 'yellow')}!${RESET}` : '';
      const marks = [flag, slot ? `${muted}${slot}${RESET}` : ''].filter(Boolean).join(' ');
      const marksWidth = (flag ? 1 : 0) + (slot ? String(slot).length : 0) + (flag && slot ? 1 : 0);
      const line = `   ${statusMark(agentStatus(item, { unseen: unseen.has(item.id) }), theme)} ${item.title}`;
      rows.push({ text: spreadPlain(line, marks, marksWidth, width), selected: index === selected, item: index });
    }
  }
  rows.push(folder);
  return rows;
}

/** 왼쪽 글과 오른쪽 표시(폭 rightWidth)를 width칸 한 줄에 놓는다. 오른쪽 끝에 한 칸 띄운다 */
function spreadPlain(left: string, right: string, rightWidth: number, width: number): string {
  if (!rightWidth) return fitAnsi(left, width);
  if (rightWidth + 3 >= width) return fitAnsi(left, width);
  return `${fitAnsi(left, width - rightWidth - 2)} ${right} `;
}

/**
 * desk 사이드바(#887): 스페이스(프로젝트) 목록이 중심이다. 스페이스마다 소속 세션 가운데 가장 급한 상태를 점 하나로 보이고,
 * 고른 세션이 든 스페이스 아래에만 그 세션들을 한 줄씩 짧게 편다. 세션의 자세한 내용(지금 하는 일, 서브에이전트, 게이트, 토큰)은 스페이스 화면의 카드에 있다
 */
import { fit, fitAnsi } from './screen';
import { fg, RESET, DEFAULT_THEME, type Theme } from './theme';
import type { DeskAgent, DeskItem, DeskUsage } from './types';
import { statusMark } from './widgets';

export type Tone = 'warn' | 'busy' | 'ok' | 'fail' | 'muted';

export interface StatusBadge {
  label: string;
  tone: Tone;
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
    const parts = [`토큰 ${totalTokens(agent.tokens).toLocaleString('ko-KR')}`, ...(agent.activity ? [agent.activity] : [])];
    lines.push({ text: `↳ ${agent.name} ${state.label} · ${parts.join(' · ')}`, tones: [{ text: state.label, tone: state.tone }] });
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

export function deskSpaces(items: readonly DeskItem[]): Space[] {
  const spaces: Space[] = [];
  deskSessions(items).forEach((item, index) => {
    let space = spaces.at(-1);
    if (space?.name !== item.projectName) {
      space = { name: item.projectName, sessions: [], status: agentStatus(item) };
      spaces.push(space);
    }
    space.sessions.push(index);
    const status = agentStatus(item);
    if (URGENCY[status.tone] > URGENCY[space.status.tone]) space.status = status;
  });
  return spaces;
}

/** 에이전트가 지금 무엇을 하는가. 사람이 손대야 하는 것(권한·답)을 먼저 본다 */
export function agentStatus(item: DeskItem): StatusBadge {
  if (item.terminal?.waiting === 'permission') return { label: '권한 대기', tone: 'warn' };
  if (item.attention === 'question') return { label: '답 기다림', tone: 'warn' };
  if (item.attention === 'approval') return { label: '승인 대기', tone: 'warn' };
  if (item.state === 'working') return { label: '작업 중', tone: 'busy' };
  if (item.state === 'booting') return { label: '켜는 중', tone: 'busy' };
  if (item.state === 'error') return { label: '오류', tone: 'fail' };
  if (item.state === 'stopped') return { label: '멈춤', tone: 'muted' };
  // 작업 카드 계획이 끝나 자원을 돌려준 레인(#868)
  if (item.state === 'done') return { label: '끝남', tone: 'ok' };
  if (item.state === 'dormant') return { label: '꺼짐', tone: 'muted' };
  if (item.terminal?.cli === 'up') return { label: 'CLI 대기', tone: 'ok' };
  return { label: '쉼', tone: 'muted' };
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
 * slots는 세션 id → 열린 칸 번호(1부터), flagged는 알린 뒤 아직 보지 않은 세션(!로 보인다, #864)
 */
export function sidebarRows(
  items: readonly DeskItem[],
  selected: number,
  slots: ReadonlyMap<string, number>,
  width: number,
  flagged: ReadonlySet<string> = new Set(),
  theme: Theme = DEFAULT_THEME,
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
  for (const space of deskSpaces(items)) {
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
      const line = `   ${statusMark(agentStatus(item), theme)} ${item.title}`;
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

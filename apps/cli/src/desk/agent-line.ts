/**
 * 서브에이전트 한 줄(#1411): 가지(├ └)·상태 표시·종류와 맡긴 일·지금 도구(끝났으면 결과)·경과.
 * 에이전트 나무(m)와 사이드바가 같은 글을 쓰도록 한 군데에 둔다. 보이는 폭은 늘 width다(넓은 글자 포함)
 */
import { agentQuiet, clipWords, forText, oneLine, spanText, toolLineLabel } from './cards';
import { fitAnsi, stringWidth } from './screen';
import { subagentName } from './sidebar';
import { fg, RESET, type Theme } from './theme';
import type { DeskAgent } from './types';

export interface AgentLineOptions {
  width: number;
  theme: Theme;
  now: number;
  /** 가지 앞의 글(나무는 고름 표시 두 칸, 사이드바는 빈칸). 색 없는 글이어야 한다 */
  lead: string;
  /** 가지 앞의 빈칸 수 */
  indent: number;
  /** 마지막 자식이면 └ */
  last: boolean;
  /** 좁은 자리(사이드바): 오른쪽 글을 짧게 줄인다 */
  compact?: boolean;
}

interface Right {
  text: string;
  color: 'muted' | 'accent' | 'yellow';
}

function rightOf(agent: DeskAgent, now: number, compact: boolean): Right | undefined {
  const quiet = agentQuiet(agent, now);
  if (quiet !== undefined) return { text: compact ? `⚠${spanText(quiet)}` : `⚠ ${spanText(quiet)}째 소식 없음`, color: 'yellow' };
  if (agent.state === 'working' && agent.startedAt) return { text: compact ? forText(agent.startedAt, now).replace(/째$/, '') : forText(agent.startedAt, now), color: 'accent' };
  if (agent.state === 'done' && agent.startedAt && agent.lastAt) return { text: spanText(Math.max(0, Date.parse(agent.lastAt) - Date.parse(agent.startedAt))), color: 'muted' };
  if (agent.state === 'idle') return { text: '대기', color: 'muted' };
  return undefined;
}

export function agentMark(agent: DeskAgent, theme: Theme, now: number): string {
  const quiet = agentQuiet(agent, now);
  return agent.state === 'done' ? `${fg(theme, 'teal')}✓${RESET}` : agent.state === 'working' ? `${fg(theme, quiet !== undefined ? 'yellow' : 'accent')}◐${RESET}` : `${fg(theme, 'muted')}○${RESET}`;
}

export function agentLine(agent: DeskAgent, options: AgentLineOptions): string {
  const { width, theme, now } = options;
  const branch = `${fg(theme, 'border')}${' '.repeat(options.indent)}${options.last ? '└' : '├'} ${RESET}`;
  const right = rightOf(agent, now, options.compact === true);
  const rightWidth = right && stringWidth(right.text) > 0 ? stringWidth(right.text) + 1 : 0;
  const prefixWidth = stringWidth(options.lead) + options.indent + 2 + 2;
  const room = Math.max(1, width - prefixWidth - rightWidth);
  const doing = agent.state === 'working' ? (agent.tool ? toolLineLabel(agent.tool) : agent.activity) : undefined;
  const result = agent.state === 'done' && agent.result ? oneLine(agent.result) : undefined;
  const name = subagentName(agent) || '서브에이전트';
  // 종류와 맡긴 일은 도구·결과보다 먼저 자리를 잡는다
  const tail = doing ? oneLine(doing) : result ? `결과 ${result}` : '';
  // 좁은 자리(사이드바)에서는 종류와 맡긴 일을 먼저 다 보이고, 도구는 남는 자리가 있을 때만 붙인다
  const nameMax = options.compact ? room : tail ? Math.max(8, Math.min(stringWidth(name), Math.floor(room * 0.6))) : room;
  const nameText = clipWords(name, nameMax);
  const tailRoom = room - stringWidth(nameText) - 3;
  const tailText = tail && tailRoom >= 6 ? clipWords(tail, tailRoom) : '';
  const body = `${nameText}${tailText ? `${fg(theme, 'muted')} · ${RESET}${tailText}` : ''}`;
  const left = `${options.lead}${branch}${agentMark(agent, theme, now)} ${fitAnsi(body, room)}`;
  return right && rightWidth ? fitAnsi(`${left} ${fg(theme, right.color)}${right.text}${RESET}`, width) : fitAnsi(left, width);
}

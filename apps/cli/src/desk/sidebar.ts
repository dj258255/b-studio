/** desk 사이드바: AI마다 두 줄(AI·프로젝트, 상태·게이트·체크포인트·비용). herdr의 "막힘/작업 중/끝남" 줄에 게이트 판정을 붙인다 */
import { fit } from './screen';
import type { DeskItem } from './types';

export type Tone = 'warn' | 'busy' | 'ok' | 'fail' | 'muted';

export interface StatusBadge {
  label: string;
  tone: Tone;
}

export interface SidebarRow {
  text: string;
  /** 고른 항목의 줄이면 true(반전으로 그린다) */
  selected: boolean;
  tones?: Array<{ text: string; tone: Tone }>;
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

/** 사이드바에 올리는 항목: 칸에 열 수 있는 세션만(계획 승인 같은 세션 밖 항목은 뺀다) */
export function deskSessions(items: readonly DeskItem[]): DeskItem[] {
  return items.filter((item) => !item.id.startsWith('plan:'));
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

/** 사이드바 줄. slots는 세션 id → 열린 칸 번호(1부터) */
export function sidebarRows(items: readonly DeskItem[], selected: number, slots: ReadonlyMap<string, number>, width: number): SidebarRow[] {
  const sessions = deskSessions(items);
  if (sessions.length === 0) {
    return [
      { text: fit(' 세션이 없습니다', width), selected: false },
      { text: fit(' Ctrl-b n 으로 새 요청', width), selected: false },
    ];
  }
  const rows: SidebarRow[] = [];
  sessions.forEach((item, index) => {
    const slot = slots.get(item.id);
    const mark = index === selected ? '▸' : ' ';
    const head = `${mark}${slot ? `[${slot}]` : ''} ${backendLabel(item.backend)} · ${item.projectName} · ${item.title}`;
    const status = agentStatus(item);
    const gate = gateStatus(item);
    const parts = [status.label];
    if (gate) parts.push(gate.label);
    if (item.gate && item.gate.checkpoints > 0) parts.push(`체크포인트 ${item.gate.checkpoints}`);
    if (item.costUsd !== undefined && item.costUsd > 0) parts.push(`$${item.costUsd.toFixed(2)}`);
    const tones = [{ text: status.label, tone: status.tone }, ...(gate ? [{ text: gate.label, tone: gate.tone }] : [])];
    rows.push({ text: fit(head, width), selected: index === selected });
    rows.push({ text: fit(`   ${parts.join(' · ')}`, width), selected: false, tones });
  });
  return rows;
}

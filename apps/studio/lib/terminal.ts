import type { ChatItem } from './session-view';

/** 세션 터미널 화면이 쓰는 작은 순수 함수들(이슈 #673). 화면 컴포넌트와 따로 두어 브라우저 없이 테스트한다 */

export type TerminalStatus =
  | { state: 'idle' }
  | { state: 'opening'; message?: string }
  | { state: 'open'; message?: string }
  | { state: 'closed'; message?: string }
  | { state: 'exited'; code: number | null };

/** 서버가 base64로 실어 준 출력을 바이트로 되돌린다. 화면 제어 문자와 여러 바이트 글자가 섞여 있어 글자로 바꾸지 않고 터미널에 그대로 준다 */
export function decodeTerminalData(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function terminalStatusLabel(status: TerminalStatus): string {
  switch (status.state) {
    case 'idle':
      return '연결하는 중';
    case 'opening':
      return '컨테이너를 준비하는 중';
    case 'open':
      return '열림';
    case 'exited':
      return status.code === 0 || status.code === null ? '터미널이 끝났습니다' : `터미널이 끝났습니다 (종료 코드 ${status.code})`;
    case 'closed':
      return status.message ? `닫힘 — ${status.message}` : '닫힘';
  }
}

export type AgentSurface = 'chat' | 'terminal';
const SURFACE_KEY = 'b-studio:agent-surface';

/**
 * 일을 시키는 자리. 터미널을 쓸 수 있는 세션은 터미널이 기본이다(이슈 #689) — 사람이 "대화 입력으로 보기"를 골랐을 때만 대화다.
 * 저장소를 못 쓰는 환경에서도 터미널로 둔다(터미널을 쓸 수 없는 세션에서는 이 값을 보지 않고 대화 창을 그린다)
 */
export const DEFAULT_AGENT_SURFACE: AgentSurface = 'terminal';

export function readAgentSurface(storage: Pick<Storage, 'getItem'> | undefined): AgentSurface {
  try {
    return storage?.getItem(SURFACE_KEY) === 'chat' ? 'chat' : DEFAULT_AGENT_SURFACE;
  } catch {
    return DEFAULT_AGENT_SURFACE;
  }
}

export function writeAgentSurface(storage: Pick<Storage, 'setItem'> | undefined, surface: AgentSurface): void {
  try {
    storage?.setItem(SURFACE_KEY, surface);
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다
  }
}

/** 터미널에서 보낸 마지막 요청이 지금 어디까지 왔는지. 터미널 아래의 활동 줄이 한 줄로 알려 준다(자세한 것은 펼친 기록에 있다) */
export interface TerminalGateStatus {
  tone: 'working' | 'ok' | 'fail' | 'idle';
  text: string;
}

export function terminalGateStatus(chat: readonly ChatItem[]): TerminalGateStatus | undefined {
  const request = chat.findLast((item): item is Extract<ChatItem, { kind: 'request' }> => item.kind === 'request' && item.via === 'terminal');
  if (!request) return undefined;
  const ofRun = chat.filter((item) => 'runId' in item && item.runId === request.runId);
  const gate = ofRun.findLast((item): item is Extract<ChatItem, { kind: 'gate' }> => item.kind === 'gate');
  const outcome = ofRun.findLast((item): item is Extract<ChatItem, { kind: 'outcome' }> => item.kind === 'outcome');
  if (!outcome) {
    if (gate && !gate.interrupted) {
      // 서비스 재시작과 계약 결과(report)가 온 뒤에 테스트·화면 확인이 이어진다. 그 확인들의 실패는 report가 아니라 확인 항목에 있다
      const failed = (gate.report && !gate.report.ok) || ofRun.slice(ofRun.lastIndexOf(gate)).some((item) => item.kind === 'check' && !item.ok);
      if (failed) return { tone: 'fail', text: '검증을 통과하지 못해 결과를 에이전트에게 돌려줬습니다. 고친 뒤 턴이 끝나면 다시 검증합니다' };
      return { tone: 'working', text: '검증하는 중입니다. 서비스를 다시 띄우고 확인을 돌립니다' };
    }
    return { tone: 'working', text: '요청을 처리하는 중입니다. 턴이 끝나면 검증합니다' };
  }
  switch (outcome.status) {
    case 'done':
      return gate ? { tone: 'ok', text: '마지막 요청이 검증을 통과했습니다. 체크포인트로 남겼습니다' } : { tone: 'idle', text: '마지막 요청은 파일을 바꾸지 않고 끝났습니다' };
    case 'failed':
      return { tone: 'fail', text: '마지막 요청이 검증을 통과하지 못해 변경을 되돌렸습니다. 기록에서 사유를 보고 되살릴 수 있습니다' };
    case 'cancelled':
      return { tone: 'idle', text: '마지막 요청을 닫고 변경을 되돌렸습니다. 기록에서 되살릴 수 있습니다' };
    default:
      return { tone: 'fail', text: '마지막 요청을 검증하지 못했습니다. 기록에서 사유를 확인하세요' };
  }
}

/** 터미널 아래 활동 줄에 그릴 것(이슈 #689): 마지막 터미널 요청의 검증 상태와 단계별 결과, 가장 최근 체크포인트 */
export interface TerminalActivity {
  status?: TerminalGateStatus;
  /** 마지막 터미널 요청의 마지막 검증 회차가 확인한 단계. 확인한 순서대로, 단계마다 하나 */
  stages: Array<{ stage: string; ok: boolean }>;
  /** 세션의 가장 최근 체크포인트(세션 시작은 뺀다). 턴 상한에서 남긴 것이면 incomplete */
  checkpoint?: { shortSha: string; incomplete: boolean };
}

export function terminalActivity(chat: readonly ChatItem[], checkpoints: ReadonlyArray<{ shortSha: string; incomplete?: 'max_turns' }>): TerminalActivity {
  const status = terminalGateStatus(chat);
  const request = chat.findLast((item): item is Extract<ChatItem, { kind: 'request' }> => item.kind === 'request' && item.via === 'terminal');
  const stages: TerminalActivity['stages'] = [];
  if (request) {
    const ofRun = chat.filter((item) => 'runId' in item && item.runId === request.runId);
    const lastGate = ofRun.findLastIndex((item) => item.kind === 'gate');
    if (lastGate >= 0) {
      const gate = ofRun[lastGate] as Extract<ChatItem, { kind: 'gate' }>;
      // 서비스 재시작과 계약 비교는 확인 항목이 아니라 게이트의 보고서로 온다
      if (gate.report) stages.push({ stage: 'run', ok: gate.report.ok });
      for (const item of ofRun.slice(lastGate + 1)) {
        if (item.kind !== 'check') continue;
        const known = stages.find((entry) => entry.stage === item.stage);
        if (known) known.ok = known.ok && item.ok;
        else stages.push({ stage: item.stage, ok: item.ok });
      }
    }
  }
  // 목록의 마지막은 세션 시작 체크포인트다
  const latest = checkpoints.length > 1 ? checkpoints[0] : undefined;
  return { ...(status ? { status } : {}), stages, ...(latest ? { checkpoint: { shortSha: latest.shortSha, incomplete: latest.incomplete === 'max_turns' } } : {}) };
}

/**
 * 다른 패널이 "입력창에 채우기"로 넘긴 글을 터미널의 입력 줄에 붙여 넣을 꼴로 다듬는다(이슈 #689).
 * 대화 입력창에서는 "읽기만" 스위치를 함께 켤 수 있었다. 터미널에는 그 스위치가 없으므로 같은 뜻을 글로 앞에 적는다
 */
export function terminalPasteText(text: string, mode?: { readOnly?: boolean }): string {
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (body === '') return '';
  return mode?.readOnly ? `파일은 바꾸지 말고 답만 해 주세요.\n\n${body}` : body;
}

/** 터미널과 작업 패널 사이 경계의 자리(왼쪽 칸이 차지하는 비율). 너무 좁아져 쓸 수 없게 되지 않도록 범위를 둔다 */
export const SPLIT_MIN = 0.3;
export const SPLIT_MAX = 0.7;
export const SPLIT_DEFAULT = 0.5;
const SPLIT_KEY = 'b-studio:terminal-split';

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

export function readSplit(storage: Pick<Storage, 'getItem'> | undefined): number {
  try {
    const raw = storage?.getItem(SPLIT_KEY);
    return raw === null || raw === undefined || raw === '' ? SPLIT_DEFAULT : clampSplit(Number(raw));
  } catch {
    return SPLIT_DEFAULT;
  }
}

export function writeSplit(storage: Pick<Storage, 'setItem'> | undefined, value: number): void {
  try {
    storage?.setItem(SPLIT_KEY, String(Math.round(clampSplit(value) * 1000) / 1000));
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다
  }
}

const RECORD_KEY = 'b-studio:terminal-record-open';

/** 활동 기록을 펼쳐 뒀는가. 기본은 접힘(터미널이 넓게 보이는 쪽) */
export function readRecordOpen(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(RECORD_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeRecordOpen(storage: Pick<Storage, 'setItem'> | undefined, open: boolean): void {
  try {
    storage?.setItem(RECORD_KEY, open ? '1' : '0');
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다
  }
}


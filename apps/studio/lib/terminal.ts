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
 * 읽기만 요청의 표시. 요청 글이 이것으로 시작하면 플랫폼이 그 실행에서 파일을 바꿀 수 있는 도구를 모두 거절한다
 * (쓰기 직전의 훅, sessions.ts의 terminalToolStarting). 문장으로 부탁하는 것이 아니라 훅이 막는다
 */
export const TERMINAL_READ_ONLY_MARK = '[읽기만]';

export function isReadOnlyPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(TERMINAL_READ_ONLY_MARK);
}

/** 붙여 넣는 글의 길이 상한. 터미널에 한꺼번에 밀어 넣는 양을 묶는다 */
export const TERMINAL_PASTE_LIMIT = 8_000;

/**
 * 제어 문자와 방향 제어 문자. 터미널에 붙여 넣는 것은 글이 아니라 키 입력이다 — 남이 쓴 글(이슈 본문, 리뷰 지적, 미리보기의 HTML)에
 * ESC나 붙여 넣기 끝 표시가 들어 있으면 붙여 넣기 구간을 빠져나와 Enter까지 누를 수 있다. xterm의 paste는 걸러 주지 않는다(6.0.0에서 확인).
 * 줄바꿈과 탭만 남기고 C0·DEL·C1을 지운다. 방향 제어 문자(U+202A~202E, U+2066~2069)는 사람이 보는 글과 실제 글을 다르게 만들 수 있어 함께 지운다
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_PASTE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * 다른 패널이 "입력창에 채우기"로 넘긴 글을 터미널의 입력 줄에 붙여 넣을 꼴로 다듬는다(이슈 #689).
 * - 제어 문자를 지운다(위)
 * - multiline이 거짓이면(CLI가 붙여 넣기 모드를 켜 두지 않았다 — 셸 프롬프트일 수 있다) 줄바꿈을 빈칸으로 바꾼다.
 *   그 상태에서 줄바꿈은 Enter로 들어가, 글의 줄마다 명령으로 실행된다
 * - 입력 줄의 첫 글자로 CLI의 다른 모드를 여는 글자("!" 셸, "/" 명령)로 시작하면 앞에 말을 붙여 보통 요청으로 만든다
 * - 읽기만이면 표시를 앞에 붙인다. 플랫폼이 그 표시를 보고 쓰기 도구를 막는다
 */
export function terminalPasteText(text: string, { readOnly = false, multiline = true }: { readOnly?: boolean; multiline?: boolean } = {}): string {
  let body = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(UNSAFE_PASTE_CHARS, '').trim();
  if (body === '') return '';
  if (!multiline) body = body.replace(/\s*\n\s*/g, ' ');
  if (body.length > TERMINAL_PASTE_LIMIT) body = `${body.slice(0, TERMINAL_PASTE_LIMIT)}…(잘림)`;
  if (readOnly) return `${TERMINAL_READ_ONLY_MARK} ${body}`;
  return /^[!/]/.test(body) ? `요청: ${body}` : body;
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


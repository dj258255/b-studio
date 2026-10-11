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
      // 열렸지만 함께 알릴 것이 있다(관문 없이 열림)
      return status.message ? `열림 · ${status.message}` : '열림';
    case 'exited':
      return status.code === 0 || status.code === null ? '터미널이 끝났습니다' : `터미널이 끝났습니다 (종료 코드 ${status.code})`;
    case 'closed':
      return status.message ? `닫힘 — ${status.message}` : '닫힘';
  }
}

export type AgentSurface = 'chat' | 'terminal';
const SURFACE_KEY = 'b-studio:agent-surface';

/** 마지막으로 고른 자리(대화·터미널). 저장소를 못 쓰는 환경에서는 대화로 둔다 */
export function readAgentSurface(storage: Pick<Storage, 'getItem'> | undefined): AgentSurface {
  try {
    return storage?.getItem(SURFACE_KEY) === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
}

export function writeAgentSurface(storage: Pick<Storage, 'setItem'> | undefined, surface: AgentSurface): void {
  try {
    storage?.setItem(SURFACE_KEY, surface);
  } catch {
    // 기억하지 못해도 화면은 그대로 쓴다
  }
}

/** 터미널에서 보낸 마지막 요청이 지금 어디까지 왔는지. 터미널을 보는 동안에는 대화 창이 가려져 있어 한 줄로 알려 준다 */
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
      return { tone: 'fail', text: '마지막 요청이 검증을 통과하지 못했습니다. 변경은 작업 폴더에 남아 있고 체크포인트는 없습니다' };
    case 'cancelled':
      return { tone: 'idle', text: '마지막 요청을 닫았습니다. 변경은 작업 폴더에 남아 있고 체크포인트는 없습니다' };
    default:
      return { tone: 'fail', text: '마지막 요청을 검증하지 못했습니다. 대화 창에서 사유를 확인하세요' };
  }
}

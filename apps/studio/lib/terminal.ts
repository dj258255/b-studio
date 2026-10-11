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

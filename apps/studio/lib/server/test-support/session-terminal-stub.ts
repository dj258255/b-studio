/** `./session-terminal`의 가짜: 컨테이너의 CLI 없이 세션 터미널이 있는 것처럼만 답한다. sessions.ts를 불러오지 않는다(terminal-run.ts 머리말 참고) */
export function sessionTerminalStub(mode: 'container' | 'host' = 'container'): Record<string, unknown> {
  return {
    disposeSessionTerminal: async () => {},
    interruptSessionTerminal: () => {},
    noteSessionTerminalCli: () => {},
    sessionTerminalMode: () => mode,
    warnSessionTerminal: () => {},
    terminalPause: () => undefined,
  };
}


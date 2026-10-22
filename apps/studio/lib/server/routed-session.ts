/**
 * 규칙으로 고른 AI로 새 세션을 만들고 첫 요청을 보낸다(#822). 플릿(fleets.ts)과 같은 순서다: 세션을 만들고 → 요청을 보낸다.
 * 세션은 사람이 만든 일반 세션처럼 샌드박스를 지연 기동한다(첫 만들기 요청이 켠다).
 * terminal이면(#836) 대화 러너 대신 고른 AI의 CLI 터미널을 열고, CLI가 뜨면 첫 요청을 붙여 넣는다. 게이트·체크포인트는
 * 터미널 실행의 관문이 그대로 맡는다.
 */
import type { RuleIntent } from '../backend-rules';
import type { SessionMode, SessionSnapshot, StudioEvent } from '../studio-events';
import { terminalPasteText } from '../terminal';
import { chooseBackend, chooseDirect, type BackendFilter, type RoutingDecision } from './backend-rules';
import { assertDesignApprovedForRequest } from './design-pipeline';
import { StudioError } from './errors';
import { newSessionModel } from './new-session';
import { findProject } from './projects';
import { openSessionTerminal, sessionTerminalCliAlive, sessionTerminalMode, writeSessionTerminal, type TerminalMode } from './session-terminal';
import { createSession, sendMessage, sessionTerminalAllowed, sessionTerminalTarget, subscribe } from './sessions';

export interface RoutedTerminal {
  opened: true;
  /** 첫 요청을 CLI에 붙여 넣었는가. CLI가 시간 안에 뜨지 않았으면 false이고 pasteError에 까닭이 있다 */
  pasted: boolean;
  /** 붙여 넣지 못했거나, 붙여 넣었지만 실행이 시작됐는지 확인하지 못한 까닭. 사람이 그 칸에서 직접 이어 간다 */
  pasteError?: string;
}

export interface RoutedSession {
  session: SessionSnapshot;
  routing: RoutingDecision;
  /** 보낸 요청의 실행. 세션은 만들었는데 보내지 못했으면 없고 sendError에 까닭이 있다. 터미널로 보냈으면 없다 */
  runId?: string;
  sendError?: string;
  /** 터미널로 보냈을 때만 있다(#836) */
  terminal?: RoutedTerminal;
}

/** 터미널로 보낼 때 쓰는 것들. 테스트가 바꿔 끼운다 */
export interface RoutedTerminalDeps {
  /** 세션 터미널을 쓸 수 있는 설정인가(실험 기능 + 개인 PC 모드) */
  allowed: () => boolean;
  mode: () => TerminalMode;
  driver: {
    open: (sessionId: string) => Promise<void>;
    cliAlive: (sessionId: string) => boolean;
    write: (sessionId: string, data: string) => void;
  };
  subscribe: (sessionId: string, listener: (event: StudioEvent) => void) => () => void;
  /** CLI가 뜨기를 기다리는 상한. 넘으면 붙여 넣지 않는다(새 폴더마다 claude가 폴더 신뢰를 물어 사람이 눌러야 할 수 있다) */
  cliTimeoutMs: number;
  /** 붙여 넣은 요청이 실행으로 이어지기를 기다리는 상한. 한 번 넘으면 Enter를 한 번 더 보내고 또 기다린다 */
  submitTimeoutMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultTerminalDeps: RoutedTerminalDeps = {
  allowed: () => sessionTerminalAllowed(),
  mode: () => sessionTerminalMode(),
  // 작업 카드 레인(terminal-lane)과 같은 크기로 연다. 화면이 붙으면 그 화면의 크기로 다시 맞춘다
  driver: {
    open: (sessionId) => openSessionTerminal(sessionId, sessionTerminalTarget(sessionId), { cols: 120, rows: 32 }),
    cliAlive: (sessionId) => sessionTerminalCliAlive(sessionId),
    write: (sessionId, data) => writeSessionTerminal(sessionId, data),
  },
  subscribe: (sessionId, listener) => subscribe(sessionId, listener),
  cliTimeoutMs: 20_000,
  submitTimeoutMs: 8_000,
  pollMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * 터미널에서 띄울 수 있는 AI. 터미널 CLI는 세션 백엔드로 정해진다: 이 컴퓨터 방식이면 Claude Code·Codex, 컨테이너 방식이면 Claude Code뿐이다.
 * 그 밖의 백엔드로 세션을 만들면 터미널에는 claude가 떠서 고른 AI와 달라지므로 거른다
 */
function terminalBackends(mode: TerminalMode): BackendFilter {
  return (backend) => {
    if (backend === 'claude-code') return undefined;
    if (backend === 'codex') return mode === 'host' ? undefined : '컨테이너 방식 터미널은 Claude Code만 띄웁니다';
    return '터미널에서 띄울 수 없는 AI입니다(Claude Code·Codex만)';
  };
}

export async function startRoutedSession(
  input: { projectId: string; user: string; workspace: 'copy' | 'local'; request: string; intent: RuleIntent; direct?: { backend: string; model?: string }; terminal?: true },
  terminalOverrides?: Partial<RoutedTerminalDeps>,
): Promise<RoutedSession> {
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  const terminalDeps = input.terminal ? { ...defaultTerminalDeps, ...terminalOverrides } : undefined;
  if (terminalDeps && !terminalDeps.allowed()) throw new StudioError(400, '터미널로 보내려면 실험 기능을 켠 개인 PC 모드여야 합니다(B_STUDIO_EXPERIMENTAL=1)');
  const project = await findProject(input.projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  const only = terminalDeps ? terminalBackends(terminalDeps.mode()) : undefined;
  // 직접 고른 AI(#827)는 규칙을 건너뛴다. 그 AI를 쓸 수 없으면 세션을 만들기 전에 거절한다
  const routing = input.direct
    ? await chooseDirect({ ...input.direct, request, intent: input.intent, cwd: project.root, ...(only ? { only } : {}) })
    : await chooseBackend({ request, intent: input.intent, cwd: project.root, ...(only ? { only } : {}) });
  const backend = routing.backend as SessionMode;
  const { modelId, effort } = await newSessionModel(input.projectId, backend, routing.model);
  const session = await createSession(input.projectId, input.user, input.workspace, { modelId, effort, backend, boot: 'on-demand' });
  try {
    // 대화 창에서 보낸 요청과 같은 조건이다(messages 라우트). 설계 승인은 만들기 요청만 본다
    if (input.intent === 'build') await assertDesignApprovedForRequest(session.id, request);
    if (terminalDeps) {
      await terminalDeps.driver.open(session.id);
      return { session, routing, terminal: await pasteFirstRequest(session.id, request, input.intent, terminalDeps) };
    }
    const { runId } = sendMessage(session.id, request, { allowBreaking: false, by: input.user, intent: input.intent, interactive: true, steering: true });
    return { session, routing, runId };
  } catch (error) {
    // 세션은 이미 만들어졌다. 지우지 않고 돌려줘 화면이 그 세션을 열고 까닭을 보이게 한다
    return { session, routing, sendError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * CLI가 뜨기를 기다렸다가 첫 요청을 붙여 넣는다. 작업 카드 레인(ADR-178)과 같은 꼴이다: bracketed paste + Enter,
 * 실행이 시작되지 않으면 Enter를 한 번 더. 새 세션이라 앞선 실행이 없으므로 시작된 터미널 실행은 이 요청의 것이다
 */
async function pasteFirstRequest(sessionId: string, request: string, intent: RuleIntent, deps: RoutedTerminalDeps): Promise<RoutedTerminal> {
  const text = terminalPasteText(request, { readOnly: intent === 'ask' });
  if (!text) return { opened: true, pasted: false, pasteError: '붙여 넣을 요청 글이 비어 있습니다' };
  if (!(await waitUntil(deps, deps.cliTimeoutMs, () => deps.driver.cliAlive(sessionId)))) {
    return {
      opened: true,
      pasted: false,
      pasteError: `${Math.round(deps.cliTimeoutMs / 1000)}초 안에 터미널의 CLI가 뜨지 않아 요청을 넣지 않았습니다. 새 세션 폴더라 CLI가 폴더 신뢰를 묻고 있을 수 있습니다. 그 칸에서 답한 뒤 요청을 직접 넣으세요`,
    };
  }
  let started = false;
  const unsubscribe = deps.subscribe(sessionId, (event) => {
    if (event.type === 'run_started' && event.via === 'terminal') started = true;
  });
  try {
    deps.driver.write(sessionId, `\x1b[200~${text}\x1b[201~`);
    deps.driver.write(sessionId, '\r');
    if (!(await waitUntil(deps, deps.submitTimeoutMs, () => started))) {
      deps.driver.write(sessionId, '\r');
      if (!(await waitUntil(deps, deps.submitTimeoutMs, () => started))) {
        return { opened: true, pasted: true, pasteError: '요청을 붙여 넣었지만 실행이 시작되지 않았습니다. 입력 줄에 글이 남아 있으면 그 칸에서 Enter를 누르세요' };
      }
    }
    return { opened: true, pasted: true };
  } finally {
    unsubscribe();
  }
}

async function waitUntil(deps: Pick<RoutedTerminalDeps, 'pollMs' | 'sleep'>, timeoutMs: number, ready: () => boolean): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (ready()) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await deps.sleep(deps.pollMs);
  }
}

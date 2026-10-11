import { startHookServer, startToolServer, type HookInput, type HookServer, type ToolOutcome, type ToolServer, type ToolServerOptions } from '@b-studio/agent';
import { AGENT_GATEWAY_ENV, AGENT_GATEWAY_HOST, type AgentHookEvent } from '@b-studio/sandbox';

/**
 * 세션 터미널의 관문(이슈 #673 2단계): 컨테이너 안의 CLI가 부르는 서버 둘을 세션마다 띄운다.
 *  - 훅 서버: 대화의 시작, 요청의 시작, 쓰기 직전, 턴의 끝, CLI의 종료
 *  - 도구 서버(MCP): 서비스 컨테이너 안에서 도는 b-studio 도구
 *
 * 둘 다 127.0.0.1에만 열고 서버마다 새 토큰을 쓴다. 컨테이너는 호스트를 `host.docker.internal`로 부르므로 그 이름의 Host만 더 받는다.
 * 주소와 토큰은 파일에 쓰지 않고 터미널을 여는 프로세스의 환경 변수로만 넘긴다.
 *
 * 컨테이너 안에서 온 값은 모두 바깥에서 온 값이다. 이 토큰을 가진 쪽(터미널 안의 CLI와 그것이 돌린 명령)이 할 수 있는 일은
 * "요청이 시작됐다·끝났다"고 알리는 것과 서비스 컨테이너의 도구를 부르는 것뿐이다. 통과 여부는 여기서 받는 값이 아니라
 * 호스트가 작업 복사본을 직접 보고 돌리는 게이트가 정한다.
 */

/** 훅이 CLI에 돌려줄 답. 훅 종류마다 꼴이 달라 여기 한 곳에서 CLI의 규약으로 옮긴다 */
export interface TerminalGatewayHandlers {
  /** 대화가 시작될 때 CLI의 맥락에 넣을 글. 없으면 넣지 않는다 */
  note(): Promise<string | undefined>;
  /** 사용자가 요청을 보냈다. blocked를 주면 요청을 막고 그 글을 사용자에게 보인다 */
  prompt(input: HookInput): Promise<{ blocked?: string }>;
  /** 파일을 바꿀 수 있는 도구를 쓰기 직전. deny를 주면 도구를 막고, message는 막지 않고 사용자에게만 알린다 */
  preTool(input: HookInput): Promise<{ deny?: string; message?: string }>;
  /** 턴이 끝났다. feedback을 주면 멈추지 못하게 하고 그 글을 에이전트에게 돌려준다. message는 사용자에게만 보인다 */
  stop(input: HookInput): Promise<{ feedback?: string; message?: string }>;
  /** CLI가 끝났다 */
  sessionEnd(input: HookInput): Promise<void>;
  toolSpecs: Exclude<ToolServerOptions['specs'], unknown[]>;
  runTool(name: string, args: unknown): Promise<ToolOutcome>;
}

export interface TerminalGateway {
  /** 터미널 안의 프로세스에 넘길 환경 변수(관문의 주소와 토큰) */
  env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/** 사용자에게만 보이는 한 줄. CLI가 "<훅> says: …"로 보여 준다 */
const say = (message: string | undefined): Record<string, unknown> => (message ? { systemMessage: message } : {});

/** 훅 종류 → 처리. 핸들러가 던지면 훅 서버가 5xx로 답하고, 훅 스크립트는 CLI를 막지 않는다(판정은 호스트의 게이트가 한다) */
export function terminalHookRoutes(handlers: TerminalGatewayHandlers): Record<`/${AgentHookEvent | 'ping'}`, (input: HookInput) => Promise<Record<string, unknown>>> {
  return {
    // 터미널을 열기 전에 컨테이너에서 여기에 닿는지 묻는다
    '/ping': async () => ({}),
    '/session-start': async () => {
      const note = await handlers.note();
      return note ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } } : {};
    },
    '/prompt': async (input) => {
      const { blocked } = await handlers.prompt(input);
      return blocked ? { decision: 'block', reason: blocked } : {};
    },
    '/pre-tool': async (input) => {
      const { deny, message } = await handlers.preTool(input);
      if (deny) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } };
      return say(message);
    },
    '/stop': async (input) => {
      const { feedback, message } = await handlers.stop(input);
      return feedback ? { decision: 'block', reason: feedback } : say(message);
    },
    '/session-end': async (input) => {
      await handlers.sessionEnd(input);
      return {};
    },
  };
}

export async function startTerminalGateway(handlers: TerminalGatewayHandlers): Promise<TerminalGateway> {
  const allowedHosts = [AGENT_GATEWAY_HOST];
  let hook: HookServer | undefined;
  let tools: ToolServer | undefined;
  try {
    hook = await startHookServer(terminalHookRoutes(handlers), { allowedHosts });
    tools = await startToolServer({ specs: handlers.toolSpecs, run: handlers.runTool, allowedHosts });
  } catch (error) {
    await hook?.close().catch(() => {});
    throw error;
  }
  const servers = [hook, tools];
  return {
    env: {
      [AGENT_GATEWAY_ENV.hookUrl]: `http://${AGENT_GATEWAY_HOST}:${hook.port}`,
      [AGENT_GATEWAY_ENV.hookToken]: hook.token,
      [AGENT_GATEWAY_ENV.mcpUrl]: `http://${AGENT_GATEWAY_HOST}:${tools.port}/mcp`,
      [AGENT_GATEWAY_ENV.mcpToken]: tools.token,
    },
    async close() {
      await Promise.allSettled(servers.map((server) => server.close()));
    },
  };
}

interface GatewayEntry {
  /** 띄우는 중이거나 띄운 관문. 동시에 여러 번 불려도 하나만 띄운다 */
  starting: Promise<TerminalGateway>;
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 떠 있는 관문(열린 터미널이 그 주소를 들고 있다)을 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & { __bStudioTerminalGateways?: Map<string, GatewayEntry> };
const gateways = (globalStore.__bStudioTerminalGateways ??= new Map());

/** 세션의 관문이 떠 있게 하고 터미널에 넘길 환경 변수를 돌려준다. handlers는 세션을 id로 찾아야 한다(세션 객체는 이어서 작업할 때 바뀐다) */
export async function ensureSessionGateway(sessionId: string, handlers: () => TerminalGatewayHandlers, start: typeof startTerminalGateway = startTerminalGateway): Promise<Readonly<Record<string, string>>> {
  let entry = gateways.get(sessionId);
  if (!entry) {
    const created: GatewayEntry = { starting: start(handlers()) };
    entry = created;
    gateways.set(sessionId, created);
    // 띄우지 못했으면 자리를 비워 다음에 다시 해 보게 한다
    created.starting.catch(() => {
      if (gateways.get(sessionId) === created) gateways.delete(sessionId);
    });
  }
  return (await entry.starting).env;
}

/** 세션이 멈출 때 부른다. 띄우는 중이면 끝나기를 기다렸다가 닫는다 */
export async function closeSessionGateway(sessionId: string): Promise<void> {
  const entry = gateways.get(sessionId);
  if (!entry) return;
  gateways.delete(sessionId);
  const gateway = await entry.starting.catch(() => undefined);
  await gateway?.close();
}

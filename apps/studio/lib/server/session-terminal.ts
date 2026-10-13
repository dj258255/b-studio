import {
  clampTerminalSize,
  ensureAgentContainer,
  findHostCli,
  openAgentTerminal,
  openHostTerminal,
  probeAgentGateway,
  probeHostGateway,
  removeAgentContainer,
  removeAgentGatewayConfig,
  removeHostGatewayConfig,
  writeAgentGatewayConfig,
  writeHostGatewayConfig,
  type AgentGatewayAddress,
  type AgentTerminal,
  type TerminalSize,
} from '@b-studio/sandbox';
import { StudioError } from './errors';

/**
 * 세션 터미널(이슈 #673): 세션마다 에이전트 CLI용 컨테이너 하나와 그 안의 가상 터미널 하나를 든다.
 *
 * 화면과는 SSE(출력)와 POST(입력·크기)로 잇는다. 출력은 세션 기록에 남기지 않고(화면 제어 문자가 섞인 바이트다)
 * 최근 것만 메모리에 두어, 화면을 다시 열면 이어서 보이게 한다. 터미널은 화면이 닫혀도 살아 있고, 세션이 멈출 때 닫는다.
 */

/** 다시 연결한 화면에 되돌려 줄 최근 출력의 상한 */
const REPLAY_BYTES = 512 * 1024;
/** 한 번에 받는 입력의 상한. 붙여넣기까지는 받고, 그 이상은 잘못된 요청으로 본다 */
export const MAX_TERMINAL_INPUT = 256 * 1024;
const TERMINAL_ID = 'main';

export type TerminalMode = 'container' | 'host';

/**
 * 터미널을 여는 방식(B_STUDIO_TERMINAL): 컨테이너 안의 CLI를 붙이거나, 이 컴퓨터의 CLI를 세션의 작업 복사본에서 띄운다.
 * 비었거나 container면 컨테이너, host면 이 컴퓨터, 그 밖은 던진다 — sessionMode와 같은 태도다:
 * 오타가 조용히 다른 방식으로 떨어지지 않는다
 */
export function sessionTerminalMode(env: Record<string, string | undefined> = process.env): TerminalMode {
  const value = env.B_STUDIO_TERMINAL?.trim();
  if (!value || value === 'container') return 'container';
  if (value === 'host') return 'host';
  throw new StudioError(500, `B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다 (지금 값: ${value})`);
}

export type TerminalMessage =
  | { kind: 'data'; data: string }
  | { kind: 'status'; state: 'closed' | 'opening' | 'open'; message?: string }
  | { kind: 'exit'; code: number | null }
  /**
   * 터미널 안에 에이전트 CLI가 떠 있는가(CLI의 세션 시작·끝 훅으로 안다). 화면은 떠 있을 때만 다른 패널의 글을 붙여 넣는다 —
   * 셸 프롬프트에 붙여 넣으면 사람이 요청인 줄 알고 누른 Enter가 그 글을 명령으로 실행한다(이슈 #689)
   */
  | { kind: 'cli'; alive: boolean };

type Listener = (message: TerminalMessage) => void;

interface TerminalState {
  sandboxId: string;
  terminal?: AgentTerminal;
  opening?: Promise<void>;
  chunks: Buffer[];
  bytes: number;
  listeners: Set<Listener>;
  size: TerminalSize;
  /** 에이전트 CLI가 떠 있다고 알려 왔는가. 터미널이 닫히거나 끝나면 거짓으로 돌린다 */
  cli: boolean;
}

export interface TerminalTarget {
  /** 컨테이너에 붙일 라벨과 이름의 바탕 */
  sandboxId: string;
  /** 작업 복사본(호스트 절대 경로) */
  root: string;
  /** CLI의 홈 볼륨을 나누는 단위 */
  projectId: string;
  /**
   * 세션이 아직 살아 있는가. 세션을 멈추는 일과 터미널을 여는 일이 겹칠 수 있다: 멈추는 쪽이 컨테이너를 지운 뒤에
   * 여는 쪽이 컨테이너를 띄우면, 멈춘 세션의 작업 복사본을 붙인 컨테이너가 남는다. 띄운 뒤에 한 번 더 물어 지운다
   */
  alive?: () => boolean;
  /**
   * 관문(#673 2단계)을 띄우고 그 주소를 돌려준다. 주면 컨테이너에 CLI의 관리 설정(훅, b-studio 도구)과 그 주소를 붙이고,
   * 컨테이너에서 관문에 닿는 것을 확인한 뒤에야 터미널을 연다. 주지 않으면 관문 없는 터미널이다(테스트와 옛 호출자)
   */
  gateway?: () => Promise<AgentGatewayAddress>;
}

/** 터미널을 여는 자리(테스트가 가짜를 끼운다) */
export interface TerminalBackend {
  /** 터미널이 붙을 자리를 준비하고 그 자리를 가리키는 값을 돌려준다(컨테이너 이름, 또는 관문 설정 폴더) */
  prepare(target: TerminalTarget, gateway?: AgentGatewayAddress): Promise<string>;
  open(place: string, options: { id: string; size: TerminalSize; target: TerminalTarget }): AgentTerminal | Promise<AgentTerminal>;
  /** 준비한 것(컨테이너, 관문 설정)을 지운다 */
  remove(sandboxId: string): Promise<void>;
  /** 그 자리에서 관문에 닿는가 */
  reachable(place: string): Promise<boolean>;
  /** 닿지 못할 때 사용자에게 보일 글 */
  readonly unreachable: string;
}

/** 컨테이너를 지우고, 그것이 실패해도 토큰이 든 관문 설정은 지운다 */
export async function removeContainerAndConfig(
  sandboxId: string,
  removeContainer: (id: string) => Promise<void> = removeAgentContainer,
  removeConfig: (id: string) => Promise<void> = removeAgentGatewayConfig,
): Promise<void> {
  try {
    await removeContainer(sandboxId);
  } finally {
    // 토큰이 든 설정을 남겨 두지 않는다. 컨테이너 지우기가 실패해도 지운다
    await removeConfig(sandboxId).catch(() => {});
  }
}

const DOCKER_BACKEND: TerminalBackend = {
  prepare: async (target, gateway) => ensureAgentContainer(target.sandboxId, target.root, { projectId: target.projectId, ...(gateway ? { gatewayDir: await writeAgentGatewayConfig(target.sandboxId, gateway) } : {}) }),
  open: (place, options) => openAgentTerminal(place, options),
  remove: (sandboxId) => removeContainerAndConfig(sandboxId),
  reachable: (place) => probeAgentGateway(place),
  unreachable: '컨테이너에서 b-studio에 닿지 못합니다. 이 도커 환경에서는 컨테이너가 이 컴퓨터의 루프백 주소(host.docker.internal)에 닿아야 세션 터미널을 쓸 수 있습니다',
};

const HOST_BACKEND: TerminalBackend = {
  prepare: async (target, gateway) => {
    // CLI를 먼저 찾는다. 못 찾으면 그 오류가 그대로 화면에 간다(터미널을 열어 놓고 "명령을 찾을 수 없음"을 보이지 않는다)
    const cli = await findHostCli();
    return gateway ? writeHostGatewayConfig(target.sandboxId, gateway, cli) : '';
  },
  open: (place, options) => openHostTerminal({ id: options.id, size: options.size, cwd: options.target.root, gatewayDir: place || undefined }),
  remove: (sandboxId) => removeHostGatewayConfig(sandboxId),
  reachable: (place) => probeHostGateway(place),
  unreachable: '이 컴퓨터에서 b-studio의 관문에 닿지 못합니다. 스튜디오를 다시 띄운 뒤 터미널을 다시 여세요',
};

/** 지금 방식에 맞는 백엔드. 부를 때 정해진다 — 스튜디오를 다른 방식으로 띄우면 그 방식으로 연다 */
export function terminalBackend(mode: TerminalMode = sessionTerminalMode()): TerminalBackend {
  return mode === 'host' ? HOST_BACKEND : DOCKER_BACKEND;
}

/**
 * 앞 방식이 남긴 찌꺼기(컨테이너, 토큰이 든 관문 설정)를 지운다. 스튜디오를 다른 방식으로 다시 띄웠을 때 두 방식을 모두 치운다.
 * 한쪽이 실패해도 다른 쪽을 부른다
 */
export async function removeTerminalLeftovers(sandboxId: string, backends: readonly TerminalBackend[] = [DOCKER_BACKEND, HOST_BACKEND]): Promise<void> {
  await Promise.allSettled(backends.map((backend) => backend.remove(sandboxId)));
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 열린 터미널을 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & { __bStudioTerminals?: Map<string, TerminalState> };
const terminals = (globalStore.__bStudioTerminals ??= new Map());

/** 세션마다 상태는 하나다. 구독이 먼저 오든 열기가 먼저 오든 같은 것을 쓴다 */
function stateFor(sessionId: string): TerminalState {
  let state = terminals.get(sessionId);
  if (!state) {
    state = { sandboxId: '', chunks: [], bytes: 0, listeners: new Set(), size: clampTerminalSize({}), cli: false };
    terminals.set(sessionId, state);
  }
  return state;
}

function emit(state: TerminalState, message: TerminalMessage): void {
  for (const listener of state.listeners) {
    try {
      listener(message);
    } catch {
      // 구독자 하나의 오류가 다른 구독자에게 번지지 않게 한다
    }
  }
}

function remember(state: TerminalState, chunk: Buffer): void {
  state.chunks.push(chunk);
  state.bytes += chunk.length;
  while (state.bytes > REPLAY_BYTES && state.chunks.length > 1) state.bytes -= state.chunks.shift()!.length;
}

/**
 * 세션의 터미널을 연다. 이미 열려 있으면 크기만 맞추고 그대로 쓴다. 동시에 여러 번 불려도 컨테이너와 터미널은 하나만 만든다.
 * 컨테이너를 띄우거나 `.git` 보호를 확인하지 못하면 던지고, 그 사유를 연결된 화면에도 알린다
 */
export async function openSessionTerminal(sessionId: string, target: TerminalTarget, size: { cols?: unknown; rows?: unknown }, backend: TerminalBackend = terminalBackend()): Promise<void> {
  const wanted = clampTerminalSize(size);
  const state = stateFor(sessionId);
  // 세션을 다시 열어 샌드박스가 바뀌었으면 옛 터미널은 옛 컨테이너의 것이다. 터미널과 컨테이너만 정리하고,
  // 붙어 있는 화면(구독자)은 그대로 둔다 — 화면은 출력 통로를 먼저 열고 그다음에 "열기"를 보낸다
  if (state.sandboxId && state.sandboxId !== target.sandboxId) {
    closeSessionTerminal(sessionId);
    await backend.remove(state.sandboxId).catch(() => {});
    state.chunks = [];
    state.bytes = 0;
  }
  state.sandboxId = target.sandboxId;
  if (state.terminal) {
    state.size = wanted;
    await state.terminal.resize(wanted);
    return;
  }
  const current = state;
  current.opening ??= (async () => {
    emit(current, { kind: 'status', state: 'opening' });
    try {
      if (target.alive && !target.alive()) throw new Error('세션이 멈췄습니다');
      // 관문을 먼저 띄운다. 터미널 안의 CLI는 뜨자마자 훅을 부른다
      const gateway = target.gateway ? await target.gateway() : undefined;
      const place = await backend.prepare(target, gateway);
      // 자리를 준비하는 동안 세션이 멈췄으면 방금 만든 것을 지우고 열지 않는다
      if (target.alive && !target.alive()) {
        await backend.remove(target.sandboxId).catch(() => {});
        throw new Error('세션이 멈췄습니다');
      }
      // 관문에 닿지 못하면 열지 않는다. 관문 없이 열어 주면 그 터미널의 변경은 검증 없이 쌓이고,
      // "닿지 못하게 만들기"가 곧 검증을 끄는 방법이 된다
      if (gateway && !(await backend.reachable(place))) {
        throw new Error(backend.unreachable);
      }
      const terminal = await backend.open(place, { id: TERMINAL_ID, size: wanted, target });
      current.terminal = terminal;
      current.size = wanted;
      current.chunks = [];
      current.bytes = 0;
      terminal.onData((chunk) => {
        remember(current, chunk);
        emit(current, { kind: 'data', data: chunk.toString('base64') });
      });
      terminal.onExit((code) => {
        // 닫고 새로 연 뒤에 옛 프로세스의 종료가 늦게 와도 새 터미널을 지우지 않는다
        if (current.terminal !== terminal) return;
        current.terminal = undefined;
        setCli(current, false);
        emit(current, { kind: 'exit', code });
      });
      emit(current, { kind: 'status', state: 'open' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(current, { kind: 'status', state: 'closed', message });
      throw new StudioError(502, `터미널을 열지 못했습니다: ${message}`);
    } finally {
      current.opening = undefined;
    }
  })();
  await current.opening;
}

/** 구독하면 최근 출력과 지금 상태를 곧바로 받는다. 돌려준 함수로 구독을 푼다 */
export function subscribeSessionTerminal(sessionId: string, listener: Listener): () => void {
  // 아직 열지 않은 터미널도 구독해 둔다. 뒤따르는 "열기"가 같은 상태를 쓰므로 그 출력을 받는다
  const state = stateFor(sessionId);
  state.listeners.add(listener);
  if (state.chunks.length > 0) listener({ kind: 'data', data: Buffer.concat(state.chunks).toString('base64') });
  listener({ kind: 'status', state: state.terminal ? 'open' : state.opening ? 'opening' : 'closed' });
  listener({ kind: 'cli', alive: state.cli });
  return () => unsubscribe(sessionId, state, listener);
}

function setCli(state: TerminalState, alive: boolean): void {
  if (state.cli === alive) return;
  state.cli = alive;
  emit(state, { kind: 'cli', alive });
}

/**
 * 에이전트 CLI가 떴다·끝났다(관문의 세션 시작·끝 훅이 부른다). 터미널이 열려 있지 않으면 떴다는 알림은 받지 않는다 —
 * 닫힌 터미널에 "떠 있음"이 남으면 다음에 연 터미널(셸)에 글이 붙는다
 */
export function noteSessionTerminalCli(sessionId: string, alive: boolean): void {
  const state = terminals.get(sessionId);
  if (!state) return;
  setCli(state, alive && state.terminal !== undefined);
}

function unsubscribe(sessionId: string, state: TerminalState, listener: Listener): void {
  state.listeners.delete(listener);
  // 열린 적 없는 빈 자리만 치운다. 열린 터미널은 화면이 닫혀도 살아 있다
  if (state.listeners.size === 0 && !state.terminal && !state.opening && state.chunks.length === 0 && terminals.get(sessionId) === state) terminals.delete(sessionId);
}

export function writeSessionTerminal(sessionId: string, data: string): void {
  if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_INPUT) throw new StudioError(413, '터미널 입력이 너무 깁니다');
  const terminal = terminals.get(sessionId)?.terminal;
  if (!terminal) throw new StudioError(409, '터미널이 열려 있지 않습니다');
  terminal.write(data);
}

/**
 * 터미널 안의 CLI에 하던 일을 멈추라고 알린다(Esc). 화면에서 실행을 취소했을 때 쓴다.
 * 터미널이 없으면 아무 일도 하지 않는다. CLI가 아니라 셸이 떠 있으면 Esc는 아무 일도 하지 않는다
 */
export function interruptSessionTerminal(sessionId: string): void {
  terminals.get(sessionId)?.terminal?.write('\x1b');
}

export async function resizeSessionTerminal(sessionId: string, size: { cols?: unknown; rows?: unknown }): Promise<void> {
  const state = terminals.get(sessionId);
  if (!state?.terminal) return;
  state.size = clampTerminalSize(size);
  await state.terminal.resize(state.size);
}

/** 터미널만 닫는다. 컨테이너는 남는다(다시 열면 바로 붙는다) */
export function closeSessionTerminal(sessionId: string): void {
  const state = terminals.get(sessionId);
  if (!state?.terminal) return;
  const terminal = state.terminal;
  state.terminal = undefined;
  terminal.close();
  setCli(state, false);
  emit(state, { kind: 'status', state: 'closed' });
}

/** 세션이 멈출 때 부른다. 터미널을 닫고 컨테이너를 지운다. 열린 적이 없어도 컨테이너가 남아 있을 수 있어 지우기는 늘 한다 */
export async function disposeSessionTerminal(sessionId: string, sandboxId: string, backend: TerminalBackend = terminalBackend()): Promise<void> {
  // 열고 있는 중이면 끝나기를 기다린 뒤에 닫는다. 기다리지 않으면 지운 뒤에 컨테이너와 터미널이 생긴다
  await terminals.get(sessionId)?.opening?.catch(() => {});
  closeSessionTerminal(sessionId);
  terminals.delete(sessionId);
  await backend.remove(sandboxId).catch(() => {});
}

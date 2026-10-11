import { clampTerminalSize, ensureAgentContainer, openAgentTerminal, probeAgentGateway, removeAgentContainer, writeAgentGatewayConfig, type AgentTerminal, type TerminalSize } from '@b-studio/sandbox';
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

export type TerminalMessage =
  | { kind: 'data'; data: string }
  | { kind: 'status'; state: 'closed' | 'opening' | 'open'; message?: string }
  | { kind: 'exit'; code: number | null };

type Listener = (message: TerminalMessage) => void;

interface TerminalState {
  sandboxId: string;
  terminal?: AgentTerminal;
  opening?: Promise<void>;
  chunks: Buffer[];
  bytes: number;
  listeners: Set<Listener>;
  size: TerminalSize;
  /** 열려 있는 터미널에 대해 화면에 함께 알릴 말(관문 없이 열었다는 것) */
  note?: string;
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
   * 관문(#673 2단계)을 띄우고 터미널 안의 프로세스에 넘길 환경 변수(관문의 주소와 토큰)를 돌려준다.
   * 주면 컨테이너에 CLI의 관리 설정(훅, b-studio 도구)을 붙인다. 주지 않으면 관문 없는 터미널이다
   */
  gateway?: () => Promise<Readonly<Record<string, string>>>;
}

/** 터미널을 여는 자리(테스트가 가짜를 끼운다) */
export interface TerminalBackend {
  ensureContainer(target: TerminalTarget): Promise<string>;
  open(container: string, options: { id: string; size: TerminalSize; env?: Readonly<Record<string, string>> }): AgentTerminal;
  removeContainer(sandboxId: string): Promise<void>;
  /** 컨테이너 안에서 관문에 닿는가. 없으면 닿는다고 본다 */
  reachable?(container: string, env: Readonly<Record<string, string>>): Promise<boolean>;
}

/** 관문에 닿지 못해 관문 없이 열었을 때 화면에 알리는 말 */
export const NO_GATEWAY_NOTE = '관문 없음 — 이 도커 환경에서는 컨테이너가 b-studio에 닿지 못합니다. 여기서 한 변경은 검증되지 않고 체크포인트도 생기지 않습니다';

const DOCKER_BACKEND: TerminalBackend = {
  ensureContainer: async (target) => ensureAgentContainer(target.sandboxId, target.root, { projectId: target.projectId, ...(target.gateway ? { gatewayDir: await writeAgentGatewayConfig() } : {}) }),
  open: (container, options) => openAgentTerminal(container, options),
  removeContainer: (sandboxId) => removeAgentContainer(sandboxId),
  reachable: (container, env) => probeAgentGateway(container, env),
};

// 개발 서버의 HMR로 모듈이 다시 로드돼도 열린 터미널을 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & { __bStudioTerminals?: Map<string, TerminalState> };
const terminals = (globalStore.__bStudioTerminals ??= new Map());

/** 세션마다 상태는 하나다. 구독이 먼저 오든 열기가 먼저 오든 같은 것을 쓴다 */
function stateFor(sessionId: string): TerminalState {
  let state = terminals.get(sessionId);
  if (!state) {
    state = { sandboxId: '', chunks: [], bytes: 0, listeners: new Set(), size: clampTerminalSize({}) };
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
export async function openSessionTerminal(sessionId: string, target: TerminalTarget, size: { cols?: unknown; rows?: unknown }, backend: TerminalBackend = DOCKER_BACKEND): Promise<void> {
  const wanted = clampTerminalSize(size);
  const state = stateFor(sessionId);
  // 세션을 다시 열어 샌드박스가 바뀌었으면 옛 터미널은 옛 컨테이너의 것이다. 터미널과 컨테이너만 정리하고,
  // 붙어 있는 화면(구독자)은 그대로 둔다 — 화면은 출력 통로를 먼저 열고 그다음에 "열기"를 보낸다
  if (state.sandboxId && state.sandboxId !== target.sandboxId) {
    closeSessionTerminal(sessionId);
    await backend.removeContainer(state.sandboxId).catch(() => {});
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
      let env = target.gateway ? await target.gateway() : undefined;
      const container = await backend.ensureContainer(target);
      // 컨테이너를 띄우는 동안 세션이 멈췄으면 방금 띄운 것을 지우고 열지 않는다
      if (target.alive && !target.alive()) {
        await backend.removeContainer(target.sandboxId).catch(() => {});
        throw new Error('세션이 멈췄습니다');
      }
      // 컨테이너에서 관문에 닿지 못하는 환경이면 관문 없이 연다. 주소를 넘긴 채 열면 훅이 파일을 바꾸는 도구를 모두 막는다
      current.note = undefined;
      if (env && backend.reachable && !(await backend.reachable(container, env))) {
        env = undefined;
        current.note = NO_GATEWAY_NOTE;
      }
      const terminal = backend.open(container, { id: TERMINAL_ID, size: wanted, ...(env ? { env } : {}) });
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
        emit(current, { kind: 'exit', code });
      });
      emit(current, { kind: 'status', state: 'open', ...(current.note ? { message: current.note } : {}) });
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
  listener({ kind: 'status', state: state.terminal ? 'open' : state.opening ? 'opening' : 'closed', ...(state.terminal && state.note ? { message: state.note } : {}) });
  return () => unsubscribe(sessionId, state, listener);
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
  emit(state, { kind: 'status', state: 'closed' });
}

/** 세션이 멈출 때 부른다. 터미널을 닫고 컨테이너를 지운다. 열린 적이 없어도 컨테이너가 남아 있을 수 있어 지우기는 늘 한다 */
export async function disposeSessionTerminal(sessionId: string, sandboxId: string, backend: TerminalBackend = DOCKER_BACKEND): Promise<void> {
  // 열고 있는 중이면 끝나기를 기다린 뒤에 닫는다. 기다리지 않으면 지운 뒤에 컨테이너와 터미널이 생긴다
  await terminals.get(sessionId)?.opening?.catch(() => {});
  closeSessionTerminal(sessionId);
  terminals.delete(sessionId);
  await backend.removeContainer(sandboxId).catch(() => {});
}

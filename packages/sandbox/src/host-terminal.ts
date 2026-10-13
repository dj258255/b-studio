import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_HOOK_SCRIPT,
  agentManagedMcp,
  clampTerminalSize,
  defaultAgentGatewayRoot,
  GATEWAY_FILE_NAME,
  gatewayDirFor,
  gatewaySettings,
  HOOK_SCRIPT_NAME,
  type AgentGatewayAddress,
  type AgentTerminal,
  type TerminalSize,
} from './docker/agent-terminal';
import { SandboxError } from './errors';

const execFileAsync = promisify(execFile);

/**
 * 이 컴퓨터에서 도는 세션 터미널(ADR-173). 세션의 작업 복사본에서 이 컴퓨터에 깔린 에이전트 CLI를 그대로 띄운다.
 *
 * 컨테이너 방식(docker/agent-terminal.ts)과 견주면:
 *  - 설치·로그인·플러그인·설정이 그대로 따라온다(프로젝트마다 다시 하지 않는다)
 *  - 격리가 없다. CLI는 이 컴퓨터의 다른 파일에도 닿을 수 있다. 평소 터미널에서 CLI를 쓰는 것과 같은 신뢰 수준이다
 *  - 훅과 b-studio 도구는 관리 설정 자리가 아니라 실행 인자(`--settings`, `--mcp-config`)로 붙인다.
 *    인자로 준 설정은 프로젝트·사용자 설정보다 앞선다. 다만 CLI를 인자 없이 직접 띄우면 붙지 않는다 —
 *    그래서 터미널의 PATH 맨 앞에 인자를 붙여 주는 감싸개(`claude`)를 둔다
 *
 * 훅은 여기서도 판정이 아니라 통로다. 훅이 불리지 않으면 검증이 돌지 않고, 검증이 돌지 않으면 체크포인트가 생기지 않는다
 */

/** 이 컴퓨터의 CLI가 b-studio의 훅 서버·도구 서버를 부르는 주소의 호스트 */
export const HOST_GATEWAY_HOST = '127.0.0.1';
const SETTINGS_FILE = 'settings.json';
const MCP_FILE = 'mcp.json';
const WRAPPER_DIR = 'bin';
const WRAPPER_NAME = 'claude';
const HOST_PING_SECONDS = 5;

/** 셸 명령에 넣을 글을 작은따옴표로 감싼다. 경로에 빈칸이나 따옴표가 있어도 한 덩어리로 읽힌다 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface HostCli {
  /** 이 컴퓨터에 깔린 에이전트 CLI의 절대 경로 */
  claudePath: string;
  /** 훅 스크립트를 돌릴 node의 절대 경로(스튜디오가 도는 그 node) */
  nodePath: string;
}

/**
 * 이 컴퓨터의 에이전트 CLI를 찾는다. `B_STUDIO_CLAUDE_BIN`이 있으면 그것을, 없으면 PATH에서 찾는다.
 * 찾지 못하면 던진다 — 터미널을 열어 놓고 "명령을 찾을 수 없음"을 보이는 것보다 먼저 알린다
 */
export async function findHostCli(env: Record<string, string | undefined> = process.env): Promise<HostCli> {
  const configured = env.B_STUDIO_CLAUDE_BIN?.trim();
  let claudePath = configured && path.isAbsolute(configured) ? configured : undefined;
  if (!claudePath) {
    // 셸의 내장 명령으로 찾는다. 이름은 고정이라 명령 글에 끼워 넣는 값이 없다
    const found = await execFileAsync('/bin/sh', ['-c', 'command -v claude'], { env: env as NodeJS.ProcessEnv }).then(
      ({ stdout }) => stdout.trim().split('\n')[0] ?? '',
      () => '',
    );
    if (path.isAbsolute(found)) claudePath = found;
  }
  if (!claudePath) {
    throw new SandboxError('이 컴퓨터에서 claude CLI를 찾지 못했습니다', 'claude를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_CLAUDE_BIN에 절대 경로를 적습니다');
  }
  return { claudePath, nodePath: process.execPath };
}

/** 이 컴퓨터용 CLI 설정: 훅 명령이 세션의 관문 폴더에 둔 스크립트를 부른다 */
export function hostGatewaySettings(dir: string, nodePath: string): Record<string, unknown> {
  return gatewaySettings((event) => `${shellQuote(nodePath)} ${shellQuote(path.join(dir, HOOK_SCRIPT_NAME))} ${event}`);
}

/**
 * 인자를 붙여 CLI를 부르는 감싸개. 터미널의 PATH 맨 앞에 놓여, 터미널에서 `claude`를 어떻게 띄우든(다시 띄우거나 `--resume`을 주거나)
 * 훅과 b-studio 도구가 붙는다. 사용자가 준 인자는 그대로 넘긴다
 */
export function hostCliWrapper(dir: string, claudePath: string): string {
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `exec ${shellQuote(claudePath)} --settings ${shellQuote(path.join(dir, SETTINGS_FILE))} --mcp-config ${shellQuote(path.join(dir, MCP_FILE))} "$@"`,
    '',
  ].join('\n');
}

/** 관문 폴더에 둘 파일의 이름(폴더 기준) → 내용 */
export function hostGatewayFiles(address: AgentGatewayAddress, dir: string, cli: HostCli): Record<string, string> {
  return {
    [SETTINGS_FILE]: `${JSON.stringify(hostGatewaySettings(dir, cli.nodePath), null, 2)}\n`,
    [MCP_FILE]: `${JSON.stringify(agentManagedMcp(address), null, 2)}\n`,
    [HOOK_SCRIPT_NAME]: AGENT_HOOK_SCRIPT,
    [GATEWAY_FILE_NAME]: `${JSON.stringify({ url: address.hookUrl, token: address.hookToken })}\n`,
    [path.join(WRAPPER_DIR, WRAPPER_NAME)]: hostCliWrapper(dir, cli.claudePath),
  };
}

/**
 * 세션의 관문 설정을 이 컴퓨터에 쓰고 그 폴더를 돌려준다. 토큰이 들어 있으므로 이 사용자만 읽을 수 있게 둔다.
 * 컨테이너 방식과 같은 폴더(`<루트>/<샌드박스 id>`)를 쓴다 — 세션은 한 번에 한 방식으로만 열린다
 */
export async function writeHostGatewayConfig(sandboxId: string, address: AgentGatewayAddress, cli: HostCli, root: string = defaultAgentGatewayRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const made = gatewayDirFor(sandboxId, root);
  await mkdir(path.join(made, WRAPPER_DIR), { recursive: true, mode: 0o700 });
  // 훅 명령과 감싸개에 이 폴더의 경로가 들어간다. 링크를 푼 진짜 경로로 적는다
  const dir = await realpath(made);
  for (const [name, content] of Object.entries(hostGatewayFiles(address, dir, cli))) {
    const target = path.join(dir, name);
    const executable = name.startsWith(`${WRAPPER_DIR}${path.sep}`);
    if ((await readFile(target, 'utf8').catch(() => undefined)) !== content) {
      // 같은 폴더에 임시 이름으로 쓰고 옮긴다. 읽는 쪽(훅, CLI)이 반쯤 쓰인 파일을 보지 않는다
      const staged = `${target}.${process.pid}.tmp`;
      await writeFile(staged, content, { mode: executable ? 0o700 : 0o600 });
      await rename(staged, target);
    }
    if (executable) await chmod(target, 0o700);
  }
  return dir;
}

/** 세션이 멈출 때 그 세션의 관문 설정을 지운다. 이 코드가 쓴 파일만 지우고, 폴더는 비었을 때만 지운다 */
export async function removeHostGatewayConfig(sandboxId: string, root: string = defaultAgentGatewayRoot()): Promise<void> {
  const dir = gatewayDirFor(sandboxId, root);
  for (const name of [SETTINGS_FILE, MCP_FILE, HOOK_SCRIPT_NAME, GATEWAY_FILE_NAME, path.join(WRAPPER_DIR, WRAPPER_NAME)]) await rm(path.join(dir, name), { force: true }).catch(() => {});
  await rmdir(path.join(dir, WRAPPER_DIR)).catch(() => {});
  await rmdir(dir).catch(() => {});
}

/** 훅이 관문에 닿는가. 터미널의 훅이 쓰는 바로 그 스크립트와 주소 파일로 묻는다 */
export async function probeHostGateway(dir: string, nodePath: string = process.execPath): Promise<boolean> {
  return execFileAsync(nodePath, [path.join(dir, HOOK_SCRIPT_NAME), 'ping'], { timeout: (HOST_PING_SECONDS + 10) * 1000 }).then(
    () => true,
    () => false,
  );
}

/**
 * 터미널을 열면 도는 명령. CLI를 띄우고, CLI에서 나오면 이 컴퓨터의 셸로 남는다.
 * `claude`는 PATH 맨 앞의 감싸개다. 셸의 시작 파일이 PATH의 순서를 바꾸면 되돌아간 셸에서 친 `claude`에는 훅이 붙지 않을 수 있다 —
 * 그때의 변경은 다음 요청의 검증에 "실행 전부터 있던 변경"으로 들어간다
 */
export const HOST_TERMINAL_COMMAND = [
  // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
  'trap : INT',
  'claude',
  'printf "%s\\n" "[b-studio] claude에서 나왔습니다. 다시 띄우려면 claude 를 입력하세요."',
  'exec "${SHELL:-/bin/sh}"',
].join('\n');

/** 터미널에 넘길 환경. 스튜디오의 설정 값(`B_STUDIO_*`, 토큰이 들어 있다)은 넘기지 않고, 감싸개를 PATH 맨 앞에 둔다 */
export function hostTerminalEnv(gatewayDir: string | undefined, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('B_STUDIO_')) continue;
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  if (gatewayDir) result.PATH = `${path.join(gatewayDir, WRAPPER_DIR)}${path.delimiter}${env.PATH ?? ''}`;
  return result;
}

/** node-pty가 주는 가상 터미널에서 이 모듈이 쓰는 부분 */
export interface HostPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}
/** 가상 터미널을 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnHostPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => HostPty | Promise<HostPty>;

const spawnWithNodePty: SpawnHostPty = async (file, args, options) => {
  // 네이티브 모듈은 터미널을 열 때만 읽는다. 이 컴퓨터용 터미널을 쓰지 않는 환경(서버 모드, 컨테이너 방식)에서는 읽지 않는다
  const pty = await import('@lydell/node-pty');
  return pty.spawn(file, args, options);
};

/** 세션의 작업 복사본에서 가상 터미널을 열고 기본 명령(CLI)을 띄운다 */
export async function openHostTerminal({
  id,
  size,
  cwd,
  gatewayDir,
  command = HOST_TERMINAL_COMMAND,
  env = process.env,
  spawnPty = spawnWithNodePty,
}: {
  id: string;
  size: TerminalSize;
  /** 세션의 작업 복사본 */
  cwd: string;
  /** 관문 설정을 둔 폴더(writeHostGatewayConfig). 주지 않으면 훅 없이 띄운다 */
  gatewayDir?: string;
  command?: string;
  env?: Record<string, string | undefined>;
  spawnPty?: SpawnHostPty;
}): Promise<AgentTerminal> {
  const { cols, rows } = clampTerminalSize(size);
  let pty: HostPty;
  try {
    pty = await spawnPty('/bin/sh', ['-c', command], { name: 'xterm-256color', cols, rows, cwd, env: hostTerminalEnv(gatewayDir, env) });
  } catch (error) {
    throw new SandboxError('이 컴퓨터에서 터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error), { platform: true });
  }
  let closed = false;
  return {
    id,
    write(data) {
      if (!closed) pty.write(data);
    },
    async resize(next) {
      if (closed) return;
      const wanted = clampTerminalSize(next);
      try {
        pty.resize(wanted.cols, wanted.rows);
      } catch {
        // 이미 끝난 터미널의 크기는 바꿀 것이 없다
      }
    },
    onData(listener) {
      pty.onData((data) => listener(Buffer.from(data, 'utf8')));
    },
    onExit(listener) {
      pty.onExit(({ exitCode }) => {
        closed = true;
        listener(exitCode);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        // 터미널이 끊겼다고 알린다. 셸과 그 안의 CLI가 함께 끝난다
        pty.kill('SIGHUP');
      } catch {
        // 이미 끝났다
      }
    },
  };
}

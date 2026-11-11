import { execFile, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * 앞단(crates/bstudio-server) 너머로 서버를 시험하는 도구(ADR-195 4a). 시험 전용이다.
 * 앞단은 `cargo build -p bstudio-server`(디버그)로 빌드한다. 바뀐 것이 없으면 cargo가 바로 끝낸다
 */
const execFileAsync = promisify(execFile);
export const repoRoot = path.resolve(import.meta.dirname, '../../..');
export const frontBinary = path.join(repoRoot, 'target', 'debug', 'bstudio-server');

export async function buildFront(): Promise<string> {
  try {
    await execFileAsync('cargo', ['build', '--locked', '-p', 'bstudio-server'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`앞단을 빌드하지 못했습니다(Rust 툴체인이 필요합니다): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(frontBinary)) throw new Error(`앞단 실행 파일이 없습니다: ${frontBinary}`);
  return frontBinary;
}

export interface RunningFront {
  child: ChildProcess;
  /** 앞단이 연 공개 주소(http://127.0.0.1:포트) */
  origin: string;
  /** 지금까지의 출력 */
  output: () => string;
  stop: () => Promise<void>;
}

/** 앞단을 띄우고(binary는 buildFront의 결과. 환경 변수(HOME)를 바꾸기 전에 빌드해 둔다). "서버가 떴습니다" 줄이 나올 때까지 기다린다. args는 앞단의 인자다(`--` 뒤에 Node 명령을 적는다) */
export async function startFront(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<RunningFront> {
  const child = spawn(binary, [...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`앞단이 뜨지 않았습니다:\n${text}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      const ready = /b-studio 서버가 떴습니다: (http:\/\/[^\s]+)/.exec(text);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1]!);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (chunk: Buffer) => (text += chunk.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`앞단이 끝났습니다(${code}):\n${text}`));
    });
  });
  return {
    child,
    origin,
    output: () => text,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

export interface RunningNode {
  child: ChildProcess;
  /** 서버가 연 주소(http://127.0.0.1:포트) */
  origin: string;
  stop: () => Promise<void>;
}

/** 앞단 없이 Node 서버(tsx main.ts)를 공개 포트로 직접 띄운다. 앞단 너머와 같은 요청을 견주는 차등 시험의 기준선이다(ADR-195 4c) */
export async function startNodeDirect(env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<RunningNode> {
  const child = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts', '--port', '0', '--hostname', '127.0.0.1'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node 서버가 뜨지 않았습니다:\n${text}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      const ready = /b-studio 서버가 떴습니다: (http:\/\/[^\s]+)/.exec(text);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1]!);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (chunk: Buffer) => (text += chunk.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Node 서버가 끝났습니다(${code}):\n${text}`));
    });
  });
  return {
    child,
    origin,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

// ── 날것의 요청으로 응답을 받는 도구(차등 시험이 함께 쓴다) ──
export const FRAME_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

export interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
}

function parseChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < body.length) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(at, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** 요청 줄·머리를 그대로 보내고(`Connection: close`를 더한다) 응답을 읽는다 */
export function exchange(origin: string, requestLine: string, headers: [string, string][], isHead = false): Promise<Reply> {
  const url = new URL(origin);
  const text = [requestLine, ...headers.map(([n, v]) => `${n}: ${v}`), 'Connection: close', '', ''].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => socket.write(Buffer.from(text, 'latin1')));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error(`응답 머리가 없습니다: ${raw.toString('latin1')}`));
      const [statusLine, ...lines] = raw.subarray(0, split).toString('latin1').split('\r\n');
      const parsed = lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as [string, string];
      });
      const chunked = parsed.some(([n, v]) => n === 'transfer-encoding' && v.includes('chunked'));
      const rest = raw.subarray(split + 4);
      const body = isHead ? Buffer.alloc(0) : chunked ? parseChunked(rest) : rest;
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine!)?.[1]), headers: parsed.filter(([n]) => !FRAME_HEADERS.has(n)), body: body.toString('utf8') });
    });
  });
}

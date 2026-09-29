import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DesktopConfig } from './config';

/**
 * 서버 켜기·끄기 계약(다른 브랜치에서 만드는 CLI에 맞춘다).
 *
 *   <pnpm> studio launch --json [--mode <m>] [--port <n>]
 *     → 준비되면 stdout에 한 줄 JSON {"url","port","mode","pid","started"}. started는 이번에 새로 띄웠으면 true
 *     → 진행 안내는 stderr(로딩 화면에 보여 준다). 실패면 종료 코드 1
 *   <pnpm> studio stop --json → {"stopped":bool}
 *
 * 앱은 이 계약만 알고 있다. 실제 실행은 주입받은 러너가 하므로 테스트는 가짜 러너로 돈다(서버를 켜지 않는다).
 * 앱이 켠 서버(started=true)만 앱이 닫힐 때 끈다 — 사람이 이미 켜 둔 서버는 그대로 둔다.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  /** stderr 조각이 올 때마다 부른다(진행 안내) */
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

export interface LaunchResult {
  url: string;
  port: number;
  mode: string;
  /** 서버 프로세스 id(참고용) */
  pid: number;
  /** 이번에 새로 띄웠는가 */
  started: boolean;
}

/** CLI가 기동 로그를 남기는 폴더. 실패 화면과 메뉴의 "로그 폴더 열기"가 쓴다 */
export function launchLogDir(home: string = homedir()): string {
  return path.join(home, '.cache', 'b-studio', 'launch');
}

export function launchArgs(config: Pick<DesktopConfig, 'mode' | 'port'>): string[] {
  return ['studio', 'launch', '--json', '--mode', config.mode, ...(config.port ? ['--port', String(config.port)] : [])];
}

export function stopArgs(): string[] {
  return ['studio', 'stop', '--json'];
}

/** stdout에서 마지막 JSON 줄을 찾는다. 앞에 다른 출력이 섞여도 마지막 줄이 결과다 */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]!) as unknown;
    } catch {
      // JSON이 아닌 줄(진행 안내 등)은 건너뛴다
    }
  }
  return undefined;
}

export function parseLaunchResult(stdout: string): LaunchResult {
  const parsed = lastJsonLine(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`서버 준비 결과를 읽지 못했습니다: ${stdout.trim().slice(0, 200) || '(출력 없음)'}`);
  }
  const value = parsed as Record<string, unknown>;
  const url = typeof value.url === 'string' && value.url.startsWith('http') ? value.url : undefined;
  const port = typeof value.port === 'number' && Number.isInteger(value.port) ? value.port : undefined;
  if (!url || port === undefined) throw new Error(`서버 준비 결과에 url·port가 없습니다: ${JSON.stringify(value).slice(0, 200)}`);
  return {
    url,
    port,
    mode: typeof value.mode === 'string' ? value.mode : '',
    pid: typeof value.pid === 'number' ? value.pid : 0,
    // 필드가 없으면 false로 둔다 — 앱이 켜지 않은 서버를 끄는 쪽이 더 나쁘다
    started: value.started === true,
  };
}

export function parseStopResult(stdout: string): { stopped: boolean } {
  const parsed = lastJsonLine(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { stopped?: unknown }).stopped !== 'boolean') {
    throw new Error(`서버 중지 결과를 읽지 못했습니다: ${stdout.trim().slice(0, 200) || '(출력 없음)'}`);
  }
  return { stopped: (parsed as { stopped: boolean }).stopped };
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export interface LaunchOptions {
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

/** 서버를 켠다(이미 떠 있으면 CLI가 그대로 알려 준다) */
export async function launchStudio(config: DesktopConfig, runner: CommandRunner, options: LaunchOptions = {}): Promise<LaunchResult> {
  const result = await runner.run(config.pnpm, launchArgs(config), {
    cwd: config.root,
    ...(options.onProgress ? { onStderr: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.code !== 0) {
    const reason = lastLine(result.stderr) || lastLine(result.stdout);
    throw new Error(`스튜디오 서버를 켜지 못했습니다 (종료 코드 ${result.code})${reason ? `: ${reason}` : ''}`);
  }
  return parseLaunchResult(result.stdout);
}

/** 서버를 끈다 */
export async function stopStudio(config: DesktopConfig, runner: CommandRunner): Promise<{ stopped: boolean }> {
  const result = await runner.run(config.pnpm, stopArgs(), { cwd: config.root });
  if (result.code !== 0) {
    const reason = lastLine(result.stderr) || lastLine(result.stdout);
    throw new Error(`스튜디오 서버를 끄지 못했습니다 (종료 코드 ${result.code})${reason ? `: ${reason}` : ''}`);
  }
  return parseStopResult(result.stdout);
}

export interface StopOutcome {
  /** 끄기를 시도했는가 */
  attempted: boolean;
  stopped?: boolean;
  error?: string;
}

/** 앱이 켠 서버만 끈다. 실패해도 앱은 닫히고 이유만 돌려준다 */
export async function stopIfStarted(launched: LaunchResult | undefined, config: DesktopConfig, runner: CommandRunner): Promise<StopOutcome> {
  if (!launched?.started) return { attempted: false };
  try {
    const { stopped } = await stopStudio(config, runner);
    return { attempted: true, stopped };
  } catch (error) {
    return { attempted: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 자식 프로세스 출력을 이만큼만 들고 있는다(콜리마 기동 로그가 길 수 있다) */
const MAX_OUTPUT = 8 * 1024;

function append(current: string, text: string): string {
  const next = current + text;
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

/**
 * 실제 실행기. Dock·Finder에서 켠 앱에는 터미널 PATH(nvm·corepack)가 없어서,
 * pnpm의 shebang(`#!/usr/bin/env node`)이 실패할 수 있다 — 설치 시점 node의 폴더를 PATH 앞에 넣는다.
 */
export function createSpawnRunner(nodePath: string): CommandRunner {
  return {
    run(command, args, options) {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout = append(stdout, chunk);
        });
        child.stderr.on('data', (chunk: string) => {
          stderr = append(stderr, chunk);
          options.onStderr?.(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        options.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      });
    },
  };
}

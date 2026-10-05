import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface StopDeps {
  platform: NodeJS.Platform;
  paths: { pid: string };
  /** 프로세스가 살아 있는지 */
  isAlive: (pid: number) => boolean;
  /** 분리해 띄운 프로세스 그룹에 신호를 보낸다 */
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** 프로세스 명령줄(ps). 읽지 못하면 빈 문자열 */
  commandLine: (pid: number) => Promise<string>;
  /** http 확인 */
  probe: (url: string) => Promise<{ reachable: boolean }>;
}

interface PidInfo {
  pid?: number;
  port?: number;
  mode?: string;
}

/**
 * `studio launch`가 띄운 스튜디오를 멈춘다. PID 파일의 프로세스 그룹에 SIGTERM을 보내고 파일을 지운다.
 * 다른 프로세스를 죽이지 않도록, PID 파일의 포트가 응답하거나 명령줄에 next가 있을 때만 죽인다.
 */
export async function runStop(deps: StopDeps, options: { json?: boolean } = {}): Promise<number> {
  const json = options.json === true;
  // 진행 안내는 --json일 때 stderr로 보낸다. stdout에는 {"stopped":…} 한 줄만 남긴다
  const say = (text: string) => (json ? console.error(text) : console.log(text));
  const finish = (stopped: boolean, code = 0): number => {
    if (json) console.log(JSON.stringify({ stopped }));
    return code;
  };

  const raw = await readFile(deps.paths.pid, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    say('떠 있는 스튜디오가 없습니다');
    return finish(false);
  }

  let info: PidInfo;
  try {
    info = JSON.parse(raw) as PidInfo;
  } catch {
    await rm(deps.paths.pid, { force: true });
    say('PID 파일을 읽지 못해 지웠습니다');
    return finish(false);
  }

  const pid = info.pid;
  if (pid === undefined || !deps.isAlive(pid)) {
    await rm(deps.paths.pid, { force: true });
    say('스튜디오가 이미 종료돼 있습니다. PID 파일만 지웠습니다');
    return finish(false);
  }

  // 다른 프로세스를 죽이지 않도록 스튜디오인지 확인한다: 그 포트가 응답하거나 명령줄에 next가 있어야 한다
  const responding = info.port !== undefined && (await deps.probe(`http://127.0.0.1:${info.port}/`)).reachable;
  const command = await deps.commandLine(pid);
  if (!responding && !command.includes('next')) {
    await rm(deps.paths.pid, { force: true });
    say('PID 파일의 프로세스가 스튜디오가 아닌 것 같아 죽이지 않고 PID 파일만 지웠습니다');
    return finish(false);
  }

  try {
    deps.killGroup(pid, 'SIGTERM');
  } catch (error) {
    console.error(`프로세스 ${pid}를 멈추지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return finish(false, 1);
  }

  await rm(deps.paths.pid, { force: true });
  say(`스튜디오를 멈췄습니다 (PID ${pid})`);
  return finish(true);
}

/** 실제 환경에서 도는 stop deps. detached로 띄운 자식은 PID가 곧 프로세스 그룹 id라 -pid로 보낸다 */
export function createStopDeps(env: NodeJS.ProcessEnv = process.env): StopDeps {
  const launchDir = path.join(env.HOME ?? homedir(), '.cache', 'b-studio', 'launch');
  return {
    platform: process.platform,
    paths: { pid: path.join(launchDir, 'studio.pid') },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    killGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    commandLine: (pid) =>
      new Promise((resolve) => {
        execFile('ps', ['-o', 'command=', '-p', String(pid)], { maxBuffer: 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ''));
      }),
    probe: async (url) => {
      try {
        await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
        return { reachable: true };
      } catch {
        return { reachable: false };
      }
    },
  };
}

/** CLI 진입점 */
export function stop(options: { json?: boolean } = {}): Promise<number> {
  return runStop(createStopDeps(), options);
}

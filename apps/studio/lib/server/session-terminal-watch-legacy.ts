import path from 'node:path';
import { CODEX_HOOK_SCRIPT_NAME, type HostCliKind, type ProcessEntry } from '@b-studio/sandbox';

/**
 * 감시 판정의 옛 구현(ADR-219, 4f B5e 이전). 차등 시험의 기준으로만 남아 있다(4g에서 지운다). 운영 코드는 부르지 않는다.
 * 원본: `packages/sandbox/src/host-terminal.ts`의 `findUnhookedCli`·`looksLikeAgentCli`, `session-terminal.ts`의 `HOST_BACKEND.watch` 상태 변수들,
 * `packages/agent/src/hook-server.ts`의 본문 읽기.
 */

const CLI_PACKAGE_MARK: Record<HostCliKind, string> = { claude: '/@anthropic-ai/claude-code/', codex: '/@openai/codex' };

function looksLikeAgentCli(args: string, cliPath: string, kind: HostCliKind): boolean {
  const first = args.trim().split(/\s+/)[0] ?? '';
  return path.basename(first) === kind || first === cliPath || args.includes(CLI_PACKAGE_MARK[kind]);
}

export function legacyFindUnhookedCli(root: number, processes: readonly ProcessEntry[], expected: { settingsPath: string; cliPath: string; kind?: HostCliKind }): ProcessEntry[] {
  const kind = expected.kind ?? 'claude';
  const marker = kind === 'codex' ? path.join(path.dirname(path.dirname(expected.settingsPath)), CODEX_HOOK_SCRIPT_NAME) : `--settings ${expected.settingsPath}`;
  const children = new Map<number, ProcessEntry[]>();
  for (const process of processes) {
    const list = children.get(process.ppid);
    if (list) list.push(process);
    else children.set(process.ppid, [process]);
  }
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([root]);
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (looksLikeAgentCli(child.args, expected.cliPath, kind) && !child.args.includes(marker)) found.push(child);
      walk(child.pid);
    }
  };
  walk(root);
  return found;
}

/** 옛 감시의 상태 변수들과 한 회차(`inspect`)의 알림. 검사 결과를 받아 알릴 글을 돌려준다 */
export interface LegacyWatchState {
  warnedPids: Set<number>;
  fileFailures: number;
  fileReported: boolean;
  psFailures: number;
  psReported: boolean;
}

export function newLegacyWatchState(): LegacyWatchState {
  return { warnedPids: new Set(), fileFailures: 0, fileReported: false, psFailures: 0, psReported: false };
}

export type LegacyRoundInput = {
  file: { kind: 'failed' } | { kind: 'clean' } | { kind: 'changed'; names: string[]; restoreError?: string };
  /** undefined: 루트 pid를 몰라 건너뛴다. 'failed': 목록을 읽지 못했다. 배열: 훅 없는 CLI의 pid */
  ps: undefined | 'failed' | number[];
};

export function legacyWatchRound(state: LegacyWatchState, input: LegacyRoundInput, cliKind: string): string[] {
  const reports: string[] = [];
  if (input.file.kind === 'failed') {
    state.fileFailures += 1;
    if (state.fileFailures >= 3 && !state.fileReported) {
      state.fileReported = true;
      reports.push('관문 파일을 확인하지 못했습니다');
    }
  } else {
    state.fileFailures = 0;
    if (input.file.kind === 'changed') {
      if (input.file.restoreError === undefined) reports.push(`관문 파일이 바뀌어 되돌렸습니다: ${input.file.names.join(', ')}`);
      else reports.push(`관문 파일이 바뀌었는데 되돌리지 못했습니다: ${input.file.names.join(', ')} (${input.file.restoreError})`);
    }
  }
  if (input.ps === undefined) return reports;
  if (input.ps === 'failed') {
    state.psFailures += 1;
    if (state.psFailures >= 3 && !state.psReported) {
      state.psReported = true;
      reports.push('터미널의 프로세스를 확인하지 못했습니다');
    }
    return reports;
  }
  state.psFailures = 0;
  for (const pid of input.ps) {
    if (state.warnedPids.has(pid)) continue;
    state.warnedPids.add(pid);
    reports.push(`검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid ${pid}). 이 터미널의 ${cliKind}는 b-studio가 붙여 주는 설정으로 띄워야 합니다`);
  }
  return reports;
}

/** 옛 훅 서버의 본문 읽기: 읽지 못하거나 객체가 아니면 `{}` */
export function legacyHookInput(body: Buffer): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8') || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // 훅 입력을 읽지 못해도 검증은 돈다
  }
  return input;
}

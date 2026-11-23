import { spawn } from 'node:child_process';
import type { HookEntry, InteractiveSettings } from './settings';

export type HookAnswer = Record<string, unknown> & {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/** 훅 명령 하나를 셸로 실행해 입력 JSON을 stdin으로 넘기고 stdout의 JSON을 돌려준다. 빈 출력은 `{}`, JSON이 아니면 `{ unparsed }` */
function runHookCommand(command: string, timeoutSeconds: number | undefined, input: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<HookAnswer> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds ?? 60) * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(stdout.trim() ? (JSON.parse(stdout) as HookAnswer) : {});
      } catch {
        resolve({ unparsed: stdout });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** matcher가 없거나 빈 값이나 `*`면 모든 도구, 아니면 도구 이름 전체에 맞는 정규식(CLI와 같다). 정규식이 틀리면 맞지 않는 것으로 본다 */
export function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName ?? '');
  } catch {
    return false;
  }
}

/** 여러 훅의 답을 하나로: 처음 거절·막음, 없으면 처음 비어 있지 않은 답, 없으면 `{}` */
export function aggregateAnswers(answers: readonly HookAnswer[]): HookAnswer {
  return answers.find((one) => one.decision === 'block' || one.hookSpecificOutput?.permissionDecision === 'deny') ?? answers.find((one) => Object.keys(one).length > 0) ?? {};
}

export interface HookRunner {
  call(event: string, input?: Record<string, unknown>): Promise<HookAnswer>;
}

/** 설정의 훅을 부르는 러너. 기본 입력(대화 id·작업 폴더·기록 경로)을 모든 이벤트에 붙인다 */
export function createHookRunner(options: { settings: InteractiveSettings; cwd: string; sessionId: string; env?: NodeJS.ProcessEnv }): HookRunner {
  const env = { ...(options.env ?? process.env), ...(options.settings.env ?? {}) };
  const base = { session_id: options.sessionId, cwd: options.cwd, transcript_path: '/dev/null' };
  return {
    async call(event, input = {}) {
      const full = { ...base, hook_event_name: event, ...input };
      const answers: HookAnswer[] = [];
      for (const entry of (options.settings.hooks?.[event] ?? []) as HookEntry[]) {
        if (!matcherMatches(entry.matcher, input.tool_name as string | undefined)) continue;
        for (const hook of entry.hooks ?? []) {
          if (hook.type !== 'command' || hook.async || !hook.command) continue;
          answers.push(await runHookCommand(hook.command, hook.timeout, full, env, options.cwd));
        }
      }
      return aggregateAnswers(answers);
    },
  };
}

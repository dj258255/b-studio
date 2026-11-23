import { spawn } from 'node:child_process';
import type { HookEntry, InteractiveSettings } from './settings';

export type HookAnswer = Record<string, unknown> & {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
};

/** 훅 명령 하나의 결과. failed는 끝까지 답을 받지 못했다는 뜻이다(실행 오류, 시간 초과, 0·2가 아닌 종료, JSON이 아닌 출력) */
interface HookRun {
  answer: HookAnswer;
  failed: boolean;
  /** 종료 코드 2: CLI 규약에서 "막음"이다. 사유는 stderr */
  blocked?: string;
}

/** 훅 명령 하나를 셸로 실행해 입력 JSON을 stdin으로 넘기고 stdout의 JSON을 돌려준다. 빈 출력은 `{}` */
function runHookCommand(command: string, timeoutSeconds: number | undefined, input: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // 시간을 넘기면 죽인다. 죽은 프로세스의 종료 코드는 null이라 아래에서 실패(0·2가 아님)로 읽힌다
    const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds ?? 60) * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ answer: {}, failed: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) return resolve({ answer: {}, failed: false, blocked: stderr.trim() || '훅이 막았습니다' });
      if (code !== 0) return resolve({ answer: {}, failed: true });
      try {
        resolve({ answer: stdout.trim() ? (JSON.parse(stdout) as HookAnswer) : {}, failed: false });
      } catch {
        resolve({ answer: { unparsed: stdout }, failed: true });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * 막음·실패를 그 이벤트의 답 모양으로 바꾼다. 쓰기 직전(PreToolUse)은 막는 검사라 끝까지 답을 받지 못하면 거절한다(fail closed).
 * 다른 이벤트의 실패는 CLI 규약대로 막지 않는다(Stop을 실패로 막으면 턴이 끝나지 않는다)
 */
function answerOf(event: string, run: HookRun): HookAnswer {
  const reason = run.blocked ?? (run.failed ? '[b-studio 에이전트] 훅의 답을 끝까지 받지 못해 이 도구를 막았습니다' : undefined);
  if (reason === undefined || (run.blocked === undefined && event !== 'PreToolUse')) return run.answer;
  if (event === 'PreToolUse') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { decision: 'block', reason };
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
          answers.push(answerOf(event, await runHookCommand(hook.command, hook.timeout, full, env, options.cwd)));
        }
      }
      return aggregateAnswers(answers);
    },
  };
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { getSnapshot, openTerminalRunId, sessionTerminalTarget, terminalGatewayHandlersForTest } from '../sessions';

/**
 * 채팅 경로(`sendMessage`)를 쓰지 않고 체크포인트·실행 결과를 만드는 시험 도우미(이슈 #1392).
 * 세션 터미널의 CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이다. 이 도우미가 그 둘을 대신한다.
 * 작업 복사본·체크포인트·게이트·되돌리기는 실제 sessions.ts 코드가 돈다(시험 파일이 샌드박스와 `./session-terminal`만 가짜로 바꾼다).
 *
 * 시험 파일은 `vi.mock('./session-terminal', async () => (await import('./test-support/session-terminal-stub')).sessionTerminalStub())`(sessions.ts를 끌어오지 않는 별도 모듈이어야 한다: 같은 모듈에 두면 모의 공장이 sessions.ts를 불러오고 sessions.ts가 모의를 기다려 서로 기다린다)로
 * 세션 터미널을 가짜로 바꿔야 한다(vi.mock은 시험 파일에서만 끌어올려진다).
 */

export interface TerminalRunHandle {
  id: string;
  /** 작업 복사본의 경로(CLI가 파일을 고치는 곳) */
  work: string;
  gateway: ReturnType<typeof terminalGatewayHandlersForTest>;
}

export function terminalRunOf(id: string): TerminalRunHandle {
  return { id, work: sessionTerminalTarget(id).root, gateway: terminalGatewayHandlersForTest(id) };
}

/** CLI가 파일 하나를 쓴 것: 쓰기 훅(PreToolUse)이 허용한 뒤 작업 복사본에 파일을 쓴다 */
export async function cliWrite(run: TerminalRunHandle, file: string, content: string): Promise<void> {
  const verdict = await run.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: `/workspace/${file}`, content } });
  expect(verdict).toEqual({});
  await mkdir(path.dirname(path.join(run.work, file)), { recursive: true });
  await writeFile(path.join(run.work, file), content);
}

/** 요청을 보내(UserPromptSubmit) 실행을 열고 파일들을 쓴다. 실행은 열린 채 남는다(Stop 훅은 부르지 않는다) */
export async function openTerminalRunWithFiles(id: string, prompt: string, files: Record<string, string>): Promise<TerminalRunHandle> {
  const run = terminalRunOf(id);
  const answer = await run.gateway.prompt({ prompt });
  expect(answer.blocked).toBeUndefined();
  for (const [file, content] of Object.entries(files)) await cliWrite(run, file, content);
  expect(openTerminalRunId(id)).toBeDefined();
  return run;
}

/** 턴이 끝났다(Stop 훅): 게이트를 돌려 통과하면 체크포인트가 남고, 아니면 feedback이 돌아온다 */
export function stopTerminalTurn(run: TerminalRunHandle, lastMessage = '끝났습니다.') {
  return run.gateway.stop({ last_assistant_message: lastMessage });
}

/** API 오류로 턴이 끝났다(StopFailure 훅): 열린 실행을 실패로 닫고 되돌린다 */
export function failTerminalTurn(run: TerminalRunHandle, error = 'rate_limit'): Promise<void> {
  return run.gateway.stopFailure({ hook_event_name: 'StopFailure', error, last_assistant_message: 'API Error: usage limit reached' });
}

/**
 * 요청 하나를 터미널 경로로 끝까지 한다: 파일을 쓰고 턴을 끝내 게이트를 통과시킨다. 체크포인트가 하나 늘었는지까지 확인한다.
 * 게이트를 통과하지 못하면(feedback이 돌아오면) 시험이 잘못 짜인 것이므로 던진다
 */
export async function completeTerminalRun(id: string, prompt: string, files: Record<string, string>): Promise<{ run: TerminalRunHandle; answer: Awaited<ReturnType<typeof stopTerminalTurn>> }> {
  const before = getSnapshot(id)!.checkpoints.length;
  const run = await openTerminalRunWithFiles(id, prompt, files);
  const answer = await stopTerminalTurn(run);
  if (answer.feedback) throw new Error(`게이트가 통과하지 못했습니다: ${answer.feedback}`);
  const after = getSnapshot(id)!.checkpoints.length;
  if (after !== before + 1) throw new Error(`체크포인트가 하나 늘어야 합니다(${before} → ${after})`);
  return { run, answer };
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorld, Driver, snapshotOf, startFrontTarget, withoutFileRevisionCount, type BaselineSnapshot, type Target, type World } from './harness';
import type { FakeCli, Scenario } from './scenarios';

/**
 * 시나리오 하나를 돌려 기준 사진을 만든다. 서버를 띄우는 방법(`startTarget`)만 바꾸면 같은 시나리오를 다른 서버에 돌릴 수 있다.
 * 서버를 끈 뒤에 디스크와 docker 호출을 읽는다 — 종료 때의 session.json 쓰기와 `compose down`까지 사진에 들어가고, 비동기 쓰기와 겨루지 않는다
 */
export async function runScenario(scenario: Scenario, startTarget: (world: World) => Promise<Target> = startFrontTarget): Promise<BaselineSnapshot> {
  const world = await createWorld(scenario.options);
  let target: Target | undefined;
  const driver = new Driver('', world);
  try {
    target = await startTarget(world);
    const live = new Driver(target.origin, world);
    let session: { id: string; workDir: string; stateDir?: string } | undefined;
    const ctx = {
      driver: live,
      workDir: () => session!.workDir,
      cli: async (sessionId: string): Promise<FakeCli> => {
        await live.call('터미널 열기', 'POST', `/api/sessions/${sessionId}/terminal`, { action: 'open', cols: 80, rows: 24 });
        const claude = fakeCli(live, session!.workDir);
        await claude.started();
        return claude;
      },
      start: async (body: Record<string, unknown> = {}) => {
        const created = await live.call('세션 만들기', 'POST', '/api/sessions', { projectId: world.projectId, backend: 'claude-code', workspace: 'copy', ...body });
        if (created.status !== 201) throw new Error(`세션을 만들지 못했습니다: ${created.status} ${JSON.stringify(created.body)}`);
        session = { id: created.body.id as string, workDir: created.body.workDir as string, ...(created.body.stateDir ? { stateDir: created.body.stateDir as string } : {}) };
        await live.subscribe(session.id);
        return session.id;
      },
      startRouted: async (body: Record<string, unknown>, options: { silent?: boolean } = {}) => {
        // 서버가 터미널을 열고 첫 요청을 CLI 실행 인자로 넘긴다. 응답은 그 요청의 실행이 시작되기를 기다리므로, 응답을 기다리는 동안 진짜 CLI가 하듯 시작·요청 훅을 부른다
        const handshake = (async () => {
          if (options.silent) {
            await live.observeCli('CLI가 받은 인자');
            return undefined;
          }
          const launched = await live.observeCli('CLI가 받은 인자');
          const claude = fakeCli(live, launched.cwd);
          await claude.started();
          // 첫 요청은 CLI의 마지막 인자다. 진짜 CLI는 그 글로 요청 훅을 부른다
          await claude.prompt(launched.args.at(-1) ?? '');
          return claude;
        })();
        const created = await live.call('세션 만들기(첫 요청 넘기기)', 'POST', '/api/sessions', { projectId: world.projectId, workspace: 'copy', terminal: true, ...body }, { after: handshake });
        if (created.status !== 201) throw new Error(`세션을 만들지 못했습니다: ${created.status} ${JSON.stringify(created.body)}`);
        const made = created.body.session as { id: string; workDir: string; stateDir?: string };
        session = { id: made.id, workDir: made.workDir, ...(made.stateDir ? { stateDir: made.stateDir } : {}) };
        await live.subscribe(session.id);
        return { id: session.id, claude: await handshake };
      },
      send: async (sessionId: string, text: string, extra: Record<string, unknown> = {}) => {
        const sent = await live.call('메시지 보내기', 'POST', `/api/sessions/${sessionId}/messages`, { text, ...extra });
        if (sent.status !== 202) throw new Error(`메시지를 보내지 못했습니다: ${sent.status} ${JSON.stringify(sent.body)}`);
        const runId = (sent.body as { runId: string }).runId;
        return live.waitFor('run_finished', (event) => event.type === 'run_finished' && event.runId === runId, 120_000);
      },
    };
    await scenario.run(ctx);
    if (!session) throw new Error('시나리오가 세션을 만들지 않았습니다');
    // 실행이 끝난 뒤 늦게 오는 이벤트(저장 지연, 보고서 수거)를 조금 기다린다
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await live.close();
    const beforeShutdown = (await world.dockerCalls()).length;
    await target.stop();
    target = undefined;
    const snapshot = await snapshotOf(world, live, session, scenario.files ?? [], beforeShutdown);
    return scenario.fileRevisionCount === 'ignore' ? withoutFileRevisionCount(snapshot) : snapshot;
  } finally {
    await driver.close();
    await target?.stop();
    await world.cleanup();
  }
}

export const baselinePath = (name: string) => path.join(import.meta.dirname, '__baselines__', `${name}.json`);
export const readBaseline = (name: string) => readFile(baselinePath(name), 'utf8');

/** 진짜 CLI가 훅을 부르는 순서대로 같은 훅 스크립트를 부르는 흉내. 훅 입력의 모양은 진짜 훅 입력을 보고 흉내 낸 값이다 */
function fakeCli(live: Driver, workDir: string): FakeCli & { started: () => Promise<void> } {
  const base = { session_id: 'conversation-1', cwd: workDir, transcript_path: '/dev/null' };
  let tool = 0;
  return {
    started: async () => void (await live.hook('CLI 시작', 'session-start', { ...base, hook_event_name: 'SessionStart', source: 'startup' })),
    prompt: (text) => live.hook('요청', 'prompt', { ...base, hook_event_name: 'UserPromptSubmit', prompt: text }),
    write: async (relativePath, content) => {
      const answer = await live.hook('쓰기 직전', 'pre-tool', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(workDir, relativePath), content }, tool_use_id: `toolu_${++tool}` });
      const denied = (answer.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny';
      if (!denied) await writeFile(path.join(workDir, relativePath), content);
      return answer;
    },
    writeBypassingHook: (relativePath, content) => writeFile(path.join(workDir, relativePath), content),
    stop: (text) => live.hook('턴 끝', 'stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: text }),
    hook: (step, event, input) => live.hook(step, event, { ...base, ...input }),
  };
}

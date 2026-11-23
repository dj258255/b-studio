/**
 * 터미널 방식 작업 분해(작업 카드)의 실제 실행 경로를 외부 과금 없이 검증한다(#1363).
 *
 *  - 작업 카드 둘(쓰기 범위가 겹치지 않음)이 레인 둘이 되고, 카드가 곧 승인이라 곧바로 레인 세션이 뜬다
 *  - 레인마다 서버가 세션 터미널(이 컴퓨터 방식 PTY)에 카드의 요청을 붙여 넣는다. CLI는 스스로 훅·텔레메트리를 부르는 가짜다
 *  - 레인 B는 먼저 레인 A의 범위에 쓰려다 쓰기 직전 훅에 막히고, 자기 범위에만 쓴다 → 카드의 쓰기 범위가 실제로 걸린다
 *  - 레인마다 실제 Docker 게이트를 지나 체크포인트를 남기고, 두 레인의 결과를 새 세션에서 같은 게이트로 다시 적용해 합친다
 *
 * 모델이 계획을 내는 경로(API 모드)는 e2e:task-plan(task-plan-local.ts)가 확인한다. 이 파일은 터미널 레인만 본다.
 *
 *   pnpm e2e:task-plan-terminal
 */
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'termplanorders';
const FAKE_CLI = path.resolve(import.meta.dirname, '../server/baseline/fake-claude-agent.mjs');
const FINISHED = new Set(['done', 'failed', 'interrupted', 'rejected']);

async function main(): Promise<void> {
  // 처음 쓰는 컴퓨터(CI 실행기 등)에는 ~/.cache/b-studio가 없다. mkdtemp는 상위 폴더를 만들지 않는다
  await mkdir(path.join(homedir(), '.cache/b-studio'), { recursive: true });
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'task-plan-terminal-e2e-'));
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };
  let sessionIds: string[] = [];
  const actionLog = path.join(root, 'claude-actions.jsonl');

  try {
    const projects = path.join(root, 'projects');
    await cp(path.resolve(import.meta.dirname, '../../../examples/orders'), path.join(projects, PROJECT), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    const specFile = path.join(projects, PROJECT, 'studio.yaml');
    await writeFile(specFile, (await readFile(specFile, 'utf8')).replace(/^name: orders$/m, `name: ${PROJECT}`));

    // 가짜 CLI: 붙여 넣은 요청의 카드 표지로 대본을 고른다
    const script = {
      scripts: [
        {
          match: { request: '[card:a]' },
          steps: [
            { telemetry: { requestId: 'req_card_a', input: 200, output: 40, costUsd: 0.02 } },
            { write: { path: 'web/plan-a/one.md', content: 'from-a\n' } },
            { stop: { text: '카드 A를 끝냈습니다.' } },
          ],
        },
        {
          match: { request: '[card:b]' },
          steps: [
            { telemetry: { requestId: 'req_card_b', input: 200, output: 40, costUsd: 0.03 } },
            // 레인 A의 범위: 쓰기 직전 훅이 막아야 한다
            { write: { path: 'web/plan-a/intrude.md', content: 'intrude\n' } },
            { write: { path: 'web/plan-b/one.md', content: 'from-b\n' } },
            { stop: { text: '카드 B를 끝냈습니다.' } },
          ],
        },
      ],
    };
    const scriptFile = path.join(root, 'claude-script.json');
    await writeFile(scriptFile, JSON.stringify(script));
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const claude = path.join(binDir, 'claude');
    // 터미널은 정해 둔 환경 변수만 CLI에 넘기므로 대본·기록 경로를 감싸개에 박아 넣는다
    await writeFile(claude, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE_CLI)} ${q(path.join(root, 'claude-launch.jsonl'))} ${q(actionLog)} ${q(scriptFile)} "$@"\n`);
    await chmod(claude, 0o755);
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    await mkdir(path.join(root, 'claude-config'), { recursive: true });

    process.env.B_STUDIO_MODE = 'claude-code';
    process.env.B_STUDIO_TERMINAL = 'host';
    // 진짜 claude가 뜨지 않게 한다: 터미널은 이 경로를, 로그인 확인은 PATH의 첫 claude를 쓴다
    process.env.B_STUDIO_CLAUDE_BIN = claude;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    // 사용자의 claude 설정 파일(~/.claude.json)과 관문 폴더를 건드리지 않는다
    process.env.B_STUDIO_CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
    process.env.B_STUDIO_AGENT_GATEWAY_DIR = path.join(root, 'gateway');
    process.env.B_STUDIO_PROJECTS_DIR = projects;
    process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
    process.env.B_STUDIO_TASK_PLANS_DIR = path.join(root, 'task-plans');
    process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(root, 'model-observations.json');

    const { createTaskPlan, getTaskPlan } = await import('../lib/server/task-plans');
    const { getSnapshot, stopSession } = await import('../lib/server/sessions');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    const created = await createTaskPlan({
      projectId: PROJECT,
      request: '레인 둘의 메모를 추가한다',
      owner: LOCAL_USER,
      cards: [
        { title: '메모 A', request: '[card:a] web/plan-a/one.md를 만들어 주세요', paths: ['web/plan-a'], doneCommand: 'true' },
        { title: '메모 B', request: '[card:b] web/plan-b/one.md를 만들어 주세요', paths: ['web/plan-b'], doneCommand: 'true' },
      ],
    });
    log(`계획 ${created.id} (터미널, 카드 ${created.lanes.length}개 레인)`);

    let plan = created;
    let previous = '';
    while (!FINISHED.has(plan.status)) {
      // 정상이면 3분 안팎이다(CI 실측). 가짜 CLI는 대본이 끝나면 더 일하지 않으므로, 턴 끝 검사가 막으면 여기서 멈춘다
      if (Date.now() - started > 15 * 60_000) throw new Error(`터미널 방식 작업 분해가 15분 안에 끝나지 않았습니다\n${await tail(actionLog)}`);
      await delay(1_000);
      plan = getTaskPlan(created.id, LOCAL_USER);
      const current = `${plan.status} | ${plan.lanes.map((lane) => `${lane.id}=${lane.status}[${lane.tasks.map((task) => `${task.id}:${task.status}`).join(' ')}]`).join(' ')} | 통합=${plan.integration?.status ?? '-'}`;
      if (current !== previous) {
        log(current);
        previous = current;
      }
    }
    sessionIds = [...plan.lanes.flatMap((lane) => (lane.sessionId ? [lane.sessionId] : [])), ...(plan.integration?.sessionId ? [plan.integration.sessionId] : [])];

    log('\n확인');
    check(plan.status === 'done', `작업 분해 완료 (실제: ${plan.status}${plan.error ? ` · ${plan.error}` : ''})`);
    check(plan.runner === 'terminal', `레인이 터미널로 돎 (실제: ${plan.runner})`);
    check(plan.lanes.length === 2, `레인 2개 (실제: ${plan.lanes.length})`);
    check(Boolean(plan.lanes[0]?.sessionId && plan.lanes[1]?.sessionId && plan.lanes[0].sessionId !== plan.lanes[1].sessionId), '레인마다 다른 세션');
    for (const [index, who] of ['a', 'b'].entries()) {
      const lane = plan.lanes[index];
      const task = lane?.tasks[0];
      check(lane?.status === 'done' && task?.status === 'done' && Boolean(task.checkpoint), `레인 ${who}의 카드가 게이트를 지나 체크포인트를 남김 (${lane?.status} · ${task?.status})`);
      check(JSON.stringify(lane?.changedFiles) === JSON.stringify([`web/plan-${who}/one.md`]), `레인 ${who}가 바꾼 파일이 자기 카드의 것 하나 (${JSON.stringify(lane?.changedFiles)})`);
      check(task?.run?.costUsd === (who === 'a' ? 0.02 : 0.03), `레인 ${who}의 비용이 CLI 텔레메트리의 값 (${task?.run?.costUsd})`);
    }

    // 쓰기 직전 훅의 거절은 가짜 CLI가 받은 답으로 확인한다(레인 B의 작업 복사본에 파일이 없는 것은 통합 대상에서 본다)
    const actions = (await readFile(actionLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; path?: string; denied?: boolean; event?: string; output?: { hookSpecificOutput?: { permissionDecisionReason?: string } } });
    const intrude = actions.find((action) => action.kind === 'write' && action.path === 'web/plan-a/intrude.md');
    const denyHook = actions.find((action) => action.kind === 'hook' && action.event === 'PreToolUse' && /범위 밖/.test(action.output?.hookSpecificOutput?.permissionDecisionReason ?? '') && action.output?.hookSpecificOutput?.permissionDecisionReason?.includes('web/plan-a/intrude.md'));
    check(intrude?.denied === true && denyHook !== undefined, `레인 B가 레인 A 범위에 쓰려던 Write를 쓰기 직전 훅이 막음 (${denyHook?.output?.hookSpecificOutput?.permissionDecisionReason?.slice(0, 80) ?? '거절 없음'})`);

    const integration = plan.integration;
    const expected = ['web/plan-a/one.md', 'web/plan-b/one.md'];
    check(expected.every((file) => integration?.files.includes(file)) && !integration?.files.includes('web/plan-a/intrude.md'), `통합 대상 파일 (${integration?.files.join(', ')})`);
    const workDir = integration?.sessionId ? getSnapshot(integration.sessionId)?.workDir : undefined;
    const contents = workDir ? await Promise.all(expected.map((file) => readFile(path.join(workDir, file), 'utf8').catch(() => ''))) : [];
    check(contents[0] === 'from-a\n' && contents[1] === 'from-b\n', `통합 세션의 두 메모 내용 (${JSON.stringify(contents)})`);
    const checkpoint = integration?.sessionId ? getSnapshot(integration.sessionId)?.checkpoints[0] : undefined;
    check(
      ['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => checkpoint?.passedStages?.includes(stage as never)),
      `통합 체크포인트가 게이트를 다시 통과 (${checkpoint?.shortSha} · ${checkpoint?.passedStages?.join(', ')})`,
    );

    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
    if (failures.length) throw new Error(`실패한 확인 ${failures.length}개:\n- ${failures.join('\n- ')}\n${await tail(actionLog)}`);
    log(`\n✅ 실제 Docker 터미널 방식 작업 분해 E2E 통과 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);
  } finally {
    if (sessionIds.length) {
      const { stopSession } = await import('../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
      for (const id of sessionIds) await stopSession(id).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** 셸 감싸개에 넣을 경로를 홑따옴표로 감싼다 */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 실패를 읽을 수 있게 가짜 CLI의 동작 기록 끝부분을 돌려준다 */
async function tail(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '(가짜 CLI 동작 기록 없음)');
  return `가짜 CLI 동작 기록(끝 40줄):\n${text.split('\n').slice(-40).join('\n')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(message);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  // 세션 터미널(PTY)과 관문 서버가 이벤트 루프를 붙잡아 두므로 끝나면 나간다
  .finally(() => setTimeout(() => process.exit(), 500).unref());

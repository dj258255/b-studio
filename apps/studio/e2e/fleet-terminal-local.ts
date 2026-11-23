/**
 * 터미널 방식 Agent Fleet(`runner: 'terminal'`)의 실제 실행 경로를 외부 과금 없이 검증한다(#1363).
 * 후보마다 세션 복사본과 실제 Docker 샌드박스를 만들고, 서버가 세션 터미널(이 컴퓨터 방식 PTY)에 요청을 붙여 넣는다.
 * CLI는 스스로 훅·텔레메트리를 부르는 가짜(`server/baseline/fake-claude-agent.mjs`)라 로그인·모델 호출이 없다.
 * 훅 → 쓰기 직전 기준 → 파일 → 턴 끝 게이트(실제 서비스 재시작·준비 판정) → 체크포인트 → 승자 선택 → 모델 관측을 한 번에 지난다.
 *
 * API 모드의 제공자 어댑터는 e2e:fleet(fleet-local.ts)가 확인한다. 이 파일은 터미널 경로만 본다.
 *
 *   pnpm e2e:fleet-terminal
 */
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const TERMINAL = new Set(['done', 'failed', 'error', 'cancelled']);
const FAKE_CLI = path.resolve(import.meta.dirname, '../server/baseline/fake-claude-agent.mjs');
const CANDIDATES = ['alpha', 'beta'] as const;

async function main(): Promise<void> {
  // 처음 쓰는 컴퓨터(CI 실행기 등)에는 ~/.cache/b-studio가 없다. mkdtemp는 상위 폴더를 만들지 않는다
  await mkdir(path.join(homedir(), '.cache/b-studio'), { recursive: true });
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'fleet-terminal-e2e-'));
  let sessionIds: string[] = [];
  try {
    // 가짜 CLI: 후보는 CLI가 받은 --model로 가른다. 각자 자기 이름의 메모 파일을 쓰고 턴을 끝낸다
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const script = {
      scripts: CANDIDATES.map((who) => ({
        match: { model: who },
        steps: [
          // 쓰기 전에 텔레메트리를 보낸다(텔레메트리 없는 쓰기가 이어지면 서버가 쓰기를 막는다)
          { telemetry: { requestId: `req_${who}`, input: 100, output: 20, costUsd: 0.001 } },
          { write: { path: `web/FLEET_${who.toUpperCase()}.md`, content: `${who}\n` } },
          { stop: { text: `${who} 후보의 검증 메모를 추가했습니다.` } },
        ],
      })),
    };
    const scriptFile = path.join(root, 'claude-script.json');
    await writeFile(scriptFile, JSON.stringify(script));
    const actionLog = path.join(root, 'claude-actions.jsonl');
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
    // 사용자의 claude 설정 파일(~/.claude.json)과 관문 폴더를 건드리지 않는다(ADR-222)
    process.env.B_STUDIO_CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
    process.env.B_STUDIO_AGENT_GATEWAY_DIR = path.join(root, 'gateway');
    process.env.B_STUDIO_PROJECTS_DIR = path.resolve(import.meta.dirname, '../../../examples');
    process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
    process.env.B_STUDIO_FLEETS_DIR = path.join(root, 'fleets');
    process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(root, 'model-observations.json');

    const [{ createFleet, getFleet, chooseFleetWinner }, { getSnapshot, stopSession }, { observations }] = await Promise.all([
      import('../lib/server/fleets'),
      import('../lib/server/sessions'),
      import('../lib/server/model-observations'),
    ]);

    const owner = 'fleet-terminal-e2e';
    const request = '각 후보 이름이 적힌 검증 메모 파일을 web 폴더에 추가해줘';
    const started = Date.now();
    const created = await createFleet({
      projectId: 'orders',
      request,
      runner: 'terminal',
      candidates: CANDIDATES.map((model) => ({ backend: 'claude-code' as const, model })),
      owner,
    });
    sessionIds = created.members.map((member) => member.sessionId);
    log(`Fleet ${created.id}: ${sessionIds.length}개 독립 세션 생성(터미널)`);

    let fleet = created;
    let previous = '';
    while (!fleet.members.every((member) => TERMINAL.has(member.status))) {
      if (Date.now() - started > 15 * 60_000) throw new Error(`터미널 방식 Agent Fleet이 15분 안에 끝나지 않았습니다\n${await tail(actionLog)}`);
      await delay(1_000);
      fleet = getFleet(created.id, owner);
      const current = fleet.members.map((member) => `${member.label}=${member.status}`).join(', ');
      if (current !== previous) {
        log(current);
        previous = current;
      }
    }

    const failed = fleet.members.filter((member) => member.status !== 'done');
    if (failed.length) throw new Error(`${failed.map((member) => `${member.label}: ${member.status} ${member.summary ?? ''}`).join('\n')}\n${await tail(actionLog)}`);
    if (new Set(fleet.members.map((member) => member.sessionId)).size !== 2) throw new Error('후보가 서로 다른 세션을 쓰지 않았습니다');
    for (const [index, who] of CANDIDATES.entries()) {
      const member = fleet.members[index]!;
      const note = `web/FLEET_${who.toUpperCase()}.md`;
      if (member.modelId !== who) throw new Error(`${member.label}의 모델이 ${who}가 아닙니다: ${member.modelId}`);
      if (!member.checkpoint || JSON.stringify(member.checkpoint.files) !== JSON.stringify([note])) throw new Error(`${member.label}의 체크포인트가 자기 메모 하나가 아닙니다: ${JSON.stringify(member.checkpoint?.files)}`);
      // 사용량·비용은 CLI 텔레메트리가 알려 온 값이다
      if (member.usage?.outputTokens !== 20 || member.costUsd === undefined) throw new Error(`${member.label}의 사용량·비용이 텔레메트리와 다릅니다: ${JSON.stringify({ usage: member.usage, costUsd: member.costUsd })}`);
      const workDir = getSnapshot(member.sessionId)?.workDir;
      if (!workDir) throw new Error(`${member.label} 세션 작업 폴더를 찾지 못했습니다`);
      const content = await readFile(path.join(workDir, note), 'utf8');
      if (content !== `${who}\n`) throw new Error(`${member.label}의 메모 내용이 다릅니다: ${JSON.stringify(content)}`);
      const other = `web/FLEET_${CANDIDATES[1 - index]!.toUpperCase()}.md`;
      if (await readFile(path.join(workDir, other), 'utf8').then(() => true, () => false)) throw new Error(`${member.label}의 작업 복사본에 다른 후보의 메모(${other})가 섞였습니다`);
      log(`✓ ${member.label}: $${member.costUsd.toFixed(6)} · ${member.checkpoint.shortSha} · ${note}`);
    }

    const selected = chooseFleetWinner(fleet.id, fleet.members[0]!.sessionId, owner);
    if (selected.winnerSessionId !== fleet.members[0]!.sessionId) throw new Error('통과한 후보를 승자로 기록하지 못했습니다');
    // 터미널 관측은 b-studio가 세션에 정한 모델로 남고, 텔레메트리의 비용은 쓰지 않는다(#1359)
    const measured = observations();
    const models = measured.map((item) => item.modelId).sort();
    if (measured.length !== 2 || JSON.stringify(models) !== JSON.stringify([...CANDIDATES]) || measured.some((item) => !item.passed || item.costUsd !== undefined)) {
      throw new Error(`모델 관측 기록이 올바르지 않습니다: ${JSON.stringify(measured)}`);
    }
    log(`✅ 실제 Docker 터미널 방식 Agent Fleet E2E 통과 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);

    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
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

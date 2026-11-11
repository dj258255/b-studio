import { describe, expect, it } from 'vitest';
import { createWorld, firstDirWith, startFrontTarget, startNodeTarget, type Target, type World } from './harness';
import { baselinePath, runScenario } from './run-scenario';
import { scenarios, terminalScenarios } from './scenarios';

/**
 * 세션 경로의 바깥 동작 기준 사진(ADR-195 4f F0). 시나리오마다 진짜 studio 서버(앞단 + Node)를 임시 HOME·임시 세션 폴더·임시 프로젝트로 띄우고,
 * 가짜 docker·가짜 claude CLI로 실행을 몰아 HTTP 응답·SSE 이벤트 열·디스크(session.json, git 기록, refs)·docker 호출을 `__baselines__/<이름>.json`과 견준다.
 *
 * 기준 사진은 지금의 Node 구현이 낸 값이다("옳은 값"이 아니라 "옮기는 동안 바뀌면 안 되는 값"). 일부러 동작을 바꾸는 PR은 `pnpm test:baseline:update`로 갱신하고 diff를 리뷰한다.
 * STUDIO_BASELINE_TARGET=node면 앞단 없이 Node 서버만 띄워 같은 기준 사진과 견준다(앞단이 결과를 바꾸지 않는지).
 */
const startTarget: (world: World) => Promise<Target> = process.env.STUDIO_BASELINE_TARGET === 'node' ? startNodeTarget : startFrontTarget;

describe('시험 장치', () => {
  it('서버의 PATH에서 `docker`와 `claude`를 이름으로 찾으면 가짜 bin 폴더의 것이 잡힌다', async () => {
    const world = await createWorld();
    try {
      expect(await firstDirWith('docker', world.env.PATH)).toBe(world.binDir);
      expect(await firstDirWith('claude', world.env.PATH)).toBe(world.binDir);
      // 서버는 호스트의 HOME·사용자 폴더를 보지 않는다
      expect(world.env.HOME).toBe(world.home);
      expect(world.env.B_STUDIO_SESSIONS_DIR?.startsWith(world.root)).toBe(true);
    } finally {
      await world.cleanup();
    }
  });
});

describe.concurrent.each([
  ['세션 경로 기준 사진(/messages: stream-json 러너)', scenarios],
  ['세션 터미널 경로 기준 사진(훅 호출)', terminalScenarios],
] as const)('%s', (_name, list) => {
  for (const scenario of list) {
    it(
      `${scenario.name}: ${scenario.covers}`,
      async ({ expect }) => {
        const snapshot = await runScenario(scenario, startTarget);
        // 가짜 docker가 모르는 호출을 받았으면 시나리오가 빠뜨린 것이다 — 조용히 지나치지 않는다
        expect(snapshot.docker).toMatchObject({ unknown: [] });
        await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(baselinePath(scenario.name));
      },
      240_000,
    );
  }
});

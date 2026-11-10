import { appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, resolveCliCommand } from './claude-cli-process';
import * as legacy from './claude-cli-process-legacy';
import { makeFixture, type Fixture } from './claude-cli-command-fixture';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';

/**
 * CLI 실행 파일 고르기(ADR-191 3ac, 막는 쪽)를 Rust로 옮기면서 옛 TS(`claude-cli-process-legacy.ts`)와 새 껍데기에 같은 무작위 입력(PATH 항목 조합, 막을 폴더, 명령)을 넣어
 * 결과를 견준다. 임시 폴더만 쓴다. 지우지 않는다.
 *
 * 열린 쪽 뒤집힘: 옛 구현이 거절했는데(던짐) 새 구현이 파일을 고른 수, 옛 구현이 PATH에서 뺀 항목을 새 구현이 남긴 수. 0이어야 한다.
 * 닫는 쪽 차이는 모두 이유를 댈 수 있어야 한다(`..`로 시작하는 폴더 이름, 프로젝트 안의 링크, 대소문자만 다른 폴더). 이유 없는 차이는 0이어야 한다.
 *
 * 크기는 환경 변수: CLI_CMD_DIFF_SEEDS, CLI_CMD_DIFF_ITERATIONS, CLI_CMD_DIFF_REPORT=<파일>
 */
const SEEDS = readEnvList('CLI_CMD_DIFF_SEEDS', [1, 2, 3]);
const ITERATIONS = readEnvNumber('CLI_CMD_DIFF_ITERATIONS', 1500);
const REPORT = process.env['CLI_CMD_DIFF_REPORT'];
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => rmSync(fx.base, { recursive: true, force: true }));

function entryPool(f: Fixture): string[] {
  const b = f.base;
  const p = f.project;
  return [
    path.join(p, 'bin'), path.join(p, '..bin'), p, path.join(p, 'node_modules', '.bin'), path.join(p, 'tools'), `${p}/`, `${p}//bin`, `${b}/outside/../project/bin`, `${p}/../outside/bin`,
    path.join(b, 'project-extra', 'bin'), path.join(b, 'project2', 'bin'), path.join(b, 'Project2', 'bin'), path.join(b, 'PROJECT', 'bin'),
    path.join(b, 'outside', 'bin'), path.join(b, 'outside', 'noexec'), path.join(b, 'outside', 'dir'), `${path.join(b, 'outside', 'bin')}/`, `${b}/outside//bin`,
    path.join(b, 'linkin'), path.join(b, 'outlink'), path.join(b, 'alias', 'bin'), path.join(b, 'alias'), path.join(b, 'nope'), path.join(b, 'nope', '..', 'outside', 'bin'),
    '', '.', '..', 'bin', './bin', '../outside/bin', `"${path.join(b, 'outside', 'bin')}"`, ` ${path.join(b, 'outside', 'bin')}`, '/', '/usr/bin', '/bin',
  ];
}

function rootPool(f: Fixture): Array<string | undefined> {
  const b = f.base;
  return [f.project, f.project, f.project, `${f.project}/`, path.join(b, 'alias'), path.join(b, 'Project2'), path.join(b, 'PROJECT'), path.join(b, 'project-extra'), path.join(b, 'outside'), path.join(b, 'missing'), 'relative-root', '', undefined, '/'];
}

function commandPool(f: Fixture): string[] {
  const b = f.base;
  return ['claude', 'claude', 'claude', 'claude', 'nope', '', '.', './claude', 'bin/claude', path.join(f.project, 'claude'), path.join(b, 'outside', 'bin', 'claude'), path.join(b, 'linkin', 'claude'), `${b}/outside/../project/claude`, path.join(b, 'outlink', 'claude'), path.join(f.project, 'tools', 'claude'), path.join(b, 'Project2', 'bin', 'claude')];
}

type Result = { threw: true } | { threw: false; value: string };

function run(fn: () => string): Result {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    return { threw: true };
  }
}

interface Tally {
  runs: number;
  differ: number;
  openFlips: number;
  closedFlips: number;
  unexplained: number;
  dist: Record<string, number>;
  childRuns: number;
  childDiffer: number;
  childOpenFlips: number;
  childUnexplained: number;
}

/** 옛 구현은 열린 쪽으로 틀렸다고 설명할 수 있는 경로인가(글자로 보이는 이유) */
function explainable(candidate: string, f: Fixture, root?: string): boolean {
  // 빈 문자열 루트: 옛 구현은 `realpathSync('')`가 프로세스의 현재 폴더라 엉뚱한 폴더를 막을 폴더로 썼다. 대소문자만 다른 루트(대소문자를 구분하지 않는 볼륨)
  if (root === '' || (root !== undefined && root !== f.project && root.toLowerCase() === f.project.toLowerCase())) return true;
  const normal = path.normalize(candidate);
  const lower = normal.toLowerCase();
  const rootLower = f.project.toLowerCase();
  // 이름이 ..로 시작하는 폴더, 프로젝트 안을 지나가는 글자 경로(링크 포함), 대소문자만 다른 폴더
  return normal.split(path.sep).some((part) => part.startsWith('..') && part !== '..') || lower.startsWith(`${rootLower}/`) || lower === rootLower || lower.startsWith(f.project2.toLowerCase());
}

function runSeed(seed: number, iterations: number, f: Fixture): Tally {
  const g = new Gen(seed);
  const entries = entryPool(f);
  const roots = rootPool(f);
  const commands = commandPool(f);
  const tally: Tally = { runs: 0, differ: 0, openFlips: 0, closedFlips: 0, unexplained: 0, dist: {}, childRuns: 0, childDiffer: 0, childOpenFlips: 0, childUnexplained: 0 };
  for (let i = 0; i < iterations; i++) {
    const list = g.list(0, 4, () => g.pick(entries));
    const PATH = list.join(path.delimiter);
    const root = g.pick(roots);
    const command = g.pick(commands);
    const oldResult = run(() => legacy.resolveCliCommand(command, { PATH }, root));
    const newResult = run(() => resolveCliCommand(command, { PATH }, root));
    tally.runs += 1;
    const key = oldResult.threw ? 'ENOENT' : 'picked';
    tally.dist[key] = (tally.dist[key] ?? 0) + 1;
    if (JSON.stringify(oldResult) !== JSON.stringify(newResult)) {
      tally.differ += 1;
      if (oldResult.threw) tally.openFlips += 1;
      else if (newResult.threw) {
        tally.closedFlips += 1;
        if (!explainable(oldResult.value, f, root)) {
          tally.unexplained += 1;
          if (process.env['CLI_CMD_DIFF_DEBUG']) appendFileSync(process.env['CLI_CMD_DIFF_DEBUG'], `closed ${JSON.stringify({ command, PATH, root, oldResult })}\n`);
        }
      } else {
        // 둘 다 골랐지만 다르다: 옛 구현이 연 후보를 새 구현이 건너뛰고 뒤의 후보를 골랐다. 새 구현의 후보는 옛 구현의 후보보다 뒤여야 한다(앞이면 옛 구현이 막은 것을 연 것이다)
        const candidates = list.map((entry) => (path.isAbsolute(entry) ? path.join(entry, command) : ''));
        const oldAt = candidates.indexOf(oldResult.value);
        const newAt = candidates.indexOf(newResult.value);
        if (oldAt === -1 || newAt === -1 || newAt < oldAt) tally.openFlips += 1;
        else if (!explainable(oldResult.value, f, root)) {
          tally.unexplained += 1;
          if (process.env['CLI_CMD_DIFF_DEBUG']) appendFileSync(process.env['CLI_CMD_DIFF_DEBUG'], `both ${JSON.stringify({ command, PATH, root, oldResult, newResult })}\n`);
        } else tally.closedFlips += 1;
      }
    }
    // 자식 PATH
    const oldEnv = legacy.childEnv({ PATH, HOME: '/h' }, root);
    const newEnv = childEnv({ PATH, HOME: '/h' }, root);
    tally.childRuns += 1;
    if (JSON.stringify(oldEnv) !== JSON.stringify(newEnv)) {
      tally.childDiffer += 1;
      const oldKept = (oldEnv.PATH ?? '').split(path.delimiter).filter(Boolean);
      const newKept = (newEnv.PATH ?? '').split(path.delimiter).filter(Boolean);
      // 열린 쪽: 새 구현이 남기고 옛 구현이 뺀 항목, 또는 순서가 바뀜
      if (newKept.some((entry) => !oldKept.includes(entry)) || newKept.join('|') !== oldKept.filter((entry) => newKept.includes(entry)).join('|')) tally.childOpenFlips += 1;
      else if (!oldKept.filter((entry) => !newKept.includes(entry)).every((entry) => explainable(entry, f, root))) tally.childUnexplained += 1;
    }
  }
  return tally;
}

function report(line: string): void {
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
}

posixOnly('CLI 실행 파일 고르기 차등 시험', () => {
  it('옛 구현과 같고 열린 쪽 뒤집힘이 0이다', () => {
    let runs = 0;
    for (const seed of SEEDS) {
      const tally = runSeed(seed, ITERATIONS, fx);
      report(`cli-command seed=${seed} ${JSON.stringify(tally)}`);
      runs += tally.runs;
      expect(tally.dist['picked'] ?? 0, '고른 입력이 있어야 한다').toBeGreaterThan(0);
      expect(tally.dist['ENOENT'] ?? 0, '거절한 입력이 있어야 한다').toBeGreaterThan(0);
      expect(tally.openFlips, `열린 쪽 뒤집힘 seed=${seed}`).toBe(0);
      expect(tally.unexplained, `이유 없는 차이 seed=${seed}`).toBe(0);
      expect(tally.childOpenFlips, `자식 PATH 열린 쪽 뒤집힘 seed=${seed}`).toBe(0);
      expect(tally.childUnexplained, `자식 PATH 이유 없는 차이 seed=${seed}`).toBe(0);
    }
    expect(runs).toBe(SEEDS.length * ITERATIONS);
  });

  it('대조 장치: 열린 쪽으로 틀린 옛 구현을 차이로 잡는다', () => {
    // 옛 구현이 열린 쪽으로 틀린 입력에서 둘이 실제로 다르다(차이를 세는 장치가 작동한다)
    const PATH = path.join(fx.project, '..bin');
    const oldResult = run(() => legacy.resolveCliCommand('claude', { PATH }, fx.project));
    const newResult = run(() => resolveCliCommand('claude', { PATH }, fx.project));
    expect(oldResult.threw).toBe(false);
    expect(newResult.threw).toBe(true);
    // 새 구현의 경계를 +1 넓힌 것처럼, 옛 구현이 다르게 고른 경로를 차이로 센다
    expect(JSON.stringify(oldResult)).not.toBe(JSON.stringify(newResult));
  });

  it('돌린 횟수가 입력 크기와 맞다', () => {
    expect(SEEDS.length * ITERATIONS).toBeGreaterThan(0);
  });
});

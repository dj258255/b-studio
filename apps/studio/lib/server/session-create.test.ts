import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { runCreate, type CreateActions } from './session-create';
import { LEGACY_CREATE_STEPS, legacyCreate, type LegacyCreateStep } from './session-create-legacy';

/**
 * 세션 만들기의 순서와 치우기(ADR-206, 4f B2c): Rust `create`를 옛 TS(`session-create-legacy.ts`)와 같은 입력으로 견준다.
 * 성공과 단계마다의 실패에서 같은 콜백 순서, 같은 오류(객체 그대로)를 낸다. 다른 것은 아래 "의도한 차이" 시험들뿐이다:
 *   1. 만들다 실패하면 끝낸 단계를 거꾸로 치운다(샌드박스·맵 항목), 이 호출이 만든 세션 폴더를 지운다(옛 코드는 아무것도 치우지 않았다)
 *   2. 세션 폴더가 이미 있으면 만들지 않고 실패한다(옛 코드는 있는 폴더에 복사본을 섞거나 비어 있으면 그 안에 복제했다)
 * 모든 폴더는 임시 폴더 안에 만든다.
 */

const counts = { success: 0, stepFailures: 0, random: 0, undoFailures: 0, intendedLeftover: 0, intendedExisting: 0 };
afterAll(() => console.log(`[session-create 차등] ${JSON.stringify(counts)}`));

function prng(seedStart: number): () => number {
  let seed = seedStart;
  return () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
}

const FORWARD = LEGACY_CREATE_STEPS as readonly LegacyCreateStep[];
const UNDO = ['destroy_sandbox', 'unregister_session'] as const;

interface Run {
  /** 부른 콜백 이름(순서대로, 치우기 포함) */
  calls: string[];
  error: unknown;
}

type Plan = Partial<Record<LegacyCreateStep, unknown>>;
type UndoPlan = Partial<Record<(typeof UNDO)[number], unknown>>;

/** 계획대로 던지는 콜백들. `prepare_workdir`는 세션 폴더(없으면 만든다)에 파일을 둔다(옛 구현은 복제가 폴더를 만들었다) */
function actions(calls: string[], home: string, plan: Plan, undoPlan: UndoPlan = {}): CreateActions {
  const make = (name: string, thrown: unknown, work?: () => Promise<void>) => async () => {
    calls.push(name);
    if (work) await work();
    if (thrown !== undefined) throw thrown;
  };
  const all: Record<string, () => Promise<void>> = {};
  for (const step of FORWARD) {
    all[step] = make(step, plan[step], step === 'prepare_workdir' ? async () => void (await mkdir(home, { recursive: true }), await writeFile(path.join(home, 'copy.txt'), 'x')) : undefined);
  }
  for (const undo of UNDO) all[undo] = make(undo, undoPlan[undo]);
  return all as unknown as CreateActions;
}

interface Fixture {
  root: string;
  home: string;
}
let counter = 0;
async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'b-studio-create-diff-'));
  counter += 1;
  return { root: path.join(base, 'sessions'), home: path.join(base, 'sessions', `proj-ab12cd${String(counter % 100).padStart(2, '0')}`) };
}

async function runNew(plan: Plan, undoPlan: UndoPlan = {}, setup?: (f: Fixture) => Promise<void>): Promise<Run & { f: Fixture }> {
  const f = await fixture();
  await setup?.(f);
  const calls: string[] = [];
  try {
    await runCreate({ root: f.root, home: f.home, sessionId: path.basename(f.home).slice(-8) }, actions(calls, f.home, plan, undoPlan), () => {});
    return { calls, error: undefined, f };
  } catch (error) {
    return { calls, error, f };
  }
}

async function runLegacy(plan: Plan): Promise<Run & { f: Fixture }> {
  const f = await fixture();
  const calls: string[] = [];
  try {
    await legacyCreate(actions(calls, f.home, plan) as unknown as Record<LegacyCreateStep, () => Promise<void>>);
    return { calls, error: undefined, f };
  } catch (error) {
    return { calls, error, f };
  }
}

function forwardOnly(calls: string[]): string[] {
  return calls.filter((name) => !(UNDO as readonly string[]).includes(name));
}

describe('단계 이름 목록과 순서', () => {
  it('Rust 코어의 단계 목록은 옛 순서에 세션 폴더 만들기(make_home)가 validate_start 바로 뒤에 더해진 것이다', () => {
    const steps = native.sessionCreateSteps();
    const names = steps.map((step) => step.name);
    expect(names).toEqual(['validate_start', 'make_home', ...FORWARD.slice(1)]);
    expect(names.filter((name) => name !== 'make_home')).toEqual([...FORWARD]);
    expect(steps.filter((step) => step.undo).map((step) => [step.name, step.undo, step.undoIfFailed])).toEqual([
      ['create_sandbox', 'destroy_sandbox', false],
      ['register_session', 'unregister_session', true],
    ]);
  });
});

describe('성공과 단계마다의 실패가 옛 코드와 같다', () => {
  it('성공: 같은 콜백 순서, 치우기를 부르지 않고 세션 폴더가 남는다', async () => {
    const [legacy, current] = [await runLegacy({}), await runNew({})];
    expect(current.error).toBeUndefined();
    expect(legacy.error).toBeUndefined();
    expect(current.calls).toEqual(legacy.calls);
    expect(current.calls).toEqual([...FORWARD]);
    expect(await readdir(current.f.root)).toEqual([path.basename(current.f.home)]);
    counts.success += 1;
  });

  it('단계마다 실패(StudioError와 일반 오류): 같은 오류 객체, 앞의 단계까지 같은 콜백 순서', async () => {
    for (const [at, step] of FORWARD.entries()) {
      for (const thrown of [new StudioError(409, `${step} 거절`), new Error(`${step} 실패`), 'text' as unknown]) {
        const [legacy, current] = [await runLegacy({ [step]: thrown }), await runNew({ [step]: thrown })];
        expect(current.error, `${step}`).toBe(thrown);
        expect(legacy.error, `${step}`).toBe(thrown);
        expect(forwardOnly(current.calls), `${step}: 앞으로 가는 콜백 순서`).toEqual(legacy.calls);
        expect(legacy.calls).toEqual(FORWARD.slice(0, at + 1));
        if (thrown instanceof StudioError) expect([(current.error as StudioError).status, (current.error as StudioError).message]).toEqual([thrown.status, thrown.message]);
        counts.stepFailures += 1;
      }
    }
  });

  it('무작위 실패 계획 600개: 같은 오류와 같은 앞쪽 콜백 순서, 치우기는 끝낸 단계만 거꾸로', async () => {
    const random = prng(20_261_116);
    for (let round = 0; round < 600; round += 1) {
      const plan: Plan = {};
      for (const step of FORWARD) if (random() % 7 === 0) plan[step] = new StudioError(400 + (random() % 5), `${step} ${round}`);
      const [legacy, current] = [await runLegacy(plan), await runNew(plan)];
      expect(current.error).toBe(legacy.error);
      expect(forwardOnly(current.calls)).toEqual(legacy.calls);
      // 치우기: 끝낸 단계(실패한 단계 앞)의 치우기를 거꾸로, 실패한 register_session은 자기 치우기가 먼저
      const failing = FORWARD.find((step) => plan[step] !== undefined);
      if (!failing) {
        expect(current.calls).toEqual(legacy.calls);
      } else {
        const done = FORWARD.slice(0, FORWARD.indexOf(failing));
        const expected: string[] = [];
        if (failing === 'register_session') expected.push('unregister_session');
        if (done.includes('register_session')) expected.push('unregister_session');
        if (done.includes('create_sandbox')) expected.push('destroy_sandbox');
        expect(current.calls.filter((name) => (UNDO as readonly string[]).includes(name))).toEqual(expected);
        expect(await readdir(current.f.root).catch(() => []), '실패한 만들기의 세션 폴더').toEqual([]);
      }
      counts.random += 1;
    }
  }, 120_000);

  it('치우기도 실패하면 원래 오류를 던지고 치우기 오류는 로그로만 알린다', async () => {
    const original = new StudioError(500, '원래 오류');
    const f = await fixture();
    const calls: string[] = [];
    const logged: Array<{ name: string; message: string }> = [];
    await expect(
      runCreate({ root: f.root, home: f.home, sessionId: path.basename(f.home).slice(-8) }, actions(calls, f.home, { begin_boot: original }, { destroy_sandbox: new Error('치우기 실패'), unregister_session: new Error('빼기 실패') }), (_m, errors) => logged.push(...errors)),
    ).rejects.toBe(original);
    expect(logged).toEqual([
      { name: 'unregister_session', message: '빼기 실패' },
      { name: 'destroy_sandbox', message: '치우기 실패' },
    ]);
    expect(await readdir(f.root), '앞 치우기가 실패해도 폴더는 지운다').toEqual([]);
    counts.undoFailures += 1;
  });
});

describe('의도한 차이', () => {
  it('의도한 차이: 만들다 실패하면 이 호출이 만든 세션 폴더를 지운다(옛 코드는 남겼다)', async () => {
    const plan: Plan = { check_backend_ready: new StudioError(409, '로그인되어 있지 않습니다') };
    const legacy = await runLegacy(plan);
    expect(await readdir(legacy.f.root), '옛 코드: 실패한 세션의 폴더가 남는다').toEqual([path.basename(legacy.f.home)]);
    const current = await runNew(plan);
    expect(await readdir(current.f.root)).toEqual([]);
    counts.intendedLeftover += 1;
  });

  it('의도한 차이: 세션 폴더가 이미 있으면 만들지 않고 500으로 실패하며, 그 폴더도 뒤 단계도 건드리지 않는다', async () => {
    const run = await runNew({}, {}, async (f) => {
      await mkdir(f.home, { recursive: true });
      await writeFile(path.join(f.home, 'precious.txt'), '다른 세션의 파일');
    });
    expect(run.error).toBeInstanceOf(StudioError);
    expect((run.error as StudioError).status).toBe(500);
    expect((run.error as StudioError).message).toMatch(/이미 있어 새로 만들지 않았습니다/);
    expect(run.calls, 'validate_start만 불렸다').toEqual(['validate_start']);
    expect(await readdir(run.f.home)).toEqual(['precious.txt']);
    counts.intendedExisting += 1;
  });

  it('의도한 차이: 세션 폴더 자리가 링크여도 따라가지 않고 만들지 않는다', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'b-studio-create-diff-target-'));
    await writeFile(path.join(target, 'precious.txt'), 'keep');
    const run = await runNew({}, {}, async (f) => {
      await mkdir(f.root, { recursive: true });
      await symlink(target, f.home);
    });
    expect((run.error as StudioError).status).toBe(500);
    expect(await readdir(target)).toEqual(['precious.txt']);
  });

  it('내 폴더 세션의 사용자 폴더는 만들기가 실패해도 그대로다(userDir을 코어에 넘긴다)', async () => {
    const f = await fixture();
    const user = await mkdtemp(path.join(tmpdir(), 'b-studio-create-diff-user-'));
    await writeFile(path.join(user, 'mine.txt'), '내 파일');
    const calls: string[] = [];
    await expect(
      runCreate({ root: f.root, home: f.home, sessionId: path.basename(f.home).slice(-8), userDir: user }, actions(calls, f.home, { create_sandbox: new Error('실패') }), () => {}),
    ).rejects.toThrow('실패');
    expect(await readdir(f.root)).toEqual([]);
    expect(await readdir(user)).toEqual(['mine.txt']);
  });
});

describe('알 수 없는 콜백', () => {
  it('코어가 부르는 단계에 콜백이 없으면 그 이유로 실패하고 치운다', async () => {
    const f = await fixture();
    const partial = { validate_start: () => {} } as unknown as CreateActions;
    await expect(runCreate({ root: f.root, home: f.home, sessionId: path.basename(f.home).slice(-8) }, partial, () => {})).rejects.toThrow(/알 수 없는 만들기 단계입니다: prepare_workdir/);
    expect(await readdir(f.root)).toEqual([]);
  });
});

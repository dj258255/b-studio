import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { native } from '@b-studio/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyCheckpointStore } from './checkpoint-store-legacy';
import { CheckpointStore, type RememberedGit } from './checkpoints';

/**
 * 체크포인트의 원격 경로(올리기·가져오기·기준 브랜치 따라잡기·PR 대상·신뢰 확인·터미널이 어긋낸 기록 되돌리기)를 Rust로 옮기면서(ADR-195 4f A2)
 * 옛 구현(`checkpoint-store-legacy.ts`의 `LegacyCheckpointStore`)과 지금 `CheckpointStore`에 **같은 시나리오**를 넣어 견준다.
 * 시나리오마다 임시 폴더에 로컬 bare 저장소(origin)·원본·세션 작업 복사본을 새로 만들고(실제 GitHub·네트워크는 쓰지 않는다) 옛 구현과 지금 구현이 각자의 세계에서 돈다.
 * 견주는 것: 단계마다 ① git 호출 순서(감시용 git 껍데기가 인자를 적는다) ② 반환값 ③ 오류 글·종류·부가 필드 ④ 끝난 뒤의 저장소 상태(HEAD·브랜치·b-studio 메타·상태·원격 ref).
 * 커밋 시각을 고정해 두 세계의 sha가 같다. 경로(임시 폴더)와 시각·백업 id는 `normalize`가 같은 글자로 바꾼다.
 *
 * 의도한 차이: ① `repository()`가 base·branch를 읽는 두 git 호출은 옛 코드에서 동시라 순서가 일정하지 않아 한 쌍으로 정렬해 견준다.
 * HARDENED(옛 쪽보다 더 막는 것): `restoreRememberedHead`가 `git add -A` 앞에서 저장소 설정(clean 필터 등)을 확인한다, `baseStatus`가 읽지 못하는 `baseFetchedAt`을 오래된 것으로 본다 — 맨 아래 따로 고정한다.
 */

vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const BRANCH = 'b-studio/orders-s1';
const FIXED_DATE = '2026-01-01T00:00:00+0000';

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
let sandboxRoot: string;
let worldSeq = 0;

beforeEach(async () => {
  sandboxRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-remote-diff-')));
  const globalConfig = path.join(sandboxRoot, 'global.gitconfig');
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_DATE = FIXED_DATE;
  process.env.GIT_COMMITTER_DATE = FIXED_DATE;
});

afterEach(async () => {
  for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['GIT_AUTHOR_DATE', saved.author], ['GIT_COMMITTER_DATE', saved.committer]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandboxRoot, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}
const gitOr = (cwd: string, ...args: string[]) => git(cwd, ...args).catch((error: Error) => `오류: ${error.message.split('\n')[0]}`);

type AnyStore = CheckpointStore | LegacyCheckpointStore;
type StoreClass = typeof CheckpointStore | typeof LegacyCheckpointStore;
type StoreOptions = ConstructorParameters<typeof CheckpointStore>[1];

interface World {
  base: string;
  remote: string;
  source: string;
  workDir: string;
  log: string;
  spy: string;
  /** 세계를 만들 때만 쓰는 지금 구현(감시 껍데기 없음). 시나리오의 준비 단계가 쓴다 */
  setup: CheckpointStore;
  subdir: string;
}

/** 감시용 git 껍데기. 부른 인자를 로그에 적고 실제 git을 부른다. body는 그 앞에 끼워 넣는 셸 조각(특정 호출을 실패시킨다) */
async function writeSpy(base: string, log: string, name: string, body = ''): Promise<string> {
  const file = path.join(base, name);
  await writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}exec git "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

async function createWorld({ subdir = false }: { subdir?: boolean } = {}): Promise<World> {
  const base = path.join(sandboxRoot, `world-${++worldSeq}`);
  const remote = path.join(base, 'orders.git');
  const source = path.join(base, 'orders');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await writeFile(path.join(source, 'README.md'), '# orders\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'docs');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  const workDir = path.join(base, 'sessions', 'orders-s1');
  const { store } = await CheckpointStore.clone(subdir ? path.join(source, 'api') : source, workDir, { branch: BRANCH, allowSubfolder: subdir });
  const log = path.join(base, 'git-calls.log');
  const spy = await writeSpy(base, log, 'git-spy.sh');
  return { base, remote, source, workDir, log, spy, setup: store, subdir: subdir ? 'api' : '' };
}

/** 프로젝트 폴더 기준 파일을 쓴다 */
const writeProject = async (w: World, file: string, content: string) => {
  const target = path.join(w.workDir, w.subdir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};
const ORDER = 'api/src/Order.java';
const orderFile = (w: World) => (w.subdir ? 'src/Order.java' : ORDER);

/** 세션에서 체크포인트 하나를 남긴다(준비 단계) */
async function commitOrder(w: World, text: string, message: string) {
  await writeProject(w, orderFile(w), `class Order { String ${text}; }\n`);
  return (await w.setup.commit(message))!;
}

async function remembered(w: World): Promise<RememberedGit> {
  const head = await git(w.workDir, 'rev-parse', 'HEAD');
  const branch = await git(w.workDir, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => BRANCH);
  const originUrl = await git(w.workDir, 'remote', 'get-url', 'origin').catch(() => undefined);
  return { branch, lastCheckpoint: head, ...(originUrl ? { originUrl } : {}) };
}

/** 리뷰어가 세션 브랜치를 받아 커밋 하나를 올린다 */
async function reviewerCommit(w: World, file: string, content: string, message: string): Promise<string> {
  const reviewer = await mkdtemp(path.join(w.base, 'reviewer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, w.remote, reviewer]);
  await mkdir(path.dirname(path.join(reviewer, file)), { recursive: true });
  await writeFile(path.join(reviewer, file), content);
  await git(reviewer, 'add', '-A');
  await git(reviewer, 'commit', '-q', '-m', message);
  await git(reviewer, 'push', '-q', 'origin', 'HEAD');
  return git(reviewer, 'rev-parse', 'HEAD');
}

async function baseCommit(w: World, file: string, content: string, message: string): Promise<string> {
  const clone = await mkdtemp(path.join(w.base, 'maintainer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', w.remote, clone]);
  await mkdir(path.dirname(path.join(clone, file)), { recursive: true });
  await writeFile(path.join(clone, file), content);
  await git(clone, 'add', '-A');
  await git(clone, 'commit', '-q', '-m', message);
  await git(clone, 'push', '-q', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

interface StepRecord {
  label: string;
  result: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string; extra: Record<string, unknown> } };
  calls: string[];
}

interface Ctx {
  w: World;
  Store: StoreClass;
  /** 감시 껍데기를 쓰는 새 저장소(캐시가 비어 있다) */
  make(options?: StoreOptions, spy?: string): AnyStore;
  /** 감시 껍데기에 다른 셸 조각을 끼운 것 */
  spyWith(name: string, body: string): Promise<string>;
  step(label: string, fn: () => unknown): Promise<void>;
  steps: StepRecord[];
}

type Scenario = (ctx: Ctx) => Promise<void>;

function describeError(error: unknown): { name: string; message: string; extra: Record<string, unknown> } {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error), extra: {} };
  const extra: Record<string, unknown> = {};
  for (const key of ['conflicts', 'files', 'expected', 'actual']) if (key in error) extra[key] = (error as unknown as Record<string, unknown>)[key];
  return { name: error.constructor.name, message: error.message, extra };
}

async function stateOf(w: World) {
  const meta = (await gitOr(w.workDir, 'config', '--get-regexp', '^b-studio\\.')).split('\n').filter((line) => !line.startsWith('b-studio.start')).sort();
  return {
    head: await gitOr(w.workDir, 'rev-parse', 'HEAD'),
    branch: await gitOr(w.workDir, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
    branches: await gitOr(w.workDir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    meta,
    status: await gitOr(w.workDir, 'status', '--porcelain', '--untracked-files=all'),
    mergeHead: await gitOr(w.workDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'),
    cherryPickHead: await gitOr(w.workDir, 'rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'),
    remoteRefs: await gitOr(w.remote, 'for-each-ref', '--format=%(refname) %(objectname)'),
  };
}

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const BACKUP_ID = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-z]{4}/g;

function normalizer(w: World) {
  return (text: string) => text.split(w.base).join('<W>').replace(TIME, '<time>').replace(BACKUP_ID, '<backup>');
}

/** repository()의 두 읽기(base·branch)는 옛 코드에서 동시라 호출 순서가 일정하지 않다 — 한 쌍으로 정렬한다 */
function sortConcurrentPair(calls: string[]): string[] {
  const out = [...calls];
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i]!.endsWith('config --get b-studio.branch') && out[i + 1]!.endsWith('config --get b-studio.base')) [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  }
  return out;
}

async function runScenario(Store: StoreClass, scenario: Scenario, options: { subdir?: boolean; restore?: boolean } = {}): Promise<unknown> {
  const w = await createWorld(options);
  const steps: StepRecord[] = [];
  const ctx: Ctx = {
    w,
    Store,
    steps,
    make: (storeOptions, spy) => new Store(w.workDir, { gitBin: spy ?? w.spy, ...storeOptions }),
    spyWith: (name, body) => writeSpy(w.base, w.log, name, body),
    async step(label, fn) {
      await rm(w.log, { force: true });
      let result: StepRecord['result'];
      try {
        result = { ok: true, value: await fn() };
      } catch (error) {
        result = { ok: false, error: describeError(error) };
      }
      const calls = (await readFile(w.log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      const sorted = sortConcurrentPair(calls);
      steps.push({ label, result, calls: options.restore && Store === CheckpointStore ? withoutRestoreSafetyCheck(sorted) : sorted });
    },
  };
  await scenario(ctx);
  const state = await stateOf(w);
  const normalize = normalizer(w);
  return JSON.parse(normalize(JSON.stringify({ steps, state })));
}

/**
 * 의도한 차이(HARDENED): `restoreRememberedHead`는 `add -A` 앞에서 저장소 설정을 확인한다(`config --list`·`rev-parse --git-path info/attributes`). 옛 코드는 부르지 않았다.
 * 이 두 호출이 `add -A` 바로 앞에 붙어 있을 때만 지금 쪽 기록에서 뺀다(그 밖의 순서는 그대로 견준다)
 */
function withoutRestoreSafetyCheck(calls: string[]): string[] {
  const out = [...calls];
  const at = out.findIndex((call) => / add -A( |$)/.test(call));
  if (at >= 2 && out[at - 2]!.endsWith('config --list --includes --show-scope --show-origin -z') && out[at - 1]!.endsWith('rev-parse --git-path info/attributes')) out.splice(at - 2, 2);
  return out;
}

/** 같은 시나리오를 옛 구현과 지금 구현에 넣어 견준다 */
async function compare(scenario: Scenario, options: { subdir?: boolean; restore?: boolean } = {}) {
  const legacy = await runScenario(LegacyCheckpointStore, scenario, options);
  const current = await runScenario(CheckpointStore, scenario, options);
  expect(current).toEqual(legacy);
  return current as { steps: StepRecord[]; state: Awaited<ReturnType<typeof stateOf>> };
}

/** 원격에 닿는 git 호출(`fetch`·`push`·`ls-remote`는 하위 명령 자리에서만 센다. `b-studio.baseFetchedAt` 같은 설정 이름은 세지 않는다) */
const NETWORK = / (fetch|push|ls-remote) /;
const compareRestore: typeof compare = (scenario, options = {}) => compare(scenario, { ...options, restore: true });
const failureOf = (record: StepRecord | undefined) => (record && !record.result.ok ? record.result.error.message : undefined);
const callsOf = (record: StepRecord | undefined) => (record ? record.calls.join('\n') : '');

// ───────────────────────────────────────────────────────────────────────

describe('읽기: repository·headState·remoteUrl·uncommitTo·recordPullRequest', () => {
  it('repository: 세션과 메타·하위 폴더', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('세션', () => make().repository());
      await w.setup.recordPullRequest('https://example.com/pr/1');
      await git(w.workDir, 'config', 'b-studio.pushed', 'a'.repeat(40));
      await git(w.workDir, 'config', 'b-studio.remote', 'b'.repeat(40));
      await git(w.workDir, 'config', 'b-studio.pullrequestBase', 'main');
      await step('메타 있음', () => make().repository());
      // 같은 저장소 객체로 두 번(캐시가 따뜻하다)
      const warm = make();
      await step('따뜻한 1', () => warm.repository());
      await step('따뜻한 2', () => warm.repository());
      await git(w.workDir, 'config', '--unset', 'b-studio.branch');
      await step('branch 없음', () => make().repository());
      await git(w.workDir, 'remote', 'remove', 'origin');
      await git(w.workDir, 'config', 'b-studio.branch', BRANCH);
      await step('origin 없음', () => make().repository());
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { base: 'main', branch: BRANCH } });
    expect(out.steps[4]!.result).toMatchObject({ ok: true });
    expect(failureOf(out.steps[5])).toBeDefined();
  });

  it('repository: 모노레포 하위 폴더', async () => {
    const out = await compare(async ({ make, step }) => {
      await step('하위 폴더', () => make().repository());
    }, { subdir: true });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { subdir: 'api' } });
  });

  it('repository: 원격 없는 일반 저장소는 undefined', async () => {
    await compare(async ({ w, Store, step }) => {
      const plain = path.join(w.base, 'plain');
      await mkdir(plain, { recursive: true });
      await writeFile(path.join(plain, 'a.txt'), 'a\n');
      const store = new Store(plain, { gitBin: w.spy });
      await store.init();
      await step('repository', () => store.repository());
      await step('push', async () => store.push({ branch: 'main', lastCheckpoint: 'a'.repeat(40) }));
    });
  });

  it('headState·remoteUrl: 브랜치·분리된 HEAD·origin 없음', async () => {
    await compare(async ({ w, make, step }) => {
      await step('브랜치', () => make().headState());
      await step('remoteUrl', () => make().remoteUrl());
      await git(w.workDir, 'checkout', '-q', '--detach');
      await step('분리됨', () => make().headState());
      await git(w.workDir, 'remote', 'remove', 'origin');
      await step('origin 없음', () => make().remoteUrl());
    });
  });

  it('uncommitTo: 얹은 커밋을 푼다·0개·형식 오류·없는 sha', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const a = await commitOrder(w, 'a', '요청: A');
      await step('같음', () => make().uncommitTo(a.sha));
      await writeProject(w, 'x.txt', '1\n');
      await git(w.workDir, 'add', '-A');
      await git(w.workDir, 'commit', '-q', '-m', '에이전트 1');
      await writeProject(w, 'y.txt', '1\n');
      await git(w.workDir, 'add', '-A');
      await git(w.workDir, 'commit', '-q', '-m', '에이전트 2');
      await step('둘 풀기', () => make().uncommitTo(a.sha));
      await step('형식 오류', () => make().uncommitTo('not-a-sha'));
      await step('없는 sha', () => make().uncommitTo('1'.repeat(40)));
      await step('짧은 sha', () => make().uncommitTo(a.sha.slice(0, 10)));
    });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: 2 });
    expect(failureOf(out.steps[2])).toBe('체크포인트 ID 형식이 올바르지 않습니다');
    expect(failureOf(out.steps[3])).toBe('체크포인트를 찾을 수 없습니다');
  });

  it('recordPullRequest', async () => {
    const out = await compare(async ({ make, step }) => {
      await step('기록', () => make().recordPullRequest('https://example.com/pr/9'));
      await step('읽기', () => make().repository());
    });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: { pullRequestUrl: 'https://example.com/pr/9' } });
  });
});

describe('신뢰 확인: assertTrustedGit·#assertSafeLocalGit', () => {
  it('통과와 어긋남(브랜치·HEAD·origin)', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const ok = await remembered(w);
      await step('통과', () => make().assertTrustedGit(ok));
      const { originUrl: _omitted, ...withoutOrigin } = ok;
      await step('origin 기억 없음', () => make().assertTrustedGit(withoutOrigin));
      await step('기억한 HEAD가 다름', () => make().assertTrustedGit({ ...ok, lastCheckpoint: 'f'.repeat(40) }));
      await step('기억한 브랜치가 다름', () => make().assertTrustedGit({ ...ok, branch: 'other' }));
      await git(w.workDir, 'remote', 'set-url', 'origin', path.join(w.base, 'evil.git'));
      await step('origin 바뀜', () => make().assertTrustedGit(ok));
      await git(w.workDir, 'remote', 'remove', 'origin');
      await step('origin 없음', () => make().assertTrustedGit(ok));
      await git(w.workDir, 'checkout', '-q', '--detach');
      await step('분리된 HEAD + origin 없음', () => make().assertTrustedGit(ok));
      await git(w.workDir, 'checkout', '-q', '-b', 'other');
      await step('다른 브랜치', () => make().assertTrustedGit(ok));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
    expect(failureOf(out.steps[4])).toContain('remote.origin.url이 기억한 주소와 다릅니다');
    expect(failureOf(out.steps[6])).toContain('지금 HEAD가 브랜치가 아니라 커밋을 가리킵니다');
  });

  const dangerous: Array<[string, string]> = [
    ['url.file:///evil/.insteadOf', 'https://evil/'],
    ['url.file:///evil/.pushInsteadOf', 'https://evil/'],
    ['credential.helper', '!echo x'],
    ['core.sshCommand', '/bin/false'],
    ['core.gitProxy', '/bin/false'],
    ['core.askPass', '/bin/false'],
    ['http.extraHeader', 'Authorization: x'],
    ['http.proxy', 'http://127.0.0.1:9'],
    ['remote.origin.pushurl', '/evil.git'],
    ['remote.origin.uploadpack', '/bin/false'],
    ['protocol.ext.allow', 'always'],
    ['filter.evil.clean', 'cat'],
    ['gpg.program', '/bin/false'],
    ['commit.gpgSign', 'true'],
    ['diff.external', '/bin/false'],
    ['diff.evil.textconv', 'cat'],
    ['merge.evil.driver', 'cat'],
    ['includeIf.gitdir:/.path', '%ROOT%/missing-include-config'],
    // /tmp를 쓰면 Linux에서는 시험 임시 폴더(다른 world)까지 git status에 잡혀 결과가 순서에 따라 달라진다 — world 안의 빈 폴더를 쓴다
    ['core.worktree', '%ROOT%/elsewhere'],
  ];

  it.each(dangerous)('위험한 설정 %s', async (key, value) => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const ok = await remembered(w);
      await mkdir(path.join(w.base, 'elsewhere'), { recursive: true });
      await git(w.workDir, 'config', key, value.replace('%ROOT%', w.base));
      await step('assertTrustedGit', () => make().assertTrustedGit(ok));
    });
    expect(failureOf(out.steps[0])).toContain('저장소 설정에');
  });

  it('짝 없는 서로게이트가 든 기억한 브랜치는 U+FFFD가 든 실제 브랜치와 같다고 보지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const real = 'b-studio/\ufffd-x';
      await git(w.workDir, 'checkout', '-q', '-b', real);
      const ok = await remembered(w);
      await step('같은 브랜치', () => make().assertTrustedGit(ok));
      await step('짝 없는 서로게이트', () => make().assertTrustedGit({ ...ok, branch: 'b-studio/\ud800-x' }));
      await step('짝 없는 서로게이트(push)', () => make().push({ ...ok, branch: 'b-studio/\ud800-x' }));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
    expect(failureOf(out.steps[1])).toContain('기억한 세션 브랜치');
  });

  it('commit.gpgsign=false는 막지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      await git(w.workDir, 'config', 'commit.gpgsign', 'false');
      await step('통과', async () => make().assertTrustedGit(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
  });

  it('include.path로 숨긴 값과 config.worktree', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const ok = await remembered(w);
      const included = path.join(w.base, 'included.gitconfig');
      await writeFile(included, `[url "${w.base}/evil.git"]\n\tpushInsteadOf = ${ok.originUrl}\n`);
      await git(w.workDir, 'config', 'include.path', included);
      await step('include', () => make().assertTrustedGit(ok));
      await git(w.workDir, 'config', '--unset', 'include.path');
      await step('정리 뒤 통과', () => make().assertTrustedGit(ok));
      await git(w.workDir, 'config', 'extensions.worktreeConfig', 'true');
      await git(w.workDir, 'config', '--worktree', 'credential.helper', '!echo x');
      await step('config.worktree', () => make().assertTrustedGit(ok));
    });
    expect(failureOf(out.steps[0])).toContain('include.path');
    expect(out.steps[1]!.result).toMatchObject({ ok: true });
    expect(failureOf(out.steps[2])).toContain('(config.worktree)');
  });

  it('설정을 읽지 못하면(git 실패) 통과가 아니라 오류이고, 원격 명령도 부르지 않는다', async () => {
    const out = await compare(async ({ w, make, spyWith, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const ok = await remembered(w);
      const spy = await spyWith('fail-config.sh', 'case "$*" in *"config --list"*) echo "fatal: bad config" >&2; exit 1;; esac\n');
      await step('assertTrustedGit', () => make({}, spy).assertTrustedGit(ok));
      await step('baseStatus(force)', () => make({}, spy).baseStatus(ok, { force: true }));
      await step('pullRequestTarget', () => make({}, spy).pullRequestTarget(ok));
    });
    for (const index of [0, 1, 2]) {
      expect(failureOf(out.steps[index])).toContain('git config 실패');
      expect(callsOf(out.steps[index])).not.toMatch(NETWORK);
    }
  });

  it('설정 출력의 형식을 알아보지 못하면 오류다', async () => {
    const out = await compare(async ({ w, make, spyWith, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const spy = await spyWith('garbage-config.sh', `case "$*" in *"config --list"*) printf 'a\\0b\\0'; exit 0;; esac\n`);
      await step('assertTrustedGit', async () => make({}, spy).assertTrustedGit(await remembered(w)));
    });
    expect(failureOf(out.steps[0])).toBe('저장소 설정을 읽었지만 형식을 알아보지 못해 확인하지 못했습니다');
  });

  it('gitDir 방식은 core.worktree를 위험하게 보지 않는다', async () => {
    const out = await compare(async ({ w, Store, step }) => {
      const folder = path.join(w.base, 'mine');
      const gitDir = path.join(w.base, 'mine-git');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'a.txt'), 'a\n');
      const store = new Store(folder, { gitBin: w.spy, gitDir });
      await store.init();
      const head = await git(folder, '--git-dir', gitDir, 'rev-parse', 'HEAD');
      await step('worktree 설정 있음', async () => {
        await execFileAsync('git', ['--git-dir', gitDir, 'config', 'core.worktree', folder]);
        return store.assertTrustedGit({ branch: 'main', lastCheckpoint: head });
      });
      await step('다른 위험한 값', async () => {
        await execFileAsync('git', ['--git-dir', gitDir, 'config', 'credential.helper', '!x']);
        return store.assertTrustedGit({ branch: 'main', lastCheckpoint: head });
      });
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
    expect(failureOf(out.steps[1])).toContain('credential.helper');
  });

  it('commit이 부르는 안전 확인: info/attributes·위험한 설정·읽지 못함', async () => {
    const out = await compare(async ({ w, make, spyWith, step }) => {
      await writeProject(w, orderFile(w), 'class Order { String a; }\n');
      const attributes = path.join(w.workDir, '.git/info/attributes');
      await mkdir(path.dirname(attributes), { recursive: true });
      await writeFile(attributes, '# 주석\n*.java export-ignore\n');
      await step('attributes', () => make().commit('요청: A'));
      await writeFile(attributes, '# 주석만\n');
      await step('주석만', () => make().commit('요청: A'));
      await git(w.workDir, 'config', 'filter.evil.clean', 'cat');
      await writeProject(w, orderFile(w), 'class Order { String b; }\n');
      await step('필터 설정', () => make().commit('요청: B'));
      await git(w.workDir, 'config', '--unset', 'filter.evil.clean');
      await rm(attributes);
      await mkdir(attributes);
      await step('attributes가 폴더', () => make().commit('요청: B'));
      await rm(attributes, { recursive: true });
      const spy = await spyWith('fail-config.sh', 'case "$*" in *"config --list"*) exit 1;; esac\n');
      await step('설정을 읽지 못함', () => make({}, spy).commit('요청: B'));
    });
    expect(failureOf(out.steps[0])).toContain('.git/info/attributes에 속성이 있습니다');
    expect(failureOf(out.steps[2])).toContain('filter.evil.clean');
    expect(failureOf(out.steps[3])).toContain('.git/info/attributes를 읽지 못해 확인하지 못했습니다');
  });
});

describe('올리기: push', () => {
  const setupCommits = async (w: World) => {
    const a = await commitOrder(w, 'a', '요청: A');
    return a;
  };

  it('처음 올리기와 이어 올리기', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommits(w);
      await step('처음', async () => make().push(await remembered(w)));
      await commitOrder(w, 'b', '요청: B');
      await step('이어서', async () => make().push(await remembered(w)));
      await step('같은 것 다시', async () => make().push(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { commits: 1, forced: false } });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: { commits: 2, forced: false } });
    // 원격 명령(push) 앞에서 저장소 설정을 읽었다
    const calls = out.steps[0]!.calls;
    expect(calls.findIndex((call) => call.includes('config --list'))).toBeLessThan(calls.findIndex((call) => call.includes(' push ')));
  });

  it('올릴 체크포인트가 없거나 저장하지 않은 변경이 있으면 원격에 닿지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('체크포인트 없음', async () => make().push(await remembered(w)));
      await writeProject(w, orderFile(w), 'class Order { String pending; }\n');
      await step('저장하지 않은 변경', async () => make().push(await remembered(w)));
    });
    expect(failureOf(out.steps[0])).toContain('올릴 체크포인트가 없습니다');
    expect(failureOf(out.steps[1])).toBe('체크포인트로 저장하지 않은 변경이 있어 올릴 수 없습니다');
    expect(callsOf(out.steps[1])).not.toMatch(NETWORK);
  });

  it('원격이 다른 사람이 올린 커밋으로 앞서 있으면 덮어쓰지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommits(w);
      await step('처음', async () => make().push(await remembered(w)));
      await reviewerCommit(w, 'NOTE.md', 'review\n', 'review note');
      await commitOrder(w, 'b', '요청: B');
      await step('덮어쓰기 거절', async () => make().push(await remembered(w)));
    });
    expect(failureOf(out.steps[1])).toContain('덮어쓰지 않았습니다');
  });

  it('되돌린 뒤 올리면 강제로 표시한다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const a = await setupCommits(w);
      await commitOrder(w, 'b', '요청: B');
      await step('A·B', async () => make().push(await remembered(w)));
      await w.setup.restore(a.sha);
      await commitOrder(w, 'c', '요청: C');
      await step('되돌린 뒤', async () => make().push(await remembered(w)));
    });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: { forced: true } });
  });

  it('원격이 거절하면 그 글을 오류에 담되 자격 증명은 가린다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommits(w);
      const hook = path.join(w.remote, 'hooks/pre-receive');
      await writeFile(hook, '#!/bin/sh\necho "remote: 거절 https://user:topsecret@example.com/x.git" >&2\nexit 1\n');
      await chmod(hook, 0o755);
      await step('거절', async () => make().push(await remembered(w)));
    });
    const message = failureOf(out.steps[0])!;
    expect(message).toContain('git push 실패');
    expect(message).not.toContain('topsecret');
  });

  it('기억과 다르면(origin·HEAD·설정) 원격에 닿기 전에 멈춘다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommits(w);
      const ok = await remembered(w);
      await git(w.workDir, 'config', 'url.file:///evil/.insteadOf', 'https://evil/');
      await step('insteadOf', () => make().push(ok));
      await git(w.workDir, 'config', '--unset', 'url.file:///evil/.insteadOf');
      await git(w.workDir, 'remote', 'set-url', 'origin', path.join(w.base, 'evil.git'));
      await step('origin 바뀜', () => make().push(ok));
    });
    for (const index of [0, 1]) expect(callsOf(out.steps[index])).not.toMatch(NETWORK);
  });

  it('config의 b-studio.branch를 바꿔도 기억한 브랜치로만 올린다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommits(w);
      const ok = await remembered(w);
      await git(w.workDir, 'config', 'b-studio.branch', 'main');
      await step('push', () => make().push(ok));
    });
    expect(out.state.remoteRefs).toContain(`refs/heads/${BRANCH}`);
  });

  it('모노레포 하위 폴더 세션', async () => {
    await compare(
      async ({ w, make, step }) => {
        await setupCommits(w);
        await step('push', async () => make().push(await remembered(w)));
      },
      { subdir: true },
    );
  });
});

describe('가져오기: integrateRemote·acceptRemote', () => {
  it('원격에 브랜치가 없거나 이미 들어 있으면 가져올 것이 없다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('원격에 브랜치 없음', async () => make().integrateRemote(await remembered(w)));
      await setupCommitsAndPush(w);
      await step('이미 들어 있음', async () => make().integrateRemote(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { status: 'up-to-date' } });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: { status: 'up-to-date' } });
  });

  async function setupCommitsAndPush(w: World) {
    const a = await commitOrder(w, 'a', '요청: A');
    await w.setup.push(await remembered(w));
    return a;
  }

  it('리뷰어 커밋을 병합 커밋으로 가져오고 받아들인 뒤 올린다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommitsAndPush(w);
      await reviewerCommit(w, 'NOTE.md', 'review\n', 'review note');
      await commitOrder(w, 'b', '요청: B');
      let result: Awaited<ReturnType<AnyStore['integrateRemote']>> | undefined;
      await step('integrateRemote', async () => (result = await make().integrateRemote(await remembered(w))));
      await step('acceptRemote', async () => make().acceptRemote(result!));
      await step('push', async () => make().push(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { status: 'merged', files: ['NOTE.md'] } });
    expect(out.steps[2]!.result).toMatchObject({ ok: true, value: { commits: 3, forced: false } });
    // 원격 명령 앞에서 설정을 읽는다(ls-remote와 fetch 둘 다)
    const calls = out.steps[0]!.calls;
    const configs = calls.map((call, index) => (call.includes('config --list') ? index : -1)).filter((index) => index >= 0);
    const ls = calls.findIndex((call) => call.includes('ls-remote'));
    const fetch = calls.findIndex((call) => call.includes(' fetch '));
    expect(configs.some((index) => index < ls)).toBe(true);
    expect(configs.some((index) => index > ls && index < fetch)).toBe(true);
  });

  it('올린 뒤 되돌린 기록은 원격에만 있는 변경을 옮겨 오고, 되돌리면 받아들이지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const a = await commitOrder(w, 'a', '요청: A');
      await commitOrder(w, 'b', '요청: B');
      await w.setup.push(await remembered(w));
      await w.setup.restore(a.sha);
      await reviewerCommit(w, 'NOTE.md', 'review\n', 'review note');
      let result: Awaited<ReturnType<AnyStore['integrateRemote']>> | undefined;
      await step('picked', async () => (result = await make().integrateRemote(await remembered(w))));
      await w.setup.restore(a.sha);
      await step('되돌린 뒤 accept', async () => make().acceptRemote(result!));
      await step('덮어쓰지 않는 push', async () => make().push(await remembered(w)));
      let again: Awaited<ReturnType<AnyStore['integrateRemote']>> | undefined;
      await step('다시 가져오기', async () => (again = await make().integrateRemote(await remembered(w))));
      await step('accept', async () => make().acceptRemote(again!));
      await step('강제 표시 push', async () => make().push(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { status: 'picked' } });
    expect(failureOf(out.steps[1])).toContain('원격 상태로 기록하지 않았습니다');
    expect(out.steps[5]!.result).toMatchObject({ ok: true, value: { forced: true } });
  });

  it('같은 곳을 고쳤으면 충돌한 파일을 알리고 그대로 둔다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommitsAndPush(w);
      await reviewerCommit(w, ORDER, 'class Order { String reviewer; }\n', 'reviewer edit');
      await commitOrder(w, 'mine', '요청: 내 변경');
      await step('충돌', async () => make().integrateRemote(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: false, error: { name: 'RemoteConflictError', extra: { conflicts: [ORDER] } } });
    expect(out.state.mergeHead).toContain('오류');
  });

  it('원격 커밋 가운데 병합 커밋이 있으면 옮겨 오지 못한다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const a = await commitOrder(w, 'a', '요청: A');
      await commitOrder(w, 'b', '요청: B');
      await w.setup.push(await remembered(w));
      const reviewer = await mkdtemp(path.join(w.base, 'reviewer-'));
      await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, w.remote, reviewer]);
      await git(reviewer, 'checkout', '-q', '-b', 'topic');
      await writeFile(path.join(reviewer, 'T.md'), 't\n');
      await git(reviewer, 'add', '-A');
      await git(reviewer, 'commit', '-q', '-m', 'topic');
      await git(reviewer, 'checkout', '-q', BRANCH);
      await writeFile(path.join(reviewer, 'M.md'), 'm\n');
      await git(reviewer, 'add', '-A');
      await git(reviewer, 'commit', '-q', '-m', 'main side');
      await git(reviewer, 'merge', '--no-ff', '-q', '-m', 'merge topic', 'topic');
      await git(reviewer, 'push', '-q', 'origin', 'HEAD');
      await w.setup.restore(a.sha);
      await step('병합 커밋', async () => make().integrateRemote(await remembered(w)));
    });
    expect(failureOf(out.steps[0])).toContain('병합 커밋이 있어 옮겨 오지 못했습니다');
  });

  it('원격 브랜치가 시작 커밋을 포함하지 않으면 가져오지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await commitOrder(w, 'a', '요청: A');
      const orphan = await mkdtemp(path.join(w.base, 'orphan-'));
      await execFileAsync('git', ['init', '-q', '-b', BRANCH, orphan]);
      await writeFile(path.join(orphan, 'x.md'), 'x\n');
      await git(orphan, 'add', '-A');
      await git(orphan, 'commit', '-q', '-m', 'unrelated');
      await git(orphan, 'push', '-q', w.remote, `${BRANCH}:${BRANCH}`);
      await step('시작 커밋 없음', async () => make().integrateRemote(await remembered(w)));
    });
    expect(failureOf(out.steps[0])).toContain('시작 커밋을 포함하지 않아 가져오지 않았습니다');
  });

  it('원격 기록이 다시 쓰였으면 갈라진 곳에서부터 센다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommitsAndPush(w);
      const rewrite = await mkdtemp(path.join(w.base, 'rewrite-'));
      await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, w.remote, rewrite]);
      await git(rewrite, 'reset', '-q', '--hard', 'HEAD~1');
      await writeFile(path.join(rewrite, 'R.md'), 'r\n');
      await git(rewrite, 'add', '-A');
      await git(rewrite, 'commit', '-q', '-m', 'rewritten');
      await git(rewrite, 'push', '-q', '--force', 'origin', 'HEAD');
      await commitOrder(w, 'b', '요청: B');
      await step('다시 쓰임', async () => make().integrateRemote(await remembered(w)));
    });
    expect(out.steps[0]!.result.ok).toBeDefined();
  });

  it('가져온 체크포인트는 생성 파일(제외됨) 스냅샷을 병합 전 것으로 물려받는다', async () => {
    const out = await compare(async ({ w, Store, step }) => {
      await mkdir(path.join(w.workDir, '.git/info'), { recursive: true });
      await writeFile(path.join(w.workDir, '.git/info/exclude'), 'studio.yaml\n', { flag: 'a' });
      const provider = async () => ['studio.yaml'];
      const setup = new CheckpointStore(w.workDir, { excludedFiles: provider });
      await writeFile(path.join(w.workDir, 'studio.yaml'), 'name: orders\n');
      await writeProject(w, orderFile(w), 'class Order { String a; }\n');
      await setup.commit('요청: A');
      await setup.push(await remembered(w));
      await reviewerCommit(w, 'NOTE.md', 'review\n', 'review note');
      await writeFile(path.join(w.workDir, 'studio.yaml'), 'name: changed-after-commit\n');
      const store = new Store(w.workDir, { gitBin: w.spy, excludedFiles: provider });
      await step('integrateRemote', async () => store.integrateRemote(await remembered(w)));
      const dir = path.join(w.workDir, '.git/b-studio/excluded');
      await step('스냅샷', async () => {
        const out: Record<string, string> = {};
        for (const id of (await readdir(dir)).sort()) out[id] = await readFile(path.join(dir, id, 'files/studio.yaml'), 'utf8').catch(() => '없음');
        return out;
      });
    });
    const snapshots = (out.steps[1]!.result as { value: Record<string, string> }).value;
    // 가져온 체크포인트의 스냅샷은 지금 디스크가 아니라 병합 전 내용이다
    expect(Object.values(snapshots)).not.toContain('name: changed-after-commit\n');
    expect(Object.keys(snapshots).length).toBeGreaterThanOrEqual(2);
  });

  it('저장하지 않은 변경이 있거나 기억과 다르면 멈춘다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await setupCommitsAndPush(w);
      await reviewerCommit(w, 'NOTE.md', 'review\n', 'review note');
      const ok = await remembered(w);
      await writeProject(w, orderFile(w), 'class Order { String pending; }\n');
      await step('저장하지 않은 변경', () => make().integrateRemote(ok));
      await git(w.workDir, 'checkout', '-q', '--', '.');
      await git(w.workDir, 'checkout', '-q', '--detach');
      await step('분리된 HEAD', () => make().integrateRemote(ok));
    });
    expect(failureOf(out.steps[0])).toContain('저장하지 않은 변경이 있어 원격 변경을 가져올 수 없습니다');
    expect(failureOf(out.steps[1])).toContain('브랜치');
    expect(callsOf(out.steps[1])).not.toMatch(NETWORK);
  });

  it('acceptRemote: 가져온 것이 없으면 아무것도 하지 않는다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('빈 결과', async () => make().acceptRemote({ status: 'up-to-date', commits: [], files: [], previous: await git(w.workDir, 'rev-parse', 'HEAD') }));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
    expect(out.steps[0]!.calls).toEqual([]);
  });

  it('모노레포 하위 폴더 세션', async () => {
    await compare(
      async ({ w, make, step }) => {
        await setupCommitsAndPush(w);
        await reviewerCommit(w, 'NOTE.md', 'review\n', 'outside note');
        await reviewerCommit(w, 'api/NOTE2.md', 'review\n', 'inside note');
        await step('integrateRemote', async () => make().integrateRemote(await remembered(w)));
      },
      { subdir: true },
    );
  });
});

describe('기준 브랜치: baseStatus·integrateBase', () => {
  it('가져오고(throttle) 강제로 다시 가져온다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const store = make();
      await step('처음', async () => store.baseStatus(await remembered(w)));
      await baseCommit(w, 'CHANGELOG.md', '# changes\n', 'main 변경');
      await step('throttle', async () => store.baseStatus(await remembered(w)));
      await step('강제', async () => store.baseStatus(await remembered(w), { force: true }));
      await commitOrder(w, 'mine', '요청: 내 변경');
      await step('앞섬과 뒤처짐', async () => make().baseStatus(await remembered(w), { force: true }));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { base: 'main', behind: 0 } });
    expect(out.steps[1]!.calls.some((call) => NETWORK.test(call))).toBe(false);
    expect(out.steps[2]!.result).toMatchObject({ ok: true, value: { behind: 1 } });
    expect(out.steps[3]!.result).toMatchObject({ ok: true, value: { behind: 1, aheadCommits: 1 } });
  });

  it('원격에서 기준 브랜치가 사라지면 가져오기가 실패한다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await execFileAsync('git', ['-C', w.remote, 'update-ref', '-d', 'refs/heads/main']);
      await step('baseStatus', async () => make().baseStatus(await remembered(w), { force: true }));
      await step('integrateBase', async () => make().integrateBase(await remembered(w)));
    });
    expect(failureOf(out.steps[0])).toContain('git fetch 실패');
  });

  it('원격 주소를 바꾸면 가져오기 전에 멈춘다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const ok = await remembered(w);
      await git(w.workDir, 'remote', 'set-url', 'origin', path.join(w.base, 'evil.git'));
      await step('baseStatus', () => make().baseStatus(ok, { force: true }));
      await step('integrateBase', () => make().integrateBase(ok));
    });
    for (const index of [0, 1]) {
      expect(failureOf(out.steps[index])).toContain('remote.origin.url');
      expect(callsOf(out.steps[index])).not.toMatch(NETWORK);
    }
  });

  it('원본이 아닌 세션이면 오류', async () => {
    await compare(async ({ w, Store, step }) => {
      const plain = path.join(w.base, 'plain');
      await mkdir(plain, { recursive: true });
      await writeFile(path.join(plain, 'a.txt'), 'a\n');
      const store = new Store(plain, { gitBin: w.spy });
      await store.init();
      const ok = { branch: 'main', lastCheckpoint: 'a'.repeat(40) };
      await step('baseStatus', () => store.baseStatus(ok));
      await step('integrateBase', () => store.integrateBase(ok));
    });
  });

  it('integrateBase: 따라잡을 것이 없음·병합·충돌·저장하지 않은 변경', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('없음', async () => make().integrateBase(await remembered(w)));
      await commitOrder(w, 'mine', '요청: 내 변경');
      await baseCommit(w, 'CHANGELOG.md', '# changes\n', 'main 변경');
      await step('병합', async () => make().integrateBase(await remembered(w)));
      await commitOrder(w, 'mine2', '요청: 내 변경 2');
      await baseCommit(w, ORDER, 'class Order { String main; }\n', 'main이 같은 곳을 고침');
      await step('충돌', async () => make().integrateBase(await remembered(w)));
      await writeProject(w, orderFile(w), 'class Order { String pending; }\n');
      await step('저장하지 않은 변경', async () => make().integrateBase(await remembered(w)));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { status: 'up-to-date' } });
    expect(out.steps[1]!.result).toMatchObject({ ok: true, value: { status: 'merged' } });
    expect(out.steps[2]!.result).toMatchObject({ ok: false, error: { name: 'RemoteConflictError', extra: { conflicts: [ORDER] } } });
    expect(failureOf(out.steps[3])).toContain('기준 브랜치를 따라잡을 수 없습니다');
  });

  it('integrateBase: 모노레포 하위 폴더', async () => {
    await compare(
      async ({ w, make, step }) => {
        await commitOrder(w, 'mine', '요청: 내 변경');
        await baseCommit(w, 'ROOT.md', 'root\n', 'main 루트 변경');
        await baseCommit(w, 'api/INNER.md', 'inner\n', 'main 하위 변경');
        await step('병합', async () => make().integrateBase(await remembered(w)));
      },
      { subdir: true },
    );
  });
});

describe('PR 대상: pullRequestTarget', () => {
  it('기준 브랜치가 원격에 있다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      await step('대상', async () => make().pullRequestTarget(await remembered(w)));
      await step('메타', () => make().repository());
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { base: 'main' } });
  });

  it('기준 브랜치가 원격에 없으면 기본 브랜치와 원래 이름', async () => {
    const out = await compare(async ({ w, Store, step }) => {
      await git(w.source, 'checkout', '-q', '-b', 'feat/local-only');
      await writeFile(path.join(w.source, 'NOTE.md'), 'local\n');
      await git(w.source, 'add', '-A');
      await git(w.source, 'commit', '-q', '-m', 'local only');
      const workDir = path.join(w.base, 'sessions', 'local-only');
      const { store: setup } = await CheckpointStore.clone(w.source, workDir, { branch: 'b-studio/local' });
      const store = new Store(workDir, { gitBin: w.spy });
      const head = await setup.headState();
      const ok = { branch: head.branch!, lastCheckpoint: head.head, originUrl: (await setup.remoteUrl())! };
      await step('대상', () => store.pullRequestTarget(ok));
      await step('메타', () => store.repository());
      await execFileAsync('git', ['-C', w.remote, 'update-ref', '-d', 'refs/heads/main']);
      await step('기본 브랜치도 없음', () => store.pullRequestTarget(ok));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { base: 'main', missingBase: 'feat/local-only' } });
    expect(out.steps[2]!.result).toMatchObject({ ok: true, value: { base: 'feat/local-only', missingBase: 'feat/local-only' } });
  });

  it('원격에 닿지 못하거나 기억과 다르면 던진다', async () => {
    const out = await compare(async ({ w, make, step }) => {
      const ok = await remembered(w);
      await git(w.workDir, 'config', 'credential.helper', '!echo x');
      await step('위험한 설정', () => make().pullRequestTarget(ok));
      await git(w.workDir, 'config', '--unset', 'credential.helper');
      await rm(w.remote, { recursive: true, force: true });
      await step('원격 없음', () => make().pullRequestTarget(ok));
    });
    expect(callsOf(out.steps[0])).not.toMatch(NETWORK);
    expect(failureOf(out.steps[1])).toContain('git ls-remote 실패');
  });
});

describe('터미널이 어긋낸 기록 되돌리기: restoreRememberedHead', () => {
  /** 세션에서 체크포인트 둘과 바깥에서 얹은 상태를 만든다 */
  async function dirty(w: World) {
    const a = await commitOrder(w, 'a', '요청: A');
    await writeProject(w, 'keep.txt', 'tracked\n');
    const b = (await w.setup.commit('요청: B'))!;
    return { a, b };
  }

  const tree = async (w: World) => ({
    order: await readFile(path.join(w.workDir, w.subdir, orderFile(w)), 'utf8').catch(() => '없음'),
    files: (await gitOr(w.workDir, 'ls-files')).split('\n'),
    untracked: (await gitOr(w.workDir, 'ls-files', '--others')).split('\n'),
    ignored: (await gitOr(w.workDir, 'ls-files', '--others', '--ignored', '--exclude-standard')).split('\n'),
  });

  const backups = async (w: World) => {
    const dir = path.join(w.workDir, '.git/b-studio/discarded');
    const ids = await readdir(dir).catch(() => [] as string[]);
    return Promise.all(ids.sort().map(async (id) => ({ files: (await readdir(path.join(dir, id))).sort(), patch: await readFile(path.join(dir, id, 'changes.patch'), 'utf8').catch(() => undefined) })));
  };

  it('다른 브랜치로 옮겨 커밋하고 파일을 고친 경우', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      const { b } = await dirty(w);
      const ok = await remembered(w);
      await git(w.workDir, 'checkout', '-q', '-b', 'agent-branch');
      await writeProject(w, orderFile(w), 'class Order { String hacked; }\n');
      await writeProject(w, 'new/dir/file.txt', 'new\n');
      await git(w.workDir, 'add', '-A');
      await git(w.workDir, 'commit', '-q', '-m', '에이전트 커밋');
      await writeProject(w, 'keep.txt', 'dirty tracked\n');
      await writeProject(w, 'untracked.txt', 'untracked\n');
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('결과', async () => ({ tree: await tree(w), backups: await backups(w), at: b.sha }));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true });
    const value = (out.steps[0]!.result as { value: { files: string[]; backup?: unknown } }).value;
    expect(value.files).toContain('keep.txt');
    expect(value.backup).toBeDefined();
    expect(out.state.branch).toBe(BRANCH);
  });

  it('분리된 HEAD와 지워진 브랜치', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      await git(w.workDir, 'checkout', '-q', '--detach');
      await git(w.workDir, 'branch', '-q', '-D', BRANCH);
      await writeProject(w, 'stray.txt', 'stray\n');
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('결과', async () => ({ tree: await tree(w) }));
    });
    expect(out.state.branch).toBe(BRANCH);
  });

  it('기록을 되감은 경우', async () => {
    await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      await git(w.workDir, 'reset', '-q', '--hard', 'HEAD~1');
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('결과', async () => ({ tree: await tree(w), backups: await backups(w) }));
    });
  });

  it('바뀐 것이 없으면 백업을 만들지 않는다', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      await step('되돌리기', async () => make().restoreRememberedHead(await remembered(w)));
      await step('결과', async () => ({ backups: await backups(w) }));
    });
    expect(out.steps[0]!.result).toMatchObject({ ok: true, value: { files: [] } });
  });

  it('링크와 무시된 파일: 링크 너머의 폴더는 지워지지 않는다', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      const outside = path.join(w.base, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'precious.txt'), 'keep me\n');
      const link = path.join(w.workDir, w.subdir, 'link-to-outside');
      await symlink(path.relative(path.dirname(link), outside), link);
      await writeProject(w, 'node_modules/pkg/index.js', 'ignored\n');
      await writeProject(w, 'tmp/new.txt', 'untracked\n');
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('결과', async () => ({ tree: await tree(w), outside: await readdir(outside) }));
    });
    const result = (out.steps[1]!.result as { value: { outside: string[]; tree: { ignored: string[] } } }).value;
    expect(result.outside).toEqual(['precious.txt']);
    expect(result.tree.ignored.join('\n')).toContain('node_modules');
  });

  it('모노레포 하위 폴더: 정리는 프로젝트 폴더만, 폴더 밖 추적되지 않은 파일은 남는다', async () => {
    const out = await compareRestore(
      async ({ w, make, step }) => {
        await commitOrder(w, 'a', '요청: A');
        const ok = await remembered(w);
        await git(w.workDir, 'checkout', '-q', '-b', 'agent-branch');
        await writeProject(w, 'inside.txt', 'inside\n');
        await writeFile(path.join(w.workDir, 'outside-untracked.txt'), 'outside\n');
        await step('되돌리기', () => make().restoreRememberedHead(ok));
        await step('결과', async () => ({ tree: await tree(w), outside: await readFile(path.join(w.workDir, 'outside-untracked.txt'), 'utf8').catch(() => '없음') }));
      },
      { subdir: true },
    );
    expect((out.steps[1]!.result as { value: { outside: string } }).value.outside).toBe('outside\n');
  });

  it('생성 파일(제외됨)도 같이 되돌리고 백업에 담는다', async () => {
    const out = await compareRestore(async ({ w, Store, step }) => {
      await mkdir(path.join(w.workDir, '.git/info'), { recursive: true });
      await writeFile(path.join(w.workDir, '.git/info/exclude'), 'studio.yaml\n', { flag: 'a' });
      const provider = async () => ['studio.yaml'];
      const setup = new CheckpointStore(w.workDir, { excludedFiles: provider });
      await writeFile(path.join(w.workDir, 'studio.yaml'), 'name: orders\n');
      await writeProject(w, orderFile(w), 'class Order { String a; }\n');
      await setup.commit('요청: A');
      const ok = await remembered(w);
      await writeFile(path.join(w.workDir, 'studio.yaml'), 'name: hacked\n');
      await git(w.workDir, 'checkout', '-q', '-b', 'agent-branch');
      const store = new Store(w.workDir, { gitBin: w.spy, excludedFiles: provider });
      await step('되돌리기', () => store.restoreRememberedHead(ok));
      await step('결과', async () => ({ studio: await readFile(path.join(w.workDir, 'studio.yaml'), 'utf8'), backups: await backups(w) }));
    });
    expect((out.steps[1]!.result as { value: { studio: string } }).value.studio).toBe('name: orders\n');
  });

  it('체크포인트 ID가 올바르지 않거나 없으면 아무것도 건드리지 않는다', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      await writeProject(w, 'stray.txt', 'stray\n');
      await step('형식 오류', () => make().restoreRememberedHead({ ...ok, lastCheckpoint: 'zzzzzzz' }));
      await step('없는 sha', () => make().restoreRememberedHead({ ...ok, lastCheckpoint: '1'.repeat(40) }));
      await step('결과', async () => ({ tree: await tree(w) }));
    });
    expect(out.steps[0]!.calls.some((call) => call.includes('reset'))).toBe(false);
    expect(out.steps[2]!.result).toMatchObject({ ok: true, value: { tree: { untracked: ['stray.txt'] } } });
  });

  it('보여 주는 패치는 길이 상한에서 자른다(백업에는 전체가 남는다)', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      await writeProject(w, 'big.txt', `${'가나다라마바사\n'.repeat(40_000)}`);
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('백업', async () => ({ bytes: (await backups(w))[0]?.patch?.length }));
    });
    const patch = (out.steps[0]!.result as { value: { patch: string } }).value.patch;
    expect(patch).toContain('길어서');
    expect(patch.length).toBeLessThan(200_100);
  });

  it('백업을 쓰지 못하면 되돌리지 않는다(백업이 먼저)', async () => {
    const out = await compareRestore(async ({ w, make, step }) => {
      await dirty(w);
      const ok = await remembered(w);
      await git(w.workDir, 'checkout', '-q', '-b', 'agent-branch');
      await writeProject(w, orderFile(w), 'class Order { String hacked; }\n');
      await writeProject(w, 'untracked.txt', 'untracked\n');
      // 백업 폴더를 만들 수 없게 파일을 둔다
      await writeFile(path.join(w.workDir, '.git/b-studio'), 'file in the way');
      await step('되돌리기', () => make().restoreRememberedHead(ok));
      await step('결과', async () => ({ tree: await tree(w) }));
    });
    expect(out.steps[0]!.result.ok).toBe(false);
    // 파일을 고친 상태가 그대로 남는다
    const calls = out.steps[0]!.calls;
    expect(calls.some((call) => call.includes('reset') || call.includes('checkout') || call.includes('clean'))).toBe(false);
    expect((out.steps[1]!.result as { value: { tree: { order: string } } }).value.tree.order).toContain('hacked');
  });
});

describe('Rust 쪽 구조', () => {
  it('원격 경로 입구가 네이티브 모듈에 있다', () => {
    expect(typeof (native as unknown as { checkpointRemote?: unknown }).checkpointRemote).toBe('function');
  });
});

describe('옛 쪽보다 더 막는 것(HARDENED)', () => {
  it('저장소 설정에 clean 필터가 있으면 터미널 기록 되돌리기도 필터를 부르지 않는다(옛 코드는 add -A가 필터를 실행했다)', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorld();
      await commitOrder(w, 'a', '요청: A');
      const ok = await remembered(w);
      const marker = path.join(w.base, 'filter-ran');
      await git(w.workDir, 'config', 'filter.evil.clean', `sh -c ": > '${marker}'; cat"`);
      await writeFile(path.join(w.workDir, '.git/info/attributes'), '');
      await writeFile(path.join(w.workDir, '.gitattributes'), '*.java filter=evil\n');
      await git(w.workDir, 'checkout', '-q', '-b', 'agent-branch');
      await writeProject(w, orderFile(w), 'class Order { String hacked; }\n');
      // 준비 단계의 git(checkout 등)도 인덱스를 새로 고치며 필터를 부를 수 있다 — 되돌리기 직전에 표시를 지운다
      await rm(marker, { force: true });
      const error = await new Store(w.workDir, { gitBin: w.spy }).restoreRememberedHead(ok).then(
        () => undefined,
        (reason: Error) => reason.message,
      );
      return { error, filterRan: await stat(marker).then(() => true, () => false), branch: await git(w.workDir, 'symbolic-ref', '--short', 'HEAD') };
    };
    const legacy = await run(LegacyCheckpointStore);
    const current = await run(CheckpointStore);
    // 옛 코드: 필터가 호스트에서 실행되고 되돌리기가 끝난다
    expect(legacy).toMatchObject({ error: undefined, filterRan: true, branch: BRANCH });
    // 지금: 실행하지 않고 멈추며 브랜치도 건드리지 않는다
    expect(current.filterRan).toBe(false);
    expect(current.error).toContain('filter.evil.clean');
    expect(current.branch).toBe('agent-branch');
  });

  it('baseFetchedAt을 읽지 못하면 오래된 것으로 보고 새로 가져온다(옛 코드는 영영 가져오지 않았다)', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorld();
      const ok = await remembered(w);
      await git(w.workDir, 'config', 'b-studio.baseFetchedAt', 'garbage');
      const store = new Store(w.workDir, { gitBin: w.spy });
      await rm(w.log, { force: true });
      const status = await store.baseStatus(ok);
      const calls = (await readFile(w.log, 'utf8').catch(() => '')).split('\n');
      return { status, fetched: calls.some((call) => call.includes(' fetch ')) };
    };
    expect((await run(LegacyCheckpointStore)).fetched).toBe(false);
    expect((await run(CheckpointStore)).fetched).toBe(true);
  });
});

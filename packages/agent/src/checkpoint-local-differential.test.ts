import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore, findNestedGitRepos } from './checkpoints';
import { legacyFindNestedGitRepos } from './checkpoint-dig-legacy';
import { LegacyCheckpointStore } from './checkpoint-store-legacy';
import { formatWorkflowTrailer } from './workflow';

/**
 * 체크포인트의 로컬 경로(읽기 전용)와 생성 파일 사이드카·백업을 Rust로 옮긴 조각(D1a)의 차등 시험.
 * 같은 시나리오를 옛 전체 구현(`checkpoint-store-legacy.ts`)과 지금 껍데기에 넣고 결과(반환값·오류 글·파일 상태·git 상태)를 견준다.
 * 커밋 시각을 고정해 두 세계의 sha가 같고, 백업 id·시각만 정규화한다.
 */
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const FIXED_DATE = '2026-01-02T03:04:05Z';
const BRANCH = 'session';
const EXCLUDED = ['studio.yaml', 'Dockerfile.b-studio', 'compose.b-studio.yaml'];

type StoreClass = typeof CheckpointStore | typeof LegacyCheckpointStore;
type Store = CheckpointStore | LegacyCheckpointStore;

let sandboxRoot: string;
let worldSeq = 0;
const saved = {
  global: process.env.GIT_CONFIG_GLOBAL,
  nosystem: process.env.GIT_CONFIG_NOSYSTEM,
  author: process.env.GIT_AUTHOR_DATE,
  committer: process.env.GIT_COMMITTER_DATE,
};

beforeEach(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), 'checkpoint-local-diff-'));
  const globalConfig = path.join(sandboxRoot, 'global.gitconfig');
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_DATE = FIXED_DATE;
  process.env.GIT_COMMITTER_DATE = FIXED_DATE;
});

afterEach(async () => {
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
    ['GIT_AUTHOR_DATE', saved.author],
    ['GIT_COMMITTER_DATE', saved.committer],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

interface World {
  base: string;
  source: string;
  workDir: string;
  store: Store;
}

async function createWorldWith(Store: StoreClass, excluded: string[]): Promise<World> {
  const base = path.join(sandboxRoot, `world-${++worldSeq}`);
  const source = path.join(base, 'orders');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await writeFile(path.join(source, 'README.md'), '# orders\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  const workDir = path.join(base, 'sessions', 'orders-s1');
  const { store } = await Store.clone(source, workDir, { branch: BRANCH, excludedFiles: async () => excluded });
  return { base, source, workDir, store };
}

async function createWorld(Store: StoreClass): Promise<World> {
  return createWorldWith(Store, EXCLUDED);
}

/** 세션 작업 복사본의 프로젝트 파일을 쓴다(프로젝트 루트는 저장소 루트와 같다) */
async function writeProject(w: World, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(w.workDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** 생성 파일을 이 저장소의 git 추적에서 뺀다(폴더 열기가 하는 일) */
async function exclude(w: World, pattern: string): Promise<void> {
  const file = path.join(w.workDir, '.git', 'info', 'exclude');
  await mkdir(path.dirname(file), { recursive: true });
  const before = await readFile(file, 'utf8').catch(() => '');
  await writeFile(file, `${before}${pattern}\n`);
}

type Step = { label: string; ok: boolean; value?: unknown; error?: { name: string; message: string } };

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const BACKUP_ID = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-z]{4}/g;

function describeError(error: unknown): { name: string; message: string } {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  return { name: error.constructor.name, message: error.message };
}

/** 스냅샷·백업 폴더의 모양(경로 → 내용 또는 null). sha 폴더 이름은 두 세계가 같다 */
async function folderTree(root: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), child);
      else {
        const content = await readFile(path.join(dir, entry.name));
        // 백업 메타에는 id·시각이 들어 있어 글자로 두고 정규화한다
        out[child] = entry.name === 'meta.json' ? content.toString('utf8') : content.toString('base64');
      }
    }
  };
  await walk(root, '');
  return out;
}

async function runScenario(Store: StoreClass): Promise<{ base: string; steps: Step[]; files: Record<string, string | null>; status: string }> {
  const w = await createWorld(Store);
  const steps: Step[] = [];
  const step = async (label: string, run: () => unknown): Promise<void> => {
    try {
      steps.push({ label, ok: true, value: await run() });
    } catch (error) {
      steps.push({ label, ok: false, error: describeError(error) });
    }
  };

  // 준비: 생성 파일 두 개를 무시 대상으로 만들고 체크포인트를 남긴다(스냅샷이 생긴다)
  await exclude(w, '/studio.yaml');
  await exclude(w, '/Dockerfile.b-studio');
  await exclude(w, '/compose.b-studio.yaml');
  await writeProject(w, 'studio.yaml', 'name: orders\n');
  await writeProject(w, 'Dockerfile.b-studio', 'FROM node:22\n');
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; }\n');
  await w.store.commit('요청: A', undefined, { trailers: [formatWorkflowTrailer(['run', 'review'])] });

  // 바이너리·실행 파일·링크·유니코드 이름·큰 파일
  await writeProject(w, 'api/src/Bin.bin', Buffer.from([0x00, 0x01, 0xff, 0x41]));
  await writeProject(w, 'bin/run.sh', '#!/bin/sh\necho hi\n');
  await chmod(path.join(w.workDir, 'bin/run.sh'), 0o755);
  await symlink('api/src/Order.java', path.join(w.workDir, 'link.java'));
  await writeProject(w, 'notes/Café.txt', 'nfc\n');
  await writeProject(w, 'notes/cafe\u0301.txt', 'nfd\n');
  await writeProject(w, 'notes/trailing.dot.', 'dot\n');
  await writeProject(w, 'notes/sp ace.txt', 'space\n');
  await writeProject(w, 'notes/long.txt', `${'x'.repeat(20_000)}\n`);
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; }\n');
  await w.store.commit('요청: B', undefined, { trailers: [formatWorkflowTrailer(['run'])] });
  await w.store.commit('요청: C', undefined, { trailers: [formatWorkflowTrailer(['run'])] });

  const store = new Store(w.workDir, { excludedFiles: async () => EXCLUDED });
  const list = await store.list();
  const shas = list.map((checkpoint) => checkpoint.sha);

  await step('list', () => store.list());
  await step('list(1)', () => store.list(1));
  for (const [index, sha] of shas.entries()) {
    await step(`patch ${index}`, () => store.patch(sha));
  }
  await step('patch redact', () => store.patch(shas[0]!, (text) => text.replace(/Order/g, '[X]')));
  await step('patch 잘못된 id', () => store.patch('deadbeef'));
  await step('fileAt 있음', () => store.fileAt('api/src/Order.java'));
  await step('fileAt 없음', () => store.fileAt('nope.txt'));
  await step('fileAt 이전 판', () => store.fileAt('api/src/Order.java', 'HEAD~1'));
  await step('blobAt 글', () => store.blobAt('api/src/Order.java', 'HEAD'));
  await step('blobAt 실행', () => store.blobAt('bin/run.sh', 'HEAD'));
  await step('blobAt 바이너리', () => store.blobAt('api/src/Bin.bin', 'HEAD'));
  await step('blobAt 링크', () => store.blobAt('link.java', 'HEAD'));
  await step('blobAt 없음', () => store.blobAt('nope.txt', 'HEAD'));
  await step('listBlobs', () => store.listBlobs('HEAD', 'api'));
  await step('listBlobs 루트', () => store.listBlobs('HEAD', '.'));
  await step('sessionDiff', () => store.sessionDiff());
  await step('diffSince', () => store.diffSince(shas.at(-1)!));
  await step('commitBefore 과거', () => store.commitBefore('2000-01-01T00:00:00.000Z'));
  await step('commitBefore 미래', () => store.commitBefore('2100-01-01T00:00:00.000Z'));

  // 사이드카: 바뀐 생성 파일·지운 생성 파일·새로 생긴 생성 파일
  await writeProject(w, 'studio.yaml', 'name: orders\nchanged: true\n');
  await rm(path.join(w.workDir, 'Dockerfile.b-studio'));
  await writeProject(w, 'compose.b-studio.yaml', 'services: {}\n');
  await step('pendingExcludedFiles', () => store.pendingExcludedFiles());
  await step('ignoredChangedSince', () => store.ignoredChangedSince('HEAD'));
  await step('discardedBackups 처음', () => store.discardedBackups());

  // 검증 지문과 다른 생성 파일이면 멈춘다(StagedMismatchError, 스냅샷은 그대로)
  await step('refreshExcludedSnapshot 불일치', () => store.refreshExcludedSnapshot('HEAD', new Map([['studio.yaml', 'blob:그런적없음']])));
  const snapshotAfterMismatch = await folderTree(path.join(w.workDir, '.git/b-studio/excluded'));

  // discard: 생성 파일을 되돌리고 백업을 남긴다
  await step('discard', () => store.discard());
  const afterDiscard = {
    studio: await readFile(path.join(w.workDir, 'studio.yaml'), 'utf8'),
    dockerfile: await readFile(path.join(w.workDir, 'Dockerfile.b-studio'), 'utf8'),
    compose: await readFile(path.join(w.workDir, 'compose.b-studio.yaml'), 'utf8').catch(() => null),
  };
  await step('discardedBackups 하나', () => store.discardedBackups());
  await step('discard 두 번째', () => store.discard());

  const snapshots = await folderTree(path.join(w.workDir, '.git/b-studio/excluded'));
  const backups = await folderTree(path.join(w.workDir, '.git/b-studio/discarded'));
  const status = await git(w.workDir, 'status', '--porcelain', '--untracked-files=all');
  return { base: w.base, steps: [{ label: 'mismatch 스냅샷', ok: true, value: snapshotAfterMismatch }, { label: 'discard 뒤 파일', ok: true, value: afterDiscard }, ...steps], files: { ...snapshots, ...backups }, status };
}

function normalize(world: { base: string; steps: Step[]; files: Record<string, string | null>; status: string }) {
  const text = JSON.stringify({ steps: world.steps, files: world.files, status: world.status })
    .split(world.base)
    .join('<W>')
    .replace(TIME, '<time>')
    .replace(BACKUP_ID, '<backup>');
  return JSON.parse(text) as { steps: Step[]; files: Record<string, string | null>; status: string };
}

describe('체크포인트 로컬 경로·사이드카 차등(D1a)', () => {
  it('읽기·스냅샷·백업·되돌리기가 옛 구현과 같은 값을 낸다', async () => {
    const legacy = normalize(await runScenario(LegacyCheckpointStore));
    const current = normalize(await runScenario(CheckpointStore));
    expect(current).toEqual(legacy);
  });
});

// ── D1c: 쓰기(commit·commitPaths·discard·restore·init)와 실패 갈래 ──────────

async function runWrites(Store: StoreClass): Promise<{ base: string; steps: Step[]; status: string; files: Record<string, string | null>; backups: Record<string, string | null>; snapshots: Record<string, string | null> }> {
  const w = await createWorld(Store);
  const steps: Step[] = [];
  const step = async (label: string, run: () => unknown): Promise<void> => {
    try {
      steps.push({ label, ok: true, value: await run() });
    } catch (error) {
      steps.push({ label, ok: false, error: describeError(error) });
    }
  };
  const store = new Store(w.workDir, { excludedFiles: async () => EXCLUDED });
  await exclude(w, '/studio.yaml');
  await exclude(w, '/Dockerfile.b-studio');
  await exclude(w, '/compose.b-studio.yaml');
  await writeProject(w, 'studio.yaml', 'name: orders\n');
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; }\n');
  await step('첫 체크포인트', () => store.commit('요청: A', undefined, { trailers: [formatWorkflowTrailer(['run'])] }));

  await step('변경 없이 commit', () => store.commit('요청: 없음'));
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; }\n');
  await step('commit 정상', () => store.commit('요청: B', '본문', { trailers: [formatWorkflowTrailer(['run'])] }));

  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; int c; }\n');
  await step('commit 빈 통과 트레일러', () => store.commit('요청: C', undefined, { trailers: [formatWorkflowTrailer([])] }));

  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; int c; int d; }\n');
  await step('commit 시크릿', () =>
    store.commit('요청: D', '키 sk_live_1234567890', { findSecrets: (text) => (text.includes('sk_live') ? ['PAYMENT_API_KEY'] : []) }),
  );

  const prints = await store.stagedFingerprints(await store.pendingFiles());
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; int c; int d; int e; }\n');
  await step('commit 스테이징 불일치', () => store.commit('요청: E', undefined, { expectStaged: prints }));

  await step('commit HEAD 이동', () => store.commit('요청: F', undefined, { expectedHead: '0'.repeat(40) }));

  await writeProject(w, 'studio.yaml', 'name: orders\nchanged: true\n');
  await step('commit 생성 파일 불일치', () => store.commit('요청: G', undefined, { expectExcluded: new Map([['studio.yaml', 'blob:그런적없음']]) }));

  await step('commit 정상 2', () => store.commit('요청: H'));

  // 대소문자만 다른 이름 바꾸기(대소문자 구분 없는 볼륨에서도 같은 규칙인지)
  await writeProject(w, 'Case.txt', 'upper\n');
  await step('commit 대소문자 파일', () => store.commit('요청: case'));
  await rename(path.join(w.workDir, 'Case.txt'), path.join(w.workDir, 'case.txt'));
  await step('commit 대소문자 이름 바꾸기', () => store.commit('요청: case rename'));

  // 심볼릭 링크(모드 120000)
  await symlink('api/src/Order.java', path.join(w.workDir, 'alias.java'));
  await step('commit 링크', () => store.commit('요청: link'));

  await mkdir(path.join(w.workDir, 'nested/.git'), { recursive: true });
  await step('commit 중첩 저장소', () => store.commit('요청: I'));
  await rm(path.join(w.workDir, 'nested'), { recursive: true, force: true });

  await writeProject(w, 'docs/a.md', '# a\n');
  await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; int c; int d; int e; int f; }\n');
  await step('commitPaths 문서만', () => store.commitPaths(['docs/a.md'], '문서: A'));
  await step('commitPaths 변경 없음', () => store.commitPaths(['nope.md'], '문서: 없음'));
  await writeProject(w, 'docs/b.md', '# b\n');
  await step('commitPaths 시크릿', () => store.commitPaths(['docs/b.md'], '문서: B', 'sk_live_1', { findSecrets: (text) => (text.includes('sk_live') ? ['X'] : []) }));
  await step('commitPaths ..', () => store.commitPaths(['../outside.md'], '문서: ..'));
  await writeProject(w, 'docs/c.md', '# c\n');
  await step('commitPaths HEAD 이동', () => store.commitPaths(['docs/c.md'], '문서: C2', undefined, { expectedHead: '0'.repeat(40) }));
  await writeProject(w, 'docs/d.md', '# d\n');
  await step('commitPaths 긴 글', () => store.commitPaths(['docs/d.md'], '문서: ' + '가'.repeat(5000)));

  const list = await store.list();
  await writeProject(w, 'api/src/Order.java', 'dirty\n');
  await step('restore 세션 시작', () => store.restore(list.at(-1)!.sha));
  const outside = await git(w.source, 'rev-list', '--max-parents=0', 'HEAD');
  await step('restore 세션 밖', () => store.restore(outside));

  await writeProject(w, 'api/src/Order.java', 'dirty2\n');
  await writeProject(w, 'studio.yaml', 'name: changed\n');
  await step('discard', () => store.discard());

  const status = await git(w.workDir, 'status', '--porcelain', '--untracked-files=all');
  const read = (file: string) => readFile(path.join(w.workDir, file), 'utf8').then((text) => text, () => null);
  const files = { order: await read('api/src/Order.java'), studio: await read('studio.yaml'), docsA: await read('docs/a.md'), docsB: await read('docs/b.md') };
  return {
    base: w.base,
    steps,
    status,
    files,
    backups: await folderTree(path.join(w.workDir, '.git/b-studio/discarded')),
    snapshots: await folderTree(path.join(w.workDir, '.git/b-studio/excluded')),
  };
}

async function runInit(Store: StoreClass): Promise<{ base: string; steps: Step[]; status: string }> {
  const base = path.join(sandboxRoot, `init-${++worldSeq}`);
  const workDir = path.join(base, 'plain');
  await mkdir(workDir, { recursive: true });
  const steps: Step[] = [];
  const step = async (label: string, run: () => unknown): Promise<void> => {
    try {
      steps.push({ label, ok: true, value: await run() });
    } catch (error) {
      steps.push({ label, ok: false, error: describeError(error) });
    }
  };
  const store = new Store(workDir, { excludedFiles: async () => EXCLUDED });
  await writeFile(path.join(workDir, 'a.txt'), 'a\n');
  await step('init', () => store.init('세션 시작'));
  await writeFile(path.join(workDir, 'a.txt'), 'a2\n');
  await step('init 뒤 commit', () => store.commit('요청: A'));
  await step('init 뒤 list', () => store.list());
  return { base, steps, status: await git(workDir, 'status', '--porcelain', '--untracked-files=all') };
}

function normalizeWrites(world: { base: string; steps: Step[]; status: string; files?: Record<string, string | null>; backups?: Record<string, string | null>; snapshots?: Record<string, string | null> }) {
  const text = JSON.stringify({ steps: world.steps, status: world.status, files: world.files, backups: world.backups, snapshots: world.snapshots })
    .split(world.base)
    .join('<W>')
    .replace(TIME, '<time>')
    .replace(BACKUP_ID, '<backup>');
  return JSON.parse(text);
}

describe('체크포인트 쓰기·걷기 차등(D1c)', () => {
  it('commit·commitPaths·restore·discard가 성공·실패 갈래에서 옛 구현과 같다', async () => {
    const legacy = normalizeWrites(await runWrites(LegacyCheckpointStore));
    const current = normalizeWrites(await runWrites(CheckpointStore));
    expect(current).toEqual(legacy);
  });

  it('init이 빈 폴더에서 같은 첫 체크포인트를 만든다', async () => {
    const legacy = normalizeWrites(await runInit(LegacyCheckpointStore));
    const current = normalizeWrites(await runInit(CheckpointStore));
    expect(current).toEqual(legacy);
  });

  // onCommitted는 옛 전체 구현(checkpoint-store-legacy.ts)에 없는 뒤에 더한 기능이라 차등하지 않는다.
  // 대신 지금 구현이 남긴 커밋의 sha로 부르는지만 확인한다(세션 터미널의 committedSha가 이 값에 기댄다).
  // 옛 전체 구현(checkpoint-store-legacy.ts)은 `commitPaths`의 마지막 방어선(넘긴 경로 밖 파일이 트리에 섞였는지)과
  // `GIT_LITERAL_PATHSPECS`를 넣기 전에 얼려 둔 파일이라, 그 두 가지는 차등 대상이 아니다. 지금 구현(옮기기 직전 TS)의
  // 동작을 따로 고정한다: 정규화되지 않은 경로가 다른 파일을 끌어들이면 커밋하지 않는다.
  it('commitPaths는 넘긴 경로 밖 파일이 트리에 섞이면 거부한다', async () => {
    const w = await createWorld(CheckpointStore);
    const store = new CheckpointStore(w.workDir, {});
    await writeProject(w, 'docs/c.md', '# c\n');
    await expect(store.commitPaths(['docs//c.md'], '문서: C')).rejects.toThrow('지정한 경로 밖의 파일이 함께 담겨 체크포인트를 남기지 않았습니다: docs/c.md');
    expect(await git(w.workDir, 'status', '--porcelain', '--untracked-files=all')).toContain('docs/c.md');
  });

  it('onCommitted는 실제로 남긴 커밋 sha로 불린다', async () => {
    const w = await createWorld(CheckpointStore);
    const store = new CheckpointStore(w.workDir, {});
    await writeProject(w, 'api/src/Order.java', 'class Order { int x; }\n');
    let seen = '';
    const checkpoint = await store.commit('요청: callback', undefined, { onCommitted: (sha) => { seen = sha; } });
    expect(seen).toBe(checkpoint!.sha);
    expect(seen).toMatch(/^[0-9a-f]{40}$/);
  });
});


// ── D1c: 걷기(findNestedGitRepos) 차등 ─────────────────────────────────────

describe('중첩 git 저장소 걷기 차등(D1c)', () => {
  it('디렉터리·파일 `.git`, 대소문자, 무시되는 폴더, 링크, 한도가 옛 구현과 같다', async () => {
    const root = path.join(sandboxRoot, 'dig');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await mkdir(path.join(root, 'vendor/lib/.git'), { recursive: true });
    await mkdir(path.join(root, 'A/.GIT'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/dep/.git'), { recursive: true });
    await mkdir(path.join(root, '.hidden/.git'), { recursive: true });
    await mkdir(path.join(root, 'plain'), { recursive: true });
    await writeFile(path.join(root, 'sub/.git'), 'gitdir: /somewhere\n');
    // 링크 너머는 걷지 않는다
    const outside = path.join(sandboxRoot, 'outside');
    await mkdir(path.join(outside, '.git'), { recursive: true });
    await symlink(outside, path.join(root, 'link'));

    const partition = async (dirs: string[]): Promise<Set<string>> => new Set(dirs.filter((dir) => dir === 'node_modules' || dir.startsWith('node_modules/')));
    const top = path.resolve(root, '.git');
    const legacy = await legacyFindNestedGitRepos(root, top, partition, 100);
    const current = await findNestedGitRepos(root, top, partition, 100);
    expect(current.sort()).toEqual(legacy.sort());

    // 한도에 닿으면 멈춘다(잘린 목록의 길이가 한도와 같다)
    const legacyLimited = await legacyFindNestedGitRepos(root, top, partition, 2);
    const currentLimited = await findNestedGitRepos(root, top, partition, 2);
    expect(currentLimited.length).toBe(legacyLimited.length);
    expect(currentLimited.sort()).toEqual(legacyLimited.sort());

    // `top`이 없으면 최상위 `.git`도 센다
    const legacyNoTop = await legacyFindNestedGitRepos(root, undefined, partition, 100);
    const currentNoTop = await findNestedGitRepos(root, undefined, partition, 100);
    expect(currentNoTop.sort()).toEqual(legacyNoTop.sort());
  });

  it('항목이 많은 폴더를 한도로 자를 때 남는 저장소가 옛 구현과 같다(옛 readdir은 이름순, 파일 시스템 순서가 아니다)', async () => {
    const root = path.join(sandboxRoot, 'dig-many');
    for (let i = 39; i >= 0; i--) await mkdir(path.join(root, `d${String(i).padStart(2, '0')}`, '.git'), { recursive: true });
    const partition = async (): Promise<Set<string>> => new Set();
    const legacy = await legacyFindNestedGitRepos(root, undefined, partition, 5);
    const current = await findNestedGitRepos(root, undefined, partition, 5);
    expect(current).toEqual(legacy);
    expect(current).toEqual(['d00/.git', 'd01/.git', 'd02/.git', 'd03/.git', 'd04/.git']);
  });
});

// ── 생성 파일 이름 경계(의도한 차이: 더 막음) ──────────────────────────────

describe('생성 파일 이름 경계', () => {
  const NAMES = ['../outside.txt', '/etc/hosts', 'a/../../x', '', 'a\0b', '.git/config', 'a//b', './a', 'a/'];

  it('프로젝트 밖·보호 경로를 가리키는 이름은 새 구현이 init에서 거부한다(옛 구현은 그대로 썼다)', async () => {
    for (const name of NAMES) {
      const legacy = await createWorldWith(LegacyCheckpointStore, [name]);
      const current = await createWorldWith(CheckpointStore, [name]);
      // 프로젝트 폴더(orders) 밖에 미끼를 둔다. `../outside.txt`는 여기를 가리킨다
      const legacyDecoy = path.join(legacy.base, 'outside.txt');
      const currentDecoy = path.join(current.base, 'outside.txt');
      await writeFile(legacyDecoy, 'decoy\n');
      await writeFile(currentDecoy, 'decoy\n');

      const legacyError = await legacy.store.init().then(
        () => undefined,
        (error: unknown) => describeError(error),
      );
      const currentError = await current.store.init().then(
        () => undefined,
        (error: unknown) => describeError(error),
      );

      // 미끼는 두 세계 모두 그대로다
      expect(await readFile(legacyDecoy, 'utf8')).toBe('decoy\n');
      expect(await readFile(currentDecoy, 'utf8')).toBe('decoy\n');
      // 새 구현은 경계에서 거부한다(의도한 차이)
      expect({ name, error: currentError?.name }).toEqual({ name, error: 'CheckpointError' });
      expect(currentError?.message).toContain('생성 파일 이름이 올바르지 않습니다');
      // 옛 구현은 이 검사를 하지 않는다. 경계 검사에서 갈린다는 것만 고정한다
      expect(legacyError?.message ?? '').not.toContain('생성 파일 이름이 올바르지 않습니다');
    }
  });

  it('`.git/config`는 옛 구현이 init을 마치고, 새 구현은 거부한다', async () => {
    const legacy = await createWorldWith(LegacyCheckpointStore, ['.git/config']);
    const current = await createWorldWith(CheckpointStore, ['.git/config']);
    expect(await legacy.store.init()).toBeDefined();
    await expect(current.store.init()).rejects.toThrow('생성 파일 이름이 올바르지 않습니다');
  });
});

describe('생성 파일 이름 경계: 중간 폴더 링크', () => {
  it('링크 폴더 아래 이름은 옛·새 구현 모두 사이드카·백업으로 읽어 오지 않는다', async () => {
    for (const Store of [LegacyCheckpointStore, CheckpointStore]) {
      const w = await createWorldWith(Store, ['apps/web/Dockerfile.b-studio']);
      const outside = path.join(w.base, 'outside');
      await mkdir(path.join(outside, 'web'), { recursive: true });
      await writeFile(path.join(outside, 'web', 'Dockerfile.b-studio'), 'outside-dockerfile\n');
      // 세션 작업 복사본의 apps는 프로젝트 밖 폴더를 가리킨다
      await symlink(outside, path.join(w.workDir, 'apps'));

      await w.store.init().catch(() => undefined);
      await writeProject(w, 'api/src/Order.java', 'class Order { int a; int b; }\n');
      await w.store.commit('요청: 링크 밖에 이름을 둔다').catch(() => undefined);
      await w.store.discard().catch(() => undefined);
      const shas = await w.store.list().catch(() => []);
      if (shas.length > 0) await w.store.restore(shas.at(-1)!.sha).catch(() => undefined);

      // 바깥 미끼는 그대로다
      expect(await readFile(path.join(outside, 'web', 'Dockerfile.b-studio'), 'utf8')).toBe('outside-dockerfile\n');
      // 사이드카·백업 어디에도 링크 너머의 내용이 들어가지 않았다
      const tree = await folderTree(path.join(w.workDir, '.git/b-studio'));
      expect(Object.values(tree)).not.toContain(Buffer.from('outside-dockerfile\n').toString('base64'));
    }
  });
});

describe('생성 파일 링크: git처럼 링크로 다룬다', () => {
  it('(a) 프로젝트 안을 가리키는 링크는 옛·새 모두 성공하고 같은 대상을 유지한다', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorldWith(Store, ['studio.yaml']);
      await mkdir(path.join(w.workDir, 'spec'), { recursive: true });
      await writeFile(path.join(w.workDir, 'spec/real.yaml'), 'real\n');
      await symlink('spec/real.yaml', path.join(w.workDir, 'studio.yaml'));
      await exclude(w, '/studio.yaml');
      const start = await w.store.init();
      await writeProject(w, 'api/src/Order.java', 'class Order { int a; }\n');
      await w.store.commit('요청: 링크');
      await w.store.discard();
      await w.store.restore(start.sha);
      const info = await lstat(path.join(w.workDir, 'studio.yaml'));
      return {
        link: info.isSymbolicLink(),
        target: info.isSymbolicLink() ? await readlink(path.join(w.workDir, 'studio.yaml')) : null,
        real: await readFile(path.join(w.workDir, 'spec/real.yaml'), 'utf8'),
      };
    };
    const legacy = await run(LegacyCheckpointStore);
    const current = await run(CheckpointStore);
    expect(current).toEqual({ link: true, target: 'spec/real.yaml', real: 'real\n' });
    expect(current).toEqual(legacy);
  });

  it('(b) 바깥 링크: 새 구현은 바깥 내용을 사이드카에 넣지 않는다(옛 구현은 넣었다 — 의도한 차이)', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorldWith(Store, ['studio.yaml']);
      const outside = path.join(w.base, 'outside.txt');
      await writeFile(outside, 'outside\n');
      await symlink(outside, path.join(w.workDir, 'studio.yaml'));
      await exclude(w, '/studio.yaml');
      await w.store.init();
      const tree = await folderTree(path.join(w.workDir, '.git/b-studio'));
      return {
        hasOutsideContent: Object.values(tree).includes(Buffer.from('outside\n').toString('base64')),
        outside: await readFile(outside, 'utf8'),
      };
    };
    const legacy = await run(LegacyCheckpointStore);
    const current = await run(CheckpointStore);
    // 새 구현은 링크 대상 글자만 기록하고 내용을 읽지 않는다
    expect(current).toEqual({ hasOutsideContent: false, outside: 'outside\n' });
    // 옛 구현은 링크를 따라 내용을 사이드카에 넣었다(의도한 차이)
    expect(legacy).toEqual({ hasOutsideContent: true, outside: 'outside\n' });
  });

  it('(c) 스냅샷은 파일인데 지금 링크: 새 구현은 링크만 지우고, 옛 구현은 링크 너머를 덮어썼다', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorldWith(Store, ['studio.yaml']);
      const leak = path.join(w.base, 'leak.txt');
      await writeFile(leak, 'outside\n');
      await writeFile(path.join(w.workDir, 'studio.yaml'), 'inside\n');
      await exclude(w, '/studio.yaml');
      await w.store.init();
      await rm(path.join(w.workDir, 'studio.yaml'));
      await symlink(leak, path.join(w.workDir, 'studio.yaml'));
      await w.store.discard();
      const info = await lstat(path.join(w.workDir, 'studio.yaml'));
      return {
        leak: await readFile(leak, 'utf8'),
        link: info.isSymbolicLink(),
        content: await readFile(path.join(w.workDir, 'studio.yaml'), 'utf8'),
      };
    };
    const legacy = await run(LegacyCheckpointStore);
    const current = await run(CheckpointStore);
    // 새 구현: 링크 자체를 지우고 파일을 만든다. 바깥은 그대로다
    expect(current).toEqual({ leak: 'outside\n', link: false, content: 'inside\n' });
    // 옛 구현: 링크를 따라 바깥 파일을 덮어썼다(의도한 차이)
    expect(legacy).toEqual({ leak: 'inside\n', link: true, content: 'inside\n' });
  });
});

describe('restoreBackup: 생성 파일 되살리기도 링크를 따라가지 않는다', () => {
  it('백업 뒤 중간 폴더가 링크가 되면 새 구현은 쓰지 않고, 옛 구현은 링크 너머를 덮어썼다(의도한 차이)', async () => {
    const run = async (Store: StoreClass) => {
      const w = await createWorldWith(Store, ['apps/web/Dockerfile.b-studio']);
      await writeProject(w, 'apps/web/Dockerfile.b-studio', 'generated-1\n');
      await exclude(w, '/apps/web/Dockerfile.b-studio');
      await w.store.init();

      await writeProject(w, 'api/src/Order.java', 'class Order { int a; }\n');
      await writeProject(w, 'apps/web/Dockerfile.b-studio', 'generated-2\n');
      const { backup } = await w.store.discard();
      expect(backup).toBeDefined();

      // 되살리기 직전에 중간 폴더를 프로젝트 밖 링크로 바꾼다
      const outside = path.join(w.base, 'outside');
      await mkdir(path.join(outside, 'web'), { recursive: true });
      const decoy = path.join(outside, 'web/Dockerfile.b-studio');
      await writeFile(decoy, 'outside\n');
      await rm(path.join(w.workDir, 'apps'), { recursive: true, force: true });
      await symlink(outside, path.join(w.workDir, 'apps'));

      const result = await w.store.restoreBackup(backup!.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error: describeError(error) }),
      );
      return {
        result,
        decoy: await readFile(decoy, 'utf8'),
        tracked: await readFile(path.join(w.workDir, 'api/src/Order.java'), 'utf8'),
      };
    };

    const legacy = await run(LegacyCheckpointStore);
    const current = await run(CheckpointStore);
    // 새 구현: 링크 폴더를 따라 쓰지 않고 오류. 그래도 보통 파일(백업의 files/)은 되살린다
    expect(current.result.ok).toBe(false);
    expect(current.decoy).toBe('outside\n');
    expect(current.tracked).toBe('class Order { int a; }\n');
    // 옛 구현: 링크를 따라 바깥 파일을 덮어썼다(의도한 차이)
    expect(legacy.result.ok).toBe(true);
    expect(legacy.decoy).toBe('generated-2\n');
    expect(legacy.tracked).toBe('class Order { int a; }\n');
  });
});

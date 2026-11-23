import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore, findNestedGitRepos } from './checkpoints';
import { formatWorkflowTrailer } from './workflow';

/**
 * 체크포인트의 로컬 경로와 생성 파일 사이드카·백업(D1a·D1c)에서 사본과 무관한 것을 확인한다: 쓰기 방어선, 걷기, 생성 파일 이름 경계, 링크 처리.
 * 옛 전체 구현(TS 사본)과 견주던 시험은 걷어냈다(#1347).
 */
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const FIXED_DATE = '2026-01-02T03:04:05Z';
const BRANCH = 'session';
const EXCLUDED = ['studio.yaml', 'Dockerfile.b-studio', 'compose.b-studio.yaml'];


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
  store: CheckpointStore;
}

async function createWorldWith(Store: typeof CheckpointStore, excluded: string[]): Promise<World> {
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

async function createWorld(Store: typeof CheckpointStore): Promise<World> {
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

describe('체크포인트 쓰기', () => {
  // onCommitted는 지금 구현이 남긴 커밋의 sha로 불러야 한다(세션 터미널의 committedSha가 이 값에 기댄다).
  // commitPaths의 마지막 방어선: 정규화되지 않은 경로가 다른 파일을 끌어들이면 커밋하지 않는다.
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


// ── 걷기(findNestedGitRepos) ─────────────────────────────────────

describe('중첩 git 저장소 걷기 ', () => {
  it('디렉터리·파일 `.git`, 대소문자, 무시되는 폴더, 링크, 한도', async () => {
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
    const current = await findNestedGitRepos(root, top, partition, 100);
    // 기대값은 옛 TS 구현이 낸 값을 옮겨 적은 것이다(#1347)
    expect(current.sort()).toEqual(['.hidden/.git', 'A/.GIT', 'sub/.git', 'vendor/lib/.git']);

    // 한도에 닿으면 멈춘다(잘린 목록의 길이가 한도와 같다)
    const currentLimited = await findNestedGitRepos(root, top, partition, 2);
    expect(currentLimited.length).toBe(2);
    expect(currentLimited.sort()).toEqual(['.hidden/.git', 'A/.GIT']);

    // `top`이 없으면 최상위 `.git`도 센다
    const currentNoTop = await findNestedGitRepos(root, undefined, partition, 100);
    expect(currentNoTop.sort()).toEqual(['.hidden/.git', 'A/.GIT', 'sub/.git', 'vendor/lib/.git']);
  });

  it('항목이 많은 폴더를 한도로 자를 때 남는 저장소는 이름순으로 앞의 것이다(파일 시스템 순서가 아니다)', async () => {
    const root = path.join(sandboxRoot, 'dig-many');
    for (let i = 39; i >= 0; i--) await mkdir(path.join(root, `d${String(i).padStart(2, '0')}`, '.git'), { recursive: true });
    const partition = async (): Promise<Set<string>> => new Set();
    const current = await findNestedGitRepos(root, undefined, partition, 5);
    expect(current).toEqual(['d00/.git', 'd01/.git', 'd02/.git', 'd03/.git', 'd04/.git']);
  });
});

// ── 생성 파일 이름 경계(의도한 차이: 더 막음) ──────────────────────────────

describe('생성 파일 이름 경계', () => {
  const NAMES = ['../outside.txt', '/etc/hosts', 'a/../../x', '', 'a\0b', '.git/config', 'a//b', './a', 'a/'];

  it('프로젝트 밖·보호 경로를 가리키는 이름은 init에서 거부한다', async () => {
    for (const name of NAMES) {
      const current = await createWorldWith(CheckpointStore, [name]);
      // 프로젝트 폴더(orders) 밖에 미끼를 둔다. `../outside.txt`는 여기를 가리킨다
      const currentDecoy = path.join(current.base, 'outside.txt');
      await writeFile(currentDecoy, 'decoy\n');

      const currentError = await current.store.init().then(
        () => undefined,
        (error: unknown) => describeError(error),
      );

      expect(await readFile(currentDecoy, 'utf8')).toBe('decoy\n');
      // 경계에서 거부한다
      expect({ name, error: currentError?.name }).toEqual({ name, error: 'CheckpointError' });
      expect(currentError?.message).toContain('생성 파일 이름이 올바르지 않습니다');
    }
  });

  it('`.git/config`는 init에서 거부한다', async () => {
    const current = await createWorldWith(CheckpointStore, ['.git/config']);
    await expect(current.store.init()).rejects.toThrow('생성 파일 이름이 올바르지 않습니다');
  });
});

describe('생성 파일 이름 경계: 중간 폴더 링크', () => {
  it('링크 폴더 아래 이름은 사이드카·백업으로 읽어 오지 않는다', async () => {
    for (const Store of [CheckpointStore]) {
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
  it('(a) 프로젝트 안을 가리키는 링크는 성공하고 같은 대상을 유지한다', async () => {
    const run = async (Store: typeof CheckpointStore) => {
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
    const current = await run(CheckpointStore);
    expect(current).toEqual({ link: true, target: 'spec/real.yaml', real: 'real\n' });
  });

  it('(b) 바깥 링크: 바깥 내용을 사이드카에 넣지 않는다', async () => {
    const run = async (Store: typeof CheckpointStore) => {
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
    const current = await run(CheckpointStore);
    // 새 구현은 링크 대상 글자만 기록하고 내용을 읽지 않는다
    expect(current).toEqual({ hasOutsideContent: false, outside: 'outside\n' });
  });

  it('(c) 스냅샷은 파일인데 지금 링크: 링크만 지우고 링크 너머는 덮어쓰지 않는다', async () => {
    const run = async (Store: typeof CheckpointStore) => {
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
    const current = await run(CheckpointStore);
    // 새 구현: 링크 자체를 지우고 파일을 만든다. 바깥은 그대로다
    expect(current).toEqual({ leak: 'outside\n', link: false, content: 'inside\n' });
  });
});

describe('restoreBackup: 생성 파일 되살리기도 링크를 따라가지 않는다', () => {
  it('백업 뒤 중간 폴더가 링크가 되면 링크 너머에 쓰지 않는다', async () => {
    const run = async (Store: typeof CheckpointStore) => {
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

    const current = await run(CheckpointStore);
    // 새 구현: 링크 폴더를 따라 쓰지 않고 오류. 그래도 보통 파일(백업의 files/)은 되살린다
    expect(current.result.ok).toBe(false);
    expect(current.decoy).toBe('outside\n');
    expect(current.tracked).toBe('class Order { int a; }\n');
  });
});

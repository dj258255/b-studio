import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from './checkpoints';
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

async function createWorld(Store: StoreClass): Promise<World> {
  const base = path.join(sandboxRoot, `world-${++worldSeq}`);
  const source = path.join(base, 'orders');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await writeFile(path.join(source, 'README.md'), '# orders\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  const workDir = path.join(base, 'sessions', 'orders-s1');
  const { store } = await Store.clone(source, workDir, { branch: BRANCH, excludedFiles: async () => EXCLUDED });
  return { base, source, workDir, store };
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

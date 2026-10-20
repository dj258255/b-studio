import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SandboxError } from '../errors';
import type { EvaluationAssetContent } from '../types';

/**
 * 평가 자산의 복사본(#745). 컨테이너에는 작업 복사본의 경로가 아니라 b-studio가 가진 이 복사본을 읽기 전용으로 붙인다.
 *
 * 작업 복사본의 경로를 붙이면 두 가지가 열린다.
 *  - 원본이 링크면 도커가 링크를 따라간다(colima 실측). 마스크를 계산할 때 링크를 걸러도, 서비스 재시작 때 도커가 같은
 *    경로를 다시 따라간다 — 원본이 작업 복사본 안에 있는 한 막을 수 없다.
 *  - 붙일 목록을 작업 복사본의 지금 상태로 정하면, 에이전트가 자산을 지우거나 링크로 바꾸는 것만으로 기대 목록이 줄어
 *    "보호가 빠졌다"는 사후 확인이 통과한다.
 * 그래서 목록은 선언에서만 정하고, 내용은 b-studio가 관리하는 복사본 자리에서만 꺼낸다. 복사본은 같은 inode를 유지한 채
 * 안을 바꾸므로 파일 하나를 마운트해도(리눅스 네이티브 도커가 inode를 붙잡는 문제) 호스트의 새 판이 보인다.
 */

/** 선언 경로 하나에 대응하는 복사본 자리. 마운트 계획에는 경로와 자리만 필요하다 */
export interface EvaluationAssetCopy {
  /** 프로젝트 폴더 기준 선언 경로 */
  path: string;
  /** b-studio가 가진 복사본의 호스트 절대 경로 */
  source: string;
}

/** 선언 경로 하나의 복사본 자리와 지금 만들 자리의 종류 */
export interface EvaluationAssetSlot extends EvaluationAssetCopy {
  kind: 'file' | 'directory';
}

/**
 * 복사본을 두는 기본 루트. 샌드박스의 workDir(tmpdir)는 colima가 기본으로 홈만 VM에 공유하므로 컨테이너에서 빈 폴더로 보인다.
 * 홈 아래에 두어야 도커가 실제 내용을 본다. 제공자·에이전트 컨테이너 옵션(테스트는 임시 폴더)으로 바꿀 수 있다
 */
export function defaultEvaluationAssetRoot(): string {
  return path.resolve(path.join(homedir(), '.cache', 'b-studio', 'evaluation-assets'));
}

/** 한 샌드박스의 복사본 폴더. 샌드박스 id의 꼴을 벗어난 값으로는 만들지 않는다 */
export function evaluationAssetSandboxDir(root: string, sandboxId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(sandboxId) || sandboxId === '.' || sandboxId === '..') {
    throw new SandboxError('샌드박스 id로 평가 자산 복사본 폴더를 정할 수 없습니다', sandboxId);
  }
  return path.join(root, sandboxId);
}

/**
 * 선언 경로들에 대응하는 복사본 자리(경로 → 자리). 순서가 바뀌어도 같은 자리를 가리키도록 경로의 해시를 이름으로 쓴다.
 * 자리를 만들지 않는다 — 마운트 계획과 사후 확인은 선언만으로 목록을 정하고, 만들기는 prepareEvaluationAssetCopies가 한다
 */
export function evaluationAssetCopies(declared: readonly string[], root: string, sandboxId: string): EvaluationAssetCopy[] {
  const dir = evaluationAssetSandboxDir(root, sandboxId);
  return declared.map((declaredPath) => ({ path: declaredPath, source: path.join(dir, copyName(declaredPath)) }));
}

/**
 * 선언마다 복사본 자리를 만든다. 폴더 자산은 빈 폴더, 파일 자산은 빈 파일이다. 자리가 링크나 다른 종류면 그 항목만 지우고
 * 새로 만든다(링크를 따라가지 않는다). 만든 뒤 실제 위치가 샌드박스 복사본 폴더 안인지 확인한다.
 * 자리의 종류는 복사본의 내용이 아니라 작업 복사본에서 지금 보이는 모습으로 정한다 — 첫 sync 전에 마운트 모양을 정해야 한다
 */
export async function prepareEvaluationAssetCopies(
  declared: readonly string[],
  projectRoot: string,
  root: string,
  sandboxId: string,
): Promise<EvaluationAssetSlot[]> {
  if (declared.length === 0) return [];
  const dir = evaluationAssetSandboxDir(root, sandboxId);
  await mkdir(dir, { recursive: true });
  const realDir = await checkSandboxDir(root, dir);
  const slots: EvaluationAssetSlot[] = [];
  for (const declaredPath of declared) {
    const kind = await declaredKind(projectRoot, declaredPath);
    const source = path.join(dir, copyName(declaredPath));
    await prepareSlot(source, kind, dir);
    if (!isInside(realDir, await realpath(source))) {
      throw new SandboxError('평가 자산 복사본 자리가 샌드박스 복사본 폴더 밖을 가리킵니다', `${source} → ${await realpath(source).catch(() => source)}`);
    }
    slots.push({ path: declaredPath, kind, source });
  }
  return slots;
}

/**
 * 복사본의 내용을 넘긴 판으로 바꾼다. 폴더 자산은 폴더 자체(inode)를 그대로 두고 안만 맞춘다(없는 파일 지우기, 새 내용 쓰기).
 * 파일 자산은 같은 파일에 덮어쓴다(truncate 후 write) — inode가 그대로라 컨테이너도 새 내용을 본다.
 * 복사본 안의 링크는 따라가지 않고 지운 뒤 새로 쓴다. 선언에 없는 `path`나 선언 경로 밖의 파일은 거절한다
 */
export async function syncEvaluationAssetCopies(
  slots: readonly EvaluationAssetSlot[],
  sandboxDir: string,
  assets: readonly EvaluationAssetContent[],
): Promise<void> {
  const byPath = new Map(slots.map((slot) => [slot.path, slot]));
  await mkdir(sandboxDir, { recursive: true });
  const realDir = await checkSandboxDir(path.dirname(sandboxDir), sandboxDir);
  for (const asset of assets) {
    const slot = byPath.get(asset.path);
    if (!slot) throw new SandboxError('선언하지 않은 평가 자산의 복사본은 바꿀 수 없습니다', asset.path);
    if (!isInside(realDir, await realpath(path.dirname(slot.source)).catch(() => path.dirname(slot.source)))) {
      throw new SandboxError('평가 자산 복사본 자리가 샌드박스 복사본 폴더 밖을 가리킵니다', slot.source);
    }
    if (asset.kind === 'file') {
      await syncFile(slot, asset.files);
    } else {
      await syncDirectory(slot, asset.files);
    }
    if (!isInside(realDir, await realpath(slot.source))) {
      throw new SandboxError('평가 자산 복사본 자리가 샌드박스 복사본 폴더 밖을 가리킵니다', slot.source);
    }
  }
}

/** 한 샌드박스의 복사본 폴더를 지운다. 그 폴더 자체가 링크면 링크만 지우고 너머는 건드리지 않는다 */
export async function removeEvaluationAssets(root: string, sandboxId: string): Promise<void> {
  const dir = evaluationAssetSandboxDir(root, sandboxId);
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return;
  await rm(dir, { recursive: info.isDirectory(), force: true });
}

function copyName(declaredPath: string): string {
  return createHash('sha256').update(declaredPath).digest('hex').slice(0, 32);
}

async function declaredKind(projectRoot: string, declaredPath: string): Promise<'file' | 'directory'> {
  const info = await lstat(path.join(projectRoot, declaredPath)).catch(() => undefined);
  return info?.isFile() ? 'file' : 'directory';
}

async function prepareSlot(source: string, kind: 'file' | 'directory', parent: string): Promise<void> {
  if (path.dirname(source) !== parent) throw new SandboxError('평가 자산 복사본 자리가 복사본 폴더 바로 아래가 아닙니다', source);
  const current = await lstat(source).catch(() => undefined);
  if (kind === 'directory') {
    // 링크·파일이면 그 항목만 지운다. 재귀 지우기는 진짜 폴더일 때만 쓴다(링크 너머를 건드리지 않게)
    if (current && !current.isDirectory()) await rm(source, { recursive: current.isDirectory(), force: true });
    if (!current?.isDirectory()) await mkdir(source);
  } else {
    if (current && !current.isFile()) await rm(source, { recursive: current.isDirectory(), force: true });
    // 빈 파일로 시작한다. 같은 inode에 나중에 내용을 덮어쓴다
    await writeFile(source, '');
  }
  const after = await lstat(source);
  if (kind === 'directory' ? !after.isDirectory() : !after.isFile()) {
    throw new SandboxError('평가 자산 복사본 자리를 만들지 못했습니다', source);
  }
}

async function checkSandboxDir(root: string, dir: string): Promise<string> {
  const realDir = await realpath(dir);
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  if (!isInside(realRoot, realDir)) throw new SandboxError('평가 자산 복사본 폴더가 정한 루트 밖을 가리킵니다', dir);
  return realDir;
}

async function syncFile(slot: EvaluationAssetSlot, files: EvaluationAssetContent['files']): Promise<void> {
  for (const file of files) {
    if (file.path !== slot.path) throw new SandboxError('평가 자산 파일 자산의 경로가 선언과 다릅니다', `${slot.path} ≠ ${file.path}`);
  }
  await prepareSlot(slot.source, 'file', path.dirname(slot.source));
  const file = files.find((entry) => entry.path === slot.path);
  const content = file?.content ?? Buffer.alloc(0);
  // 같은 inode에 쓴다. 컨테이너가 붙잡은 파일 판이 바뀌지 않는다
  await writeFile(slot.source, content);
  await chmod(slot.source, file?.executable ? 0o755 : 0o644);
}

async function syncDirectory(slot: EvaluationAssetSlot, files: EvaluationAssetContent['files']): Promise<void> {
  await prepareSlot(slot.source, 'directory', path.dirname(slot.source));
  const desired = new Map<string, EvaluationAssetContent['files'][number]>();
  for (const file of files) {
    desired.set(containedRelative(slot.path, file.path), file);
  }
  await pruneDirectory(slot.source, '', desired);
  for (const [relative, file] of desired) {
    const target = path.join(slot.source, ...relative.split('/'));
    await ensureDirectory(slot.source, path.dirname(target));
    // 그 사이에 링크나 폴더가 생겼으면 지운다(링크는 링크만). 일반 파일은 같은 inode에 덮어쓴다
    const current = await lstat(target).catch(() => undefined);
    if (current && !current.isFile()) await rm(target, { recursive: current.isDirectory(), force: true });
    await writeFile(target, file.content);
    await chmod(target, file.executable ? 0o755 : 0o644);
  }
}

/** 선언 경로 안의 상대 경로만 받는다. 선언 밖(`..`, 절대 경로, 빈 이름)은 거절한다 */
function containedRelative(declaredPath: string, filePath: string): string {
  const base = declaredPath.replace(/\/+$/, '');
  if (!filePath.startsWith(`${base}/`)) throw new SandboxError('평가 자산의 파일 경로가 선언 경로 밖입니다', filePath);
  const relative = filePath.slice(base.length + 1);
  const parts = relative.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new SandboxError('평가 자산의 파일 경로가 올바르지 않습니다', filePath);
  }
  return relative;
}

/**
 * 폴더 안에서 이번에 쓰지 않는 항목을 지운다. 폴더 자신(inode)은 그대로 두고 안만 맞춘다.
 * 링크는 링크만 지운다(따라가지 않는다). 아래에 쓸 파일이 있는 폴더는 남긴다
 */
async function pruneDirectory(base: string, relative: string, desired: ReadonlyMap<string, unknown>): Promise<void> {
  const dir = relative ? path.join(base, ...relative.split('/')) : base;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(dir, entry.name);
    if (desired.has(child)) {
      // 같은 이름에 파일을 쓸 자리다. 폴더나 링크면 지우고, 일반 파일은 뒤에서 덮어쓴다
      if (!entry.isFile()) await rm(target, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    const needed = [...desired.keys()].some((path) => path.startsWith(`${child}/`));
    if (!needed) {
      await rm(target, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    if (!entry.isDirectory()) {
      // 아래에 파일을 써야 하는데 폴더가 아니다. 링크면 링크만 지운다
      await rm(target, { force: true });
      continue;
    }
    await pruneDirectory(base, child, desired);
  }
}

/** base 안의 디렉터리를 만든다. 중간에 링크나 파일이 있으면 지우고 진짜 폴더를 만든다(링크를 따라가지 않는다) */
async function ensureDirectory(base: string, dir: string): Promise<void> {
  const relative = path.relative(base, dir);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SandboxError('평가 자산 복사본 폴더 밖에 쓸 수 없습니다', dir);
  const realBase = await realpath(base);
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info && !info.isDirectory()) await rm(current, { recursive: info.isDirectory(), force: true });
    if (!info?.isDirectory()) await mkdir(current);
    if (!isInside(realBase, await realpath(current))) throw new SandboxError('평가 자산 복사본 폴더 밖을 가리키는 링크가 있습니다', current);
  }
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

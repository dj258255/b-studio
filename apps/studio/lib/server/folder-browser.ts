/**
 * 폴더 선택 모달(ADR-082)이 쓰는 폴더 목록. 경로를 입력하는 대신 더블클릭으로 고를 수 있게, 주어진 폴더의
 * 하위 폴더 목록과 각 폴더의 실마리(Next.js·Spring·FastAPI·compose·git·studio.yaml·이미 등록됨)를 돌려준다.
 * 폴더 열기(ADR-067)와 같은 개인 PC 전용 가드를 쓴다 — 서버가 아무 경로나 읽게 되므로 로컬 폴더를 허용한
 * 모드에서만 부른다(라우트 쪽 책임).
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { COMPOSE_FILE_CANDIDATES } from '@b-studio/spec';
import { SPEC_FILE } from './project-detect';
import { readRegistry, type RegisteredProject } from './project-registry';
import { StudioError } from './errors';

/** 한 번에 보여줄 하위 폴더 수의 상한. 넘으면 앞에서부터 이만큼만 담고 truncated를 켠다 */
export const MAX_ENTRIES = 500;
/** 최근 연 폴더 바로가기 개수 상한 */
const RECENT_LIMIT = 8;

export type FolderHint = 'nextjs' | 'vite' | 'spring-boot' | 'fastapi' | 'compose' | 'git' | 'studio-yaml' | 'registered';

export interface FolderChild {
  name: string;
  /** 절대 경로 */
  path: string;
  /** 더 들어갈 하위 폴더가 있는가(빈 폴더인지 미리 보여주는 용도) */
  hasChildren: boolean;
  hints: FolderHint[];
}

export interface FolderShortcut {
  label: string;
  path: string;
  /** 최근 연 폴더 바로가기인가(등록 목록에서 왔는가) */
  recent?: boolean;
}

export interface FolderListing {
  /** 지금 보고 있는 폴더의 절대 경로(심볼릭 링크는 실제 경로로 푼다) */
  path: string;
  /** 파일 시스템 루트면 없다 */
  parent?: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  children: FolderChild[];
  /** MAX_ENTRIES를 넘어 일부만 보여줬는가 */
  truncated: boolean;
  /** 거르기 전 하위 폴더 전체 개수 */
  totalCount: number;
  shortcuts: FolderShortcut[];
}

const NEVER_LIST = new Set(['node_modules', '.git']);

/** 주어진 폴더(없으면 홈 폴더)의 하위 폴더 목록을 만든다 */
export async function listFolder(input: { path?: string; showHidden?: boolean } = {}): Promise<FolderListing> {
  const resolved = await resolveTarget(input.path);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new StudioError(400, `폴더가 아닙니다: ${resolved}`);

  const registry = await readRegistry();
  const registered = new Set(registry.map((entry) => entry.path));
  const { children, truncated, totalCount } = await listChildren(resolved, input.showHidden ?? false, registered);
  const parent = path.dirname(resolved);

  return {
    path: resolved,
    ...(parent === resolved ? {} : { parent }),
    breadcrumbs: breadcrumbsFor(resolved),
    children,
    truncated,
    totalCount,
    shortcuts: await shortcutsFor(registry),
  };
}

/** 입력 경로를 절대 경로로 풀고 심볼릭 링크를 실제 경로로 바꾼다. 없는 경로·상대 경로는 400으로 던진다 */
async function resolveTarget(rawPath: string | undefined): Promise<string> {
  const home = homedir();
  const input = rawPath?.trim();
  if (!input) return realpath(home).catch(() => home);
  const candidate = input.startsWith('~') ? path.join(home, input.slice(1)) : input;
  if (!path.isAbsolute(candidate)) throw new StudioError(400, '절대 경로(/로 시작)나 ~로 시작하는 경로를 적어 주세요');
  try {
    return await realpath(candidate);
  } catch {
    throw new StudioError(400, `폴더를 찾을 수 없습니다: ${candidate}`);
  }
}

function breadcrumbsFor(resolved: string): Array<{ name: string; path: string }> {
  const parts = resolved.split(path.sep).filter(Boolean);
  const crumbs: Array<{ name: string; path: string }> = [{ name: path.sep, path: path.sep }];
  let acc = '';
  for (const part of parts) {
    acc += `${path.sep}${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

async function listChildren(
  root: string,
  showHidden: boolean,
  registered: ReadonlySet<string>,
): Promise<{ children: FolderChild[]; truncated: boolean; totalCount: number }> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    throw new StudioError(400, `이 폴더를 읽을 수 없습니다: ${error.message}`);
  });

  const dirNames: string[] = [];
  for (const entry of entries) {
    if (NEVER_LIST.has(entry.name)) continue;
    if (!showHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      dirNames.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink() && (await isDirectory(path.join(root, entry.name)))) dirNames.push(entry.name);
  }
  dirNames.sort((a, b) => a.localeCompare(b, 'ko'));

  const totalCount = dirNames.length;
  const capped = dirNames.slice(0, MAX_ENTRIES);
  const children = await Promise.all(
    capped.map(async (name): Promise<FolderChild> => {
      const absolute = path.join(root, name);
      const [hasChildren, hints] = await Promise.all([hasListableChild(absolute), folderHints(absolute)]);
      if (registered.has(absolute)) hints.push('registered');
      return { name, path: absolute, hasChildren, hints };
    }),
  );
  return { children, truncated: totalCount > MAX_ENTRIES, totalCount };
}

async function hasListableChild(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && !NEVER_LIST.has(entry.name) && !entry.name.startsWith('.'));
}

/** 해당 폴더 바로 아래만 본다(하위 폴더까지 뒤지지 않는다) — 목록을 훑는 화면이라 가볍게 유지한다 */
async function folderHints(dir: string): Promise<FolderHint[]> {
  const hints: FolderHint[] = [];
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
    if (deps.next) hints.push('nextjs');
    else if (deps.vite) hints.push('vite');
  }
  const gradle = (await readText(path.join(dir, 'build.gradle.kts'))) ?? (await readText(path.join(dir, 'build.gradle')));
  const pom = await readText(path.join(dir, 'pom.xml'));
  if (gradle?.includes('org.springframework.boot') || pom?.includes('spring-boot')) hints.push('spring-boot');
  const requirements = await readText(path.join(dir, 'requirements.txt'));
  const pyproject = await readText(path.join(dir, 'pyproject.toml'));
  if (/(^|\n)\s*fastapi\b/i.test(requirements ?? '') || /["']fastapi/i.test(pyproject ?? '') || /(^|\n)\s*fastapi\s*=/i.test(pyproject ?? '')) hints.push('fastapi');
  if (await anyExists(dir, COMPOSE_FILE_CANDIDATES)) hints.push('compose');
  if (await exists(path.join(dir, '.git'))) hints.push('git');
  if (await exists(path.join(dir, SPEC_FILE))) hints.push('studio-yaml');
  return hints;
}

async function shortcutsFor(registry: readonly RegisteredProject[]): Promise<FolderShortcut[]> {
  const home = homedir();
  const places: FolderShortcut[] = [{ label: '홈', path: home }];
  for (const [label, rel] of [
    ['바탕화면', 'Desktop'],
    ['문서', 'Documents'],
    ['Developer', 'Developer'],
    ['Projects', 'Projects'],
  ] as const) {
    const candidate = path.join(home, rel);
    if (await isDirectory(candidate)) places.push({ label, path: candidate });
  }

  const sorted = [...registry].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const recent: FolderShortcut[] = [];
  for (const entry of sorted) {
    if (recent.length >= RECENT_LIMIT) break;
    if (await isDirectory(entry.path)) recent.push({ label: path.basename(entry.path), path: entry.path, recent: true });
  }
  return [...places, ...recent];
}

async function anyExists(dir: string, fileNames: readonly string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await exists(path.join(dir, fileName))) return true;
  }
  return false;
}

async function isDirectory(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function readText(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined);
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

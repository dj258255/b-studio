/**
 * 아무 폴더나 프로젝트로 등록한다(ADR-067). 등록한 폴더 목록은 `~/.config/b-studio/projects.json`(B_STUDIO_PROJECT_REGISTRY)에 둔다.
 * 폴더에 studio.yaml이 없으면 project-detect가 제안한 파일을 폴더에 쓰고, git 저장소면 `.git/info/exclude`로 추적에서 뺀다
 * (저장소의 기록·상태는 바뀌지 않는다). 개인 PC 전용이다 — 서버가 아무 경로나 읽고 쓰게 되므로 로컬 폴더를 허용한 모드에서만 쓴다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { detectProject, GENERATED_COMPOSE, GENERATED_DOCKERFILE, generateFiles, SPEC_FILE, withWorkspace, type GeneratedFile, type ProjectDetection } from './project-detect';
import { writeServiceSelection } from './service-selection';

export interface RegisteredProject {
  id: string;
  /** 절대 경로 */
  path: string;
  addedAt: string;
  /**
   * b-studio가 마지막으로 이 폴더에 쓴 생성 파일의 내용 해시(경로 → sha256, ADR-101). "생성 파일 다시 만들기"가
   * 디스크의 지금 내용과 비교해, 사람이 그사이 손으로 고쳤는지(해시가 다르면 손으로 고친 것)를 판단하는 기준이다.
   * 직접 만든 studio.yaml을 쓰는 프로젝트(hasSpec)는 애초에 쓴 파일이 없어 이 값이 비어 있다.
   */
  generatedHashes?: Record<string, string>;
}

interface RegistryFile {
  version: 1;
  projects: RegisteredProject[];
}

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

export function registryPath(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.B_STUDIO_PROJECT_REGISTRY?.trim() || path.join(homedir(), '.config', 'b-studio', 'projects.json'));
}

export async function readRegistry(file = registryPath()): Promise<RegisteredProject[]> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (!text) return [];
  try {
    const data = JSON.parse(text) as Partial<RegistryFile>;
    return (data.projects ?? []).filter((entry) => typeof entry?.id === 'string' && typeof entry?.path === 'string' && PROJECT_ID.test(entry.id));
  } catch {
    // 손으로 고치다 깨진 파일은 빈 목록으로 보고, 다음 등록이 새로 쓴다(기존 폴더는 지우지 않는다)
    return [];
  }
}

async function writeRegistry(projects: readonly RegisteredProject[], file = registryPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, projects: [...projects] } satisfies RegistryFile, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 이번에 쓴 생성 파일의 해시를 그 프로젝트의 레지스트리 항목에 남긴다(다음 "생성 파일 다시 만들기"가 손으로 고친 파일을 가려내는 기준) */
async function recordGeneratedHashes(id: string, files: readonly GeneratedFile[], file = registryPath()): Promise<void> {
  if (files.length === 0) return;
  const projects = await readRegistry(file);
  const addition = Object.fromEntries(files.map((entry) => [entry.path, sha256(entry.content)]));
  const next = projects.map((entry) => (entry.id === id ? { ...entry, generatedHashes: { ...entry.generatedHashes, ...addition } } : entry));
  await writeRegistry(next, file);
}

/** 폴더 이름으로 id를 만든다. 다른 프로젝트와 겹치면 뒤에 번호를 붙인다 */
export function projectIdFor(folder: string, taken: ReadonlySet<string>): string {
  const base =
    path
      .basename(folder)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  let id = PROJECT_ID.test(base) ? base : `p-${base}`;
  for (let index = 2; taken.has(id); index++) id = `${base}-${index}`;
  return id;
}

export interface FolderProposal {
  detection: ProjectDetection;
  /** 쓸 파일(이미 studio.yaml이 있으면 비어 있다) */
  files: GeneratedFile[];
  /** 이미 등록한 폴더면 그 id */
  registeredId?: string;
}

/** 지원 스택이 아닌 폴더를 코드·테스트만으로 등록하는 선택(#946). test는 workflow.tests에 그대로 들어가는 exec 꼴 명령이다 */
export interface WorkspaceChoice {
  test: readonly string[];
}

/** 등록하기 전에 무엇을 할지 보여 준다(쓰지 않는다). workspace를 주면 그 선택으로 만들 파일까지 보여 준다 */
export async function proposeFolder(folder: string, file = registryPath(), { workspace }: { workspace?: WorkspaceChoice } = {}): Promise<FolderProposal> {
  const found = await detectProject(folder);
  const detection = workspace ? withWorkspace(found, workspace.test) : found;
  const registered = (await readRegistry(file)).find((entry) => entry.path === detection.folder);
  return { detection, files: generateFiles(detection), ...(registered ? { registeredId: registered.id } : {}) };
}

/**
 * 폴더를 등록한다. 제안 파일을 쓰고(사용자 파일은 덮어쓰지 않는다) git 추적에서 뺀 뒤, b-studio가 실제로 읽을 수 있는지 확인하고 목록에 올린다.
 * takenIds는 다른 곳(예제 폴더)의 프로젝트 id. 같은 폴더를 다시 등록하면 기존 id를 돌려준다.
 * selectedInfra를 주면(폴더 열기 미리보기의 체크박스, ADR-083) 그 부가 서비스만 기본으로 띄우도록 서비스 선택을 저장한다.
 * 주지 않으면 detection.defaultInfra(앱이 기대는 부가 서비스의 닫힘)를 쓴다 — 아무도 기대지 않는 부가 서비스는 기본으로 뜨지 않는다.
 * 두 단계 탐색이 찾은, defaultSelected: false가 붙은 서비스(이미 찾은 서비스 하위의 또 다른 빌드)도 같은 식으로 처음부터 꺼 둔다.
 * workspace를 주면(#946) 지원 스택이 아닌 폴더를 코드·테스트만으로 등록한다. 테스트 명령이 비면 거절한다
 */
export async function registerFolder(
  folder: string,
  takenIds: ReadonlySet<string>,
  file = registryPath(),
  { selectedInfra, workspace }: { selectedInfra?: readonly string[]; workspace?: WorkspaceChoice } = {},
): Promise<{ id: string; created: boolean; written: string[]; excluded: boolean }> {
  const proposal = await proposeFolder(folder, file, workspace ? { workspace } : {});
  const root = proposal.detection.folder;
  if (!proposal.detection.hasSpec && proposal.files.length === 0) {
    throw new Error(proposal.detection.warnings[0] ?? '이 폴더에서 돌릴 서비스를 찾지 못했습니다');
  }

  const written: string[] = [];
  for (const generated of proposal.files) {
    const target = path.join(root, generated.path);
    // 사용자가 만든 studio.yaml은 덮어쓰지 않는다(여기 오기 전에 hasSpec으로 걸러지지만 경쟁을 막는다). 우리 이름의 파일만 다시 쓴다
    if (generated.path === SPEC_FILE && (await exists(target))) throw new Error(`${SPEC_FILE}이 이미 있습니다. 새로 고침한 뒤 다시 여세요`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, generated.content);
    written.push(generated.path);
  }
  const excluded = written.length > 0 ? await excludeFromGit(root, written) : false;

  // b-studio가 실제로 읽을 수 있어야 등록한다(틀린 추측이면 여기서 이유와 함께 멈춘다)
  await loadProject(root);

  const projects = await readRegistry(file);
  const existing = projects.find((entry) => entry.path === root);
  const id = existing?.id ?? projectIdFor(root, new Set([...takenIds, ...projects.map((entry) => entry.id)]));
  if (!existing) await writeRegistry([...projects, { id, path: root, addedAt: new Date().toISOString() }], file);
  // 이번에 쓴 파일의 해시를 남겨 둬야 나중에 "생성 파일 다시 만들기"가 사람이 손으로 고친 파일을 가려낼 수 있다
  await recordGeneratedHashes(id, proposal.files, file);

  // 두 단계 탐색(apps/* 등)으로 이미 찾은 서비스 하위의 또 다른 빌드까지 넣었을 때는 defaultSelected: false가 붙는다
  // (예: commerce/consumer-app) — 그런 서비스가 있으면 부가 서비스가 없어도 선택을 적어 기본으로 띄우지 않는다
  const hasOptedOutService = proposal.detection.services.some((service) => service.defaultSelected === false);
  if (proposal.detection.infra.length > 0 || hasOptedOutService) {
    const infraSelected = new Set(selectedInfra ?? proposal.detection.defaultInfra);
    const selected = [
      ...proposal.detection.services.filter((service) => service.defaultSelected !== false).map((service) => service.name),
      ...proposal.detection.infra.filter((service) => infraSelected.has(service.name)).map((service) => service.name),
    ];
    await writeServiceSelection(id, selected);
  }

  return { id, created: !existing, written, excluded };
}

/** 목록에서만 뺀다. 폴더와 만든 파일은 그대로 둔다 */
export async function unregisterProject(id: string, file = registryPath()): Promise<boolean> {
  const projects = await readRegistry(file);
  const next = projects.filter((entry) => entry.id !== id);
  if (next.length === projects.length) return false;
  await writeRegistry(next, file);
  return true;
}

/**
 * 만든 파일을 git 추적에서 뺀다. `.git/info/exclude`는 저장소에 커밋되지 않는 개인 무시 목록이라 저장소 기록이 바뀌지 않는다.
 * git 저장소가 아니거나 워크트리(.git이 파일)면 빼지 않고 false를 돌려준다
 */
export async function excludeFromGit(root: string, files: readonly string[]): Promise<boolean> {
  const gitDir = path.join(root, '.git');
  if (!(await stat(gitDir).then((info) => info.isDirectory(), () => false))) return false;
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  const current = (await readFile(excludeFile, 'utf8').catch(() => '')) ?? '';
  const lines = new Set(current.split('\n').map((line) => line.trim()));
  const wanted = files.map((file) => (file.endsWith(GENERATED_DOCKERFILE) ? GENERATED_DOCKERFILE : `/${file}`));
  const missing = [...new Set(wanted)].filter((line) => !lines.has(line));
  if (missing.length === 0) return true;
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  // 사용자 저장소에 남는 글이라 내부 문서 번호를 붙이지 않는다. 이 머리글을 찾아 읽는 코드는 없다(줄 단위로만 비교한다)
  await appendFile(excludeFile, `${prefix}# b-studio가 만든 파일\n${missing.join('\n')}\n`);
  return true;
}

/**
 * 세션 복사본에 b-studio가 만든 파일을 넣는다. 원본이 git 저장소면 세션은 커밋된 상태만 복제하므로, 추적에서 뺀 생성 파일이 빠진다.
 * 복사본에 없는 것만 넣고, 복사본 저장소의 무시 목록에도 넣어 세션 체크포인트·PR 커밋에 섞이지 않게 한다.
 * gitRoot는 복사본 저장소 폴더(모노레포 하위 폴더 프로젝트면 projectRoot의 상위)
 */
export async function overlayGeneratedFiles(sourceRoot: string, projectRoot: string, gitRoot: string): Promise<string[]> {
  const candidates = [SPEC_FILE, GENERATED_COMPOSE, ...(await generatedDockerfiles(sourceRoot))];
  const copied: string[] = [];
  for (const relative of candidates) {
    const from = path.join(sourceRoot, relative);
    const to = path.join(projectRoot, relative);
    if (!(await exists(from)) || (await exists(to))) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    copied.push(relative);
  }
  if (copied.length > 0) {
    const prefix = path.relative(gitRoot, projectRoot).split(path.sep).join('/');
    await excludeFromGit(gitRoot, copied.map((relative) => (prefix ? `${prefix}/${relative}` : relative)));
  }
  return copied;
}

/** 덧씌울 때 건너뛰는 폴더. 서비스 폴더가 아니고 크기만 큰 곳들이다 */
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'target', '.next', '.gradle', 'out', 'coverage']);

/**
 * 폴더 아래 두 단계까지의 Dockerfile.b-studio. project-detect가 서비스를 찾는 깊이(루트, 한 단계, apps/web·commerce/consumer-app 같은
 * 두 단계)와 같아야 한다. 깊이가 어긋나면 세션 복사본에 하위 서비스의 Dockerfile이 빠져 compose build가 실패한다(트러블슈팅 60)
 */
async function generatedDockerfiles(root: string, depth = 2, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  if (await exists(path.join(root, prefix, GENERATED_DOCKERFILE))) found.push(prefix ? `${prefix}/${GENERATED_DOCKERFILE}` : GENERATED_DOCKERFILE);
  if (depth === 0) return found;
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    found.push(...(await generatedDockerfiles(root, depth - 1, prefix ? `${prefix}/${entry.name}` : entry.name)));
  }
  return found;
}

/**
 * 지금 이 프로젝트 폴더에 있는 생성 파일(studio.yaml·compose.b-studio.yaml·Dockerfile.b-studio) 경로. CheckpointStore의
 * excludedFiles 제공자로 넘겨, 체크포인트가 git 추적에서 뺀(.git/info/exclude, ADR-067) 이 파일들도 되돌리기·복원에서
 * 그 시점 내용으로 맞출 수 있게 한다(도그푸딩 마찰 127, ADR-141). 디스크에 없는 후보는 뺀다 — 사용자가 직접 만든
 * studio.yaml을 쓰는 프로젝트도 이 후보에 들어가지만, CheckpointStore가 실제로 git이 무시하는 파일만 걸러 쓰므로
 * (평범하게 추적되는 파일이라) 아무 영향이 없다.
 */
export async function generatedFilePaths(projectRoot: string): Promise<string[]> {
  const candidates = [SPEC_FILE, GENERATED_COMPOSE, ...(await generatedDockerfiles(projectRoot))];
  const found: string[] = [];
  for (const file of candidates) if (await exists(path.join(projectRoot, file))) found.push(file);
  return found;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

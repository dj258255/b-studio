/**
 * 아무 폴더나 프로젝트로 등록한다(ADR-067). 등록한 폴더 목록은 `~/.config/b-studio/projects.json`(B_STUDIO_PROJECT_REGISTRY)에 둔다.
 * 폴더에 studio.yaml이 없으면 project-detect가 제안한 파일을 폴더에 쓰고, git 저장소면 `.git/info/exclude`로 추적에서 뺀다
 * (저장소의 기록·상태는 바뀌지 않는다). 개인 PC 전용이다 — 서버가 아무 경로나 읽고 쓰게 되므로 로컬 폴더를 허용한 모드에서만 쓴다.
 */
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { detectProject, GENERATED_COMPOSE, GENERATED_DOCKERFILE, generateFiles, SPEC_FILE, type GeneratedFile, type ProjectDetection } from './project-detect';
import { writeServiceSelection } from './service-selection';

export interface RegisteredProject {
  id: string;
  /** 절대 경로 */
  path: string;
  addedAt: string;
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
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, projects: [...projects] } satisfies RegistryFile, null, 2)}\n`);
  await rename(temporary, file);
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

/** 등록하기 전에 무엇을 할지 보여 준다(쓰지 않는다) */
export async function proposeFolder(folder: string, file = registryPath()): Promise<FolderProposal> {
  const detection = await detectProject(folder);
  const registered = (await readRegistry(file)).find((entry) => entry.path === detection.folder);
  return { detection, files: generateFiles(detection), ...(registered ? { registeredId: registered.id } : {}) };
}

/**
 * 폴더를 등록한다. 제안 파일을 쓰고(사용자 파일은 덮어쓰지 않는다) git 추적에서 뺀 뒤, b-studio가 실제로 읽을 수 있는지 확인하고 목록에 올린다.
 * takenIds는 다른 곳(예제 폴더)의 프로젝트 id. 같은 폴더를 다시 등록하면 기존 id를 돌려준다.
 * selectedInfra를 주면(폴더 열기 미리보기의 체크박스, ADR-083) 그 부가 서비스만 기본으로 띄우도록 서비스 선택을 저장한다.
 * 주지 않으면 detection.defaultInfra(앱이 기대는 부가 서비스의 닫힘)를 쓴다 — 아무도 기대지 않는 부가 서비스는 기본으로 뜨지 않는다
 */
export async function registerFolder(
  folder: string,
  takenIds: ReadonlySet<string>,
  file = registryPath(),
  { selectedInfra }: { selectedInfra?: readonly string[] } = {},
): Promise<{ id: string; created: boolean; written: string[]; excluded: boolean }> {
  const proposal = await proposeFolder(folder, file);
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

  if (proposal.detection.infra.length > 0) {
    const infraSelected = new Set(selectedInfra ?? proposal.detection.defaultInfra);
    const selected = [...proposal.detection.services.map((service) => service.name), ...proposal.detection.infra.filter((service) => infraSelected.has(service.name)).map((service) => service.name)];
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
  await appendFile(excludeFile, `${prefix}# b-studio가 만든 파일(ADR-067)\n${missing.join('\n')}\n`);
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

/** 폴더 바로 아래와 한 단계 아래의 Dockerfile.b-studio (project-detect가 서비스를 찾는 깊이와 같다) */
async function generatedDockerfiles(root: string): Promise<string[]> {
  const found: string[] = [];
  if (await exists(path.join(root, GENERATED_DOCKERFILE))) found.push(GENERATED_DOCKERFILE);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (await exists(path.join(root, entry.name, GENERATED_DOCKERFILE))) found.push(`${entry.name}/${GENERATED_DOCKERFILE}`);
  }
  return found;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}


/**
 * 아무 폴더나 프로젝트로 등록한다(ADR-067). 등록한 폴더 목록은 `~/.config/b-studio/projects.json`(B_STUDIO_PROJECT_REGISTRY)에 둔다.
 * 폴더에 studio.yaml이 없으면 project-detect가 제안한 파일을 폴더에 쓰고, git 저장소면 `.git/info/exclude`로 추적에서 뺀다
 * (저장소의 기록·상태는 바뀌지 않는다). 개인 PC 전용이다 — 서버가 아무 경로나 읽고 쓰게 되므로 로컬 폴더를 허용한 모드에서만 쓴다.
 */
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { StudioError } from './errors';
import { detectProject, GENERATED_COMPOSE, GENERATED_DOCKERFILE, generateFiles, SPEC_FILE, type GeneratedFile, type ProjectDetection } from './project-detect';
import { writeServiceSelection } from './service-selection';
import { unifiedDiff } from './text-diff';

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
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, projects: [...projects] } satisfies RegistryFile, null, 2)}\n`);
  await rename(temporary, file);
}

/** 등록한 프로젝트 하나. 없으면 undefined(id가 틀렸거나 등록을 지운 경우) */
export async function findRegisteredProject(id: string, file = registryPath()): Promise<RegisteredProject | undefined> {
  return (await readRegistry(file)).find((entry) => entry.id === id);
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
 * 주지 않으면 detection.defaultInfra(앱이 기대는 부가 서비스의 닫힘)를 쓴다 — 아무도 기대지 않는 부가 서비스는 기본으로 뜨지 않는다.
 * 두 단계 탐색이 찾은, defaultSelected: false가 붙은 서비스(이미 찾은 서비스 하위의 또 다른 빌드)도 같은 식으로 처음부터 꺼 둔다
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

export interface GeneratedFileDiff {
  /** 프로젝트 폴더 기준 */
  path: string;
  /** 지금 디스크에 있는 내용. 아직 없는 파일(새로 생기는 서비스 등)이면 없다 */
  oldContent?: string;
  newContent: string;
  /** 디스크 내용의 해시가 b-studio가 마지막으로 쓴 해시와 달라, 사람이 손으로 고쳤을 수 있다는 뜻 */
  handEdited: boolean;
  /** 옛 내용과 새 내용이 다른가. false면 다시 쓸 필요가 없다(변경 없음) */
  changed: boolean;
  /** changed일 때 git diff 형식 문자열. 새로 생기는 파일(oldContent 없음)이면 비워 둔다 — 화면이 전체 내용을 보여준다 */
  diff: string;
}

export interface RegenerationProposal {
  detection: ProjectDetection;
  files: GeneratedFileDiff[];
  /** false면 이 프로젝트는 b-studio가 만든 파일을 쓰지 않아(직접 만든 studio.yaml) 다시 만들 것이 없다 */
  eligible: boolean;
  reason?: string;
  /** 생성 기록(해시)이 없는 옛 프로젝트라 직접 고친 내용인지 알 수 없다 — 화면이 차이를 꼭 확인하라고 안내한다 */
  unverified?: boolean;
}

/** 폴더 열기가 만든 studio.yaml의 첫 줄 표시. 생성 기록(해시)이 생기기 전에 연 프로젝트도 이것으로 알아본다 */
const GENERATED_SPEC_MARKER = '# b-studio가 폴더를 보고 만든 설정';

/**
 * "생성 파일 다시 만들기"(ADR-101)의 미리보기: 지금 폴더를 다시 훑어(project-detect) 디스크의 생성 파일과 비교한다.
 * 아무것도 쓰지 않는다(proposeFolder와 같은 생각) — 적용은 applyRegeneration이 한다.
 */
export async function proposeRegeneration(id: string, file = registryPath()): Promise<RegenerationProposal> {
  const registered = await findRegisteredProject(id, file);
  if (!registered) throw new StudioError(404, '등록한 폴더 프로젝트를 찾지 못했습니다');
  const hasHashes = Boolean(registered.generatedHashes && Object.keys(registered.generatedHashes).length > 0);
  // 생성 기록이 생기기 전에 연 프로젝트는 해시가 없다. studio.yaml 첫 줄이 b-studio 표시면 b-studio가 만든 파일로 보고
  // 다시 만들기를 허용하되, 직접 고친 내용인지는 알 수 없으니 차이를 확인하라고 알린다
  const legacyGenerated = !hasHashes && ((await readText(path.join(registered.path, 'studio.yaml'))) ?? '').startsWith(GENERATED_SPEC_MARKER);
  if (!hasHashes && !legacyGenerated) {
    const detection = await detectProject(registered.path);
    return { detection, files: [], eligible: false, reason: '이 프로젝트는 직접 만든 studio.yaml을 씁니다. b-studio가 만든 파일이 없어 다시 만들 것이 없습니다' };
  }

  // hasSpec 때문에 바로 멈추지 않도록, 지금 있는 studio.yaml이 없다고 치고 폴더를 처음 열 때처럼 다시 훑는다
  const detection = await detectProject(registered.path, { ignoreExistingSpec: true });
  const freshFiles = generateFiles(detection);
  if (freshFiles.length === 0) {
    return { detection, files: [], eligible: false, reason: detection.warnings[0] ?? '지금은 이 폴더에서 돌릴 서비스를 찾지 못해 다시 만들 파일이 없습니다' };
  }

  const files: GeneratedFileDiff[] = [];
  for (const generated of freshFiles) {
    const oldContent = await readText(path.join(registered.path, generated.path));
    const lastHash = registered.generatedHashes?.[generated.path];
    const handEdited = oldContent !== undefined && lastHash !== undefined && sha256(oldContent) !== lastHash;
    const changed = oldContent !== generated.content;
    const diff = changed && oldContent !== undefined ? await unifiedDiff(generated.path, oldContent, generated.content) : '';
    files.push({ path: generated.path, oldContent, newContent: generated.content, handEdited, changed, diff });
  }
  return {
    detection,
    files,
    eligible: true,
    ...(legacyGenerated
      ? { unverified: true, reason: '이 프로젝트는 생성 기록이 남기 전에 열어, 직접 고친 내용이 있는지 알 수 없습니다. 아래 차이를 확인한 뒤 덮어쓰세요' }
      : {}),
  };
}

/**
 * 고른 파일만 다시 쓴다(사람이 미리보기에서 파일별로 "덮어쓰기"를 고른 것, overwrite). 손으로 고친 파일을 경고했는데도
 * 덮어쓰기를 고르면 그대로 사라진다 — 미리보기가 이미 경고했으므로 여기서는 다시 확인하지 않는다.
 */
export async function applyRegeneration(id: string, overwrite: readonly string[], file = registryPath()): Promise<{ written: string[] }> {
  const proposal = await proposeRegeneration(id, file);
  if (!proposal.eligible) throw new StudioError(409, proposal.reason ?? '다시 만들 파일이 없습니다');
  const registered = (await findRegisteredProject(id, file))!;
  const chosen = new Set(overwrite);

  const written: string[] = [];
  for (const entry of proposal.files) {
    if (!entry.changed || !chosen.has(entry.path)) continue;
    const target = path.join(registered.path, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.newContent);
    written.push(entry.path);
  }
  if (written.length > 0) {
    await excludeFromGit(registered.path, written);
    await recordGeneratedHashes(
      id,
      proposal.files.filter((entry) => written.includes(entry.path)).map((entry) => ({ path: entry.path, content: entry.newContent })),
      file,
    );
  }
  return { written };
}

/**
 * "이 세션에도 적용"(ADR-101): 다시 만든 생성 파일을 이미 떠 있는 세션의 작업 복사본에 덮어쓴다.
 * overlayGeneratedFiles(세션을 만들 때 쓴다)는 복사본에 이미 있는 파일을 건드리지 않지만, 여기서는 사람이 명시적으로
 * "적용"을 눌렀으므로 넘겨준 파일만 무조건 덮어쓴다. 영향받은 서비스를 재시작하는 것은 호출하는 쪽(sessions.ts)의 일이다.
 */
export async function applyGeneratedFilesToWorkingCopy(sourceRoot: string, projectRoot: string, gitRoot: string, files: readonly string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const relative of files) {
    const from = path.join(sourceRoot, relative);
    if (!(await exists(from))) continue;
    const to = path.join(projectRoot, relative);
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

async function readText(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined);
}


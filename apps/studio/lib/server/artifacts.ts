import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 화면 확인이 남긴 스크린샷과 요소 선택 스크린샷을 세션 폴더에 저장하고 제공한다.
 * 저장 위치는 체크포인트 Git 저장소 안(`<세션 폴더>/.git/b-studio/artifacts`)이다.
 * 작업 폴더에 두면 `git add -A`가 커밋에 넣고 되돌리기의 `git clean -fd`가 지워 버린다
 */
export const MAX_ARTIFACTS = 200;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const NAME_MAX = 80;

export type ArtifactContentType = 'image/png' | 'image/jpeg';

export interface ArtifactInput {
  /** 사람이 읽는 이름. 파일 이름으로 안전하게 바꾼다 */
  name: string;
  data: Buffer;
  contentType: ArtifactContentType;
}

/** 라우트가 HTTP 상태로 바꿔 돌려줄 수 있는 오류 */
export class ArtifactError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.status = status;
  }
}

const EXTENSION: Record<ArtifactContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const CONTENT_TYPE: Record<string, ArtifactContentType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export function artifactRoot(stateDir: string): string {
  return path.join(stateDir, '.git', 'b-studio', 'artifacts');
}

/** 파일 이름에 쓸 수 없는 글자를 '-'로 바꾸고 길이를 줄인다. 확장자는 저장할 때 따로 붙인다 */
export function safeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, NAME_MAX)
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'artifact';
}

/** 실행 식별자(runId)에서 폴더 이름으로 쓸 수 있는 부분만 남긴다. 서버가 만든 값이지만 경로 탈출을 막아 둔다 */
function runSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'run';
}

/** 이미 있는 파일 다음 순번. 지워진 번호를 다시 쓰지 않도록 가장 큰 번호에 1을 더한다 */
async function nextOrdinal(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let max = 0;
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * 산출물을 저장하고 식별자(`<runId>/<파일명>`)를 돌려준다. 파일은 0600, 폴더는 0700으로 만든다.
 * 저장 뒤 세션 한도(최대 200개·50MB)를 넘으면 오래된 실행 폴더부터 지운다
 */
export async function saveArtifact(stateDir: string, runId: string, input: ArtifactInput): Promise<string> {
  const root = artifactRoot(stateDir);
  const run = runSegment(runId);
  const dir = path.join(root, run);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = `${String(await nextOrdinal(dir)).padStart(3, '0')}-${safeName(input.name)}.${EXTENSION[input.contentType]}`;
  await writeFile(path.join(dir, filename), input.data, { mode: 0o600 });
  await enforceLimits(root);
  return `${run}/${filename}`;
}

/**
 * 식별자에 해당하는 파일과 content-type. 세션 산출물 폴더 밖은 거부한다.
 * `..`이나 절대 경로를 먼저 막고, 정규화한 뒤 접두어로 한 번 더 확인한다
 */
export async function resolveArtifact(stateDir: string, segments: readonly string[]): Promise<{ file: string; contentType: ArtifactContentType }> {
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArtifactError(400, '산출물 경로가 올바르지 않습니다');
  }
  const rel = segments.join('/');
  if (path.isAbsolute(rel) || rel.includes('\0') || /^[a-zA-Z]:/.test(rel)) throw new ArtifactError(400, '산출물 경로가 올바르지 않습니다');
  const root = artifactRoot(stateDir);
  const file = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!file.startsWith(prefix)) throw new ArtifactError(400, '세션 산출물 폴더 밖은 볼 수 없습니다');
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new ArtifactError(404, '산출물을 찾을 수 없습니다');
  const contentType = CONTENT_TYPE[path.extname(file).toLowerCase()];
  if (!contentType) throw new ArtifactError(404, '지원하지 않는 산출물 형식입니다');
  return { file, contentType };
}

interface RunUsage {
  name: string;
  at: number;
  files: number;
  bytes: number;
}

async function measureRun(root: string, name: string): Promise<RunUsage> {
  const dir = path.join(root, name);
  const info = await stat(dir).catch(() => undefined);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const size = await stat(path.join(dir, entry.name)).then((entryInfo) => entryInfo.size, () => 0);
    files += 1;
    bytes += size;
  }
  return { name, at: info?.mtimeMs ?? 0, files, bytes };
}

/** 한도를 넘으면 오래된 실행 폴더부터 통째로 지운다. 마지막 하나는 남겨 진행 중인 실행의 산출물을 지우지 않는다 */
async function enforceLimits(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => measureRun(root, entry.name)));
  // 오래된 것부터. 같은 시각이면 이름으로 순서를 고정한다
  runs.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  let files = runs.reduce((sum, run) => sum + run.files, 0);
  let bytes = runs.reduce((sum, run) => sum + run.bytes, 0);
  let remaining = runs.length;
  for (const run of runs) {
    if (files <= MAX_ARTIFACTS && bytes <= MAX_ARTIFACT_BYTES) break;
    if (remaining <= 1) break;
    await rm(path.join(root, run.name), { recursive: true, force: true });
    files -= run.files;
    bytes -= run.bytes;
    remaining -= 1;
  }
}

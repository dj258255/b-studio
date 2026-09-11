import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 에이전트가 읽거나 쓰면 안 되는 디렉터리. 생성물이거나 거대하거나 비밀이 들어 있다 */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules', '.next', 'build', '.gradle', '.venv', '__pycache__']);
const DENIED_FILES = [/^\.env(\..*)?$/];

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * 프로젝트 루트 안에서만 파일을 다루는 작업 공간.
 * - 루트 밖 경로, 심볼릭 링크 탈출, 생성물·비밀 파일 접근을 막는다
 * - 에이전트가 읽은 뒤 파일이 바뀌었으면 덮어쓰지 않는다 (사람의 수정 보호)
 * - 에이전트가 바꾼 파일 목록을 기록해 검증 단계가 어떤 서비스를 재시작할지 알 수 있게 한다
 */
export class Workspace {
  readonly root: string;
  readonly #seen = new Map<string, string>();
  /** 파일 → 마지막으로 바뀐 시점의 버전 */
  readonly #changed = new Map<string, number>();
  #version = 0;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** 쓰기가 일어날 때마다 1씩 오른다. 검증 게이트가 "지난 검증 이후 바뀐 파일"을 고를 때 쓴다 */
  get version(): number {
    return this.#version;
  }

  /** 에이전트가 이번 실행에서 만들거나 수정한 파일 (루트 기준 경로) */
  changedFiles(): string[] {
    return [...this.#changed.keys()].sort();
  }

  /** 주어진 버전 이후에 바뀐 파일 */
  changedSince(version: number): string[] {
    return [...this.#changed.entries()]
      .filter(([, changedAt]) => changedAt > version)
      .map(([file]) => file)
      .sort();
  }

  async list(dir = '.', depth = 3): Promise<string[]> {
    const start = await this.#resolve(dir, { mustExist: true });
    const entries: string[] = [];

    const walk = async (absolute: string, remaining: number): Promise<void> => {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        if (isDenied(child.name)) continue;
        const childPath = path.join(absolute, child.name);
        const relative = this.#relative(childPath);
        if (child.isDirectory()) {
          entries.push(`${relative}/`);
          if (remaining > 1) await walk(childPath, remaining - 1);
        } else if (child.isFile()) {
          entries.push(relative);
        }
      }
    };

    await walk(start, depth);
    return entries;
  }

  async read(file: string): Promise<string> {
    const absolute = await this.#resolve(file, { mustExist: true });
    const buffer = await readFile(absolute);
    if (buffer.byteLength > MAX_READ_BYTES) {
      throw new WorkspaceError(`${file}: 파일이 너무 큽니다 (${buffer.byteLength} bytes)`);
    }
    const content = buffer.toString('utf8');
    this.#seen.set(this.#relative(absolute), digest(content));
    return content;
  }

  async write(file: string, content: string): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: false });
    await this.#assertNotStale(absolute);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    this.#record(absolute, content);
  }

  /** oldText가 파일에 정확히 한 번 있어야 바꾼다. 모호한 수정은 거부한다 */
  async edit(file: string, oldText: string, newText: string): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: true });
    await this.#assertNotStale(absolute);
    const current = await readFile(absolute, 'utf8');

    const first = current.indexOf(oldText);
    if (oldText.length === 0 || first === -1) {
      throw new WorkspaceError(`${file}: 바꿀 문자열을 찾지 못했습니다. read_file로 현재 내용을 다시 확인하세요`);
    }
    if (current.indexOf(oldText, first + oldText.length) !== -1) {
      throw new WorkspaceError(`${file}: 바꿀 문자열이 여러 번 나옵니다. 주변 줄을 더 포함해 한 곳만 가리키게 하세요`);
    }

    const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
    await writeFile(absolute, next);
    this.#record(absolute, next);
  }

  async #assertNotStale(absolute: string): Promise<void> {
    const relative = this.#relative(absolute);
    const seen = this.#seen.get(relative);
    if (seen === undefined) return;

    const current = await readFile(absolute, 'utf8').catch(() => undefined);
    if (current !== undefined && digest(current) !== seen) {
      throw new WorkspaceError(`${relative}: 마지막으로 읽은 뒤 다른 곳에서 파일이 바뀌었습니다. 다시 읽고 수정하세요`);
    }
  }

  #record(absolute: string, content: string): void {
    const relative = this.#relative(absolute);
    this.#seen.set(relative, digest(content));
    this.#changed.set(relative, ++this.#version);
  }

  async #resolve(file: string, { mustExist }: { mustExist: boolean }): Promise<string> {
    if (path.isAbsolute(file)) throw new WorkspaceError(`${file}: 프로젝트 루트 기준 상대 경로를 쓰세요`);

    const absolute = path.resolve(this.root, file);
    if (!isInside(this.root, absolute)) throw new WorkspaceError(`${file}: 프로젝트 밖 경로입니다`);

    const relative = path.relative(this.root, absolute);
    if (relative.split(path.sep).some(isDenied)) {
      throw new WorkspaceError(`${file}: 생성물이나 비밀 파일 경로는 다룰 수 없습니다`);
    }

    // 존재하는 가장 가까운 상위 경로의 실제 위치로 심볼릭 링크 탈출을 막는다
    const existing = await nearestExisting(absolute);
    if (mustExist && existing !== absolute) throw new WorkspaceError(`${file}: 파일이 없습니다`);
    const [realRoot, realExisting] = await Promise.all([realpath(/*turbopackIgnore: true*/ this.root), realpath(/*turbopackIgnore: true*/ existing)]);
    if (!isInside(realRoot, realExisting)) throw new WorkspaceError(`${file}: 프로젝트 밖을 가리키는 링크입니다`);

    return absolute;
  }

  #relative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join('/');
  }
}

function isDenied(segment: string): boolean {
  return DENIED_SEGMENTS.has(segment) || DENIED_FILES.some((pattern) => pattern.test(segment));
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await realpath(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

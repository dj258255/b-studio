import { createHash } from 'node:crypto';
import path from 'node:path';
import { encodeLoneSurrogates, native as guard } from '@b-studio/sandbox';

/** Windows면 역슬래시도 구분자다. 판정은 Rust가 하고 플랫폼 값만 여기서 넘긴다 */
const BACKSLASH_SEP = path.sep === '\\';

const MAX_READ_BYTES = 256 * 1024;

/** readRegularFileSync의 결과: 없음, 읽은 글, 또는 읽지 않은 이유(일반 파일이 아님·너무 큼·읽기 실패) */
export type RegularFileRead = { kind: 'missing' } | { kind: 'text'; content: string } | { kind: 'irregular'; reason: string };

/** readRegularFileBytesSync의 결과: 없음, 읽은 바이트(complete가 false면 확인한 크기만큼 다 읽지 못함), 또는 읽지 않은 이유(일반 파일이 아님·너무 큼·읽기 실패) */
export type RegularFileBytesRead = { kind: 'missing' } | { kind: 'bytes'; content: Buffer; complete: boolean } | { kind: 'irregular'; reason: string };

/**
 * 일반 파일이고 상한 이하일 때만 동기적으로 읽는다. 서버의 이벤트 루프를 막는 읽기라 조건을 좁힌다:
 * - 마지막 경로 요소가 심볼릭 링크면 따라가지 않는다(O_NOFOLLOW). 링크로 바꿔치기한 문서를 읽지 않는다
 * - FIFO·장치 같은 것은 여는 데서 멈추지 않게 O_NONBLOCK으로 열고, 연 뒤 일반 파일인지 확인한다
 * - 크기는 연 파일 자체(fstat)로 확인해, 확인과 읽기 사이에 다른 파일로 바뀌는 틈을 두지 않는다
 */
/**
 * 프로젝트 루트 기준 경로의 파일을 readRegularFileSync로 읽되, 상위 폴더 어느 것도 심볼릭 링크가 아닐 때만 읽는다.
 * readRegularFileSync의 O_NOFOLLOW는 마지막 경로 요소만 본다 — `docs` 폴더 자체를 링크로 바꾸면 그 너머의 파일이 읽힌다.
 * 상위 폴더의 실제 위치가 "루트의 실제 위치 + 같은 상대 경로"와 같은지 견줘, 링크가 하나라도 끼어 있으면 읽지 않는다.
 * 확인과 여는 것 사이에 폴더가 바뀌는 틈까지는 막지 못한다(연 뒤에 확인할 방법이 없다). 그래서 실제 위치로 연다
 */
export function readProjectFileSync(root: string, relative: string, maxBytes: number = MAX_READ_BYTES): RegularFileRead {
  const read = readProjectFileBytesSync(root, relative, maxBytes);
  return read.kind === 'bytes' ? { kind: 'text', content: read.content.toString('utf8') } : read;
}

/** readProjectFileSync와 같은 규칙으로 읽되 원본 바이트를 돌려준다(글자로 바꾸면 서로 다른 바이트가 같은 글자가 된다). 상한은 읽기 전에 본다 */
export function readProjectFileBytesSync(root: string, relative: string, maxBytes: number = MAX_READ_BYTES): RegularFileBytesRead {
  const normalized = path.normalize(relative);
  if (!isInsideRelative(normalized)) {
    return { kind: 'irregular', reason: '프로젝트 밖 경로입니다' };
  }
  // 루트의 실제 위치를 폴더 서술자로 열고 그 아래를 조각마다 링크 없이 내려간다(Rust). 확인하는 경로와 여는 경로가 같다
  return fromNativeRead(guard.workspaceReadProjectFile(root, toPosix(normalized), maxBytes));
}

export function readRegularFileSync(absolute: string, maxBytes: number = MAX_READ_BYTES): RegularFileRead {
  const read = readRegularFileBytesSync(absolute, maxBytes);
  return read.kind === 'bytes' ? { kind: 'text', content: read.content.toString('utf8') } : read;
}

/**
 * readRegularFileSync와 같은 열기 규칙(O_NOFOLLOW·일반 파일·상한)으로 원본 바이트를 읽는다(Rust).
 * 글자로 바꾸면 서로 다른 바이트가 같은 글자가 되므로(예: 0xff와 0xfe가 모두 U+FFFD '�'), 바이트가 그대로 필요한
 * 지문 비교에 쓴다. 읽는 도중 파일이 줄거나 늘어남(확인한 stat 크기만큼 다 읽지 못했거나, 뒤에 내용이 덧붙어 두 번째 stat이 달라짐)
 * 이면 complete를 false로 알린다 — 어중간하게 읽은 바이트를 지문으로 삼지 않게 하는 것은 부르는 쪽의 몫이다
 * (읽기 자체는 readRegularFileSync와 같이 동작한다)
 */
export function readRegularFileBytesSync(absolute: string, maxBytes: number = MAX_READ_BYTES): RegularFileBytesRead {
  return fromNativeRead(guard.workspaceReadRegularFile(absolute, maxBytes));
}

/** Rust의 읽기 결과를 옮긴다. 모르는 꼴은 읽지 않은 것으로 본다(닫는 쪽) */
function fromNativeRead(read: { kind: string; content?: Buffer | null; complete?: boolean | null; reason?: string | null }): RegularFileBytesRead {
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind === 'bytes' && read.content) return { kind: 'bytes', content: read.content, complete: read.complete === true };
  return { kind: 'irregular', reason: read.reason ?? '읽을 수 없습니다' };
}

/** 경로 구분자를 `/`로 맞춘다(Rust는 `/`로 조각을 나눈다). POSIX에서는 그대로다 */
function toPosix(relative: string): string {
  return path.sep === '/' ? relative : relative.split(path.sep).join('/');
}

/** Rust 쪽 실패 글(`LINK`·`OS:EACCES`…)을 읽는다. 알 수 없는 오류는 그대로 글이 된다 */
function failureCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * #resolve 뒤에 열고 읽고 쓰고 지우는 자리의 실패. 경로를 확인한 뒤에 링크로 바뀐 경우(LINK)도 여기로 온다 — 읽는 쪽이 프로젝트 밖으로 새지 않았다는 뜻이다
 * (조각마다 링크를 따라가지 않고 내려가므로 연 파일은 프로젝트 안의 것이다)
 */
function openFailure(error: unknown, label: string): WorkspaceError {
  const code = failureCode(error);
  if (code === 'LINK') return new WorkspaceError(`${label}: 연 파일이 프로젝트 밖에 있습니다(경로를 확인한 뒤 링크로 바뀌었습니다)`);
  if (code === 'OUTSIDE') return new WorkspaceError(`${label}: 프로젝트 밖 경로입니다`);
  if (code === 'DENIED') return new WorkspaceError(`${label}: 생성물이나 비밀 파일 경로는 다룰 수 없습니다`);
  if (code === 'MISSING') return new WorkspaceError(`${label}: 파일이 없습니다`);
  if (code === 'NOT_REGULAR') return new WorkspaceError(`${label}: 일반 파일이 아닙니다`);
  if (code.startsWith('TOO_LARGE:')) return new WorkspaceError(`${label}: 파일이 너무 큽니다 (${code.slice('TOO_LARGE:'.length)} bytes)`);
  if (code.startsWith('OS:')) return new WorkspaceError(`${label}: 열 수 없습니다(${code.slice('OS:'.length)})`);
  return new WorkspaceError(`${label}: 열 수 없습니다`);
}

const MAX_LIST_ENTRIES = 500;
/** 검색 한 번이 훑는 파일 수·폴더 수·읽는 양의 상한. 넘으면 거기까지 찾은 것만 돌려주고 잘렸다고 알린다 */
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_DIRECTORIES = 5_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARS = 200;

export interface SearchResult {
  matches: Array<{ file: string; line: number; text: string }>;
  /** 결과 상한이나 파일 수 상한에 걸려 더 있을 수 있다 */
  truncated: boolean;
  filesScanned: number;
}

/** 실행 시작 때 고정해 두는 요구사항 문서(requirements.ts의 REQUIREMENTS_FILE과 같은 경로 — 순환 import를 피하려 따로 적는다) */
export const REQUIREMENTS_SNAPSHOT_FILE = 'docs/requirements.md';

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
  readonly #deleted = new Set<string>();
  #version = 0;
  /** 파일 → 실행 시작 시점에 읽은 결과. snapshotRead가 처음 부른 때의 값을 고정한다 */
  readonly #snapshots = new Map<string, RegularFileRead>();
  /**
   * 보호 경로 파일 → 이 실행에서 **처음 쓰기 직전**의 내용(바이트). 이 작업 공간은 실행 하나에만 산다(러너·게이트가 실행마다 새로 만든다)
   * 따라서 고정값이 다음 실행이나 다른 세션에 남지 않는다. 고정하지 못한 파일은 'irregular'로 적어, 나중의 쓰기가 이미 바뀐 내용을 고정값으로 삼지 못하게 한다.
   * 고정(pin)과 비교(restored)는 같은 Rust 구현이 같은 읽기로 한다(ADR-195 4f A3, ADR-196 결정 5). 이미 있는 고정값은 다시 쓰지 않는다(처음 한 번만)
   */
  readonly #pins = new guard.WorkspacePinStore();
  #protectedRules: readonly string[] = [];
  #outsideSync: (() => Promise<unknown>) | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * 에이전트 실행을 시작할 때 러너가 부른다: 게이트가 실행 끝에 견줄 기준점이 되는 파일을, 에이전트가 아무것도 바꾸기
   * 전에 고정한다. 게이트는 지연 기동 세션이나 CLI 러너에서 파일이 바뀐 뒤에 만들어질 수 있어, 만들 때 읽으면 늦다.
   */
  beginRun(requirementsBaseline?: string | null): void {
    // 호출자가 마지막 체크포인트의 문서를 알고 있으면 그것을 기준으로 삼는다(디스크에는 체크포인트 없이 남은 변경이 있을 수 있다)
    if (requirementsBaseline !== undefined) {
      this.#snapshots.set(
        path.normalize(REQUIREMENTS_SNAPSHOT_FILE),
        requirementsBaseline === null ? { kind: 'missing' } : { kind: 'text', content: requirementsBaseline },
      );
      return;
    }
    this.snapshotRead(REQUIREMENTS_SNAPSHOT_FILE);
  }

  /**
   * 파일의 지금 내용을 **처음 부른 때 한 번만** 읽어 고정한다. 에이전트가 파일을 바꾸기 전에(러너가 실행을 시작할 때)
   * 불러 두면, 나중에 게이트가 "실행이 이 파일의 무엇을 바꿨나"를 견줄 기준점이 된다(요구사항 문서의 사람 확인 기록,
   * ADR-157). 에이전트 도구와 무관하게 디스크를 직접 읽으므로 읽음 기록(#seen)이나 접근 거부 규칙에 영향이 없다.
   * 파일이 없으면 undefined(실행이 새로 만든 문서도 구분할 수 있다).
   */
  snapshotFile(file: string): Promise<string | undefined> {
    const read = this.snapshotRead(file);
    return Promise.resolve(read.kind === 'text' ? read.content : undefined);
  }

  /**
   * snapshotFile과 같은 고정이지만 읽은 결과를 그대로 돌려준다(없음·글·읽을 수 없는 꼴을 구분한다).
   * 부르는 그 순간에 동기적으로 읽는다: 비동기 읽기를 던져만 두면 읽기가 끝나기 전에 파일이 바뀔 수 있고, 그러면 바뀐 내용이
   * 기준점이 되어 견줄 차이가 사라진다. 서버를 막는 읽기이므로 일반 파일이고 크기 상한 이하일 때만 읽는다(readRegularFileSync).
   * 경로는 프로젝트 루트 기준 상대 경로만 받는다
   */
  snapshotRead(file: string): RegularFileRead {
    const normalized = path.normalize(file);
    if (!isInsideRelative(normalized)) {
      throw new WorkspaceError(`${file}: 프로젝트 루트 기준 상대 경로를 쓰세요`);
    }
    let snapshot = this.#snapshots.get(normalized);
    if (!snapshot) {
      snapshot = readProjectFileSync(this.root, normalized);
      this.#snapshots.set(normalized, snapshot);
    }
    return snapshot;
  }

  /** 쓰기가 일어날 때마다 1씩 오른다. 검증 게이트가 "지난 검증 이후 바뀐 파일"을 고를 때 쓴다 */
  get version(): number {
    return this.#version;
  }

  /**
   * 보호 경로 규칙을 알린다. 이 규칙에 드는 파일만 쓰기 직전에 내용을 고정한다(pinBeforeWrite).
   * 게이트가 만들어질 때 부른다. 규칙이 비면 아무것도 고정하지 않는다(이전과 같다)
   */
  watchProtectedPaths(rules: readonly string[]): void {
    this.#protectedRules = [...rules];
  }

  /**
   * 고정하기 직전에 도구 밖 변경을 먼저 옮기는 함수를 정한다(게이트·러너의 ChangeTracker.sync).
   * 셸 같은 도구 밖 길로 이미 바뀐 파일은 그 내용을 "실행 시작 때 내용"으로 고정하면 안 된다. 옮기고 나면 그 파일은 바뀐 목록에 들어 있어 고정하지 않는다
   */
  useOutsideSync(sync: () => Promise<unknown>): void {
    this.#outsideSync = sync;
  }

  /**
   * 보호 경로 파일의 내용을 이 실행에서 **처음 쓰기 직전에 한 번** 고정한다(이슈 #992). 파일을 쓰기 직전의 관문(파일 도구, CLI의 쓰기 직전 훅)이 부른다.
   * review는 지금 내용이 이 고정값과 바이트까지 같을 때만 "쓰고 원래대로 되돌린 파일"로 본다(restoredProtectedFiles).
   * 고정하지 않는 경우(모두 "모르면 바뀐 것으로"): 보호 경로가 아니다, 이미 바뀐 목록에 있다(실행 전에 사람이 고쳤거나 셸이 먼저 고쳤다),
   * 링크이거나 일반 파일이 아니다, 상한을 넘는다, 읽지 못했다. 경로를 풀지 못해도(링크를 거친다 등) 고정하지 않는다.
   * 이 함수는 던지지 않는다 — 고정하지 못해도 쓰기는 막지 않고, 그 파일이 바뀐 것으로 남을 뿐이다
   */
  async pinBeforeWrite(file: string): Promise<void> {
    if (this.#protectedRules.length === 0) return;
    let relative: string;
    try {
      relative = this.#relative(await this.#resolve(file, { mustExist: false }));
    } catch {
      return;
    }
    await this.#pin(relative);
  }

  async #pin(relative: string): Promise<void> {
    if (this.#protectedRules.length === 0 || this.#pins.contains(relative)) return;
    // 거부 목록 쪽 맞춤이다: 넓게 맞아도 읽는 파일이 하나 늘 뿐이고, 고정값은 review가 protected-paths로 보는 파일에만 쓰인다
    if (!this.#protectedRules.some((rule) => guard.isProtectedPath(relative, rule, BACKSLASH_SEP))) return;
    const unpinned = (reason: string): void => {
      this.#pins.pinUnpinned(relative, reason);
    };
    try {
      await this.#outsideSync?.();
    } catch {
      unpinned('도구 밖 변경을 옮기지 못했습니다');
      return;
    }
    if (this.#changed.has(relative)) {
      unpinned('이미 바뀐 파일입니다');
      return;
    }
    // 읽기 전에 크기를 보고(1MiB 상한), 링크를 따라가지 않으며, 못 읽으면 그 이유가 고정값이 된다. 모두 Rust 안에서 한다
    this.#pins.pin(this.root, relative);
  }

  /**
   * files(바뀐 파일 목록) 중 쓰기 직전 고정값이 있고 지금 내용이 그 고정값과 바이트까지 같은 파일. 없던 파일(고정값이 "없음")은 지금도 없을 때만 같다.
   * 열린 쪽 판정이다(protected-paths에서 빼 준다). 그래서 고정값이 없거나 읽지 못했거나 링크·일반 파일이 아니거나 상한을 넘었거나
   * 읽는 동안 바뀌었으면 같다고 하지 않는다. 지금 내용은 링크를 따라가지 않고 읽는다(쓰는 동안 링크로 바뀐 경우도 바뀐 것이다)
   */
  restoredProtectedFiles(files: readonly string[]): string[] {
    return this.#pins.restored(this.root, [...files]);
  }

  /** 에이전트가 이번 실행에서 만들거나 수정한 파일 (루트 기준 경로) */
  changedFiles(): string[] {
    return [...this.#changed.keys()].sort();
  }

  /** 에이전트가 이번 실행에서 지운 파일 (루트 기준 경로) */
  deletedFiles(): string[] {
    return [...this.#deleted].sort();
  }

  /**
   * 에이전트 도구를 거치지 않은 편집기·명령의 변경도 같은 게이트로 검증할 수 있게 알린다.
   * 파일 내용은 읽지 않고 바뀐 목록에만 기록한다 (실제 판정은 게이트가 맡는다).
   */
  trackExternalChanges(files: readonly string[]): void {
    for (const file of files) {
      const relative = this.#normalizeExternal(file);
      this.#deleted.delete(relative);
      this.#changed.set(relative, ++this.#version);
    }
  }

  /**
   * 파일 도구가 다룰 수 있는 경로인지 본다. 읽지도 쓰지도 않는다. 다룰 수 없으면 WorkspaceError를 던진다.
   * b-studio 도구를 거치지 않는 하네스(관문 방식의 CLI 내장 도구)가 파일을 건드리기 전에 같은 규칙으로 가두려고 연다:
   * 프로젝트 밖, 링크를 거치는 경로, 숨긴 이름(.git·.env·생성물)을 파일 도구와 똑같이 거절한다.
   */
  async assertToolPath(file: string): Promise<void> {
    await this.#resolve(file, { mustExist: false });
  }

  /** 주어진 버전 이후에 바뀐 파일 */
  changedSince(version: number): string[] {
    return [...this.#changed.entries()]
      .filter(([, changedAt]) => changedAt > version)
      .map(([file]) => file)
      .sort();
  }

  async list(dir = '.', depth = 3): Promise<string[]> {
    const start = this.#relative(await this.#resolve(dir, { mustExist: true }));
    const entries: string[] = [];

    const walk = async (relativeDir: string, remaining: number): Promise<void> => {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const children = await this.#readDir(relativeDir);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        if (isDenied(child.name)) continue;
        const relative = relativeDir === '' ? child.name : `${relativeDir}/${child.name}`;
        // 종류는 링크를 따라가지 않은 것이다: 링크는 폴더도 파일도 아니라서 보여 주지 않는다
        if (child.kind === 'dir') {
          entries.push(`${relative}/`);
          if (remaining > 1) await walk(relative, remaining - 1);
        } else if (child.kind === 'file') {
          entries.push(relative);
        }
      }
    };

    await walk(start, depth);
    return entries;
  }

  async read(file: string): Promise<string> {
    const { absolute, content } = await this.#load(file);
    this.#seen.set(this.#relative(absolute), digest(content));
    return content;
  }

  /**
   * 글 파일에서 낱말(글자 그대로, 정규식 아님)이 든 줄을 찾는다. 에이전트가 컨테이너 안의 grep 대신 쓴다.
   * 목록(list)과 같은 규칙으로 숨기는 폴더·비밀 파일을 건너뛰고 링크를 따라가지 않는다. 큰 파일과 이진 파일은 건너뛴다.
   *  - 정규식을 받지 않는다. 이 코드는 studio 서버의 스레드에서 돈다. 모델이 준 정규식이 되돌아가기를 폭발시키면 서버 전체가 멈춘다.
   *  - **가린 글에서 찾는다.** 파일 내용을 먼저 통째로 가리고(redact) 그 결과에서 줄을 고른다. 원문에서 찾고 결과만 가리면,
   *    "이 낱말이 든 줄이 있는가"로 시크릿 값을 한 글자씩 알아낼 수 있고(찾았다는 사실이 새어 나간다), 줄 단위로 가리면
   *    여러 줄에 걸친 값이나 잘린 값은 가려지지 않는다.
   *  - 크기는 읽기 전에 본다. 훑는 파일 수·폴더 수·읽는 양에 상한을 두고, 넘으면 거기까지만 돌려주며 잘렸다고 알린다
   */
  async search(
    terms: readonly string[],
    target = '.',
    { limit = 50, ignoreCase = false, redact = (text: string) => text }: { limit?: number; ignoreCase?: boolean; redact?: (text: string) => string } = {},
  ): Promise<SearchResult> {
    const needles = terms.filter((term) => term.length > 0).map((term) => (ignoreCase ? term.toLowerCase() : term));
    if (needles.length === 0) throw new WorkspaceError('검색할 낱말이 없습니다');
    const start = this.#relative(await this.#resolve(target, { mustExist: true }));
    const result: SearchResult = { matches: [], truncated: false, filesScanned: 0 };
    let directories = 0;
    let bytes = 0;

    const scan = async (relative: string): Promise<void> => {
      // 링크는 따라가지 않고, 일반 파일이 아니거나 상한을 넘는 파일은 읽기 전에 건너뛴다
      const info = await this.#lstat(relative).catch(() => undefined);
      if (!info || info.kind !== 'file' || info.size > MAX_READ_BYTES) return;
      if (result.filesScanned >= MAX_SEARCH_FILES || bytes + info.size > MAX_SEARCH_BYTES) {
        result.truncated = true;
        return;
      }
      result.filesScanned += 1;
      bytes += info.size;
      // 크기를 본 뒤 여는 사이에 이 파일이 링크로 바뀌어도 따라가지 않는다
      const buffer = await readNoFollowInside(this.root, path.join(this.root, relative), relative, MAX_READ_BYTES).catch(() => undefined);
      if (!buffer || buffer.byteLength > MAX_READ_BYTES || buffer.subarray(0, 1024).includes(0)) return;
      const lines = redact(buffer.toString('utf8')).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const hay = ignoreCase ? line.toLowerCase() : line;
        if (!needles.some((needle) => hay.includes(needle))) continue;
        if (result.matches.length >= limit) {
          result.truncated = true;
          return;
        }
        result.matches.push({ file: relative, line: index + 1, text: line.length > MAX_SEARCH_LINE_CHARS ? `${line.slice(0, MAX_SEARCH_LINE_CHARS)}…` : line });
      }
    };
    const walk = async (relativeDir: string): Promise<void> => {
      if (result.truncated) return;
      directories += 1;
      if (directories > MAX_SEARCH_DIRECTORIES) {
        result.truncated = true;
        return;
      }
      const children = await this.#readDir(relativeDir).catch(() => []);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (result.truncated) return;
        if (isDenied(child.name)) continue;
        const relative = relativeDir === '' ? child.name : `${relativeDir}/${child.name}`;
        // 종류는 링크를 따라가지 않은 것이다: 링크는 폴더도 파일도 아니라서 건너뛴다
        if (child.kind === 'dir') await walk(relative);
        else if (child.kind === 'file') await scan(relative);
      }
    };

    const startInfo = await this.#lstat(start).catch((error: unknown) => {
      throw openFailure(error, target);
    });
    if (startInfo.kind === 'dir') await walk(start);
    else await scan(start);
    return result;
  }

  /**
   * 읽은 표시(#seen)를 남기지 않고 읽는다. 게이트처럼 에이전트가 아닌 쪽이 파일을 훑어볼 때 쓴다 —
   * read()로 읽으면 에이전트가 직접 읽지 않은 파일에도 "마지막으로 읽은 뒤 바뀌었다" 검사가 걸린다
   */
  async peek(file: string): Promise<string> {
    return (await this.#load(file)).content;
  }

  async #load(file: string): Promise<{ absolute: string; content: string }> {
    const absolute = await this.#resolve(file, { mustExist: true });
    const buffer = await readNoFollowInside(this.root, absolute, file, MAX_READ_BYTES);
    return { absolute, content: buffer.toString('utf8') };
  }

  async write(file: string, content: string): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: false });
    await this.#assertNotStale(absolute);
    await this.#pin(this.#relative(absolute));
    await writeNoFollowInside(this.root, absolute, content, true);
    this.#record(absolute, content);
  }

  /**
   * 이진 파일(PNG 등)을 쓴다. 경로 규칙·프로젝트 밖 탈출 금지는 write와 같다.
   * 텍스트가 아니라 내용 해시 비교(덮어쓰기 보호)는 하지 않지만, 바뀐 파일로는 똑같이 기록한다
   */
  async writeBinary(file: string, data: Buffer): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: false });
    await this.#pin(this.#relative(absolute));
    await writeNoFollowInside(this.root, absolute, data, true);
    const relative = this.#relative(absolute);
    this.#seen.delete(relative);
    this.#deleted.delete(relative);
    this.#changed.set(relative, ++this.#version);
  }

  /** oldText가 파일에 정확히 한 번 있어야 바꾼다. 모호한 수정은 거부한다 */
  async edit(file: string, oldText: string, newText: string): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: true });
    await this.#assertNotStale(absolute);
    const current = (await readNoFollowInside(this.root, absolute, file)).toString('utf8');

    const first = current.indexOf(oldText);
    if (oldText.length === 0 || first === -1) {
      throw new WorkspaceError(`${file}: 바꿀 문자열을 찾지 못했습니다. read_file로 현재 내용을 다시 확인하세요`);
    }
    if (current.indexOf(oldText, first + oldText.length) !== -1) {
      throw new WorkspaceError(`${file}: 바꿀 문자열이 여러 번 나옵니다. 주변 줄을 더 포함해 한 곳만 가리키게 하세요`);
    }

    const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
    await this.#pin(this.#relative(absolute));
    await writeNoFollowInside(this.root, absolute, next);
    this.#record(absolute, next);
  }

  /** 파일 하나를 지운다. 디렉터리는 지우지 않는다 */
  async remove(file: string): Promise<void> {
    const absolute = await this.#resolve(file, { mustExist: true });
    await this.#assertNotStale(absolute);
    await this.#pin(this.#relative(absolute));
    await removeNoFollowInside(this.root, absolute, file);

    const relative = this.#relative(absolute);
    this.#seen.delete(relative);
    this.#deleted.add(relative);
    this.#changed.set(relative, ++this.#version);
  }

  async #assertNotStale(absolute: string): Promise<void> {
    const relative = this.#relative(absolute);
    const seen = this.#seen.get(relative);
    if (seen === undefined) return;

    const current = await readNoFollowInside(this.root, absolute, relative).then((buffer) => buffer.toString('utf8'), () => undefined);
    if (current !== undefined && digest(current) !== seen) {
      throw new WorkspaceError(`${relative}: 마지막으로 읽은 뒤 다른 곳에서 파일이 바뀌었습니다. 다시 읽고 수정하세요`);
    }
  }

  #record(absolute: string, content: string): void {
    const relative = this.#relative(absolute);
    this.#deleted.delete(relative);
    this.#seen.set(relative, digest(content));
    this.#changed.set(relative, ++this.#version);
  }

  async #resolve(file: string, { mustExist }: { mustExist: boolean }): Promise<string> {
    // 들어온 경로의 글자 검사는 Rust가 한다. POSIX에서 역슬래시는 구분자가 아니라 이름의 한 글자다. 실행 정책은 그런 경로를 받지 않으므로(path-names.ts) 여기서도 받지 않는다.
    // 한쪽만 받으면 검사한 경로와 쓰는 경로가 달라진다
    const problem = guard.workspaceInputProblem(file, BACKSLASH_SEP, false);
    if (problem === 1) throw new WorkspaceError(`${file}: 프로젝트 루트 기준 상대 경로를 쓰세요`);
    if (problem !== 0) throw new WorkspaceError(`${file}: 경로에 쓸 수 없는 글자가 있습니다`);

    const absolute = path.resolve(this.root, file);
    if (!isInside(this.root, absolute)) throw new WorkspaceError(`${file}: 프로젝트 밖 경로입니다`);

    const relative = path.relative(this.root, absolute);
    if (relative.split(path.sep).some(isDenied)) {
      throw new WorkspaceError(`${file}: 생성물이나 비밀 파일 경로는 다룰 수 없습니다`);
    }

    // 파일 도구는 링크를 따라가지 않는다(트러블슈팅 124). 위의 숨김 검사는 이름만 보므로, 프로젝트 안의 링크가 숨긴 경로(.git, .env)를
    // 가리키면 그 이름으로는 지나가고 실제 위치가 프로젝트 안이라 아래의 검사도 지나갔다 — 체크포인트 저장소를 읽고 쓸 수 있었다.
    // 경로의 조각을 위에서부터 하나씩 보고, 링크가 하나라도 있으면(깨진 링크 포함) 거절한다. 목록(list)이 링크를 보여 주지 않는 것과 같은 규칙이다.
    // 이 확인과 아래의 실제 읽기·쓰기·지우기는 같은 방식(루트의 실제 위치에서 조각마다 링크 없이 내려감, Rust)이다. 존재하지 않는 조각부터는 아직 없는 경로다(쓰기가 새로 만든다).
    // 운영체제가 알려 주는 실제 저장 이름으로도 숨긴 이름을 한 번 더 본다. 위의 이름 검사는 우리가 아는 변형(대소문자·정규화)만 맞추므로,
    // 파일 시스템이 같은 항목으로 보는 다른 이름이 있어도 실제 이름이 숨긴 이름이면 여기서 걸린다.
    // 실제 저장 이름으로 돌려준다(트러블슈팅 125). 받은 표기 그대로 돌려주면 바뀐 파일 기록이 `WEB/app/page.tsx`처럼 남아,
    // 뒤의 검사들(보호 경로의 사후 확인, 바뀐 파일 → 다시 올릴 서비스)이 같은 파일을 다른 이름으로 본다. 아직 없는 조각은 받은 그대로 둔다
    let stored: string;
    try {
      stored = await guard.workspaceResolve(this.root, toPosix(relative), mustExist);
    } catch (error) {
      throw resolveFailure(error, file);
    }
    return stored === '' ? this.root : path.join(this.root, ...stored.split('/'));
  }

  /** 바깥에서 온 경로를 루트 기준 상대 경로로 정규화한다. 루트 밖 경로는 거부한다 */
  #normalizeExternal(file: string): string {
    if (guard.workspaceInputProblem(file, BACKSLASH_SEP, true) !== 0) throw new WorkspaceError(`${file}: 프로젝트 루트 기준 상대 경로를 쓰세요`);

    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    const absolute = path.resolve(this.root, normalized);
    if (!isInside(this.root, absolute)) throw new WorkspaceError(`${file}: 프로젝트 밖 경로입니다`);

    const relative = path.relative(this.root, absolute);
    if (relative === '') throw new WorkspaceError(`${file}: 프로젝트 루트 자체는 다룰 수 없습니다`);
    if (relative.split(path.sep).some(isDenied)) {
      throw new WorkspaceError(`${file}: 생성물이나 비밀 파일 경로는 다룰 수 없습니다`);
    }
    return this.#relative(absolute);
  }

  /** 폴더의 항목(이름·종류). 숨긴 이름과 링크를 따라가는 길은 Rust가 막는다. 순서는 정해져 있지 않다 */
  async #readDir(relative: string): Promise<Array<{ name: string; kind: string }>> {
    try {
      return await guard.workspaceReadDir(this.root, relative);
    } catch (error) {
      throw openFailure(error, relative === '' ? '.' : relative);
    }
  }

  /** 링크를 따라가지 않는 종류·크기 */
  async #lstat(relative: string): Promise<{ kind: string; size: number }> {
    return guard.workspaceLstat(this.root, relative);
  }

  #relative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join('/');
  }
}

/**
 * 바깥에서 이미 바뀐 파일(세션 시작 전에 복원된 보관본, IDE로 고친 파일 등)을 작업 공간에 동기화한다.
 * 이번 실행의 도구 호출(write_file 등)을 거치지 않았어도 게이트가 "검증할 변경"으로 보게 하려는 것이다
 * (gate.ts의 VerificationGate.check()는 workspace.changedFiles()만 보고 검증 여부를 정한다 — 작업 트리에
 * 실제로 바뀐 파일이 있어도 이 동기화가 없으면 게이트가 "바뀐 파일 없음"으로 보고 검증 없이 통과시킨다).
 * 프로젝트 밖 경로·생성물·비밀 파일처럼 trackExternalChanges가 거부하는 경로는 조용히 건너뛴다 —
 * 검증 대상에서 빼는 것뿐이지 실행 자체를 막을 이유가 아니다(폴더 경로도 같은 이유로 건너뛴다).
 */
export function syncExternalChanges(workspace: Workspace, files: readonly string[]): void {
  for (const file of files) {
    if (file.endsWith('/')) continue;
    try {
      workspace.trackExternalChanges([file]);
    } catch {
      // 거부된 경로는 건너뛴다(위 주석 참고)
    }
  }
}

/** 경로의 어느 구간이든 .env·.env.* 이면 비밀 파일로 본다(.env.example 같은 예시 파일은 뺀다). Pi 확장도 같은 규칙으로 읽기를 막는다. 판정은 Rust(거부 목록) */
export function isSecretFile(file: string): boolean {
  return guard.workspaceIsSecretFile(file);
}

/** 숨긴 이름(생성물 폴더·.env 계열)인가. 거부 목록이라 틀려도 더 막을 뿐이다. 판정은 Rust */
function isDenied(segment: string): boolean {
  return guard.workspaceIsDenied(segment);
}

/**
 * target이 root 자신이거나 그 안쪽인가. 허용 목록이라 통과가 곧 안쪽이다. 경로 계산(path.relative)은 Node가 하고 그 결과를 읽는 판정은 Rust가 한다.
 * 짝 없는 서로게이트는 경계에서 U+FFFD로 합쳐지므로 단사로 바꿔 보낸다(접두를 읽는 판정에는 영향이 없지만 허용 목록의 규칙을 그대로 지킨다)
 */
function isInside(root: string, target: string): boolean {
  return isInsideRelative(path.relative(root, target));
}

/**
 * 상대 경로(`path.relative`의 결과, 또는 받은 경로를 `path.normalize`한 글자)가 루트 자신이거나 안쪽인가(허용 목록: 통과가 곧 안쪽). 모르는 꼴은 바깥이다. 판정은 Rust.
 * 받은 경로를 읽는 자리(readProjectFileSync·snapshotRead)는 옛 식이 받은 글자의 `path.isAbsolute`도 봤지만, 이 판정이 절대 경로를 바깥으로 보고
 * `path.normalize`는 상대 경로를 절대 경로로(또는 반대로) 바꾸지 않으므로 같은 답이다(차등 시험이 본다)
 */
function isInsideRelative(relative: string): boolean {
  return guard.workspaceIsInside(encodeLoneSurrogates(relative), BACKSLASH_SEP);
}

/** #resolve 자리의 실패 글. 열기 전의 확인이라 링크는 "링크를 거치는 경로"다 */
function resolveFailure(error: unknown, file: string): WorkspaceError {
  const code = failureCode(error);
  if (code === 'LINK') return new WorkspaceError(`${file}: 링크를 거치는 경로는 다룰 수 없습니다`);
  if (code === 'MISSING') return new WorkspaceError(`${file}: 파일이 없습니다`);
  if (code === 'OUTSIDE') return new WorkspaceError(`${file}: 프로젝트 밖을 가리키는 링크입니다`);
  if (code === 'DENIED') return new WorkspaceError(`${file}: 생성물이나 비밀 파일 경로는 다룰 수 없습니다`);
  // 확인하지 못했으면 통과가 아니라 거절이다(허용 목록: 모르면 범위 밖)
  return new WorkspaceError(`${file}: 경로를 확인할 수 없습니다(${code.startsWith('OS:') ? code.slice('OS:'.length) : '알 수 없는 오류'})`);
}

/** absolute(루트 아래)를 루트 기준 `/` 경로로 바꾼다. 루트 밖이면 거절한다(허용 목록: 모르면 밖) */
function insideRelative(root: string, absolute: string, label: string): string {
  const relative = path.relative(root, absolute);
  if (!isInsideRelative(relative)) throw new WorkspaceError(`${label}: 프로젝트 밖 경로입니다`);
  return toPosix(relative);
}

/**
 * 읽기. 루트의 실제 위치에서 조각마다 링크를 따라가지 않고 내려가 열고(O_NOFOLLOW), 연 파일의 종류와 크기를 읽기 전에 본다(Rust). #resolve가 확인한 경로와 같은 방식으로 여는 것이라,
 * 확인한 뒤 상위 폴더가 링크로 바뀌어도 연 파일은 프로젝트 안의 것이다(#799) — 옛 구현은 연 뒤에 realpath와 dev/ino를 견줬다.
 *  - FIFO는 쓰는 쪽이 없으면 열기에서 멈추므로 O_NONBLOCK으로 열고 일반 파일이 아니면 거절한다
 *  - maxBytes를 주면 확인한 크기까지만 읽는다. 확인 뒤에 파일이 늘어나도 그 뒤는 읽지 않는다
 */
export async function readNoFollowInside(root: string, absolute: string, label: string, maxBytes?: number): Promise<Buffer> {
  const relative = insideRelative(root, absolute, label);
  try {
    return await guard.workspaceReadFile(root, relative, maxBytes ?? null);
  } catch (error) {
    throw openFailure(error, label);
  }
}

/**
 * 쓰기. 부모 폴더는 링크 없이 내려가며(makeDirs면 없는 폴더를 만들며) 열고, 파일은 그 폴더 서술자 아래에서 O_NOFOLLOW로 연다(Rust).
 * 일반 파일이 아니면 비우기 전에 거절한다. 만드는 폴더·파일은 걸어 내려온 폴더 아래에만 생기므로 프로젝트 밖에 빈 파일을 남길 수 없다(옛 구현의 한계였다, #799)
 */
export async function writeNoFollowInside(root: string, absolute: string, data: string | Buffer, makeDirs = false): Promise<void> {
  const relative = insideRelative(root, absolute, path.relative(root, absolute));
  try {
    await guard.workspaceWriteFile(root, relative, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, makeDirs);
  } catch (error) {
    throw openFailure(error, relative);
  }
}

/** 지우기. 부모 폴더는 링크 없이 내려가고 그 이름의 항목 하나만 지운다(unlinkat). 링크면 링크만 지우고 너머를 따라가지 않으며 폴더는 지우지 못한다 */
async function removeNoFollowInside(root: string, absolute: string, label: string): Promise<void> {
  const relative = insideRelative(root, absolute, label);
  try {
    await guard.workspaceRemoveFile(root, relative);
  } catch (error) {
    throw openFailure(error, label);
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

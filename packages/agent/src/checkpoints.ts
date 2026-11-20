import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeNative, encodeLoneSurrogates, execBytes, native } from '@b-studio/sandbox';
import type { WorkflowStage } from '@b-studio/spec';
import { decodeLoneSurrogates } from './lone-surrogates';
import {
  isDocCheckpointPath,
  parseIncompleteTrailerValues,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  WORKFLOW_INCOMPLETE_TRAILER,
  WORKFLOW_TRAILER,
  WORKFLOW_VERIFY_TRAILER,
  type VerifyTrailer,
} from './workflow';

export interface Checkpoint {
  sha: string;
  shortSha: string;
  message: string;
  /** ISO 8601 */
  createdAt: string;
  /** 직전 체크포인트 대비 바뀐 파일 (세션 시작 체크포인트는 전체 파일) */
  files: string[];
  /** 커밋 본문의 Workflow-Passed 트레일러. 없으면 검증 게이트를 거쳤다는 기록이 없는 체크포인트다 */
  passedStages?: WorkflowStage[];
  /**
   * 가볍게 확인(light) 실행이면 'light', 문서만 바꿔 검증 게이트 없이 남긴 체크포인트(ADR-096)면 'docs', 요청 사이에 쌓인 변경을
   * 게이트 없이 남긴 직접 수정이면 'unverified'(#772). 전체 검증이면 없다
   */
  verify?: VerifyTrailer;
  /** 턴 상한에 닿은 실행이 게이트만 통과해 남긴 체크포인트면 'max_turns'(커밋 본문의 Workflow-Incomplete 트레일러). 요청이 끝나지 않았을 수 있다 */
  incomplete?: 'max_turns';
  /**
   * 문서 체크포인트(verify: 'docs')가 바꿨는데 files에는 드러나지 않는 경로 수. files는 프로젝트 폴더 기준이라 폴더 밖 변경이
   * 빠지고, 이름 바꾸기는 새 이름만 남아 사라진 원래 파일이 안 보인다. "이 체크포인트가 바꾼 것은 files가 전부다"라고 말하려면
   * 이 값이 없어야 한다(ADR-156). 0이면 넣지 않고, 문서 체크포인트가 아니면 세지 않는다
   */
  outsideFiles?: number;
}

export interface GitAuthor {
  name: string;
  email: string;
}

/** 세션을 시작할 원본 Git 저장소의 상태 */
export interface SourceRepository {
  /** 원본이 체크아웃한 브랜치. 세션 브랜치가 여기서 갈라지고 PR의 대상이 된다 */
  base: string;
  /** 원본의 origin 주소. 없으면 원본 저장소 자체로 올린다 */
  originUrl?: string;
  /** 원본에서 커밋하지 않은 변경 수. 세션은 커밋된 상태로 시작하므로 이 변경은 들어가지 않는다 */
  dirtyFiles: number;
  /** 저장소 루트 기준 프로젝트 폴더 경로. 저장소 루트면 빈 문자열이고, 모노레포 하위 폴더면 "apps/orders" 같은 값이다 */
  subdir: string;
}

export interface RepositoryInfo {
  /** 올릴 곳. 자격 증명이 들어 있을 수 있어 화면에는 parseRemote로 가공해 보여 준다 */
  remoteUrl: string;
  base: string;
  branch: string;
  /** 모노레포 하위 폴더 프로젝트면 저장소 루트 기준 폴더 경로 */
  subdir?: string;
  /** 스튜디오가 마지막으로 올린 커밋 */
  pushedSha?: string;
  /** 스튜디오가 마지막으로 확인한 원격 브랜치의 끝 커밋(올렸거나 가져왔을 때). 다음에 올릴 때 원격이 이 상태 그대로인지 확인한다 */
  remoteSha?: string;
  pullRequestUrl?: string;
  /** 마지막으로 확인한 PR 대상 브랜치(pullRequestTarget). 기준 브랜치가 원격에 없으면 base와 다르다 */
  pullRequestBase?: string;
}

export interface SessionCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  files: string[];
  /** 바뀐 줄 수(추가·삭제). 제출 준비 점검(ADR-080)이 한 커밋이 전체 변경을 독차지하는지 볼 때 쓴다. sessionCommits()가 항상 채운다 */
  stat?: { insertions: number; deletions: number };
  /** 커밋 본문의 Workflow-Passed 트레일러. 없으면 검증 게이트를 거쳤다는 기록이 없는 커밋이다 */
  passedStages?: WorkflowStage[];
  /** 커밋 본문의 Workflow-Verify 트레일러. 문서만 바꿔 검증 게이트 없이 남긴 체크포인트(ADR-096)면 'docs'.
   * PR 본문(buildPullRequest)이 이 값으로 "필수 단계 기록이 없다"가 아니라 "문서 체크포인트"로 보여준다 */
  verify?: VerifyTrailer;
  /** 커밋 본문의 Workflow-Incomplete 트레일러. 턴 상한에 닿은 실행이 게이트만 통과해 남긴 체크포인트면 'max_turns' */
  incomplete?: 'max_turns';
}

export interface PushResult {
  sha: string;
  /** 세션 시작 이후 커밋 수 */
  commits: number;
  /** 되돌리기 때문에 원격 브랜치를 이어 붙이지 않고 다른 기록으로 맞췄는지 */
  forced: boolean;
}

/** 지금 작업 복사본의 HEAD와 체크아웃된 브랜치. 분리된 HEAD면 branch가 없다 */
export interface HeadState {
  head: string;
  branch: string | undefined;
}

/**
 * b-studio가 작업 복사본 밖(세션 저장)에 기억해 두는 Git 상태(이슈 #699). 이 컴퓨터 방식에서는 에이전트가 작업
 * 복사본의 `.git`을 고칠 수 있다(브랜치 전환, 기록 되감기, `.git/config`의 브랜치·원격 주소 바꾸기). 올리기·
 * 가져오기·PR 만들기 전에 지금 작업 복사본의 Git과 이 기억을 견줘, 다르면 멈춘다
 */
export interface RememberedGit {
  /** 세션 브랜치 이름. 지금 체크아웃된 브랜치가 이것과 다르면 멈춘다 */
  branch: string;
  /** b-studio가 마지막으로 남긴 체크포인트(HEAD). 지금 HEAD가 이것과 다르면 멈춘다 */
  lastCheckpoint: string;
  /** 기억한 origin 주소. 있으면 지금 remote.origin.url과 같아야 한다 */
  originUrl?: string;
}

/** 마지막 체크포인트 이후 바뀐 파일 (프로젝트 기준 경로) */
export interface PendingChange {
  file: string;
  change: 'added' | 'modified' | 'deleted';
}

/**
 * 체크포인트에 커밋된 경로 하나의 모습. 일반 파일(100644)·실행 파일(100755)만 내용(kind: 'file')을 주고,
 * 그 시점에 없으면 'missing', 심볼릭 링크(120000)·서브모듈(160000)·폴더 같은 그 밖의 종류는 'unsupported'다.
 * 내용은 작업 폴더가 아니라 커밋된 값이라, 그 뒤에 파일이 링크로 바뀌어도 이 값을 쓴다
 */
export type BlobAt = { kind: 'file'; content: Buffer; executable: boolean } | { kind: 'missing' } | { kind: 'unsupported'; mode: string };

/** 체크포인트(ref)에 커밋된 일반 파일 하나. path는 프로젝트 폴더 기준이다 */
export interface CheckpointBlob {
  path: string;
  content: Buffer;
  /** 실행 비트(100755) */
  executable: boolean;
}

/**
 * discard()·restore()가 체크포인트에 없던 변경을 버리기 직전에 남긴 백업(ADR-099, "절대 조용히 지우지 않는다").
 * 작업 복사본에 git apply로 그대로 되살릴 수 있는 패치 하나로 저장한다(추가·수정·삭제·바이너리 파일 모두 포함,
 * untracked 파일도 git add -A로 인덱스에 올린 뒤 떠서 새 파일 diff로 들어가므로 따로 보관할 필요가 없다).
 */
export interface DiscardBackup {
  /** 백업 폴더 이름(타임스탬프 기반). restoreBackup()에 그대로 넘긴다 */
  id: string;
  /** 백업에 담긴 파일(프로젝트 기준 경로) */
  files: string[];
  /** ISO 8601 */
  createdAt: string;
}

/** 생성 파일(제외됨, ADR-141) 하나의 지금 내용과 되돌아갈 내용. before·after가 undefined면 그 시점에 파일이 없었다는 뜻이다 */
interface ExcludedChange {
  /** 프로젝트 폴더 기준 경로 */
  file: string;
  /** 지금 자리가 파일이면 내용, 링크·없음이면 undefined */
  before: Buffer | undefined;
  /** 스냅샷 자리가 파일이면 내용, 링크·없음이면 undefined */
  after: Buffer | undefined;
  /** 지금 자리가 링크면 가리키는 곳. 링크가 아니면 undefined */
  beforeLink?: string;
  /** 스냅샷 자리가 링크면 가리키는 곳. 링크가 아니면 undefined */
  afterLink?: string;
}

/** 원격 세션 브랜치에만 있던 커밋 (리뷰어가 올린 커밋 등) */
export interface RemoteCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
}

/** PR을 열 원격 브랜치. 세션의 기준 브랜치는 원본 폴더가 체크아웃해 둔 브랜치일 뿐이라 원격에 없을 수 있다 */
export interface PullRequestTarget {
  /** PR의 대상 브랜치. 기준 브랜치가 원격에 있으면 그것이고, 없으면 원격의 기본 브랜치다 */
  base: string;
  /** 기준 브랜치가 원격에 없을 때 그 이름. 원격의 기본 브랜치도 알 수 없으면 base가 이 값과 같다(PR을 만들 수 없다) */
  missingBase?: string;
}

/** 기준 브랜치(세션이 갈라져 나온 브랜치, 보통 main)가 이 세션보다 얼마나 앞서 있는지(ADR-076) */
export interface BaseStatus {
  /** 세션이 갈라져 나온 기준 브랜치 이름 */
  base: string;
  /** 기준 브랜치에는 있지만 이 세션에는 없는 커밋 수. 0이면 따라잡을 것이 없다 */
  behind: number;
  /** 이 세션이 기준 브랜치와 갈라진 뒤 만든 커밋 수 */
  aheadCommits?: number;
  /** 기준 브랜치를 마지막으로 가져온(fetch) 시각(ISO). 화면이 자주 물어도 이 값이 오래되지 않았으면 새로 가져오지 않는다 */
  lastFetchedAt: string;
}

export interface RemoteSyncResult {
  /**
   * up-to-date: 가져올 커밋이 없다 (원격에 브랜치가 없거나 이미 기록에 들어 있다)
   * merged: 원격 브랜치를 병합 커밋으로 가져왔다
   * picked: 올린 뒤 되돌린 기록이라, 버린 체크포인트는 빼고 원격에만 있는 커밋의 변경을 옮겨 왔다
   */
  status: 'up-to-date' | 'merged' | 'picked';
  /** 원격 브랜치의 끝 커밋. 원격에 브랜치가 없으면 비어 있다 */
  remoteSha?: string;
  /** 가져온 원격 커밋. 오래된 것부터 */
  commits: RemoteCommit[];
  /** 가져오기로 바뀐 파일 */
  files: string[];
  /** 가져온 변경을 담은 체크포인트 */
  checkpoint?: Checkpoint;
  /** 가져오기 전의 최신 체크포인트. 가져온 변경이 검증을 통과하지 못하면 여기로 되돌린다 */
  previous: string;
}

/** 체크포인트가 git 추적에서 뺀 생성 파일(폴더 열기, ADR-067) 후보 경로를 돌려준다. projectRoot는 이 세션의 프로젝트 폴더(모노레포 하위 폴더면 그 폴더) 기준이다 */
export type ExcludedFilesProvider = (projectRoot: string) => Promise<readonly string[]>;

export interface CheckpointStoreOptions {
  gitBin?: string;
  /** 체크포인트 커밋 작성자. 사내 저장소가 작성자 이메일을 검사하면 바꿔야 한다 */
  author?: GitAuthor;
  /**
   * 작업 폴더 밖에 둘 Git 저장소 경로. 사용자의 프로젝트 폴더에서 바로 작업할 때 쓴다.
   * 사용자 폴더의 .git(커밋, 브랜치, 설정, 훅)을 건드리지 않고 체크포인트를 따로 남긴다
   */
  gitDir?: string;
  /**
   * 커밋에서 뺀 생성 파일(폴더 열기가 만든 studio.yaml 등, ADR-067) 후보 목록을 돌려준다. 체크포인트를 남길 때마다
   * 이 중 실제로 이 저장소가 무시하는(git status --ignored) 파일의 지금 내용을 사이드카로 함께 보관해, discard()·
   * restore()가 git 기록에 없는 이 파일도 그 시점 내용으로 되돌릴 수 있게 한다(도그푸딩 마찰 127, ADR-141).
   * 생략하면(기본) 이 기능을 쓰지 않는다 — 생성 파일 없이 평범하게 추적되는 세션은 필요 없다.
   */
  excludedFiles?: ExcludedFilesProvider;
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/**
 * 스테이징된 내용이 검증한 내용과 다르다(검증한 뒤에 파일이 바뀌었다). 체크포인트를 만들지 않았고 스테이징도 풀었다.
 * 작업 복사본은 그대로다
 */
export class StagedMismatchError extends CheckpointError {
  readonly files: string[];
  constructor(files: string[]) {
    super(`검증한 뒤에 바뀐 파일이 있어 체크포인트를 남기지 않았습니다: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` 외 ${files.length - 20}개` : ''}`);
    this.name = 'StagedMismatchError';
    this.files = files;
  }
}

/** 원격 커밋과 같은 곳을 고쳐 가져오지 못했다. 작업 복사본은 가져오기 전 그대로다 */
/**
 * 체크포인트를 남기려는데 HEAD가 b-studio가 기대한 커밋이 아니다(이슈 #706). 이 컴퓨터 방식에서 뒤에서 도는 프로세스가 커밋을
 * 끼워 넣으면 그 위에 체크포인트를 쌓지 않는다. 끼워 넣은 커밋이 b-studio의 작성자와 통과 트레일러를 흉내 내도 기록에 들어가지 않는다
 */
export class HeadMovedError extends CheckpointError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`HEAD(${actual.slice(0, 7)})가 b-studio가 마지막으로 남긴 체크포인트(${expected.slice(0, 7)})와 달라 체크포인트를 남기지 않았습니다`);
    this.name = 'HeadMovedError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class RemoteConflictError extends CheckpointError {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`원격 커밋과 같은 곳을 고쳐 충돌했습니다. 가져오지 않고 그대로 두었습니다: ${conflicts.join(', ')}`);
    this.name = 'RemoteConflictError';
    this.conflicts = conflicts;
  }
}

/** Rust가 git log·show 출력에서 나눈 레코드(`checkpoint_git::session_records`). ours는 작성자 이메일이 체크포인트를 만든 쪽과 같은지다 */
interface ParsedLogRecord {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  ours: boolean;
  trailers: string[];
  verifyTrailers: string[];
  incompleteTrailers: string[];
}
const MAX_PATCH_CHARS = 200_000;
const MAX_BODY_CHARS = 8_000;
const CLONE_TIMEOUT_MS = 300_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'b-studio', email: 'checkpoints@b-studio.local' };
/**
 * b-studio가 부르는 git은 저장소의 훅과 fsmonitor를 쓰지 않는다(이슈 #699). 이 컴퓨터 방식에서는 에이전트가 작업
 * 복사본의 `.git/config`를 고칠 수 있어, `npm install`이 husky로 `core.hooksPath=.husky`를 넣으면 b-studio의
 * 체크포인트 커밋이 프로젝트의 훅(린트·테스트)을 돌아 느려지거나 실패하고, 훅이 인덱스를 바꾸면 검증한 것과 커밋한
 * 것이 달라진다. hooksPath를 /dev/null로 두면 `<hooksPath>/<훅 이름>`이 없어 어떤 훅도 돌지 않는다.
 * 모든 git 호출의 인자 맨 앞(하위 명령보다 앞)에 붙인다
 */
export const GIT_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];
/** Rust로 보낼 기억한 Git 상태. 짝 없는 서로게이트가 napi 경계에서 U+FFFD로 합쳐져 다른 값이 같아지지 않게 단사 변환한다(Rust가 git이 낸 글자도 같은 규칙으로 바꿔 견준다) */
function rememberedInput(remembered: RememberedGit): Record<string, string | undefined> {
  return {
    branch: encodeLoneSurrogates(remembered.branch),
    lastCheckpoint: encodeLoneSurrogates(remembered.lastCheckpoint),
    originUrl: remembered.originUrl === undefined ? undefined : encodeLoneSurrogates(remembered.originUrl),
  };
}
/** discard()·restore() 백업을 이 안에 둔다(ADR-099). 작업 복사본이 아니라 체크포인트 저장소 쪽이라 커밋·게이트에 걸리지 않는다 */
const BACKUP_DIRNAME = 'b-studio/discarded';
/** 체크포인트마다 생성 파일(제외됨) 스냅샷을 이 안에 둔다(ADR-141). 체크포인트 sha별 하위 폴더 하나씩이다 */
const EXCLUDED_DIRNAME = 'b-studio/excluded';
// 백업·제외 스냅샷의 나머지 모양(한도 10개/200MB·스냅샷 200개, staging 폴더 이름)은 Rust(`crates/bstudio-io/src/checkpoint_local.rs`)가 안다.
// TS는 `excludedSnapshotFile`·`restoreBackup`이 읽는 폴더 이름만 안다.

/**
 * 세션 작업 복사본의 Git 기록으로 체크포인트를 관리한다.
 * 게이트를 통과한 변경만 남기고, 통과하지 못한 변경은 되돌릴 수 있게 하는 것이 목적이다.
 * 원본이 Git 저장소면 세션 브랜치에서 작업하고, 체크포인트를 그대로 원격 브랜치로 올린다.
 */
export class CheckpointStore {
  readonly root: string;
  readonly #gitBin: string;
  readonly #author: GitAuthor;
  readonly #separateGitDir: string | undefined;
  readonly #excludedFiles: ExcludedFilesProvider | undefined;
  #start: string | undefined;
  #subdirCache: string | undefined;

  constructor(root: string, { gitBin = 'git', author = DEFAULT_AUTHOR, gitDir, excludedFiles }: CheckpointStoreOptions = {}) {
    this.root = path.resolve(root);
    this.#gitBin = gitBin;
    this.#author = author;
    this.#separateGitDir = gitDir === undefined ? undefined : path.resolve(gitDir);
    this.#excludedFiles = excludedFiles;
  }

  /** 체크포인트 저장소 위치. 따로 정하지 않으면 작업 폴더의 .git이다 */
  get gitDir(): string {
    return this.#separateGitDir ?? path.join(this.root, '.git');
  }

  /**
   * 체크포인트 sha가 남긴 생성 파일 스냅샷(ADR-141) 안에서 한 파일의 경로. 그 시점에 파일이 없었을 수도 있어(아직
   * 만들기 전, 또는 excludedFiles 제공자가 없는 저장소) 실제로 있는지는 호출하는 쪽이 따로 확인한다. 복구 안내처럼
   * 읽기 전용으로 경로만 알고 싶을 때 쓴다 — studio.yaml 형식 오류로 project를 못 읽어 보통의 restore()를 쓸 수
   * 없을 때(도그푸딩 마찰 131) 사람이 참고할 경로를 알려주는 용도다
   */
  excludedSnapshotFile(sha: string, file: string): string {
    return path.join(this.gitDir, EXCLUDED_DIRNAME, sha, 'files', file);
  }

  /**
   * 폴더가 커밋이 있는 Git 저장소에 있는지 확인한다. 저장소가 아니면 undefined.
   * 저장소 루트가 아닌 하위 폴더는 allowSubfolder(모노레포 하위 폴더 프로젝트)일 때만 인정한다
   */
  static async inspectSource(
    source: string,
    { gitBin = 'git', allowSubfolder = false }: { gitBin?: string; allowSubfolder?: boolean } = {},
  ): Promise<SourceRepository | undefined> {
    const root = await resolveReal(source);
    const inRepo = (args: string[]) => runGit(gitBin, ['-C', root, ...args]);

    const toplevel = await inRepo(['rev-parse', '--show-toplevel']).then((out) => resolveReal(out.trim()), () => undefined);
    if (!toplevel) return undefined;
    const subdir = path.relative(toplevel, root).split(path.sep).join('/');
    if (subdir === '..' || subdir.startsWith('../') || (subdir !== '' && !allowSubfolder)) return undefined;
    const hasCommit = await inRepo(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(() => true, () => false);
    if (!hasCommit) return undefined;

    // source가 다른 b-studio 세션의 작업 복사본이면(작업 분해가 세션의 체크포인트에서 레인·통합을 시작할 때, ADR-096)
    // 지금 체크아웃된 브랜치는 그 세션 브랜치이지 기준 브랜치가 아니다. 그 세션이 클론될 때 기록해 둔 기준 브랜치
    // 메타(b-studio.base)가 있으면 그것을 쓰고, 없으면(보통의 프로젝트 원본) 지금처럼 체크아웃된 브랜치를 쓴다
    const sessionBase = await inRepo(['config', '--get', 'b-studio.base']).then((out) => out.trim() || undefined, () => undefined);
    const base = sessionBase ?? (await inRepo(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((out) => out.trim(), () => ''));
    if (!base) throw new CheckpointError('원본 저장소가 브랜치가 아닌 커밋(detached HEAD)을 가리키고 있어 세션 브랜치를 만들 수 없습니다');
    const originUrl = await inRepo(['remote', 'get-url', 'origin']).then((out) => out.trim() || undefined, () => undefined);
    // 모노레포에서 다른 폴더의 변경은 이 프로젝트와 관계없으므로 프로젝트 폴더의 변경만 센다
    const status = await inRepo(['status', '--porcelain=v1', '--untracked-files=normal', ...(subdir ? ['--', '.'] : [])]);
    return { base, originUrl, dirtyFiles: status.split('\n').filter(Boolean).length, subdir };
  }

  /**
   * 원본 저장소의 커밋된 상태를 복제하고 세션 브랜치를 만든다.
   * 원본에 origin이 있으면 그 주소로, 없으면 원본 저장소로 올리도록 설정한다.
   */
  static async clone(
    source: string,
    root: string,
    {
      branch,
      allowSubfolder = false,
      ref,
      ...options
    }: CheckpointStoreOptions & {
      branch: string;
      allowSubfolder?: boolean;
      /**
       * 세션 브랜치를 시작할 커밋. 생략하면 지금처럼 원본의 기준 브랜치(info.base) 끝에서 시작한다.
       * 작업 분해(레인·통합)가 다른 세션의 체크포인트에서 시작할 때(ADR-096) source에 그 세션의 작업 복사본을 주고
       * 여기에 그 세션의 최신 체크포인트 sha를 준다 — info.base는 그대로 메타(PR 대상)로 쓰고, 내용만 그 sha에서 가져온다
       */
      ref?: string;
    },
  ): Promise<{ store: CheckpointStore; start: Checkpoint; source: SourceRepository; projectRoot: string }> {
    const gitBin = options.gitBin ?? 'git';
    const info = await CheckpointStore.inspectSource(source, { gitBin, allowSubfolder });
    if (!info) {
      throw new CheckpointError(
        allowSubfolder ? '커밋이 있는 Git 저장소 안의 폴더만 세션 브랜치로 시작할 수 있습니다' : '커밋이 있는 Git 저장소의 루트 폴더만 세션 브랜치로 시작할 수 있습니다',
      );
    }
    await runGit(gitBin, ['check-ref-format', '--branch', branch]).catch(() => {
      throw new CheckpointError(`브랜치 이름이 올바르지 않습니다: ${branch}`);
    });

    // 모노레포 하위 폴더도 저장소 전체를 복제한다. compose 빌드가 공용 패키지처럼 프로젝트 밖 폴더를 쓸 수 있기 때문이다
    const toplevel = (await runGit(gitBin, ['-C', await resolveReal(source), 'rev-parse', '--show-toplevel'])).trim();
    await mkdir(path.dirname(path.resolve(root)), { recursive: true });
    // ref가 있으면(다른 세션에서 시작) 그 커밋이 기준 브랜치에는 없을 수 있어 --branch로 고정하지 않고 복제한 뒤 따로 체크아웃한다
    await runGit(
      gitBin,
      ref
        ? ['clone', '--quiet', '--', await resolveReal(toplevel), path.resolve(root)]
        : ['clone', '--quiet', '--branch', info.base, '--', await resolveReal(toplevel), path.resolve(root)],
      { timeout: CLONE_TIMEOUT_MS },
    );

    const store = new CheckpointStore(root, options);
    if (info.originUrl) await store.#git(['remote', 'set-url', 'origin', info.originUrl]);
    if (ref) await store.#git(['checkout', '-q', ref]);
    await store.#git(['checkout', '-q', '-b', branch]);
    await store.#remote('configure');
    const start = (await store.#git(['rev-parse', 'HEAD'])).trim();
    await store.#setMeta('start', start);
    await store.#setMeta('base', info.base);
    await store.#setMeta('branch', branch);
    // 서버를 다시 시작해도 작업 복사본만으로 프로젝트 폴더를 찾을 수 있게 저장소 설정에 남긴다
    if (info.subdir) await store.#setMeta('subdir', info.subdir);
    return { store, start: await store.#checkpoint(start), source: info, projectRoot: path.join(path.resolve(root), info.subdir) };
  }

  /** 프로젝트 폴더. 모노레포 하위 폴더 세션이면 저장소 루트 아래의 그 폴더다 */
  async projectRoot(): Promise<string> {
    return path.join(this.root, await this.#subdir());
  }

  /** 저장소가 없으면 만들고, 지금 상태를 첫 체크포인트로 남긴다 */
  async init(message = '세션 시작'): Promise<Checkpoint> {
    return this.#remote<Checkpoint>('init', { message }, this.#excludedFilesHooks());
  }

  /** 마지막 체크포인트 이후 바뀐 파일 (새 파일과 삭제 포함) */
  async pendingFiles(): Promise<string[]> {
    await this.#assertNoNestedRepos();
    const output = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(await this.#scope())]);
    return native.checkpointPendingFiles(output, await this.#subdir()).sort();
  }

  /**
   * 마지막 체크포인트 이후 바뀐 파일(추적 밖 생성물 포함)의 지문. 경로와 내용의 sha256을 정렬해 하나로 잇는다.
   * 지워진 파일은 내용 대신 표시를 넣는다(빈 파일과 없어진 파일을 가른다). 읽기만 실행이 도는 동안 작업 복사본이
   * 바뀌었는지 시작과 끝에서 견주는 데 쓴다 — 사람이 미리 고쳐 둔 파일은 양쪽에 모두 들어가므로 다르지 않다.
   */
  async pendingFingerprint(): Promise<string> {
    const projectRoot = await this.projectRoot();
    const files = [...new Set([...(await this.pendingFiles()), ...(await this.pendingExcludedFiles())])].sort();
    const parts: string[] = [];
    for (const file of files) {
      const content = await readFile(path.join(projectRoot, file)).catch(() => undefined);
      parts.push(`${file} ${content === undefined ? 'deleted' : createHash('sha256').update(content).digest('hex')}`);
    }
    return parts.join('\n');
  }

  /** 마지막 체크포인트 이후 바뀐 파일과 바뀐 종류. 코드 화면이 추가·수정·삭제를 구분해 보여 줄 때 쓴다 */
  async pendingChanges(): Promise<PendingChange[]> {
    await this.#assertNoNestedRepos();
    const subdir = await this.#subdir();
    const output = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(await this.#scope())]);
    // 저장소 루트 기준 경로를 프로젝트 기준으로 바꾸고, 프로젝트 밖 경로는 뺀다(Rust가 한다). 정렬은 여기서 한다
    return native
      .checkpointPendingChanges(output, subdir)
      .map(([file, change]) => ({ file: file!, change: change as PendingChange['change'] }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  /**
   * 파일 하나가 마지막 체크포인트 이후 어떻게 바뀌었는지. 아직 기록에 없는 새 파일은 빈 문자열이다.
   * redact는 자르기 전에 적용한다. 자른 뒤에 가리면 경계에 걸친 시크릿의 앞부분이 남는다(#751)
   */
  async pendingPatch(file: string, redact: (text: string) => string = (text) => text): Promise<string> {
    await this.#assertNoNestedRepos();
    const subdir = await this.#subdir();
    const target = subdir ? `${subdir}/${file}` : file;
    return capText(redact(await this.#git(['diff', '--no-color', ...(await this.#relative()), 'HEAD', '--', target])), MAX_PATCH_CHARS);
  }

  /**
   * 바뀐 파일이 있으면 체크포인트로 남긴다. 본문에는 검증 결과처럼 PR에서 다시 쓸 기록을 넣는다.
   * allowEmpty는 파일은 그대로지만 데이터베이스만 바뀐 요청을 체크포인트로 남길 때 쓴다.
   * trailers는 본문 길이 상한과 상관없이 마지막 문단으로 붙인다. 본문에 넣으면 긴 검증 보고서와 함께 잘려 나간다
   */
  async commit(
    message: string,
    body?: string,
    {
      allowEmpty = false,
      findSecrets,
      trailers = [],
      expectStaged,
      expectExcluded,
      expectedHead,
      onCommitted,
    }: {
      allowEmpty?: boolean;
      findSecrets?: (text: string) => string[];
      trailers?: readonly string[];
      /** 검증한 내용의 지문. 다르면 StagedMismatchError */
      expectStaged?: ReadonlyMap<string, string>;
      /** 검증한 생성 파일의 지문. 다르면 StagedMismatchError(#775) */
      expectExcluded?: ReadonlyMap<string, string>;
      /** 마지막 체크포인트. 다르면 HeadMovedError(이슈 #706) */
      expectedHead?: string;
      /** 커밋이 HEAD에 올라간 직전에 그 sha로 부른다(ADR-212) */
      onCommitted?: (sha: string) => void;
    } = {},
  ): Promise<Checkpoint | undefined> {
    // 기대 지문은 옛 `stagedMismatchOf`와 같이 단사로 바꿔 보낸다
    const staged = expectStaged ? [...expectStaged].map(([file, print]) => [encodeLoneSurrogates(file), encodeLoneSurrogates(print)] as [string, string]) : null;
    const hooks: Record<string, (request: Record<string, unknown>) => Promise<unknown>> = {};
    if (findSecrets) hooks.findSecrets = async (request) => ({ secrets: findSecrets(String(request.text ?? '')) });
    if (onCommitted) hooks.onCommitted = async (request) => void onCommitted(String(request.sha ?? ''));
    const checkpoint = await this.#remote<Checkpoint | null>(
      'commit',
      {
        message,
        body: body ?? null,
        allowEmpty,
        trailers: [...trailers],
        expectStaged: staged,
        expectExcluded: expectExcluded ? [...expectExcluded] : null,
        expectedHead: expectedHead ?? null,
        hasFindSecrets: findSecrets !== undefined,
        hasOnCommitted: onCommitted !== undefined,
      },
      { ...this.#excludedFilesHooks(), ...hooks },
    );
    return checkpoint ?? undefined;
  }

  /**
   * 작업 복사본의 파일이 지금 스테이징되면 인덱스에 들어갈 모습의 지문(프로젝트 기준 경로 → 지문).
   * 일반 파일은 git이 add할 때와 같은 변환(줄 끝, 필터)을 거친 blob id라서, 스테이징한 뒤 인덱스의 id와 그대로 견줄 수 있다.
   * 없는 파일은 `missing`, 링크는 `link:<가리키는 곳>`, 그 밖(폴더, 장치)은 `other`다.
   */
  async stagedFingerprints(files: readonly string[]): Promise<Map<string, string>> {
    // hash-object도 add처럼 필터를 돈다. 돌기 전에 설정을 본다(이슈 #706)
    await this.#assertSafeLocalGit();
    const projectRoot = await this.projectRoot();
    const subdir = await this.#subdir();
    const prints = new Map<string, string>();
    const regular: string[] = [];
    for (const file of files) {
      const info = await lstat(path.join(projectRoot, file)).catch(() => undefined);
      if (!info) prints.set(file, 'missing');
      else if (info.isSymbolicLink()) prints.set(file, `link:${await readlink(path.join(projectRoot, file)).catch(() => '')}`);
      else if (!info.isFile()) prints.set(file, 'other');
      else regular.push(file);
    }
    // 인자 길이 상한을 넘지 않게 나눠 부른다. 순서대로 한 줄에 id 하나가 온다
    for (let index = 0; index < regular.length; index += 200) {
      const chunk = regular.slice(index, index + 200);
      const ids = (await this.#git(['hash-object', '--', ...chunk.map((file) => (subdir ? `${subdir}/${file}` : file))])).split('\n').filter(Boolean);
      // 그 사이에 파일이 사라지거나 바뀌어 개수가 맞지 않으면 어느 것도 믿지 않는다
      if (ids.length !== chunk.length) throw new CheckpointError('파일의 지문을 읽는 동안 작업 복사본이 바뀌었습니다');
      chunk.forEach((file, offset) => prints.set(file, `blob:${ids[offset]!}`));
    }
    return prints;
  }

  /**
   * 지정한 경로만 범위로 체크포인트를 남긴다. 그 밖에 바뀐 파일이 있어도 손대지 않고 그대로 둔다(ADR-096).
   * 요구사항 저장처럼 문서만 바꾼 변경을, 함께 진행 중일 수 있는 코드 변경과 섞지 않고 따로 커밋할 때 쓴다.
   * 범위 안에 바뀐 파일이 없으면 커밋하지 않는다(undefined) — 저장했지만 내용이 같았던 경우를 조용히 건너뛴다.
   */
  async commitPaths(
    paths: readonly string[],
    message: string,
    body?: string,
    {
      findSecrets,
      trailers = [],
      expectedHead,
    }: { findSecrets?: (text: string) => string[]; trailers?: readonly string[]; expectedHead?: string } = {},
  ): Promise<Checkpoint | undefined> {
    const hooks: Record<string, (request: Record<string, unknown>) => Promise<unknown>> = {};
    if (findSecrets) hooks.findSecrets = async (request) => ({ secrets: findSecrets(String(request.text ?? '')) });
    const checkpoint = await this.#remote<Checkpoint | null>(
      'commitPaths',
      {
        paths: [...paths],
        message,
        body: body ?? null,
        trailers: [...trailers],
        expectedHead: expectedHead ?? null,
        hasFindSecrets: findSecrets !== undefined,
        // 임시 인덱스 이름. 옛 코드처럼 TS의 backupId()를 한 번 소비한다
        tempIndexId: paths.length > 0 ? backupId() : '',
      },
      hooks,
    );
    return checkpoint ?? undefined;
  }

  /**
   * 마지막 체크포인트 이후의 변경을 버린다. 무엇을 버렸는지 볼 수 있게 patch를 함께 돌려주고, 되살릴 수 있게
   * 백업도 남긴다(ADR-099) — 버리기 전에 조용히 사라지는 변경이 없게 한다. 문서 경로를 먼저 지키는 일은
   * 이 메서드의 책임이 아니다(어떤 경로가 "문서"인지는 studio 쪽 정책이다) — 부르는 쪽이 discard() 전에
   * 문서만 먼저 체크포인트로 남겨야 한다.
   */
  async discard(): Promise<{ files: string[]; patch: string; backup?: DiscardBackup }> {
    const result = await this.#remote<{ files: string[]; patch: string; backup: DiscardBackup | null }>('discard', {}, { ...this.#excludedFilesHooks(), ...this.#backupIdentityHooks() });
    return { files: result.files, patch: result.patch, backup: result.backup ?? undefined };
  }

  /**
   * 최신 체크포인트부터. 복제한 저장소의 이전 기록은 포함하지 않고 세션 시작에서 끝난다.
   * 원격에서 가져온 커밋은 병합 커밋 하나로만 보이도록 첫 번째 부모만 따라간다
   */
  async list(limit = 50): Promise<Checkpoint[]> {
    return this.#remote<Checkpoint[]>('list', { limit });
  }

  /** 체크포인트 하나의 변경. redact는 pendingPatch처럼 자르기 전에 적용한다(#751) */
  async patch(sha: string, redact: (text: string) => string = (text) => text): Promise<string> {
    return this.#remote<string>('patch', { sha }, { redact: async (request) => ({ text: redact(String(request.text ?? '')) }) });
  }

  /**
   * 체크포인트(기본 HEAD)에 커밋된 파일 내용(프로젝트 폴더 기준 경로). 그 시점에 파일이 없으면 undefined.
   * 작업 복사본이 아니라 커밋된 값을 읽으므로, 에이전트가 작업 트리에서 바꾼 것과 무관한 "믿을 수 있는 기준"이다
   * (요구사항 문서의 사람 확인 기록 되돌리기, ADR-157).
   */
  async fileAt(file: string, ref = 'HEAD'): Promise<string | undefined> {
    return (await this.#remote<string | null>('fileAt', { file, ref })) ?? undefined;
  }

  /**
   * 체크포인트(ref)에 커밋된 파일의 바이트를 파일 종류까지 보고 꺼낸다. 일반 파일(100644)·실행 파일(100755)만
   * 내용을 주고, 심볼릭 링크(120000)·서브모듈(160000)·폴더 같은 그 밖의 종류는 unsupported로 알린다. 그 시점에
   * 경로가 없으면 missing이다. 작업 폴더가 아니라 커밋된 값을 읽으므로, 체크포인트 뒤에 파일이 프로젝트 밖을
   * 가리키는 링크로 바뀌어도 그 내용을 쓰지 않는다. 모노레포 하위 폴더 처리는 fileAt과 같다
   */
  async blobAt(file: string, ref: string): Promise<BlobAt> {
    const found = await this.#remote<{ kind: 'file'; content: string; executable: boolean } | { kind: 'missing' } | { kind: 'unsupported'; mode: string }>('blobAt', { file, ref });
    if (found.kind !== 'file') return found;
    return { kind: 'file', content: Buffer.from(found.content, 'base64'), executable: found.executable };
  }

  /**
   * 체크포인트(ref)에 커밋된 폴더 아래의 일반 파일(100644·100755)을 모두 꺼낸다. `git ls-tree -r`로 커밋된 판만 보므로,
   * 작업 트리에서 파일을 지우거나 링크로 바꿔도 그 시점의 내용이 나온다. 링크(120000)·서브모듈(160000)은 넣지 않는다.
   * 돌려주는 path는 프로젝트 폴더 기준이다(blobAt과 같은 규칙, 모노레포 하위 폴더도 같다)
   */
  async listBlobs(ref: string, dir: string): Promise<CheckpointBlob[]> {
    const blobs = await this.#remote<Array<{ path: string; content: string; executable: boolean }>>('listBlobs', { ref, dir });
    return blobs.map((blob) => ({ path: blob.path, content: Buffer.from(blob.content, 'base64'), executable: blob.executable })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 이 세션 기록에 있는 체크포인트로 되돌린다. 그 뒤의 체크포인트는 기록(reflog)에 남아 되찾을 길이 있지만,
   * 아직 체크포인트로 남기지 않은 변경(pending)은 이대로면 영영 사라지므로 버리기 전에 백업한다(ADR-099).
   * 돌려주는 파일 목록으로 어떤 서비스를 재시작할지 정한다.
   */
  async restore(sha: string): Promise<{ checkpoint: Checkpoint; files: string[]; backup?: DiscardBackup }> {
    const result = await this.#remote<{ checkpoint: Checkpoint; files: string[]; backup: DiscardBackup | null }>('restore', { sha }, { ...this.#excludedFilesHooks(), ...this.#backupIdentityHooks() });
    return { checkpoint: result.checkpoint, files: result.files, backup: result.backup ?? undefined };
  }

  /**
   * 되살리기 백업 하나를 작업 복사본에 그대로 되돌린다. 그 사이에 같은 파일이 다시 바뀌어 패치가 깨끗하게
   * 들어가지 않으면(git apply --check 실패) 거부한다 — 일부만 들어가 상태를 더 헷갈리게 만들지 않는다.
   */
  async restoreBackup(id: string): Promise<{ files: string[] }> {
    if (!native.checkpointIsBackupId(id)) throw new CheckpointError('백업 id 형식이 올바르지 않습니다');
    const dir = this.#backupDir(id);
    const patchFile = path.join(dir, 'changes.patch');
    const meta = await readFile(path.join(dir, 'meta.json'), 'utf8').then(
      (text) => JSON.parse(text) as DiscardBackup,
      () => {
        throw new CheckpointError('백업을 찾을 수 없습니다. 이미 지워졌을 수 있습니다');
      },
    );
    const patch = await readFile(patchFile, 'utf8').catch(() => '');
    const excludedManifestText = await readFile(path.join(dir, 'excluded-manifest.json'), 'utf8').catch(() => undefined);
    if (!patch.trim() && excludedManifestText === undefined) return { files: [] };

    if (patch.trim()) {
      try {
        await this.#git(['apply', '--check', patchFile]);
      } catch (error) {
        throw new CheckpointError(
          `그 사이 바뀐 파일과 충돌해 되살리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.#git(['apply', patchFile]);
    }

    if (excludedManifestText !== undefined) {
      // 생성 파일(제외됨)은 git 기록이 없어 충돌을 확인할 길이 없다 — 백업한 내용으로 그대로 되살린다.
      // 경로의 어느 조각이 링크여도 따라가지 않도록 쓰기·지우기·링크 만들기는 Rust(`workspace_io`)가 한다.
      // 백업 폴더는 손으로 바뀔 수 있으므로 manifest 이름도 그 자리에서 다시 검사한다
      await this.#remote('restoreBackupExcluded', { backupDir: dir });
    }
    return { files: meta.files };
  }

  /** 지금까지 남은 되살리기 백업. 최신순 */
  async discardedBackups(): Promise<DiscardBackup[]> {
    const backups = await this.#remote<DiscardBackup[]>('discardedBackups');
    return backups.sort((a, b) => b.id.localeCompare(a.id));
  }

  /**
   * git add -A로 이미 올린 인덱스 전체(base 대비)를 되살릴 수 있는 패치로 저장하고, 생성 파일(제외됨, 도그푸딩 마찰
   * 127)의 지금 내용도 같은 백업 id 아래에 함께 담는다. 버릴 변경이 전혀 없으면(둘 다 비어 있으면) 아무것도 쓰지
   * 않는다. #git 호출에 -C root가 이미 들어가 있어 패치의 경로는 저장소 루트 기준이고, 되살릴 때(restoreBackup)도
   * 같은 기준으로 적용한다 — 모노레포 하위 폴더 세션이어도 add -A가 이미 scope로 좁혔으므로 patch는 scope 안의
   * 변경만 담는다. base는 견줄 기준 커밋(기본 HEAD). restoreRememberedHead는 기억한 체크포인트를 기준으로 준다
   */
  async #backupChanges(trackedFiles: readonly string[], excluded: readonly ExcludedChange[], base = 'HEAD'): Promise<DiscardBackup | undefined> {
    const encoded = excluded.map((change) => ({
      file: change.file,
      before: change.before === undefined ? null : change.before.toString('base64'),
      beforeLink: change.beforeLink ?? null,
    }));
    const backup = await this.#remote<DiscardBackup | null>('backupChanges', { trackedFiles: [...trackedFiles], excluded: encoded, base }, this.#backupIdentityHooks());
    return backup ?? undefined;
  }

  /** 백업 id와 만든 시각은 필요할 때만 TS가 정한다(옛 `backupSequence`·`new Date()`) */
  #backupIdentityHooks(): Record<string, (request: Record<string, unknown>) => Promise<unknown>> {
    return { backupIdentity: async () => ({ id: backupId(), createdAt: new Date().toISOString() }) };
  }

  #backupRoot(): string {
    return path.join(this.gitDir, BACKUP_DIRNAME);
  }

  #backupDir(id: string): string {
    return path.join(this.#backupRoot(), id);
  }

  // ---------------------------------------------------------------------------
  // 생성 파일(제외됨) 스냅샷(ADR-141, 도그푸딩 마찰 127): 폴더 열기(ADR-067)가 만든 studio.yaml·compose.b-studio.yaml·
  // Dockerfile.b-studio는 사용자 저장소를 더럽히지 않으려고 .git/info/exclude로 이 저장소의 git 추적에서도 뺀다.
  // 그래서 git add -A·status·reset·clean이 모두 이 파일을 보지 못해, 실패한 실행이 고친 내용이 discard()·restore()로
  // 되돌아가지 않았다. excludedFiles 제공자가 돌려준 후보 중 실제로 이 저장소가 무시하는 파일만 골라, 체크포인트를
  // 남길 때마다(commit·commitPaths·init) 그 내용을 git 밖(gitDir/b-studio/excluded/<sha>)에 함께 남기고,
  // discard()·restore()가 그 스냅샷과 지금 디스크를 비교해 같이 되돌리게 한다. 커밋 오브젝트에는 전혀 들어가지
  // 않으므로 push()에도 새지 않는다(원래 요구사항 그대로 유지).
  // ---------------------------------------------------------------------------

  /** `excludedFiles` 제공자를 Rust 콜백으로 넘긴다. 없으면 빈 객체(그때는 사이드카를 만들지 않는다) */
  #excludedFilesHooks(): Record<string, (request: Record<string, unknown>) => Promise<unknown>> {
    if (!this.#excludedFiles) return {};
    const excludedFiles = this.#excludedFiles;
    return {
      excludedFiles: async (request) => ({ files: [...(await excludedFiles(String(request.projectRoot)))] }),
    };
  }

  /**
   * 지금 이 체크포인트(sha)가 git 추적 밖에 둔 생성 파일의 내용을 사이드카로 남긴다. "지금 디스크 상태를 그대로
   * 받아들인다"는 뜻이라 commit()·init()처럼 게이트를 통과한 변경을 그대로 남기는 체크포인트에서만 자동으로 부른다.
   * 세션 시작 직후 overlayGeneratedFiles()처럼 체크포인트 없이 생성 파일을 끼워 넣는 경우에만 studio 쪽이 그
   * 체크포인트의 sha로 따로 부른다. 문서만 좁혀 남기는 commitPaths()나 원격·기준 브랜치만 들여오는 병합처럼
   * "이 체크포인트는 생성 파일을 바꾸지 않았다"는 뜻이면 이 메서드 대신 #carryForwardExcludedSnapshot을 쓴다 —
   * 그렇지 않으면 아직 받아들이지 않은(discard 대상인) 생성 파일 변경을 부모 체크포인트의 스냅샷으로 덮어써,
   * 그 변경이 영영 되돌릴 수 없는 "이미 그런 적 있던 상태"로 둔갑한다.
   * expected(검증한 생성 파일 지문, #775)를 주면 디스크 내용이 검증과 같을 때만 남기고, 다르면 StagedMismatchError를 던지며
   * 스냅샷을 바꾸지 않는다. 생성 파일만 바뀐 실행이 게이트를 통과한 뒤 기준선을 갱신할 때 쓴다
   */
  async refreshExcludedSnapshot(sha = 'HEAD', expected?: ReadonlyMap<string, string>): Promise<void> {
    if (!this.#excludedFiles) return;
    await this.#remote('refreshExcludedSnapshot', { sha, expected: expected ? [...expected] : null }, this.#excludedFilesHooks());
  }

  /**
   * 지금 디스크의 생성 파일을 임시 폴더로 읽어 둔다(스냅샷 형식 그대로: files/와 manifest). expected를 주면(#775) 읽어 둔
   * 내용을 게이트가 검증한 지문과 견준다:
   *  - expected에 있는 파일은 지문이 같아야 한다(없어진 파일은 `missing`, 링크는 `link:<가리키는 곳>`)
   *  - expected에 없는 파일은 기준 체크포인트(base)의 스냅샷과 같아야 한다. 검증에 없던 변경이다. 기준 스냅샷이 없으면
   *    그 시점 상태를 모르므로 견주지 않는다(#excludedDiff와 같은 규칙)
   * 다르면 임시 폴더를 지우고 StagedMismatchError를 던진다. 견준 바이트를 그대로 스냅샷으로 옮기므로(#placeExcludedSnapshot),
   * 견준 뒤에 디스크가 바뀌어도 검증하지 않은 내용이 기준선이 되지 않는다
   */
  async #stageExcludedSnapshot(expected?: ReadonlyMap<string, string>, base?: string): Promise<{ dir: string; manifest: Record<string, boolean> }> {
    return this.#remote<{ dir: string; manifest: Record<string, boolean> }>(
      'stageExcludedSnapshot',
      { expected: expected ? [...expected] : null, base: base ?? null },
      this.#excludedFilesHooks(),
    );
  }

  /** 읽어 둔 생성 파일을 sha 체크포인트의 스냅샷으로 옮긴다. 생성 파일이 하나도 없으면 스냅샷을 두지 않는다(예전과 같다) */
  async #placeExcludedSnapshot(sha: string, staged: { dir: string; manifest: Record<string, boolean> }): Promise<void> {
    await this.#remote('placeExcludedSnapshot', { sha, dir: staged.dir, manifest: staged.manifest });
  }

  /**
   * parentSha의 생성 파일 스냅샷을 newSha로 그대로 옮긴다(지금 디스크 상태를 보지 않는다). commitPaths()(문서만
   * 좁혀 남기는 체크포인트)·integrateRemote()·integrateBase()(원격·기준 브랜치의 내용만 들여오는 병합 — 둘 다
   * 생성 파일을 바꾸지 않는다)가 쓴다. 부모에 스냅샷이 없으면(생성 파일이 없던 시점) 새 체크포인트도 "없음"으로 둔다.
   */
  async #carryForwardExcludedSnapshot(parentSha: string, newSha: string): Promise<void> {
    if (!this.#excludedFiles || parentSha === newSha) return;
    await this.#remote('carryForwardExcludedSnapshot', { parentSha, newSha });
  }

  /**
   * 체크포인트(sha) 뒤에 생기거나 바뀐 무시된(.gitignore) 파일(#778). 되돌리기(`clean -fd`)는 무시된 파일을 지우지 않아, 실패한
   * 실행이 만든 테스트 설정 같은 파일이 남아 다음 게이트의 결과를 바꿀 수 있다. 지우지 않고 알리기만 한다. 무시된 파일이 언제
   * 생겼는지 git은 모르고, 사람이 고친 .env.local 같은 파일도 같은 목록에 들기 때문이다.
   *  - 폴더째 무시된 것(node_modules/, build/ 등)은 의존성·빌드 출력이라 보지 않는다
   *  - 생성 파일(excludedFiles)은 스냅샷이 되돌리므로 뺀다
   *  - 커밋 시각은 초 단위라 수정 시각도 초로 내려 견준다. 체크포인트와 같은 초에 바뀐 파일은 빠진다
   */
  async ignoredChangedSince(sha = 'HEAD'): Promise<string[]> {
    return this.#remote<string[]>('ignoredChangedSince', { sha }, this.#excludedFilesHooks());
  }

  async pendingExcludedFiles(): Promise<string[]> {
    if (!this.#excludedFiles) return [];
    return this.#remote<string[]>('pendingExcludedFiles', {}, this.#excludedFilesHooks());
  }

  /**
   * target 체크포인트의 생성 파일 스냅샷과 지금 디스크를 비교해, 내용이 다른 파일만 돌려준다(되돌리지 않는다).
   * 비교 대상은 지금 디스크에 있는 후보(excludedFiles 제공자, 새로 생긴 서비스의 Dockerfile 등도 잡는다)와
   * target 스냅샷에 적힌 파일의 합집합이다 — 그래야 그 사이에 지워진 파일도 "되돌아가야 할 변경"으로 잡힌다.
   */
  async #excludedDiff(target: string): Promise<ExcludedChange[]> {
    if (!this.#excludedFiles) return [];
    const changes = await this.#remote<Array<{ file: string; before: string | null; after: string | null; beforeLink?: string | null; afterLink?: string | null }>>(
      'excludedDiff',
      { target },
      this.#excludedFilesHooks(),
    );
    return changes.map((change) => ({
      file: change.file,
      before: change.before === null ? undefined : Buffer.from(change.before, 'base64'),
      after: change.after === null ? undefined : Buffer.from(change.after, 'base64'),
      ...(change.beforeLink ? { beforeLink: change.beforeLink } : {}),
      ...(change.afterLink ? { afterLink: change.afterLink } : {}),
    }));
  }

  /** #excludedDiff가 계산한 변경을 실제로 적용한다(없던 파일은 지우고, 있던 파일은 그 내용으로 되돌린다). 적용한 파일 이름을 돌려준다 */
  async #applyExcludedDiff(changes: readonly ExcludedChange[]): Promise<string[]> {
    if (changes.length === 0) return [];
    const encoded = changes.map((change) => ({
      file: change.file,
      after: change.after === undefined ? null : change.after.toString('base64'),
      afterLink: change.afterLink ?? null,
    }));
    return this.#remote<string[]>('applyExcludedDiff', { changes: encoded });
  }

  /**
   * 세션 시작(첫 체크포인트) 이후 지금 HEAD까지의 전체 변경. PR의 base...head diff와 같다(시작 커밋이 세션 브랜치가
   * 갈라진 지점이라서다). AI 리뷰가 보는 diff가 이 함수로 만든다. 크기 제한은 부르는 쪽(pr-review.ts의 truncateDiff)이 한다
   */
  async sessionDiff(): Promise<string> {
    return this.#remote<string>('sessionDiff');
  }

  /**
   * sha부터 지금 HEAD까지의 변경(sessionDiff와 같은 모양, 시작점만 세션 시작이 아니라 주어진 커밋이다).
   * PR 자동 리뷰(ADR-074)가 이미 열려 있던 PR에 새 커밋이 쌓였을 때, 전체 base...head가 아니라 마지막으로
   * 리뷰한 커밋 이후의 변경만 다시 보는 데 쓴다 — 같은 지적을 되풀이해 보고하지 않도록 범위를 좁힌다
   */
  async diffSince(sha: string): Promise<string> {
    return this.#remote<string>('diffSince', { sha });
  }

  /**
   * 주어진 시각 이전에 만든 마지막 커밋(HEAD 기준). 리뷰 라운드가 끝 지점(headSha)을 기록하기 전에 끝난 옛 라운드의
   * 기준점을 되짚을 때 쓴다 — 그 라운드가 시작될 때 HEAD였던 커밋이 곧 그 라운드가 본 diff의 끝이다
   */
  async commitBefore(iso: string): Promise<string | undefined> {
    return (await this.#remote<string | null>('commitBefore', { iso })) ?? undefined;
  }

  /** 원본 Git 저장소에서 시작한 세션만 원격 정보가 있다 */
  async repository(): Promise<RepositoryInfo | undefined> {
    return (await this.#remote<RepositoryInfo | null>('repository')) ?? undefined;
  }

  /** 지금 작업 복사본의 HEAD와 체크아웃된 브랜치. 분리된 HEAD면 branch가 없다(이슈 #699) */
  async headState(): Promise<HeadState> {
    return this.#remote<HeadState>('headState');
  }

  /** origin 주소. 원격이 없으면 undefined. 세션을 만들 때 기억할 주소를 읽는 데 쓴다(이슈 #699) */
  async remoteUrl(): Promise<string | undefined> {
    return (await this.#remote<string | null>('remoteUrl')) ?? undefined;
  }

  /** ancestor가 descendant의 조상인가(같으면 참). 터미널 턴 끝 검사가 에이전트의 커밋을 풀 수 있는지 판단할 때 쓴다 */
  async isAncestorOf(ancestor: string, descendant: string): Promise<boolean> {
    return this.#isAncestor(ancestor, descendant);
  }

  /**
   * 지금 HEAD가 체크포인트 sha보다 앞서 있을 때, 그 뒤의 커밋을 풀어 변경으로 되돌린다(git reset --soft, 이슈 #699).
   * 에이전트가 터미널에서 직접 만든 커밋을 b-studio가 검증할 수 있게 풀 때 쓴다. 푼 커밋 수를 돌려준다
   */
  async uncommitTo(sha: string): Promise<number> {
    return (await this.#remote<number | null>('uncommitTo', { sha: encodeLoneSurrogates(sha) })) ?? Number.NaN;
  }

  /**
   * 터미널 실행이 작업 복사본의 Git 기록을 b-studio가 기억한 것과 다르게 만들었을 때(브랜치를 바꿈, 분리된 HEAD,
   * 기록을 되감음) 기억한 체크포인트로 되돌린다(이슈 #699). 지금 작업 복사본이 기억한 체크포인트와 다른 부분은
   * discard()와 같은 방식으로 백업한다(ADR-099). 세션 브랜치로 강제로 옮긴 뒤 그 체크포인트로 hard reset 하고,
   * 브랜치가 없어졌으면 그 체크포인트에서 다시 만든다
   */
  async restoreRememberedHead(remembered: RememberedGit): Promise<{ files: string[]; patch: string; backup?: DiscardBackup }> {
    // 순서(Rust, crates/bstudio-io/src/checkpoint_remote.rs): 체크포인트 확인 → before → add -A → 바뀐 파일·패치 → backup → checkout → reset → clean → after.
    // 백업(backup 콜백)이 실패하면 Rust가 checkout·reset·clean을 부르지 않는다
    let excluded: ExcludedChange[] = [];
    let backup: DiscardBackup | undefined;
    let reverted: string[] = [];
    const done = await this.#remote<{ files: string[]; patch: string }>(
      'restoreRememberedHead',
      { remembered: rememberedInput(remembered) },
      {
        beforeRestore: async () => {
          excluded = await this.#excludedDiff(await this.#headSha());
        },
        backup: async (request) => {
          backup = await this.#backupChanges(request.files as string[], excluded, request.checkpoint as string);
        },
        afterRestore: async () => {
          reverted = await this.#applyExcludedDiff(excluded);
        },
      },
    );
    return { files: [...new Set([...done.files, ...reverted])].sort(), patch: done.patch, backup };
  }

  /**
   * 지금 작업 복사본의 Git이 기억한 것과 같은지 본다. 다르면 던진다(올리기·가져오기·PR 전 확인, 이슈 #699).
   * 브랜치·HEAD가 다르거나, 원격 주소가 다르거나, 저장소 로컬 설정에 주소·자격 증명을 바꿀 수 있는 값이 있으면 멈춘다.
   * 무엇이 다른지와, 사람이 고친 것이면 되돌린 뒤 다시 하라는 안내를 담는다
   */
  async assertTrustedGit(remembered: RememberedGit): Promise<void> {
    await this.#remote('assertTrustedGit', { remembered: rememberedInput(remembered) });
  }

  /**
   * add·hash-object·commit·archive처럼 저장소 설정에 따라 프로그램을 부르거나 내용을 바꾸는 명령 앞에서 본다(이슈 #706).
   * 위험한 설정이나 `.git/info/attributes`가 있으면 던진다. 컨테이너 방식은 `.git`이 읽기 전용이라 여기 걸릴 것이 없다
   */
  async #assertSafeLocalGit(): Promise<void> {
    await this.#remote('assertSafeLocalGit');
  }

  /**
   * 원격 경로(올리기·가져오기·기준 브랜치·PR 대상)와 신뢰 확인의 git 호출 순서는 Rust(`checkpoint_remote.rs`)가 한다(ADR-195 4f A2).
   * 원격에 닿는 명령(fetch·push·ls-remote)은 Rust에서 신뢰 확인을 지나는 한 함수로만 부른다 — 여기서는 부를 수 없다.
   * 이 함수는 입력을 JSON으로 보내고 결과를 옛 오류 클래스로 바꾼다. 순서 중간에 TS 상태가 끼는 자리(저장하지 않은 변경 수, 백업·제외 스냅샷)는 `hooks`로 Rust가 부른다.
   * 캐시(`#start`·`#subdirCache`)는 Rust가 읽은 값을 돌려받아 갱신한다(콜드·웜에서 git 호출 순서가 옛 코드와 같다)
   */
  async #remote<T = undefined>(
    op: string,
    input: Record<string, unknown> = {},
    hooks: Record<string, (request: Record<string, unknown>) => Promise<unknown>> = {},
  ): Promise<T> {
    let thrown: { error: unknown } | undefined;
    const hook = async (text: string): Promise<string> => {
      try {
        const request = JSON.parse(text, (_key, value: unknown) => (typeof value === 'string' ? decodeLoneSurrogates(value) : value)) as Record<string, unknown>;
        // Rust가 읽어 둔 캐시를 먼저 받는다(콜백 안의 git 호출 순서가 옛 코드와 같다)
        if (typeof request.start === 'string') this.#start = request.start;
        if (typeof request.subdir === 'string') this.#subdirCache = request.subdir;
        if (request.op === 'pendingFiles') return JSON.stringify({ ok: true, count: (await this.pendingFiles()).length });
        const handler = hooks[String(request.op)];
        if (!handler) throw new CheckpointError(`알 수 없는 원격 경로 콜백입니다: ${String(request.op)}`);
        const answer = await handler(request);
        return JSON.stringify({ ok: true, ...(answer !== null && typeof answer === 'object' ? answer : {}) });
      } catch (error) {
        thrown ??= { error };
        return JSON.stringify({ ok: false });
      }
    };
    const text = await native.checkpointRemote(
      op,
      JSON.stringify({
        root: this.root,
        gitBin: this.#gitBin,
        gitDir: this.#separateGitDir,
        start: this.#start,
        subdir: this.#subdirCache,
        authorEmail: encodeLoneSurrogates(this.#author.email),
        authorName: encodeLoneSurrogates(this.#author.name),
        hasExcludedFiles: this.#excludedFiles !== undefined,
        ...input,
      }),
      hook,
    );
    const result = JSON.parse(text, (_key, value: unknown) => (typeof value === 'string' ? decodeLoneSurrogates(value) : value)) as {
      ok: boolean;
      value?: T;
      kind?: string;
      message?: string;
      conflicts?: string[];
      files?: string[];
      expected?: string;
      actual?: string;
      cache?: { start?: string | null; subdir?: string | null };
    };
    this.#start = result.cache?.start ?? this.#start;
    this.#subdirCache = result.cache?.subdir ?? this.#subdirCache;
    if (result.ok) return result.value as T;
    if (result.kind === 'conflict') throw new RemoteConflictError(result.conflicts ?? []);
    if (result.kind === 'staged_mismatch') throw new StagedMismatchError(result.files ?? []);
    if (result.kind === 'head_moved') throw new HeadMovedError(result.expected ?? '', result.actual ?? '');
    // 옛 코드가 `fs`에서 받아 그대로 던지던 오류다(백업·스냅샷을 쓰다 난 오류). CheckpointError로 바꾸지 않는다
    if (result.kind === 'io') throw new Error(result.message ?? '파일을 다루지 못했습니다');
    if (result.kind === 'hook') throw thrown?.error ?? new CheckpointError('원격 경로의 콜백이 실패했습니다');
    throw new CheckpointError(result.message ?? '원격 경로가 실패했습니다');
  }

  async pullRequestTarget(remembered: RememberedGit): Promise<PullRequestTarget> {
    return this.#remote<PullRequestTarget>('pullRequestTarget', { remembered: rememberedInput(remembered) });
  }

  async recordPullRequest(url: string): Promise<void> {
    await this.#remote('recordPullRequest', { url });
  }

  /** 세션 시작 이후 체크포인트 커밋. 오래된 것부터. 원격에서 가져온 커밋은 병합 커밋으로만 들어간다 */
  async sessionCommits(): Promise<SessionCommit[]> {
    const start = await this.#startSha();
    const records = decodeNative<ParsedLogRecord[]>(
      native.checkpointSessionRecords(
        await this.#git([
          'log', '--first-parent', '--reverse',
          `--format=%H%x00%h%x00%s%x00%b%x00%ae%x00%(trailers:key=${WORKFLOW_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_VERIFY_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_INCOMPLETE_TRAILER},valueonly,separator=%x1f)%x1e`,
          `${start}..HEAD`,
        ]),
        encodeLoneSurrogates(this.#author.email),
      ),
    );
    return Promise.all(
      records.map(async (record) => {
        // 통과 기록·문서 체크포인트 표시는 스튜디오가 만든 커밋에서만 읽는다(#checkpoint와 같은 경계)
        const passedStages = record.ours ? parseWorkflowTrailerValues(record.trailers) : undefined;
        const verify = record.ours ? parseVerifyTrailerValues(record.verifyTrailers) : undefined;
        const incomplete = record.ours ? parseIncompleteTrailerValues(record.incompleteTrailers) : undefined;
        return {
          sha: record.sha,
          shortSha: record.shortSha,
          subject: record.subject,
          body: record.body,
          files: await this.#changedFiles(record.sha),
          stat: await this.#commitStat(record.sha),
          ...(passedStages ? { passedStages } : {}),
          ...(verify ? { verify } : {}),
          ...(incomplete ? { incomplete } : {}),
        };
      }),
    );
  }

  /** 커밋 하나가 바꾼 줄 수(추가·삭제). 제출 준비 점검(ADR-080)이 한 커밋이 전체 변경을 독차지하는지 볼 때 쓴다 */
  async #commitStat(sha: string): Promise<{ insertions: number; deletions: number }> {
    const parent = await this.#firstParent(sha);
    const relative = await this.#relative();
    const output = parent
      ? await this.#git(['diff', '--numstat', ...relative, parent, sha])
      : await this.#git(['diff-tree', '--no-commit-id', '--numstat', '-r', '--root', ...relative, sha]);
    const [insertions = 0, deletions = 0] = native.checkpointCommitStat(output);
    return { insertions, deletions };
  }

  /**
   * 체크포인트를 세션 브랜치로 올린다.
   * 되돌리기 뒤에는 원격 브랜치를 다른 기록으로 맞춰야 하므로 강제로 올리되,
   * 원격이 스튜디오가 마지막으로 올린 상태와 다르면(다른 사람이 커밋했으면) 거부한다.
   * remembered는 필수다. 올리기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 본다(이슈 #699) — 에이전트가
   * 브랜치·원격 주소·HEAD를 바꿨으면 멈춘다. 올릴 브랜치는 config(b-studio.branch)가 아니라 기억한 값에서 읽는다
   */
  async push(remembered: RememberedGit): Promise<PushResult> {
    return this.#remote<PushResult>('push', { remembered: rememberedInput(remembered) });
  }

  /**
   * 원격 세션 브랜치에 다른 사람이 올린 커밋을 가져온다.
   * 체크포인트마다 DB 덤프를 커밋 ID로 저장하므로, 기존 체크포인트의 ID를 바꾸는 리베이스 대신 병합 커밋 하나로 가져온다.
   * 올린 뒤 이전 체크포인트로 되돌렸다면, 버린 체크포인트가 다시 들어오지 않게 원격에만 있는 커밋의 변경만 옮겨 온다.
   * 충돌하면 작업 복사본을 가져오기 전 그대로 두고 충돌한 파일을 알린다.
   * 가져온 결과는 검증을 통과한 뒤 acceptRemote()로 받아들여야 다음에 올릴 때 원격 상태로 인정된다.
   * remembered는 필수다. 가져오기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 본다(이슈 #699)
   */
  async integrateRemote(remembered: RememberedGit): Promise<RemoteSyncResult> {
    const result = await this.#remote<RemoteSyncResult>('integrateRemote', { remembered: rememberedInput(remembered) });
    if (result.status === 'up-to-date') return result;
    return this.#withCheckpoint(result);
  }

  /** 병합·옮겨 오기가 끝난 HEAD를 체크포인트로 읽고, 생성 파일(제외됨) 스냅샷은 병합 전 것을 물려받는다 */
  async #withCheckpoint(result: RemoteSyncResult): Promise<RemoteSyncResult> {
    const checkpoint = await this.#checkpoint('HEAD');
    // 가져온 커밋은 생성 파일(제외됨)을 바꾸지 않는다 — 지금 디스크를 받아들이지 않고 병합 전 스냅샷을 그대로 물려받는다
    await this.#carryForwardExcludedSnapshot(result.previous, checkpoint.sha);
    return { ...result, checkpoint };
  }

  /**
   * 가져온 변경이 검증을 통과했을 때 원격 상태로 기록한다. 다음에 올릴 때 이 상태를 기준으로 덮어쓰는지 확인한다.
   * 가져온 체크포인트가 지금 기록에 없으면(검증에 실패해 되돌렸으면) 기록하지 않는다. 기록하면 리뷰어 커밋을 덮어쓸 수 있다
   */
  async acceptRemote(result: RemoteSyncResult): Promise<void> {
    await this.#remote('acceptRemote', { remoteSha: result.remoteSha ?? null, checkpoint: result.checkpoint?.sha ?? null });
  }

  /**
   * 기준 브랜치(main 따라잡기, ADR-076)가 이 세션보다 얼마나 앞서 있는지 가볍게 확인한다.
   * 화면이 자주(예: 60초마다) 물어도 origin에 부담을 주지 않도록, 마지막으로 가져온 지 BASE_FETCH_THROTTLE_MS 안이면
   * 새로 가져오지 않고 이미 받아 둔 상태로 다시 센다. force면 그 시간과 상관없이 새로 가져온다.
   * remembered는 필수다. 새로 가져올 때는 원격에 닿기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 본다(이슈 #699)
   */
  async baseStatus(remembered: RememberedGit, { force = false }: { force?: boolean } = {}): Promise<BaseStatus> {
    return this.#remote<BaseStatus>('baseStatus', { remembered: rememberedInput(remembered), force });
  }

  /**
   * 세션 브랜치가 갈라져 나온 기준 브랜치(main 등, ADR-076)를 병합으로 따라잡는다.
   * integrateRemote와 같은 이유로 리베이스 대신 병합 커밋을 쓴다: 체크포인트마다 DB 덤프를 커밋 ID로 저장하므로
   * 기존 체크포인트의 ID를 바꾸는 리베이스를 쓸 수 없다. 강제 푸시도 하지 않는다(세션 브랜치를 올릴 때는 그대로 push()를 쓴다).
   * 충돌하면 작업 복사본을 병합을 시작하기 전 그대로 두고 충돌한 파일을 알린다(RemoteConflictError).
   * 가져온 결과는 검증을 통과한 뒤에만 받아들여야 한다(runBaseCatchUp이 검증 게이트와 체크포인트/데이터베이스 스냅샷을
   * integrateRemote·runRemoteSync와 같은 방식으로 잇는다)
   * remembered는 필수다. 따라잡기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 본다(이슈 #699)
   */
  async integrateBase(remembered: RememberedGit): Promise<RemoteSyncResult> {
    const result = await this.#remote<RemoteSyncResult>('integrateBase', { remembered: rememberedInput(remembered) });
    if (result.status === 'up-to-date') return result;
    return this.#withCheckpoint(result);
  }

  async #firstParent(sha: string): Promise<string | undefined> {
    return (await this.#git(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ')[1];
  }

  async #checkpoint(ref: string): Promise<Checkpoint> {
    return this.#remote<Checkpoint>('checkpoint', { ref });
  }

  /** 지금 HEAD 커밋의 sha(생성 파일 스냅샷의 기준을 정하는 TS 쪽 호출부가 쓴다) */
  async #headSha(): Promise<string> {
    return (await this.#git(['rev-parse', 'HEAD'])).trim();
  }

  /** 첫 번째 부모와 비교한다. 병합 커밋은 기본 diff-tree 출력이 비어 있기 때문이다 */
  async #changedFiles(sha: string): Promise<string[]> {
    const parent = await this.#firstParent(sha);
    const relative = await this.#relative();
    const output = parent
      ? await this.#git(['diff', '--name-only', '-z', ...relative, parent, sha])
      : await this.#git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', ...relative, sha]);
    return output.split('\0').filter(Boolean);
  }

  async #subdir(): Promise<string> {
    this.#subdirCache ??= (await this.#getMeta('subdir')) ?? '';
    return this.#subdirCache;
  }

  /** git 명령의 대상을 프로젝트 폴더로 한정한다 */
  async #scope(): Promise<string[]> {
    const subdir = await this.#subdir();
    return subdir ? ['--', subdir] : [];
  }

  /** diff 계열 출력의 경로를 프로젝트 폴더 기준으로 바꾸고 폴더 밖 변경은 뺀다 */
  async #relative(): Promise<string[]> {
    const subdir = await this.#subdir();
    return subdir ? [`--relative=${subdir}`] : [];
  }

  async #startSha(): Promise<string> {
    this.#start ??= (await this.#getMeta('start')) ?? (await this.#git(['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0]!;
    return this.#start;
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.#git(['merge-base', '--is-ancestor', ancestor, descendant]).then(
      () => true,
      () => false,
    );
  }

  /** 세션 정보는 저장소 설정에 둔다. 스튜디오 서버를 재시작해도 작업 복사본만으로 복원할 수 있다 */
  async #getMeta(key: string): Promise<string | undefined> {
    return this.#git(['config', '--get', `b-studio.${key}`]).then(
      (out) => out.trim() || undefined,
      () => undefined,
    );
  }

  async #setMeta(key: string, value: string): Promise<void> {
    await this.#git(['config', `b-studio.${key}`, value]);
  }

  /**
   * 작업 폴더 안에 최상위 체크포인트 저장소가 아닌 다른 git 저장소(중첩된 `.git` 디렉터리나 파일)가, 그것도 호스트 git이
   * 무시하지 않는 자리에 있으면 던진다. 호스트 git은 작업 폴더를 다룰 때 그런 저장소를 스캔하며 그 저장소의 설정을 적용할 수
   * 있는데, 호스트 git 하드닝과 설정 검사는 최상위 저장소에만 적용된다. 그래서 체크포인트를 만들기 전에 막는다.
   *
   * 무시 여부는 이름이 아니라 `git check-ignore`로 걷는 중에 판단한다(화면·커밋이 쓰는 것과 같은 규칙 — 사용자의 `.gitignore`
   * 예외(negation)까지). 무시되는 자리(node_modules 등)의 저장소는 호스트 git이 어차피 스캔하지 않으므로 세지 않는다. 그래서
   * {@link findNestedGitRepos}가 돌려주는 것은 모두 위험한 것이고, 한도에 닿아 목록이 잘렸으면(길이가 한도와 같으면) 통과가 아니라
   * "확인하지 못함"으로 던진다(fail-closed).
   *
   * 완전한 방어는 아니다: 이 검사와 다음 git 작업 사이에 생긴 저장소는 잡지 못하고(시점 차이), 생성 파일 스냅샷처럼 무시되는
   * 경로를 따로 읽는 다른 경로(#775)는 덮지 않는다. 근본적인 구조 수정은 #1033에서 다룬다
   */
  async #assertNoNestedRepos(): Promise<void> {
    await this.#remote('assertNoNestedRepos');
  }

  async #git(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<string> {
    const location = this.#separateGitDir ? ['--git-dir', this.#separateGitDir, '--work-tree', this.root] : [];
    // diff·show의 출력은 리뷰·화면·보관본으로 간다. 저장소 설정의 외부 diff와 textconv가 내용을 바꾸지 못하게 한다(이슈 #706)
    const [command, ...rest] = args;
    const hardened = command === 'diff' || command === 'show' ? [command, '--no-ext-diff', '--no-textconv', ...rest] : args;
    return runGit(this.#gitBin, ['-C', this.root, ...location, ...hardened], options);
  }

}

/**
 * 작업 폴더(`root`)에서 최상위 저장소(`top`, 보통 `root/.git`)가 아니고 git이 무시하지도 않는 중첩 git 저장소를 찾아 프로젝트
 * 기준 경로로 돌려준다. `.git`은 디렉터리(일반 저장소)일 수도 파일(worktree·submodule의 gitdir 포인터)일 수도 있어
 * 이름이 `.git`인지로 센다(Rust `checkpoint_git::is_dot_git`). 심볼릭 링크는 따라가지 않는다(링크 너머는 작업 폴더 밖일 수 있다).
 *
 * 무시 여부는 `partitionIgnored`(디렉터리 경로들 중 git이 무시하는 집합)로 **걷는 중에** 판단해, 무시되는 디렉터리에는 들어가지
 * 않는다. 이렇게 하면 (1) 무시되는 저장소는 애초에 세지 않아 `limit`가 열린 채로 우회되지 않고(발견하는 것은 모두 호스트 git이
 * 실제로 스캔하는 위험한 것이다), (2) 큰 생성물 폴더(node_modules 등, 보통 무시됨)를 걷지 않아 빠르다. 판단 규칙은 화면·커밋이
 * 쓰는 것과 같은 `.gitignore`다(사용자의 예외(negation)까지). `limit`에 닿으면 멈추는데, 그때 호출자는 "확인하지 못함"으로
 * 다뤄야 한다(fail-closed) — 돌려준 목록이 잘렸는지는 길이가 `limit`인지로 안다
 */
export async function findNestedGitRepos(
  root: string,
  top: string | undefined,
  partitionIgnored: (relDirs: string[]) => Promise<Set<string>>,
  limit = 100,
): Promise<string[]> {
  // 걷기·`.git` 감지·한도는 Rust가 한다. 무시 여부만 이 콜백으로 묻는다(상태는 TS가 든다)
  let thrown: { error: unknown } | undefined;
  const hook = async (text: string): Promise<string> => {
    try {
      const request = JSON.parse(text) as { op?: string; dirs?: string[] };
      if (request.op !== 'partitionIgnored') throw new CheckpointError(`알 수 없는 중첩 저장소 콜백입니다: ${String(request.op)}`);
      const ignored = [...(await partitionIgnored(request.dirs ?? []))];
      return JSON.stringify({ ok: true, ignored });
    } catch (error) {
      thrown ??= { error };
      return JSON.stringify({ ok: false });
    }
  };
  const result = decodeNative<{ ok: boolean; value?: string[]; kind?: string; message?: string }>(
    await native.checkpointRemote('findNestedGitRepos', JSON.stringify({ root, gitBin: 'git', top: top ?? null, limit }), hook),
  );
  if (result.ok) return result.value ?? [];
  if (result.kind === 'hook') throw thrown?.error ?? new CheckpointError('중첩 저장소 콜백이 실패했습니다');
  throw new CheckpointError(result.message ?? '중첩 저장소를 찾지 못했습니다');
}

/** git 한 번의 stdout·stderr 상한(바이트). 넘으면 멈추고 던진다 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 인덱스 잠금(`.git/index.lock`)을 다른 git이 쥐고 있어 실패했을 때 다시 해 보는 간격(ms). 합쳐서 약 3초.
 * 잠금은 보통 수십 ms 안에 풀린다. 죽은 git이 남긴 잠금은 끝까지 풀리지 않으므로 그때는 원래의 오류를 그대로 낸다(잠금 파일을
 * 스스로 지우지 않는다 — 살아 있는 git의 것일 수 있다)
 */
const INDEX_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1400];

/** git이 인덱스 잠금을 얻지 못해 아무것도 하지 않고 끝났는가. 이 실패는 다시 해도 안전하다 */
export function isIndexLockFailure(stderr: string): boolean {
  return native.checkpointIsIndexLockFailure(stderr);
}

/**
 * 셸을 거치지 않고 인자 배열로 실행한다. 원격 작업이 사람의 입력(비밀번호, 호스트 키 확인)을 기다리며 멈추지 않게 한다.
 *
 * 인덱스 잠금의 충돌 둘을 여기서 다룬다(#682).
 * - `GIT_OPTIONAL_LOCKS=0`: `git status` 같은 읽기 명령은 인덱스를 새로 고치려고 잠금을 잠깐 잡는다(선택적 잠금). 뒤에서 도는
 *   상태 읽기(요구사항 계산, 미리보기, 화면의 주기적 조회)가 그 잠금을 쥔 사이에 체크포인트의 `git add`가 오면 실패했다.
 *   읽기 명령이 잠금을 잡지 않게 한다. 내 폴더 모드에서 사용자의 IDE·셸이 돌리는 git을 방해하지 않는 효과도 있다
 * - 그래도 부딪히면(쓰기끼리, 또는 스튜디오 밖의 git과) 잠깐 기다렸다 다시 한다
 */
async function runGit(gitBin: string, args: string[], { timeout, env }: { timeout?: number; env?: Record<string, string> } = {}): Promise<string> {
  return runGitWithRetry(args, async () => {
    const { stdout } = await execBytes(gitBin, [...GIT_HARDENING, ...args], { maxBuffer: GIT_MAX_BUFFER, timeoutMs: timeout, env: { ...gitEnv(), ...env } });
    return stdout.toString('utf8');
  });
}

/** runGit과 같지만 stdout을 Buffer로 받는다(cat-file blob처럼 바이트를 그대로 옮겨야 하는 명령) */
/**
 * 인덱스 잠금 충돌이나 시간 초과로 실패한 git 호출을 다시 해 보는 공통 루프(runGit). 문자열·바이트
 * 양쪽이 같은 재시도·오류 문구를 쓰도록 여기 한 곳에 둔다. stderr는 인코딩에 따라 문자열일 수도 Buffer일 수도 있다
 */
async function runGitWithRetry<T>(args: readonly string[], run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const failure = error as { stderr?: string | Buffer; killed?: boolean };
      const stderr = typeof failure.stderr === 'string' ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
      const delay = INDEX_LOCK_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined && !failure.killed && isIndexLockFailure(stderr)) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const command = subcommand(args);
      const trimmed = redactCredentials(stderr.trim());
      throw new CheckpointError(`git ${command} 실패${failure.killed ? ' (시간 초과)' : ''}${trimmed ? `: ${trimmed}` : ''}`);
    }
  }
}

/**
 * b-studio가 부르는 git의 환경(이슈 #706). 스튜디오 프로세스의 환경에서 PASSED_GIT_ENV 밖의 GIT_*를 빼고, 사람의 입력을
 * 기다리지 않게 하는 값과 시스템 속성 파일을 읽지 않는 값을 더한다. 시스템 설정(GIT_CONFIG_NOSYSTEM)은 끄지 않는다 — macOS의
 * git은 자격 증명 도우미(osxkeychain)를 시스템 설정에 두고, 그 파일은 에이전트가 고칠 수 없다
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return gitEnvFrom(process.env);
}

/** gitEnv()의 본체. 환경을 인자로 받는다(차등 시험이 가짜 환경으로 돌린다) */
export function gitEnvFrom(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  // 막는 검사다: 지울 키를 이름이 아니라 자리로 받는다(짝 없는 서로게이트가 든 이름이 경계에서 바뀌어도 지워진다)
  const keys = Object.keys(env);
  const keep = native.checkpointGitEnvKeep(keys);
  keys.forEach((key, index) => {
    if (!keep[index]) delete env[key];
  });
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_SSH_COMMAND: source.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

/**
 * `ls-files --stage -z`와 `diff --cached --name-only -z` 출력으로 스테이징한 것이 기대한 지문과 다른 파일들을 가린다(정렬). 막는 검사다:
 * 짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐지면 다른 두 경로가 같아져 불일치를 놓치므로 기대 쪽을 `encodeLoneSurrogates`(단사)로 바꿔 보내고,
 * 돌아온 경로는 되돌린다. git 쪽 글자는 유효한 UTF-8을 읽은 것이라 Rust가 예약 글자만 같은 규칙으로 막는다
 */
export function stagedMismatchOf(lsFiles: string, stagedNames: string, subdir: string, expected: ReadonlyMap<string, string>): string[] {
  const keys = [...expected.keys()];
  const mismatched = native.checkpointStagedMismatch(
    lsFiles,
    stagedNames,
    subdir,
    keys.map(encodeLoneSurrogates),
    keys.map((key) => encodeLoneSurrogates(expected.get(key)!)),
  );
  return mismatched.map(decodeLoneSurrogates).sort();
}

/** 체크포인트 커밋 메시지. `git commit --cleanup=whitespace -m 제목 -m 본문 -m 트레일러`가 만드는 것과 같은 글이다 */
function commitMessage(subject: string, body: string | undefined, trailers: readonly string[]): string {
  return native.checkpointCommitMessage(subject, body, [...trailers]);
}

/** 오류 메시지에 넣을 git 하위 명령. 앞에 붙인 위치·설정 옵션(-C, --git-dir, --work-tree, -c)과 그 값은 건너뛴다 */
function subcommand(args: readonly string[]): string | undefined {
  return native.checkpointSubcommand([...args]) ?? undefined;
}

/** 오류 메시지가 화면과 로그로 나가므로 주소에 들어 있는 토큰을 지운다 */
export function redactCredentials(text: string): string {
  return native.checkpointRedactCredentials(text);
}

async function resolveReal(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

/** 타임스탬프 + 단조 증가 번호. 같은 밀리초에 여러 백업이 생겨도(테스트 등) 사전순 정렬이 생성 순서와 같다 */
let backupSequence = 0;
function backupId(): string {
  backupSequence += 1;
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${backupSequence.toString(36).padStart(4, '0')}`;
}

function capText(text: string, max: number): string {
  return native.checkpointCapText(text, max);
}

/**
 * commit()에 넘긴 trailers 중 Workflow-Passed 값이 'none'(통과한 단계가 하나도 없다는 뜻)인 줄이 있는지. 막는 쪽이라 하나라도 있으면 참이다.
 * 판정은 Rust(crates/bstudio-guard/src/workflow.rs, ADR-191 3단계 3v)가 한다
 */
export function hasEmptyPassedTrailer(trailers: readonly string[]): boolean {
  return native.workflowHasEmptyPassedTrailer([...trailers]);
}

/**
 * commit()에 넘긴 trailers에 문서 체크포인트 예외(Workflow-Verify: docs, ADR-096)가 있는지. 여는 쪽이라 마지막 Workflow-Verify 줄이 정확히 docs일 때만 참이다.
 * 판정은 Rust가 한다
 */
export function hasDocsVerifyTrailer(trailers: readonly string[]): boolean {
  return native.workflowHasDocsVerifyTrailer([...trailers]);
}

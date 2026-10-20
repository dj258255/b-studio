import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkflowStage } from '@b-studio/spec';
import {
  formatVerifyTrailer,
  isDocCheckpointPath,
  parseIncompleteTrailerValues,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  WORKFLOW_INCOMPLETE_TRAILER,
  WORKFLOW_TRAILER,
  WORKFLOW_VERIFY_TRAILER,
} from './workflow';

const execFileAsync = promisify(execFile);

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
  /** 가볍게 확인(light) 실행이면 'light', 문서만 바꿔 검증 게이트 없이 남긴 체크포인트(ADR-096)면 'docs'. 전체 검증이면 없다 */
  verify?: 'light' | 'docs';
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
  verify?: 'light' | 'docs';
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
export type BlobAt = { kind: 'file'; content: Buffer } | { kind: 'missing' } | { kind: 'unsupported'; mode: string };

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
  before: Buffer | undefined;
  after: Buffer | undefined;
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

const SHA = /^[0-9a-f]{7,40}$/;
/** backupId()가 만드는 형식만 받는다(경로 조작 방어 — id는 API 요청에서 그대로 넘어온다) */
const BACKUP_ID = /^[0-9A-Za-z-]{10,64}$/;
/** 가져오기 전에 원격 세션 브랜치를 받아 두는 곳. origin/*는 원본 폴더의 브랜치를 가리킬 수 있어 쓰지 않는다 */
const REMOTE_REF = 'refs/b-studio/remote';
/** 기준 브랜치(main 등)를 받아 두는 곳 (ADR-076) */
const BASE_REF = 'refs/b-studio/base';
/** 기준 브랜치 확인(baseStatus)을 이 시간 안에 다시 부르면 새로 가져오지 않는다. 화면이 자주 물어도 origin에 부담을 주지 않는다 */
const BASE_FETCH_THROTTLE_MS = 60_000;
const MAX_PATCH_CHARS = 200_000;
const MAX_BODY_CHARS = 8_000;
const CLONE_TIMEOUT_MS = 300_000;
const PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'b-studio', email: 'checkpoints@b-studio.local' };
/**
 * b-studio가 부르는 git은 저장소의 훅과 fsmonitor를 쓰지 않는다(이슈 #699). 이 컴퓨터 방식에서는 에이전트가 작업
 * 복사본의 `.git/config`를 고칠 수 있어, `npm install`이 husky로 `core.hooksPath=.husky`를 넣으면 b-studio의
 * 체크포인트 커밋이 프로젝트의 훅(린트·테스트)을 돌아 느려지거나 실패하고, 훅이 인덱스를 바꾸면 검증한 것과 커밋한
 * 것이 달라진다. hooksPath를 /dev/null로 두면 `<hooksPath>/<훅 이름>`이 없어 어떤 훅도 돌지 않는다.
 * 모든 git 호출의 인자 맨 앞(하위 명령보다 앞)에 붙인다
 */
export const GIT_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];
/**
 * 작업 복사본의 저장소 설정(로컬·worktree 범위, include로 끌어온 것 포함)에 없어야 하는 키(이슈 #699·#706, 대소문자 무시).
 * 원격 주소를 바꾸거나 자격 증명을 가로채는 값, b-studio의 git이 프로그램을 부르게 하는 값(필터, diff·병합 드라이버,
 * 서명 프로그램, 프록시), 작업 폴더를 옮기는 값이다. include는 펼쳐 읽지만 키 자체도 막는다(조건부 include는 읽는 쪽과
 * 쓰는 쪽에서 조건이 다르게 풀릴 수 있다). 사용자의 전역·시스템 설정은 보지 않는다
 */
const DANGEROUS_LOCAL_CONFIG = [
  /^include\./i,
  /^includeif\./i,
  /^url\..*\.insteadof$/i,
  /^url\..*\.pushinsteadof$/i,
  /^credential\./i,
  /^core\.(sshcommand|gitproxy|askpass|worktree)$/i,
  /^http\.(.*\.)?(extraheader|proxy|ssl|cookiefile)/i,
  /^remote\..*\.(pushurl|receivepack|uploadpack|proxy|vcs)/i,
  /^protocol\./i,
  /^filter\./i,
  /^diff\.external$/i,
  /^diff\..*\.(textconv|command)$/i,
  /^merge\..*\.driver$/i,
  /^gpg\./i,
];
/** 켜져 있으면 막는 키. b-studio가 스스로 false로 넣는 commit.gpgsign이 여기 있다 */
const DANGEROUS_WHEN_ENABLED = [/^commit\.gpgsign$/i, /^tag\.gpgsign$/i];
/**
 * b-studio의 git에 넘기는 환경 변수 중 GIT_*로 시작해도 남기는 것(이슈 #706). 나머지 GIT_*(GIT_DIR, GIT_INDEX_FILE,
 * GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT 등)는 스튜디오 프로세스에 우연히 들어 있어도 넘기지 않는다 — 저장소·인덱스·설정을
 * 바꿔 b-studio가 본 것과 다른 것을 커밋하게 한다. PATH·HOME·프록시·인증서 변수는 자격 증명 도우미와 원격 연결에 필요해 그대로 둔다
 */
const PASSED_GIT_ENV = new Set([
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
]);
/** 샌드박스가 프로젝트 폴더에 만드는 생성물. 사용자 프로젝트의 .gitignore를 건드리지 않고 이 저장소에서만 제외한다 */
const GENERATED = ['node_modules/', '.next/', 'build/', '.gradle/', '.venv/', '__pycache__/', '*.tsbuildinfo', 'next-env.d.ts', '*.b-studio-relay-*'];
/** discard()·restore() 백업을 이 안에 둔다(ADR-099). 작업 복사본이 아니라 체크포인트 저장소 쪽이라 커밋·게이트에 걸리지 않는다 */
const BACKUP_DIRNAME = 'b-studio/discarded';
/** 백업은 이 개수를 넘으면 오래된 것부터 지운다. 방금 만든 백업은 이 한도를 넘어도 지우지 않는다 */
const BACKUP_KEEP_MAX = 10;
/** 백업 전체 용량이 이 값을 넘으면 오래된 것부터 지운다(방금 만든 백업은 예외) */
const BACKUP_KEEP_BYTES = 200 * 1024 * 1024;
/** 체크포인트마다 생성 파일(제외됨) 스냅샷을 이 안에 둔다(ADR-141). 체크포인트 sha별 하위 폴더 하나씩이다 */
const EXCLUDED_DIRNAME = 'b-studio/excluded';
/** 생성 파일은 작아서(studio.yaml 등 텍스트 몇 개) discard 백업(10개)보다 훨씬 넉넉하게 남겨도 된다 */
const EXCLUDED_KEEP_MAX = 200;

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
    return path.join(this.#excludedSnapshotDir(sha), 'files', file);
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
    if (subdir.startsWith('..') || (subdir !== '' && !allowSubfolder)) return undefined;
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
    await store.#configure();
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
    if (this.#separateGitDir) {
      // 작업 폴더가 다른 저장소(사용자의 저장소) 안에 있어도 그 저장소를 쓰지 않고 따로 만든다
      const exists = await stat(path.join(this.#separateGitDir, 'HEAD')).then(() => true, () => false);
      if (!exists) {
        await mkdir(path.dirname(this.#separateGitDir), { recursive: true });
        await this.#git(['init', '-q', '-b', 'main']);
      }
    } else {
      const toplevel = await this.#git(['rev-parse', '--show-toplevel']).then((out) => resolveReal(out.trim()), () => undefined);
      if (toplevel !== (await resolveReal(this.root))) await this.#git(['init', '-q', '-b', 'main']);
    }

    await this.#configure();
    await this.#git(['add', '-A']);
    await this.#git(['commit', '-q', '--allow-empty', '-m', oneLine(message)]);
    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    if (!(await this.#getMeta('start'))) await this.#setMeta('start', head);
    const checkpoint = await this.#checkpoint(head);
    await this.refreshExcludedSnapshot(checkpoint.sha);
    return checkpoint;
  }

  /** 마지막 체크포인트 이후 바뀐 파일 (새 파일과 삭제 포함) */
  async pendingFiles(): Promise<string[]> {
    const entries = (await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(await this.#scope())])).split('\0').filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      files.push(entry.slice(3));
      // 이름 변경은 다음 항목에 원래 경로가 온다
      if (entry[0] === 'R' || entry[0] === 'C') {
        const original = entries[++i];
        if (original) files.push(original);
      }
    }
    return (await this.#fromRoot([...new Set(files)])).sort();
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
    const subdir = await this.#subdir();
    const entries = (await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(await this.#scope())])).split('\0').filter(Boolean);
    const changes = new Map<string, PendingChange['change']>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') {
        // 이름 변경은 새 경로가 추가, 원래 경로가 삭제다
        const original = entries[++i];
        if (original) changes.set(original, 'deleted');
        changes.set(file, 'added');
        continue;
      }
      changes.set(file, code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified');
    }
    // 저장소 루트 기준 경로를 프로젝트 기준으로 바꾸고, 프로젝트 밖 경로는 뺀다
    return [...changes.entries()]
      .filter(([file]) => !subdir || file.startsWith(`${subdir}/`))
      .map(([file, change]) => ({ file: subdir ? file.slice(subdir.length + 1) : file, change }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  /** 파일 하나가 마지막 체크포인트 이후 어떻게 바뀌었는지. 아직 기록에 없는 새 파일은 빈 문자열이다 */
  async pendingPatch(file: string): Promise<string> {
    const subdir = await this.#subdir();
    const target = subdir ? `${subdir}/${file}` : file;
    return capText(await this.#git(['diff', '--no-color', ...(await this.#relative()), 'HEAD', '--', target]), MAX_PATCH_CHARS);
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
      expectedHead,
    }: {
      allowEmpty?: boolean;
      findSecrets?: (text: string) => string[];
      trailers?: readonly string[];
      /**
       * 검증한 내용의 지문(stagedFingerprints가 준 것). 주면 스테이징한 뒤 커밋하기 전에 견준다: 스테이징된 변경이 이것과
       * 하나라도 다르면(내용이 다르거나, 여기 없는 파일이 스테이징됐거나, 여기 있는 변경이 사라졌으면) 스테이징을 풀고
       * StagedMismatchError를 던진다. 커밋은 작업 복사본이 아니라 인덱스에서 만들어지므로, 견준 내용이 곧 커밋되는 내용이다.
       * 에이전트의 프로세스가 살아 있는 채로 검증하는 자리(세션 터미널)에서 쓴다 — 게이트가 통과시킨 뒤 커밋 전에 바뀐 내용이
       * 체크포인트에 들어가지 않게 한다
       */
      expectStaged?: ReadonlyMap<string, string>;
      /**
       * b-studio가 마지막으로 남긴 체크포인트(이슈 #706). 주면 지금 HEAD가 이것과 같을 때만 그 위에 커밋하고, 다르면
       * HeadMovedError를 던진다. 주지 않으면 이 함수가 시작할 때의 HEAD를 부모로 삼는다. 어느 쪽이든 HEAD를 바꾸는 순간에
       * 원자적으로 비교하므로, 스테이징과 커밋 사이에 끼어든 커밋 위에 쌓지 않는다
       */
      expectedHead?: string;
    } = {},
  ): Promise<Checkpoint | undefined> {
    const pending = await this.pendingFiles();
    if (!allowEmpty && pending.length === 0) return undefined;
    // 부모는 스테이징하기 전에 정한다. 그 뒤에 끼어든 커밋은 HEAD를 옮길 때 걸린다
    const parent = await this.#expectHead(expectedHead);
    // 마지막 방어선(ADR-131, session 5b640fd3 사고): 코드 변경(문서가 아닌 파일)이 있는데 트레일러가 검증
    // 게이트를 거쳤다는 기록을 "none"(통과한 단계 없음)으로 명시하면 체크포인트를 만들지 않는다. 트레일러
    // 자체가 없는 경우(commitLocalEdits처럼 애초에 게이트를 거치지 않기로 한 경로)는 다른 이야기라 막지 않는다
    // — 여기서 막는 것은 "게이트가 있었는데 아무 단계도 통과하지 못했다"는 모순된 기록뿐이다. 문서만 바꿔
    // 게이트 없이 남기는 체크포인트(Workflow-Verify: docs, ADR-096)는 예외로 그대로 둔다
    const codeFiles = pending.filter((file) => !isDocCheckpointPath(file));
    if (codeFiles.length > 0 && hasEmptyPassedTrailer(trailers) && !hasDocsVerifyTrailer(trailers)) {
      throw new CheckpointError(
        `검증 게이트를 거치지 않은 코드 변경이 있어 체크포인트를 남기지 않았습니다: ${codeFiles.slice(0, 20).join(', ')}`,
      );
    }
    // 검증 게이트는 에이전트 도구로 쓴 파일만 보지만, 커밋은 명령이 만든 파일까지 담는다. 올리기 전 마지막으로 막는다
    if (findSecrets) {
      const leaks = await this.#secretLeaks(pending, `${message}\n${body ?? ''}`, findSecrets);
      if (leaks.length > 0) throw new CheckpointError(`시크릿 값이 들어 있어 체크포인트를 남기지 않았습니다: ${leaks.join(', ')}`);
    }
    // add는 저장소 설정의 필터를 돈다. 돌기 전에 설정을 본다(이슈 #706)
    await this.#assertSafeLocalGit();
    await this.#git(['add', '-A', ...(await this.#scope())]);
    if (expectStaged) {
      const mismatched = await this.#stagedMismatch(expectStaged).catch(async (error: unknown) => {
        await this.#git(['reset', '-q', ...(await this.#scope())]).catch(() => {});
        throw error;
      });
      if (mismatched.length > 0) {
        await this.#git(['reset', '-q', ...(await this.#scope())]);
        throw new StagedMismatchError(mismatched);
      }
    }
    const text = body?.trim();
    const tree = (await this.#git(['write-tree'])).trim();
    const sha = await this.#commitTree(tree, parent, commitMessage(message, text, trailers), { allowEmpty }).catch(async (error: unknown) => {
      await this.#git(['reset', '-q', ...(await this.#scope())]).catch(() => {});
      throw error;
    });
    const checkpoint = await this.#checkpoint(sha);
    await this.refreshExcludedSnapshot(checkpoint.sha);
    return checkpoint;
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

  /** 스테이징된 변경이 기대한 지문과 다른 파일들. 기대에 없는데 스테이징된 것과, 기대에 있는데 스테이징되지 않은 것도 포함한다 */
  async #stagedMismatch(expected: ReadonlyMap<string, string>): Promise<string[]> {
    const scope = await this.#scope();
    // HEAD와 다른 스테이징된 경로. 이름 변경은 옛 경로(삭제)와 새 경로(추가)로 따로 본다
    const staged = await this.#fromRoot((await this.#git(['diff', '--cached', '--name-only', '--no-renames', '-z', ...scope])).split('\0').filter(Boolean));
    const index = new Map<string, string>();
    for (const entry of (await this.#git(['ls-files', '--stage', '-z', ...scope])).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, id] = entry.slice(0, tab).split(' ');
      const [file] = await this.#fromRoot([entry.slice(tab + 1)]);
      if (file === undefined) continue;
      index.set(file, mode === '120000' ? 'link:' : mode === '160000' ? 'other' : `blob:${id}`);
    }
    const mismatched = new Set<string>();
    for (const file of staged) {
      const actual = index.get(file) ?? 'missing';
      if (expected.get(file) !== actual) mismatched.add(file);
    }
    for (const file of expected.keys()) {
      if (!staged.includes(file)) mismatched.add(file);
    }
    return [...mismatched].sort();
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
    }: { findSecrets?: (text: string) => string[]; trailers?: readonly string[]; /** commit()의 expectedHead와 같다(이슈 #706) */ expectedHead?: string } = {},
  ): Promise<Checkpoint | undefined> {
    if (paths.length === 0) return undefined;
    const subdir = await this.#subdir();
    const scoped = paths.map((file) => (subdir ? `${subdir}/${file}` : file));
    const changed = (await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...scoped])).split('\0').filter(Boolean);
    if (changed.length === 0) return undefined;
    if (findSecrets) {
      const leaks = await this.#secretLeaks(paths, `${message}\n${body ?? ''}`, findSecrets);
      if (leaks.length > 0) throw new CheckpointError(`시크릿 값이 들어 있어 체크포인트를 남기지 않았습니다: ${leaks.join(', ')}`);
    }
    const parentSha = await this.#expectHead(expectedHead);
    await this.#assertSafeLocalGit();
    // 부모의 트리에 이 경로들만 얹은 트리를 따로 만든다(git commit -- 경로와 같은 결과). 진짜 인덱스의 다른 스테이징은 건드리지 않는다
    const gitDir = (await this.#git(['rev-parse', '--absolute-git-dir'])).trim();
    const index = path.join(gitDir, `b-studio-index-${process.pid}-${backupId()}`);
    let tree: string;
    try {
      const env = { GIT_INDEX_FILE: index };
      await this.#git(['read-tree', parentSha], { env });
      await this.#git(['add', '-A', '--', ...scoped], { env });
      tree = (await this.#git(['write-tree'], { env })).trim();
    } finally {
      await rm(index, { force: true });
    }
    await this.#git(['add', '-A', '--', ...scoped]);
    const sha = await this.#commitTree(tree, parentSha, commitMessage(message, body?.trim(), trailers), { allowEmpty: false });
    const checkpoint = await this.#checkpoint(sha);
    // 범위를 좁힌 커밋이라 생성 파일은 바꾸지 않았다 — 지금 디스크를 받아들이지 않고 부모의 스냅샷을 그대로 물려받는다
    await this.#carryForwardExcludedSnapshot(parentSha, checkpoint.sha);
    return checkpoint;
  }

  /** "파일 (시크릿 이름)" 목록. 값은 담지 않는다 */
  async #secretLeaks(files: readonly string[], text: string, findSecrets: (text: string) => string[]): Promise<string[]> {
    const leaks: string[] = [];
    const inText = findSecrets(text);
    if (inText.length > 0) leaks.push(`커밋 메시지 (${inText.join(', ')})`);
    const projectRoot = await this.projectRoot();
    for (const file of files) {
      const content = await readFile(path.join(projectRoot, file), 'utf8').catch(() => undefined);
      const found = content === undefined ? [] : findSecrets(content);
      if (found.length > 0) leaks.push(`${file} (${found.join(', ')})`);
    }
    return leaks;
  }

  /**
   * 마지막 체크포인트 이후의 변경을 버린다. 무엇을 버렸는지 볼 수 있게 patch를 함께 돌려주고, 되살릴 수 있게
   * 백업도 남긴다(ADR-099) — 버리기 전에 조용히 사라지는 변경이 없게 한다. 문서 경로를 먼저 지키는 일은
   * 이 메서드의 책임이 아니다(어떤 경로가 "문서"인지는 studio 쪽 정책이다) — 부르는 쪽이 discard() 전에
   * 문서만 먼저 체크포인트로 남겨야 한다.
   */
  async discard(): Promise<{ files: string[]; patch: string; backup?: DiscardBackup }> {
    const files = await this.pendingFiles();
    // git 추적 밖(생성 파일, ADR-067)이라 pendingFiles에 안 보이는 변경도, 마지막 체크포인트의 스냅샷과 비교해 함께 되돌린다(도그푸딩 마찰 127)
    const excluded = await this.#excludedDiff(await this.#headSha());
    if (files.length === 0 && excluded.length === 0) return { files, patch: '' };

    const scope = await this.#scope();
    let patch = '';
    if (files.length > 0) {
      await this.#git(['add', '-A', ...scope]);
      patch = await this.#git(['diff', '--cached', '--no-color', ...(await this.#relative()), 'HEAD']);
    }
    const backup = await this.#backupChanges(files, excluded);
    if (files.length > 0) {
      await this.#git(['reset', '-q', '--hard', 'HEAD']);
      await this.#git(['clean', '-q', '-fd', ...scope]);
    }
    const excludedReverted = await this.#applyExcludedDiff(excluded);
    return { files: [...new Set([...files, ...excludedReverted])].sort(), patch: capText(patch, MAX_PATCH_CHARS), backup };
  }

  /**
   * 최신 체크포인트부터. 복제한 저장소의 이전 기록은 포함하지 않고 세션 시작에서 끝난다.
   * 원격에서 가져온 커밋은 병합 커밋 하나로만 보이도록 첫 번째 부모만 따라간다
   */
  async list(limit = 50): Promise<Checkpoint[]> {
    const start = await this.#startSha();
    const shas = (await this.#git(['log', '--first-parent', `-n${Math.max(limit - 1, 0)}`, '--format=%H', `${start}..HEAD`])).split('\n').filter(Boolean);
    return Promise.all([...shas, start].map((sha) => this.#checkpoint(sha)));
  }

  async patch(sha: string): Promise<string> {
    const commit = await this.#resolve(sha);
    // 복제한 저장소의 시작 커밋은 원본 기록의 커밋이라 그 diff는 이 세션의 변경이 아니다
    if (commit === (await this.#startSha()) && (await this.#getMeta('base'))) {
      return `# 세션을 시작한 시점입니다. ${await this.#getMeta('base')} 브랜치의 커밋이며 이 세션에서 바꾼 내용은 없습니다.\n`;
    }
    // 병합 커밋도 체크포인트 사이의 변경으로 보이도록 첫 번째 부모와 비교한다
    const parent = await this.#firstParent(commit);
    const relative = await this.#relative();
    const patch = parent
      ? await this.#git(['diff', '--no-color', ...relative, parent, commit])
      : await this.#git(['show', '--format=', '--patch', '--no-color', ...relative, commit]);
    return capText(patch, MAX_PATCH_CHARS);
  }

  /**
   * 체크포인트(기본 HEAD)에 커밋된 파일 내용(프로젝트 폴더 기준 경로). 그 시점에 파일이 없으면 undefined.
   * 작업 복사본이 아니라 커밋된 값을 읽으므로, 에이전트가 작업 트리에서 바꾼 것과 무관한 "믿을 수 있는 기준"이다
   * (요구사항 문서의 사람 확인 기록 되돌리기, ADR-157).
   */
  async fileAt(file: string, ref = 'HEAD'): Promise<string | undefined> {
    const subdir = await this.#subdir();
    const target = subdir ? `${subdir}/${file}` : file;
    return this.#git(['show', `${ref}:${target}`]).then(
      (out) => out,
      () => undefined,
    );
  }

  /**
   * 체크포인트(ref)에 커밋된 파일의 바이트를 파일 종류까지 보고 꺼낸다. 일반 파일(100644)·실행 파일(100755)만
   * 내용을 주고, 심볼릭 링크(120000)·서브모듈(160000)·폴더 같은 그 밖의 종류는 unsupported로 알린다. 그 시점에
   * 경로가 없으면 missing이다. 작업 폴더가 아니라 커밋된 값을 읽으므로, 체크포인트 뒤에 파일이 프로젝트 밖을
   * 가리키는 링크로 바뀌어도 그 내용을 쓰지 않는다. 모노레포 하위 폴더 처리는 fileAt과 같다
   */
  async blobAt(file: string, ref: string): Promise<BlobAt> {
    const subdir = await this.#subdir();
    const target = subdir ? `${subdir}/${file}` : file;
    const entry = (await this.#git(['ls-tree', '-z', ref, '--', target])).split('\0').find(Boolean);
    if (!entry) return { kind: 'missing' };
    const tab = entry.indexOf('\t');
    const [mode = '', , oid = ''] = (tab < 0 ? entry : entry.slice(0, tab)).split(' ');
    if (mode === '100644' || mode === '100755') return { kind: 'file', content: await this.#gitBytes(['cat-file', 'blob', oid]) };
    return { kind: 'unsupported', mode };
  }

  /**
   * 이 세션 기록에 있는 체크포인트로 되돌린다. 그 뒤의 체크포인트는 기록(reflog)에 남아 되찾을 길이 있지만,
   * 아직 체크포인트로 남기지 않은 변경(pending)은 이대로면 영영 사라지므로 버리기 전에 백업한다(ADR-099).
   * 돌려주는 파일 목록으로 어떤 서비스를 재시작할지 정한다.
   */
  async restore(sha: string): Promise<{ checkpoint: Checkpoint; files: string[]; backup?: DiscardBackup }> {
    const commit = await this.#resolve(sha);
    const inSession = (await this.#isAncestor(await this.#startSha(), commit)) && (await this.#isAncestor(commit, 'HEAD'));
    if (!inSession) throw new CheckpointError('현재 세션 기록에 없는 체크포인트입니다');

    const scope = await this.#scope();
    const pending = await this.pendingFiles();
    const committed = (await this.#git(['diff', '--name-only', '-z', ...(await this.#relative()), commit, 'HEAD'])).split('\0').filter(Boolean);
    // 되돌릴 체크포인트(commit) 시점의 생성 파일 스냅샷과 지금 디스크를 비교한다(도그푸딩 마찰 127)
    const excluded = await this.#excludedDiff(commit);
    await this.#git(['add', '-A', ...scope]);
    const backup = await this.#backupChanges(pending, excluded);
    await this.#git(['reset', '-q', '--hard', commit]);
    await this.#git(['clean', '-q', '-fd', ...scope]);
    const excludedReverted = await this.#applyExcludedDiff(excluded);

    return { checkpoint: await this.#checkpoint(commit), files: [...new Set([...pending, ...committed, ...excludedReverted])].sort(), backup };
  }

  /**
   * 되살리기 백업 하나를 작업 복사본에 그대로 되돌린다. 그 사이에 같은 파일이 다시 바뀌어 패치가 깨끗하게
   * 들어가지 않으면(git apply --check 실패) 거부한다 — 일부만 들어가 상태를 더 헷갈리게 만들지 않는다.
   */
  async restoreBackup(id: string): Promise<{ files: string[] }> {
    if (!BACKUP_ID.test(id)) throw new CheckpointError('백업 id 형식이 올바르지 않습니다');
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
      // 생성 파일(제외됨)은 git 기록이 없어 충돌을 확인할 길이 없다 — 백업한 내용으로 그대로 덮어쓴다(단순화, 알려진 한계)
      const manifest = JSON.parse(excludedManifestText) as Record<string, boolean>;
      const projectRoot = await this.projectRoot();
      for (const [file, existed] of Object.entries(manifest)) {
        const target = path.join(projectRoot, file);
        if (!existed) {
          await rm(target, { force: true });
          continue;
        }
        const content = await readFile(path.join(dir, 'excluded', file));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
    return { files: meta.files };
  }

  /** 지금까지 남은 되살리기 백업. 최신순 */
  async discardedBackups(): Promise<DiscardBackup[]> {
    const root = this.#backupRoot();
    const ids = await readdir(root).catch(() => [] as string[]);
    const backups = await Promise.all(
      ids.map((id) =>
        readFile(path.join(root, id, 'meta.json'), 'utf8').then(
          (text) => JSON.parse(text) as DiscardBackup,
          () => undefined,
        ),
      ),
    );
    return backups.filter((backup): backup is DiscardBackup => backup !== undefined).sort((a, b) => b.id.localeCompare(a.id));
  }

  /**
   * git add -A로 이미 올린 인덱스 전체(base 대비)를 되살릴 수 있는 패치로 저장하고, 생성 파일(제외됨, 도그푸딩 마찰
   * 127)의 지금 내용도 같은 백업 id 아래에 함께 담는다. 버릴 변경이 전혀 없으면(둘 다 비어 있으면) 아무것도 쓰지
   * 않는다. #git 호출에 -C root가 이미 들어가 있어 패치의 경로는 저장소 루트 기준이고, 되살릴 때(restoreBackup)도
   * 같은 기준으로 적용한다 — 모노레포 하위 폴더 세션이어도 add -A가 이미 scope로 좁혔으므로 patch는 scope 안의
   * 변경만 담는다. base는 견줄 기준 커밋(기본 HEAD). restoreRememberedHead는 기억한 체크포인트를 기준으로 준다
   */
  async #backupChanges(trackedFiles: readonly string[], excluded: readonly ExcludedChange[], base = 'HEAD'): Promise<DiscardBackup | undefined> {
    // --binary로 바이너리 파일도 되살릴 수 있게 하고, 백업은 화면에 보여줄 것이 아니라 캡 없이 전체를 남긴다
    const patch = trackedFiles.length > 0 ? await this.#git(['diff', '--cached', '--no-color', '--binary', base]) : '';
    if (!patch.trim() && excluded.length === 0) return undefined;

    const id = backupId();
    const dir = this.#backupDir(id);
    await mkdir(dir, { recursive: true });
    const createdAt = new Date().toISOString();
    const files = [...new Set([...trackedFiles, ...excluded.map((change) => change.file)])].sort();
    const backup: DiscardBackup = { id, files, createdAt };
    if (patch.trim()) await writeFile(path.join(dir, 'changes.patch'), patch, 'utf8');
    if (excluded.length > 0) {
      const manifest: Record<string, boolean> = {};
      for (const change of excluded) {
        manifest[change.file] = change.before !== undefined;
        if (change.before !== undefined) {
          const to = path.join(dir, 'excluded', change.file);
          await mkdir(path.dirname(to), { recursive: true });
          await writeFile(to, change.before);
        }
      }
      await writeFile(path.join(dir, 'excluded-manifest.json'), JSON.stringify(manifest));
    }
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(backup), 'utf8');
    await this.#pruneBackups(id);
    return backup;
  }

  #backupRoot(): string {
    return path.join(this.gitDir, BACKUP_DIRNAME);
  }

  #backupDir(id: string): string {
    return path.join(this.#backupRoot(), id);
  }

  /** 개수(BACKUP_KEEP_MAX)·용량(BACKUP_KEEP_BYTES) 한도를 넘으면 오래된 백업부터 지운다. 방금 만든 백업(keepId)은 지우지 않는다 */
  async #pruneBackups(keepId: string): Promise<void> {
    const root = this.#backupRoot();
    const ids = (await readdir(root).catch(() => [] as string[])).sort(); // 타임스탬프 기반 id라 오름차순 = 오래된 것부터
    const sized = await Promise.all(
      ids.map(async (id) => ({ id, bytes: await stat(path.join(root, id, 'changes.patch')).then((info) => info.size, () => 0) })),
    );
    let total = sized.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = sized.length;
    for (const entry of sized) {
      if (entry.id === keepId) continue;
      if (count <= BACKUP_KEEP_MAX && total <= BACKUP_KEEP_BYTES) break;
      await rm(path.join(root, entry.id), { recursive: true, force: true });
      total -= entry.bytes;
      count -= 1;
    }
  }

  // ---------------------------------------------------------------------------
  // 생성 파일(제외됨) 스냅샷(ADR-141, 도그푸딩 마찰 127): 폴더 열기(ADR-067)가 만든 studio.yaml·compose.b-studio.yaml·
  // Dockerfile.b-studio는 사용자 저장소를 더럽히지 않으려고 .git/info/exclude로 이 저장소의 git 추적에서도 뺀다.
  // 그래서 git add -A·status·reset·clean이 모두 이 파일을 보지 못해, 실패한 실행이 고친 내용이 discard()·restore()로
  // 되돌아가지 않았다. excludedFiles 제공자가 돌려준 후보 중 실제로 이 저장소가 무시하는 파일만 골라, 체크포인트를
  // 남길 때마다(commit·commitPaths·init) 그 내용을 git 밖(gitDir/b-studio/excluded/<sha>)에 함께 남기고,
  // discard()·restore()가 그 스냅샷과 지금 디스크를 비교해 같이 되돌리게 한다. 커밋 오브젝트에는 전혀 들어가지
  // 않으므로 push()·exportTree()에도 새지 않는다(원래 요구사항 그대로 유지).
  // ---------------------------------------------------------------------------

  /** 지금 HEAD 커밋의 sha */
  async #headSha(): Promise<string> {
    return (await this.#git(['rev-parse', 'HEAD'])).trim();
  }

  #excludedSnapshotRoot(): string {
    return path.join(this.gitDir, EXCLUDED_DIRNAME);
  }

  #excludedSnapshotDir(sha: string): string {
    return path.join(this.#excludedSnapshotRoot(), sha);
  }

  /** excludedFiles 제공자의 후보 중 이 저장소가 실제로 무시하는(git status --ignored) 파일만 돌려준다.
   * 사용자가 직접 만든 studio.yaml처럼 평범하게 추적되는 파일은 여기서 걸러져 평소 git 흐름에 그대로 맡겨진다 */
  async #ignoredAmong(files: readonly string[]): Promise<string[]> {
    if (files.length === 0) return [];
    const subdir = await this.#subdir();
    const scoped = files.map((file) => (subdir ? `${subdir}/${file}` : file));
    const out = await this.#git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...scoped]);
    const ignored: string[] = [];
    for (const entry of out.split('\0').filter(Boolean)) {
      if (!entry.startsWith('!!')) continue;
      const file = entry.slice(3);
      ignored.push(subdir ? file.slice(subdir.length + 1) : file);
    }
    return ignored;
  }

  async #readExcludedManifest(sha: string): Promise<Record<string, boolean> | undefined> {
    const text = await readFile(path.join(this.#excludedSnapshotDir(sha), 'manifest.json'), 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as Record<string, boolean>;
    } catch {
      return undefined;
    }
  }

  /**
   * 지금 이 체크포인트(sha)가 git 추적 밖에 둔 생성 파일의 내용을 사이드카로 남긴다. "지금 디스크 상태를 그대로
   * 받아들인다"는 뜻이라 commit()·init()처럼 게이트를 통과한 변경을 그대로 남기는 체크포인트에서만 자동으로 부른다.
   * 세션 시작 직후 overlayGeneratedFiles()처럼 체크포인트 없이 생성 파일을 끼워 넣는 경우에만 studio 쪽이 그
   * 체크포인트의 sha로 따로 부른다. 문서만 좁혀 남기는 commitPaths()나 원격·기준 브랜치만 들여오는 병합처럼
   * "이 체크포인트는 생성 파일을 바꾸지 않았다"는 뜻이면 이 메서드 대신 #carryForwardExcludedSnapshot을 쓴다 —
   * 그렇지 않으면 아직 받아들이지 않은(discard 대상인) 생성 파일 변경을 부모 체크포인트의 스냅샷으로 덮어써,
   * 그 변경이 영영 되돌릴 수 없는 "이미 그런 적 있던 상태"로 둔갑한다.
   */
  async refreshExcludedSnapshot(sha = 'HEAD'): Promise<void> {
    if (!this.#excludedFiles) return;
    const commit = sha === 'HEAD' ? await this.#headSha() : await this.#resolve(sha);
    const projectRoot = await this.projectRoot();
    const candidates = await this.#excludedFiles(projectRoot);
    const ignored = await this.#ignoredAmong(candidates);
    const dir = this.#excludedSnapshotDir(commit);
    await rm(dir, { recursive: true, force: true });
    if (ignored.length === 0) return; // 생성 파일이 없는 체크포인트는 "스냅샷 없음"과 구분하지 않는다(둘 다 "아무것도 없었다"로 읽힌다)
    await mkdir(path.join(dir, 'files'), { recursive: true });
    const manifest: Record<string, boolean> = {};
    for (const file of ignored) {
      const content = await readFile(path.join(projectRoot, file)).catch(() => undefined);
      manifest[file] = content !== undefined;
      if (content !== undefined) {
        const to = path.join(dir, 'files', file);
        await mkdir(path.dirname(to), { recursive: true });
        await writeFile(to, content);
      }
    }
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    await this.#pruneExcludedSnapshots();
  }

  /**
   * parentSha의 생성 파일 스냅샷을 newSha로 그대로 옮긴다(지금 디스크 상태를 보지 않는다). commitPaths()(문서만
   * 좁혀 남기는 체크포인트)·integrateRemote()·integrateBase()(원격·기준 브랜치의 내용만 들여오는 병합 — 둘 다
   * 생성 파일을 바꾸지 않는다)가 쓴다. 부모에 스냅샷이 없으면(생성 파일이 없던 시점) 새 체크포인트도 "없음"으로 둔다.
   */
  async #carryForwardExcludedSnapshot(parentSha: string, newSha: string): Promise<void> {
    if (!this.#excludedFiles || parentSha === newSha) return;
    const from = this.#excludedSnapshotDir(parentSha);
    const to = this.#excludedSnapshotDir(newSha);
    await rm(to, { recursive: true, force: true });
    const hasParentSnapshot = await stat(from).then((info) => info.isDirectory(), () => false);
    if (!hasParentSnapshot) return;
    await cp(from, to, { recursive: true });
  }

  /**
   * 지금 디스크의 생성 파일이 마지막 체크포인트(HEAD)의 스냅샷과 다른지 본다. 되돌리지 않고 이름만 돌려준다 —
   * studio 쪽이 추적한 파일은 그대로였지만 생성 파일만 바뀐 성공한 실행 뒤에, project를 다시 읽을지 정할 때 쓴다.
   */
  async pendingExcludedFiles(): Promise<string[]> {
    if (!this.#excludedFiles) return [];
    return (await this.#excludedDiff(await this.#headSha())).map((change) => change.file);
  }

  /**
   * target 체크포인트의 생성 파일 스냅샷과 지금 디스크를 비교해, 내용이 다른 파일만 돌려준다(되돌리지 않는다).
   * 비교 대상은 지금 디스크에 있는 후보(excludedFiles 제공자, 새로 생긴 서비스의 Dockerfile 등도 잡는다)와
   * target 스냅샷에 적힌 파일의 합집합이다 — 그래야 그 사이에 지워진 파일도 "되돌아가야 할 변경"으로 잡힌다.
   */
  async #excludedDiff(target: string): Promise<ExcludedChange[]> {
    if (!this.#excludedFiles) return [];
    const projectRoot = await this.projectRoot();
    const candidates = await this.#excludedFiles(projectRoot);
    const manifest = await this.#readExcludedManifest(target);
    // 대상 체크포인트의 스냅샷이 없으면(이 기능 이전에 만든 체크포인트, 또는 개수 상한으로 정리된 오래된 스냅샷) 그 시점의
    // 생성 파일 상태를 모른다. 모르는 것을 "없었다"로 보면 지금 있는 studio.yaml·compose를 모두 지워 세션이 뜨지 않는다
    // (도그푸딩 실측: 세션 재개가 생성 파일 5개를 지워 compose build가 실패했다). 모를 때는 건드리지 않는다
    if (!manifest) return [];
    const files = [...new Set([...(await this.#ignoredAmong(candidates)), ...Object.keys(manifest)])].sort();
    const dir = this.#excludedSnapshotDir(target);
    const changes: ExcludedChange[] = [];
    for (const file of files) {
      const current = await readFile(path.join(projectRoot, file)).catch(() => undefined);
      const existedAtTarget = manifest[file] ?? false;
      const targetContent = existedAtTarget ? await readFile(path.join(dir, 'files', file)).catch(() => undefined) : undefined;
      const changed = existedAtTarget ? current === undefined || targetContent === undefined || !current.equals(targetContent) : current !== undefined;
      if (changed) changes.push({ file, before: current, after: targetContent });
    }
    return changes;
  }

  /** #excludedDiff가 계산한 변경을 실제로 적용한다(없던 파일은 지우고, 있던 파일은 그 내용으로 되돌린다). 적용한 파일 이름을 돌려준다 */
  async #applyExcludedDiff(changes: readonly ExcludedChange[]): Promise<string[]> {
    if (changes.length === 0) return [];
    const projectRoot = await this.projectRoot();
    const applied: string[] = [];
    for (const { file, after } of changes) {
      const target = path.join(projectRoot, file);
      if (after === undefined) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, after);
      }
      applied.push(file);
    }
    return applied;
  }

  /** 체크포인트마다 쌓이는 생성 파일 스냅샷을 EXCLUDED_KEEP_MAX개까지만 남기고(작아서 넉넉하게), 오래된 것부터 지운다 */
  async #pruneExcludedSnapshots(): Promise<void> {
    const root = this.#excludedSnapshotRoot();
    const ids = await readdir(root).catch(() => [] as string[]);
    if (ids.length <= EXCLUDED_KEEP_MAX) return;
    const withTime = await Promise.all(ids.map(async (id) => ({ id, time: await stat(path.join(root, id)).then((info) => info.mtimeMs, () => 0) })));
    withTime.sort((a, b) => a.time - b.time);
    for (const entry of withTime.slice(0, withTime.length - EXCLUDED_KEEP_MAX)) {
      await rm(path.join(root, entry.id), { recursive: true, force: true });
    }
  }

  /**
   * 체크포인트의 파일을 폴더로 꺼낸다. 운영 배포는 작업 폴더가 아니라 게이트를 통과한 체크포인트를 빌드한다.
   * 기록한 파일만 나오므로 생성물과 무시한 파일은 들어가지 않는다. 모노레포 하위 폴더 세션은 저장소 전체를 꺼내고 프로젝트 폴더를 돌려준다
   */
  async exportTree(sha: string, dest: string): Promise<string> {
    const commit = await this.#resolve(sha);
    // archive는 smudge 필터와 export-subst·export-ignore 속성을 따른다. 검증한 체크포인트와 다른 것이 나가지 않게 먼저 본다(이슈 #706)
    await this.#assertSafeLocalGit();
    await mkdir(dest, { recursive: true });
    const location = this.#separateGitDir ? ['--git-dir', this.#separateGitDir, '--work-tree', this.root] : [];
    await new Promise<void>((resolve, reject) => {
      const git = spawn(this.#gitBin, [...GIT_HARDENING, '-C', this.root, ...location, 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
      // root로 돌면 GNU tar는 기록된 소유자(uid 0)로 chown하려 해, 호스트 폴더를 마운트한 컨테이너에서 실패한다 (docs/troubleshooting.md 34)
      const tar = spawn('tar', ['-x', '--no-same-owner', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
      git.stdout.pipe(tar.stdin);
      let errors = '';
      let pending = 2;
      let failed = false;
      const collect = (chunk: Buffer) => (errors += chunk.toString('utf8'));
      git.stderr.on('data', collect);
      tar.stderr.on('data', collect);
      const finish = (name: string) => (code: number | null) => {
        if (code !== 0) {
          failed = true;
          errors += `\n${name}이(가) ${code}로 끝났습니다`;
        }
        if (--pending > 0) return;
        if (failed) reject(new CheckpointError(`체크포인트를 꺼내지 못했습니다: ${redactCredentials(errors.trim())}`));
        else resolve();
      };
      git.on('error', reject);
      tar.on('error', reject);
      git.on('close', finish('git archive'));
      tar.on('close', finish('tar'));
    });
    return path.join(dest, await this.#subdir());
  }

  /**
   * 세션 시작(첫 체크포인트) 이후 지금 HEAD까지의 전체 변경. PR의 base...head diff와 같다(시작 커밋이 세션 브랜치가
   * 갈라진 지점이라서다). AI 리뷰가 보는 diff가 이 함수로 만든다. 크기 제한은 부르는 쪽(pr-review.ts의 truncateDiff)이 한다
   */
  async sessionDiff(): Promise<string> {
    const start = await this.#startSha();
    return this.#git(['diff', '--no-color', ...(await this.#relative()), start, 'HEAD']);
  }

  /**
   * sha부터 지금 HEAD까지의 변경(sessionDiff와 같은 모양, 시작점만 세션 시작이 아니라 주어진 커밋이다).
   * PR 자동 리뷰(ADR-074)가 이미 열려 있던 PR에 새 커밋이 쌓였을 때, 전체 base...head가 아니라 마지막으로
   * 리뷰한 커밋 이후의 변경만 다시 보는 데 쓴다 — 같은 지적을 되풀이해 보고하지 않도록 범위를 좁힌다
   */
  async diffSince(sha: string): Promise<string> {
    return this.#git(['diff', '--no-color', ...(await this.#relative()), sha, 'HEAD']);
  }

  /**
   * 주어진 시각 이전에 만든 마지막 커밋(HEAD 기준). 리뷰 라운드가 끝 지점(headSha)을 기록하기 전에 끝난 옛 라운드의
   * 기준점을 되짚을 때 쓴다 — 그 라운드가 시작될 때 HEAD였던 커밋이 곧 그 라운드가 본 diff의 끝이다
   */
  async commitBefore(iso: string): Promise<string | undefined> {
    const out = await this.#git(['rev-list', '-1', `--before=${iso}`, 'HEAD']).catch(() => '');
    return out.trim() || undefined;
  }

  /** 원본 Git 저장소에서 시작한 세션만 원격 정보가 있다 */
  async repository(): Promise<RepositoryInfo | undefined> {
    const [base, branch] = await Promise.all([this.#getMeta('base'), this.#getMeta('branch')]);
    if (!base || !branch) return undefined;
    return {
      remoteUrl: (await this.#git(['remote', 'get-url', 'origin'])).trim(),
      base,
      branch,
      subdir: (await this.#subdir()) || undefined,
      pushedSha: await this.#getMeta('pushed'),
      remoteSha: await this.#getMeta('remote'),
      pullRequestUrl: await this.#getMeta('pullrequest'),
      pullRequestBase: await this.#getMeta('pullrequestBase'),
    };
  }

  /** 지금 작업 복사본의 HEAD와 체크아웃된 브랜치. 분리된 HEAD면 branch가 없다(이슈 #699) */
  async headState(): Promise<HeadState> {
    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const branch = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((out) => out.trim() || undefined, () => undefined);
    return { head, branch };
  }

  /** origin 주소. 원격이 없으면 undefined. 세션을 만들 때 기억할 주소를 읽는 데 쓴다(이슈 #699) */
  async remoteUrl(): Promise<string | undefined> {
    return this.#git(['remote', 'get-url', 'origin']).then((out) => out.trim() || undefined, () => undefined);
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
    const resolved = await this.#resolve(sha);
    const count = Number((await this.#git(['rev-list', '--count', `${resolved}..HEAD`])).trim());
    if (count === 0) return 0;
    await this.#git(['reset', '--soft', resolved]);
    return count;
  }

  /**
   * 터미널 실행이 작업 복사본의 Git 기록을 b-studio가 기억한 것과 다르게 만들었을 때(브랜치를 바꿈, 분리된 HEAD,
   * 기록을 되감음) 기억한 체크포인트로 되돌린다(이슈 #699). 지금 작업 복사본이 기억한 체크포인트와 다른 부분은
   * discard()와 같은 방식으로 백업한다(ADR-099). 세션 브랜치로 강제로 옮긴 뒤 그 체크포인트로 hard reset 하고,
   * 브랜치가 없어졌으면 그 체크포인트에서 다시 만든다
   */
  async restoreRememberedHead(remembered: RememberedGit): Promise<{ files: string[]; patch: string; backup?: DiscardBackup }> {
    const checkpoint = await this.#resolve(remembered.lastCheckpoint);
    const scope = await this.#scope();
    const relative = await this.#relative();
    const excluded = await this.#excludedDiff(await this.#headSha());
    // 지금 작업 복사본 전체를 인덱스에 올린 뒤 기억한 체크포인트와 견준다. 브랜치를 바꿔 커밋한 경우에도 그 내용이
    // 보관본에 담긴다 — 현재 HEAD 기준으로 보면 이미 커밋이라 변경이 없어 보이기 때문이다
    await this.#git(['add', '-A', ...scope]);
    const files = (await this.#git(['diff', '--cached', '--name-only', '-z', ...relative, checkpoint])).split('\0').filter(Boolean);
    const patch = files.length > 0 ? await this.#git(['diff', '--cached', '--no-color', ...relative, checkpoint]) : '';
    const backup = await this.#backupChanges(files, excluded, checkpoint);
    // 세션 브랜치로 강제로 옮긴 뒤 기억한 체크포인트로 되돌린다. 브랜치가 없어졌으면(에이전트가 지웠으면) 그 체크포인트에서 다시 만든다
    await this.#git(['checkout', '-f', remembered.branch]).catch(async () => {
      await this.#git(['checkout', '-f', checkpoint]);
      await this.#git(['checkout', '-B', remembered.branch]);
    });
    await this.#git(['reset', '-q', '--hard', checkpoint]);
    await this.#git(['clean', '-q', '-fd', ...scope]);
    const excludedReverted = await this.#applyExcludedDiff(excluded);
    return { files: [...new Set([...files, ...excludedReverted])].sort(), patch: capText(patch, MAX_PATCH_CHARS), backup };
  }

  /**
   * 지금 작업 복사본의 Git이 기억한 것과 같은지 본다. 다르면 던진다(올리기·가져오기·PR 전 확인, 이슈 #699).
   * 브랜치·HEAD가 다르거나, 원격 주소가 다르거나, 저장소 로컬 설정에 주소·자격 증명을 바꿀 수 있는 값이 있으면 멈춘다.
   * 무엇이 다른지와, 사람이 고친 것이면 되돌린 뒤 다시 하라는 안내를 담는다
   */
  async assertTrustedGit(remembered: RememberedGit): Promise<void> {
    const mismatches: string[] = [];
    const state = await this.headState();
    if (state.branch !== remembered.branch) {
      mismatches.push(
        state.branch === undefined
          ? `지금 HEAD가 브랜치가 아니라 커밋을 가리킵니다(기억한 세션 브랜치: ${remembered.branch})`
          : `지금 브랜치(${state.branch})가 기억한 세션 브랜치(${remembered.branch})와 다릅니다`,
      );
    }
    if (state.head !== remembered.lastCheckpoint) {
      mismatches.push(`지금 HEAD(${state.head.slice(0, 7)})가 b-studio가 마지막으로 남긴 체크포인트(${remembered.lastCheckpoint.slice(0, 7)})와 다릅니다`);
    }
    if (remembered.originUrl !== undefined) {
      const originUrl = (await this.remoteUrl()) ?? '';
      if (originUrl !== remembered.originUrl) mismatches.push(`remote.origin.url이 기억한 주소와 다릅니다(지금: ${originUrl || '없음'})`);
    }
    mismatches.push(...(await this.#dangerousLocalConfig()));
    if (mismatches.length > 0) {
      throw new CheckpointError(
        `작업 복사본의 Git 설정이 b-studio가 기억한 것과 달라 멈췄습니다:\n- ${mismatches.join('\n- ')}\n사람이 직접 고친 것이면 되돌린 뒤 다시 시도하세요.`,
      );
    }
  }

  /**
   * 저장소 설정에 원격 주소를 바꾸거나, 자격 증명을 가로채거나, b-studio의 git이 프로그램을 부르게 하는 값이 있으면 그 설명들
   * (이슈 #699·#706). git이 실제로 읽는 규칙 그대로 읽는다: include를 펼치고(`--includes`), worktree 설정(`config.worktree`)도
   * 포함한다. 범위(`--show-scope`)가 local·worktree인 것만 본다 — 전역·시스템 설정은 사용자의 것이고, command는 b-studio가 붙인 `-c`다
   */
  async #dangerousLocalConfig(): Promise<string[]> {
    // 값에 개행이 들어갈 수 있어 -z(NUL 구분)로 읽는다. 항목마다 "범위\0출처\0키\n값\0"이다.
    // 읽지 못하면 빈 목록이 아니라 던진다 — 확인하지 못한 것을 "위험한 값이 없다"로 보면 안 된다
    const fields = (await this.#git(['config', '--list', '--includes', '--show-scope', '--show-origin', '-z'])).split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0) throw new CheckpointError('저장소 설정을 읽었지만 형식을 알아보지 못해 확인하지 못했습니다');
    const found: string[] = [];
    for (let index = 0; index < fields.length; index += 3) {
      const scope = fields[index]!;
      if (scope !== 'local' && scope !== 'worktree') continue;
      const entry = fields[index + 2]!;
      const newline = entry.indexOf('\n');
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? 'true' : entry.slice(newline + 1);
      const enabled = !/^(false|no|off|0)$/i.test(value.trim());
      // 작업 폴더 밖 저장소(내 폴더 방식)는 git init이 core.worktree를 적고, b-studio는 --work-tree를 직접 넘겨 그 값을 쓰지 않는다
      if (/^core\.worktree$/i.test(key) && this.#separateGitDir) continue;
      if (DANGEROUS_LOCAL_CONFIG.some((pattern) => pattern.test(key)) || (enabled && DANGEROUS_WHEN_ENABLED.some((pattern) => pattern.test(key)))) {
        found.push(`저장소 설정에 ${key}이(가) 있습니다${scope === 'worktree' ? '(config.worktree)' : ''}`);
      }
    }
    return found;
  }

  /**
   * `.git/info/attributes`에 적힌 속성(이슈 #706). 커밋에 들어가지 않고 에이전트가 고칠 수 있는 파일인데, 필터·diff·병합
   * 드라이버를 걸거나 내보내기(git archive)에서 파일을 빼고 바꾼다(export-ignore, export-subst). b-studio는 이 파일을 쓰지 않으므로
   * 주석과 빈 줄이 아닌 줄이 있으면 모두 알린다
   */
  async #infoAttributes(): Promise<string[]> {
    const file = path.resolve(this.root, (await this.#git(['rev-parse', '--git-path', 'info/attributes'])).trim());
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw new CheckpointError(`.git/info/attributes를 읽지 못해 확인하지 못했습니다: ${error.message}`);
    });
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    return lines.length > 0 ? [`.git/info/attributes에 속성이 있습니다: ${lines.slice(0, 3).join(' / ')}`] : [];
  }

  /**
   * add·hash-object·commit·archive처럼 저장소 설정에 따라 프로그램을 부르거나 내용을 바꾸는 명령 앞에서 본다(이슈 #706).
   * 위험한 설정이나 `.git/info/attributes`가 있으면 던진다. 컨테이너 방식은 `.git`이 읽기 전용이라 여기 걸릴 것이 없다
   */
  async #assertSafeLocalGit(): Promise<void> {
    const found = [...(await this.#dangerousLocalConfig()), ...(await this.#infoAttributes())];
    if (found.length > 0) {
      throw new CheckpointError(
        `작업 복사본의 Git 설정이 b-studio가 커밋하거나 내보내는 내용을 바꿀 수 있어 멈췄습니다:\n- ${found.join('\n- ')}\n사람이 직접 고친 것이면 되돌린 뒤 다시 시도하세요.`,
      );
    }
  }

  /** expectedHead를 주면 지금 HEAD가 그것과 같은지 보고, 그 sha(주지 않았으면 지금 HEAD)를 돌려준다(이슈 #706) */
  async #expectHead(expectedHead: string | undefined): Promise<string> {
    const head = (await this.#git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (expectedHead !== undefined && head !== expectedHead) throw new HeadMovedError(expectedHead, head);
    return head;
  }

  /**
   * 트리와 부모를 정해 커밋을 만들고, HEAD가 아직 그 부모일 때만 HEAD를 옮긴다(이슈 #706). `git commit`은 그 순간의 HEAD를
   * 부모로 삼아, 스테이징과 커밋 사이에 끼어든 커밋 위에 체크포인트를 쌓았다. `update-ref`의 옛 값 비교는 ref 잠금 안에서 한다.
   * 옮기지 못하면 HeadMovedError를 던진다. 만든 커밋의 sha를 돌려준다
   */
  async #commitTree(tree: string, parent: string, message: string, { allowEmpty }: { allowEmpty: boolean }): Promise<string> {
    if (!allowEmpty && tree === (await this.#git(['rev-parse', `${parent}^{tree}`])).trim()) {
      throw new CheckpointError('git commit 실패: 커밋할 변경이 없습니다');
    }
    const sha = (await this.#git(['commit-tree', tree, '-p', parent, '-m', message])).trim();
    try {
      await this.#git(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, 'HEAD', sha, parent]);
    } catch (error) {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD']).then((out) => out.trim(), () => '');
      if (head !== parent) throw new HeadMovedError(parent, head);
      throw error;
    }
    return sha;
  }

  /**
   * 원격에 닿는 git 명령(fetch·push·ls-remote). 닿기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 먼저 본다
   * (이슈 #699). 원격 주소를 바꾸거나 자격 증명을 가로채는 설정이 있으면 여기서 멈춘다 — baseStatus처럼 이 확인
   * 없이 먼저 fetch하던 길을 막기 위해 원격 명령을 이 한 함수로 모은다
   */
  async #remoteGit(remembered: RememberedGit, args: string[], options?: { timeout?: number }): Promise<string> {
    await this.assertTrustedGit(remembered);
    return this.#git(args, options);
  }

  /**
   * PR을 어느 원격 브랜치로 열지 원격에 물어 정한다. 기준 브랜치가 원격에 없으면(원본 폴더가 올리지 않은 로컬
   * 브랜치를 체크아웃하고 있던 경우) 원격의 기본 브랜치를 대상으로 삼고, 원래의 기준 브랜치 이름을 함께 돌려준다.
   * 원격에 닿지 못하면 던진다. 부르는 쪽이 "확인하지 못함"으로 다룬다.
   * remembered를 주면 원격에 닿기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 먼저 본다(이슈 #699)
   */
  async pullRequestTarget(remembered: RememberedGit): Promise<PullRequestTarget> {
    const info = await this.repository();
    if (!info) throw new CheckpointError('원격 저장소와 연결되지 않은 세션입니다');

    const baseRef = `refs/heads/${info.base}`;
    const listed = await this.#remoteGit(remembered, ['ls-remote', '--symref', 'origin', 'HEAD', baseRef], { timeout: PUSH_TIMEOUT_MS });
    const lines = listed.split('\n').map((line) => line.trim());
    const target: PullRequestTarget = lines.some((line) => line.endsWith(`\t${baseRef}`))
      ? { base: info.base }
      : { base: /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(lines.find((line) => line.startsWith('ref: ')) ?? '')?.[1] ?? info.base, missingBase: info.base };
    await this.#setMeta('pullrequestBase', target.base);
    return target;
  }

  async recordPullRequest(url: string): Promise<void> {
    await this.#setMeta('pullrequest', url);
  }

  /** 세션 시작 이후 체크포인트 커밋. 오래된 것부터. 원격에서 가져온 커밋은 병합 커밋으로만 들어간다 */
  async sessionCommits(): Promise<SessionCommit[]> {
    const start = await this.#startSha();
    const records = (
      await this.#git([
        'log', '--first-parent', '--reverse',
        `--format=%H%x00%h%x00%s%x00%b%x00%ae%x00%(trailers:key=${WORKFLOW_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_VERIFY_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_INCOMPLETE_TRAILER},valueonly,separator=%x1f)%x1e`,
        `${start}..HEAD`,
      ])
    )
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean);
    return Promise.all(
      records.map(async (record) => {
        const [sha = '', shortSha = '', subject = '', body = '', authorEmail = '', trailers = '', verifyTrailers = '', incompleteTrailers = ''] = record.split('\0');
        // 통과 기록·문서 체크포인트 표시는 스튜디오가 만든 커밋에서만 읽는다(#checkpoint와 같은 경계)
        const ours = authorEmail.trim().toLowerCase() === this.#author.email.trim().toLowerCase();
        const passedStages = ours ? parseWorkflowTrailerValues(trailers.split('\x1f')) : undefined;
        const verify = ours ? parseVerifyTrailerValues(verifyTrailers.split('\x1f')) : undefined;
        const incomplete = ours ? parseIncompleteTrailerValues(incompleteTrailers.split('\x1f')) : undefined;
        return {
          sha,
          shortSha,
          subject,
          body: body.trim(),
          files: await this.#changedFiles(sha),
          stat: await this.#commitStat(sha),
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
    let insertions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
      const [added, removed] = line.split('\t');
      // 이진 파일은 "-\t-\t경로"로 나와 줄 수를 셀 수 없으니 건너뛴다
      if (added && removed && added !== '-' && removed !== '-') {
        insertions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
    }
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
    const info = await this.repository();
    if (!info) throw new CheckpointError('원격 저장소와 연결되지 않은 세션입니다');
    if ((await this.pendingFiles()).length > 0) throw new CheckpointError('체크포인트로 저장하지 않은 변경이 있어 올릴 수 없습니다');
    const branch = remembered.branch;
    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const commits = Number((await this.#git(['rev-list', '--count', '--first-parent', `${await this.#startSha()}..HEAD`])).trim());
    if (commits === 0) throw new CheckpointError('올릴 체크포인트가 없습니다. 요청이 검증 게이트를 통과하면 체크포인트가 생깁니다');

    const ref = `refs/heads/${branch}`;
    // 한 번도 올리거나 가져오지 않았으면 빈 값: 원격에 같은 이름의 브랜치가 없어야 한다
    const expected = info.remoteSha ?? info.pushedSha ?? '';
    try {
      await this.#remoteGit(remembered, ['push', `--force-with-lease=${ref}:${expected}`, 'origin', `HEAD:${ref}`], { timeout: PUSH_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof CheckpointError && error.message.includes('stale info')) {
        throw new CheckpointError(
          `원격의 ${branch} 브랜치가 스튜디오가 마지막으로 확인한 상태와 달라 덮어쓰지 않았습니다. 다른 사람이 올린 커밋이면 원격 변경을 가져온 뒤 다시 올리세요.`,
        );
      }
      throw error;
    }

    const forced = expected !== '' && !(await this.#isAncestor(expected, head));
    await this.#setMeta('pushed', head);
    await this.#setMeta('remote', head);
    return { sha: head, commits, forced };
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
    const info = await this.repository();
    if (!info) throw new CheckpointError('원격 저장소와 연결되지 않은 세션입니다');
    if ((await this.pendingFiles()).length > 0) throw new CheckpointError('체크포인트로 저장하지 않은 변경이 있어 원격 변경을 가져올 수 없습니다');

    const branch = remembered.branch;
    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const ref = `refs/heads/${branch}`;
    const listed = (await this.#remoteGit(remembered, ['ls-remote', '--heads', 'origin', ref], { timeout: PUSH_TIMEOUT_MS })).trim();
    if (!listed) return { status: 'up-to-date', commits: [], files: [], previous: head };

    await this.#remoteGit(remembered, ['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:${REMOTE_REF}`], { timeout: PUSH_TIMEOUT_MS });
    const remote = (await this.#git(['rev-parse', REMOTE_REF])).trim();
    if (!(await this.#isAncestor(await this.#startSha(), remote))) {
      throw new CheckpointError(`원격의 ${branch} 브랜치가 이 세션의 시작 커밋을 포함하지 않아 가져오지 않았습니다`);
    }
    if (await this.#isAncestor(remote, head)) {
      // 지금 기록이 원격을 모두 담고 있으므로 원격 상태로 기록해도 덮어쓸 커밋이 없다
      await this.#setMeta('remote', remote);
      return { status: 'up-to-date', remoteSha: remote, commits: [], files: [], previous: head };
    }

    // 원격에만 있는 커밋의 시작점: 마지막으로 확인한 원격 상태가 원격 기록에 남아 있으면 그곳, 아니면 두 기록이 갈라진 곳
    const known = info.remoteSha ?? info.pushedSha;
    const from = known && (await this.#isAncestor(known, remote)) ? known : (await this.#git(['merge-base', head, remote])).trim();
    const commits = await this.#remoteCommits(from, remote);
    const picked = !(await this.#isAncestor(from, head));
    if (picked && (await this.#git(['rev-list', '--merges', `${from}..${remote}`])).trim()) {
      throw new CheckpointError('원격에만 있는 커밋에 병합 커밋이 있어 옮겨 오지 못했습니다. PR에서 기록을 정리한 뒤 다시 가져오세요');
    }

    try {
      await this.#git(picked ? ['cherry-pick', '--no-commit', `${from}..${remote}`] : ['merge', '--no-ff', '--no-commit', remote]);
    } catch (error) {
      const conflicts = (await this.#git(['diff', '--name-only', '-z', '--diff-filter=U', ...(await this.#relative())])).split('\0').filter(Boolean).sort();
      await this.#git([picked ? 'cherry-pick' : 'merge', '--abort']).catch(() => {});
      await this.#git(['reset', '-q', '--hard', head]);
      await this.#git(['clean', '-q', '-fd', ...(await this.#scope())]);
      if (conflicts.length > 0) throw new RemoteConflictError(conflicts);
      throw error;
    }

    const body = commits.map((commit) => `- ${commit.shortSha} ${commit.subject} (${commit.author})`).join('\n');
    await this.#git([
      'commit', '-q', '--allow-empty', '--cleanup=whitespace',
      '-m', `원격 커밋 ${commits.length}개 가져오기`, ...(body ? ['-m', capText(body, MAX_BODY_CHARS)] : []),
    ]);
    // 모노레포에서는 프로젝트 밖 변경도 함께 들어오지만, 게이트가 확인할 파일은 프로젝트 폴더 안의 것뿐이다
    const files = (await this.#git(['diff', '--name-only', '-z', ...(await this.#relative()), head, 'HEAD'])).split('\0').filter(Boolean).sort();
    const checkpoint = await this.#checkpoint('HEAD');
    // 가져온 커밋은 생성 파일(제외됨)을 바꾸지 않는다 — 지금 디스크를 받아들이지 않고 병합 전 스냅샷을 그대로 물려받는다
    await this.#carryForwardExcludedSnapshot(head, checkpoint.sha);
    return { status: picked ? 'picked' : 'merged', remoteSha: remote, commits, files, checkpoint, previous: head };
  }

  /**
   * 가져온 변경이 검증을 통과했을 때 원격 상태로 기록한다. 다음에 올릴 때 이 상태를 기준으로 덮어쓰는지 확인한다.
   * 가져온 체크포인트가 지금 기록에 없으면(검증에 실패해 되돌렸으면) 기록하지 않는다. 기록하면 리뷰어 커밋을 덮어쓸 수 있다
   */
  async acceptRemote(result: RemoteSyncResult): Promise<void> {
    if (!result.remoteSha || !result.checkpoint) return;
    if (!(await this.#isAncestor(result.checkpoint.sha, 'HEAD'))) {
      throw new CheckpointError('가져온 체크포인트가 지금 기록에 없어 원격 상태로 기록하지 않았습니다');
    }
    await this.#setMeta('remote', result.remoteSha);
  }

  /**
   * 기준 브랜치(main 따라잡기, ADR-076)가 이 세션보다 얼마나 앞서 있는지 가볍게 확인한다.
   * 화면이 자주(예: 60초마다) 물어도 origin에 부담을 주지 않도록, 마지막으로 가져온 지 BASE_FETCH_THROTTLE_MS 안이면
   * 새로 가져오지 않고 이미 받아 둔 상태로 다시 센다. force면 그 시간과 상관없이 새로 가져온다.
   * remembered는 필수다. 새로 가져올 때는 원격에 닿기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 본다(이슈 #699)
   */
  async baseStatus(remembered: RememberedGit, { force = false }: { force?: boolean } = {}): Promise<BaseStatus> {
    const info = await this.repository();
    if (!info) throw new CheckpointError('원본 저장소와 연결되지 않은 세션입니다');

    const lastFetchedAt = await this.#getMeta('baseFetchedAt');
    const stale = force || !lastFetchedAt || Date.now() - Date.parse(lastFetchedAt) >= BASE_FETCH_THROTTLE_MS;
    if (stale) await this.#fetchBase(remembered, info.base);
    const fetchedAt = (await this.#getMeta('baseFetchedAt')) ?? new Date().toISOString();

    const baseSha = await this.#git(['rev-parse', '--verify', '--quiet', BASE_REF]).then(
      (out) => out.trim(),
      () => undefined,
    );
    if (!baseSha) return { base: info.base, behind: 0, lastFetchedAt: fetchedAt };

    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const behind = Number((await this.#git(['rev-list', '--count', `${head}..${baseSha}`])).trim());
    const aheadCommits = Number((await this.#git(['rev-list', '--count', `${baseSha}..${head}`])).trim());
    return { base: info.base, behind, aheadCommits, lastFetchedAt: fetchedAt };
  }

  async #fetchBase(remembered: RememberedGit, base: string): Promise<void> {
    await this.#remoteGit(remembered, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:${BASE_REF}`], { timeout: PUSH_TIMEOUT_MS });
    await this.#setMeta('baseFetchedAt', new Date().toISOString());
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
    const info = await this.repository();
    if (!info) throw new CheckpointError('원본 저장소와 연결되지 않은 세션입니다');
    if ((await this.pendingFiles()).length > 0) {
      throw new CheckpointError('체크포인트로 저장하지 않은 변경이 있어 기준 브랜치를 따라잡을 수 없습니다');
    }

    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    await this.#fetchBase(remembered, info.base);
    const baseSha = (await this.#git(['rev-parse', BASE_REF])).trim();

    if (await this.#isAncestor(baseSha, head)) return { status: 'up-to-date', commits: [], files: [], previous: head };

    const mergeBase = (await this.#git(['merge-base', head, baseSha])).trim();
    const commits = await this.#remoteCommits(mergeBase, baseSha);

    try {
      await this.#git(['merge', '--no-ff', '--no-commit', baseSha]);
    } catch (error) {
      const conflicts = (await this.#git(['diff', '--name-only', '-z', '--diff-filter=U', ...(await this.#relative())])).split('\0').filter(Boolean).sort();
      await this.#git(['merge', '--abort']).catch(() => {});
      await this.#git(['reset', '-q', '--hard', head]);
      await this.#git(['clean', '-q', '-fd', ...(await this.#scope())]);
      if (conflicts.length > 0) throw new RemoteConflictError(conflicts);
      throw error;
    }

    const body = commits.map((commit) => `- ${commit.shortSha} ${commit.subject} (${commit.author})`).join('\n');
    await this.#git([
      'commit', '-q', '--allow-empty', '--cleanup=whitespace',
      '-m', `${withObjectParticle(info.base)} 따라잡는다 (${commits.length}커밋)`, ...(body ? ['-m', capText(body, MAX_BODY_CHARS)] : []),
    ]);
    // 프로젝트 밖 변경도 함께 들어올 수 있지만(모노레포), 게이트가 확인할 파일은 프로젝트 폴더 안의 것뿐이다
    const files = (await this.#git(['diff', '--name-only', '-z', ...(await this.#relative()), head, 'HEAD'])).split('\0').filter(Boolean).sort();
    const checkpoint = await this.#checkpoint('HEAD');
    // 기준 브랜치를 따라잡아도 생성 파일(제외됨)은 바뀌지 않는다 — 지금 디스크를 받아들이지 않고 병합 전 스냅샷을 그대로 물려받는다
    await this.#carryForwardExcludedSnapshot(head, checkpoint.sha);
    return { status: 'merged', remoteSha: baseSha, commits, files, checkpoint, previous: head };
  }

  async #remoteCommits(from: string, remote: string): Promise<RemoteCommit[]> {
    return (await this.#git(['log', '--reverse', '--format=%H%x00%h%x00%s%x00%an%x1e', `${from}..${remote}`]))
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean)
      .map((record) => {
        const [sha = '', shortSha = '', subject = '', author = ''] = record.split('\0');
        return { sha, shortSha, subject, author };
      });
  }

  async #firstParent(sha: string): Promise<string | undefined> {
    return (await this.#git(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ')[1];
  }

  async #resolve(sha: string): Promise<string> {
    if (!SHA.test(sha)) throw new CheckpointError('체크포인트 ID 형식이 올바르지 않습니다');
    try {
      return (await this.#git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim();
    } catch {
      throw new CheckpointError('체크포인트를 찾을 수 없습니다');
    }
  }

  async #checkpoint(ref: string): Promise<Checkpoint> {
    // 트레일러는 git이 마지막 문단에서만 읽는다. 본문(에이전트 요약)에 같은 모양의 줄이 있어도 통과 기록이 되지 않는다
    const [sha = '', shortSha = '', subject = '', createdAt = '', authorEmail = '', trailers = '', verifyTrailers = '', incompleteTrailers = ''] = (
      await this.#git([
        'show', '-s',
        `--format=%H%x00%h%x00%s%x00%cI%x00%ae%x00%(trailers:key=${WORKFLOW_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_VERIFY_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key=${WORKFLOW_INCOMPLETE_TRAILER},valueonly,separator=%x1f)`,
        ref,
      ])
    )
      .trim()
      .split('\0');
    // 통과 기록은 스튜디오가 만든 커밋에서만 읽는다. 원격에 쓸 수 있는 사람이 커밋 메시지에 트레일러를 적어 가져온 체크포인트를 배포 조건 통과처럼 보이게 하지 못하게 한다
    const ours = authorEmail.trim().toLowerCase() === this.#author.email.trim().toLowerCase();
    const passedStages = ours ? parseWorkflowTrailerValues(trailers.split('\x1f')) : undefined;
    const verify = ours ? parseVerifyTrailerValues(verifyTrailers.split('\x1f')) : undefined;
    const incomplete = ours ? parseIncompleteTrailerValues(incompleteTrailers.split('\x1f')) : undefined;

    if (sha === (await this.#startSha())) {
      const base = await this.#getMeta('base');
      const files = await this.#fromRoot((await this.#git(['ls-tree', '-r', '--name-only', '-z', sha])).split('\0').filter(Boolean));
      return { sha, shortSha, message: base ? `세션 시작 (${base} 브랜치)` : subject, createdAt, files };
    }
    const files = await this.#changedFiles(sha);
    const outsideFiles = verify === 'docs' ? await this.#changedBeyond(sha, files) : 0;
    return {
      sha,
      shortSha,
      message: subject,
      createdAt,
      files,
      ...(passedStages ? { passedStages } : {}),
      ...(verify ? { verify } : {}),
      ...(incomplete ? { incomplete } : {}),
      ...(outsideFiles > 0 ? { outsideFiles } : {}),
    };
  }

  /**
   * 커밋이 바꾼 경로 중 files(프로젝트 폴더 기준 목록)에 드러나지 않는 것의 수. 저장소 전체를 이름 바꾸기 감지 없이 본다 —
   * 그래야 폴더 밖 변경과, 이름 바꾸기로 사라진 원래 파일(목록에는 새 이름만 남는다)이 둘 다 잡힌다
   */
  async #changedBeyond(sha: string, files: readonly string[]): Promise<number> {
    const subdir = await this.#subdir();
    const parent = await this.#firstParent(sha);
    const output = parent
      ? await this.#git(['diff', '--no-renames', '--name-only', '-z', parent, sha])
      : await this.#git(['diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]);
    const listed = new Set(files.map((file) => (subdir ? `${subdir}/${file}` : file)));
    return output.split('\0').filter((file) => file && !listed.has(file)).length;
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

  /** 저장소 루트 기준 경로를 프로젝트 기준으로 바꾸고, 프로젝트 밖 경로는 뺀다 */
  async #fromRoot(files: string[]): Promise<string[]> {
    const subdir = await this.#subdir();
    if (!subdir) return files;
    return files.filter((file) => file.startsWith(`${subdir}/`)).map((file) => file.slice(subdir.length + 1));
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

  /** 사용자 전역 설정(커밋 훅, 서명)이 체크포인트 커밋을 막거나 입력을 기다리며 멈추지 않도록 이 저장소에만 설정한다 */
  async #configure(): Promise<void> {
    const hooks = path.join(this.gitDir, 'b-studio-hooks');
    await mkdir(hooks, { recursive: true });
    await this.#git(['config', 'core.hooksPath', hooks]);
    await this.#git(['config', 'commit.gpgsign', 'false']);
    await this.#git(['config', 'user.name', this.#author.name]);
    await this.#git(['config', 'user.email', this.#author.email]);
    await this.#excludeGenerated();
  }

  async #excludeGenerated(): Promise<void> {
    const file = path.join(this.gitDir, 'info', 'exclude');
    await mkdir(path.dirname(file), { recursive: true });
    const current = await readFile(file, 'utf8').catch(() => '');
    const lines = new Set(current.split('\n'));
    const missing = GENERATED.filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return;
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${separator}# b-studio 샌드박스 생성물\n${missing.join('\n')}\n`);
  }

  async #git(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<string> {
    const location = this.#separateGitDir ? ['--git-dir', this.#separateGitDir, '--work-tree', this.root] : [];
    // diff·show의 출력은 리뷰·화면·보관본으로 간다. 저장소 설정의 외부 diff와 textconv가 내용을 바꾸지 못하게 한다(이슈 #706)
    const [command, ...rest] = args;
    const hardened = command === 'diff' || command === 'show' ? [command, '--no-ext-diff', '--no-textconv', ...rest] : args;
    return runGit(this.#gitBin, ['-C', this.root, ...location, ...hardened], options);
  }

  /**
   * stdout을 문자열이 아니라 바이트로 받아야 하는 git 명령(cat-file blob). 위치·하드닝·재시도는 #git과 같다 —
   * 내용이 utf8이 아닐 수 있어 문자열로 받으면 바이트가 바뀐다
   */
  async #gitBytes(args: string[], options?: { timeout?: number; env?: Record<string, string> }): Promise<Buffer> {
    const location = this.#separateGitDir ? ['--git-dir', this.#separateGitDir, '--work-tree', this.root] : [];
    return runGitBuffer(this.#gitBin, ['-C', this.root, ...location, ...args], options);
  }
}

/**
 * 인덱스 잠금(`.git/index.lock`)을 다른 git이 쥐고 있어 실패했을 때 다시 해 보는 간격(ms). 합쳐서 약 3초.
 * 잠금은 보통 수십 ms 안에 풀린다. 죽은 git이 남긴 잠금은 끝까지 풀리지 않으므로 그때는 원래의 오류를 그대로 낸다(잠금 파일을
 * 스스로 지우지 않는다 — 살아 있는 git의 것일 수 있다)
 */
const INDEX_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1400];

/** git이 인덱스 잠금을 얻지 못해 아무것도 하지 않고 끝났는가. 이 실패는 다시 해도 안전하다 */
export function isIndexLockFailure(stderr: string): boolean {
  return /index\.lock/.test(stderr) && /File exists|Unable to create|Another git process/i.test(stderr);
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
    const { stdout } = await execFileAsync(gitBin, [...GIT_HARDENING, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      env: { ...gitEnv(), ...env },
    });
    return stdout;
  });
}

/** runGit과 같지만 stdout을 Buffer로 받는다(cat-file blob처럼 바이트를 그대로 옮겨야 하는 명령) */
async function runGitBuffer(gitBin: string, args: string[], { timeout, env }: { timeout?: number; env?: Record<string, string> } = {}): Promise<Buffer> {
  return runGitWithRetry(args, async () => {
    const { stdout } = await execFileAsync(gitBin, [...GIT_HARDENING, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
      timeout,
      env: { ...gitEnv(), ...env },
    });
    return stdout;
  });
}

/**
 * 인덱스 잠금 충돌이나 시간 초과로 실패한 git 호출을 다시 해 보는 공통 루프(runGit·runGitBuffer). 문자열·바이트
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
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) && !PASSED_GIT_ENV.has(key)) delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

/** 체크포인트 커밋 메시지. `git commit --cleanup=whitespace -m 제목 -m 본문 -m 트레일러`가 만드는 것과 같은 글이다 */
function commitMessage(subject: string, body: string | undefined, trailers: readonly string[]): string {
  const paragraphs = [oneLine(subject), ...(body ? [capText(body, MAX_BODY_CHARS)] : []), ...(trailers.length > 0 ? [trailers.map(oneLine).join('\n')] : [])];
  return stripSpace(paragraphs.join('\n\n'));
}

/** `git stripspace`(주석은 남긴다): 줄 끝 공백을 지우고, 빈 줄 여럿을 하나로 줄이고, 앞뒤의 빈 줄을 없앤다. 끝 줄바꿈은 붙이지 않는다 */
function stripSpace(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\r\v\f]+$/, '');
    if (line === '' && (lines.length === 0 || lines.at(-1) === '')) continue;
    lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

/** 오류 메시지에 넣을 git 하위 명령. 앞에 붙인 위치·설정 옵션(-C, --git-dir, --work-tree, -c)과 그 값은 건너뛴다 */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C' || args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '-c') i++;
    else return args[i];
  }
  return undefined;
}

/** 오류 메시지가 화면과 로그로 나가므로 주소에 들어 있는 토큰을 지운다 */
export function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

async function resolveReal(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

/** 한글 조사 '을/를'을 고른다. 브랜치 이름은 대개 영문이라 마지막 글자의 발음(모음이면 '를')으로 대략 고른다 */
function withObjectParticle(word: string): string {
  const last = word.trim().slice(-1).toLowerCase();
  return /[aeiou]/.test(last) ? `${word}를` : `${word}을`;
}

/** 타임스탬프 + 단조 증가 번호. 같은 밀리초에 여러 백업이 생겨도(테스트 등) 사전순 정렬이 생성 순서와 같다 */
let backupSequence = 0;
function backupId(): string {
  backupSequence += 1;
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${backupSequence.toString(36).padStart(4, '0')}`;
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 120) || '체크포인트';
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... 길어서 ${text.length - max}자를 생략했습니다 ...]\n`;
}

/** commit()에 넘긴 trailers 중 Workflow-Passed 값이 'none'(통과한 단계가 하나도 없다는 뜻)인 줄이 있는지 */
function hasEmptyPassedTrailer(trailers: readonly string[]): boolean {
  const prefix = `${WORKFLOW_TRAILER}:`.toLowerCase();
  const line = trailers.find((entry) => entry.trim().toLowerCase().startsWith(prefix));
  if (!line) return false;
  return line.slice(line.indexOf(':') + 1).trim().toLowerCase() === 'none';
}

/** commit()에 넘긴 trailers에 문서 체크포인트 예외(Workflow-Verify: docs, ADR-096)가 있는지 */
function hasDocsVerifyTrailer(trailers: readonly string[]): boolean {
  const expected = formatVerifyTrailer('docs').toLowerCase();
  return trailers.some((entry) => entry.trim().toLowerCase() === expected);
}

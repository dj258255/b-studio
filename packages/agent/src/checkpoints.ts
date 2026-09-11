import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Checkpoint {
  sha: string;
  shortSha: string;
  message: string;
  /** ISO 8601 */
  createdAt: string;
  /** 직전 체크포인트 대비 바뀐 파일 (세션 시작 체크포인트는 전체 파일) */
  files: string[];
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
}

export interface RepositoryInfo {
  /** 올릴 곳. 자격 증명이 들어 있을 수 있어 화면에는 parseRemote로 가공해 보여 준다 */
  remoteUrl: string;
  base: string;
  branch: string;
  /** 스튜디오가 마지막으로 올린 커밋 */
  pushedSha?: string;
  /** 스튜디오가 마지막으로 확인한 원격 브랜치의 끝 커밋(올렸거나 가져왔을 때). 다음에 올릴 때 원격이 이 상태 그대로인지 확인한다 */
  remoteSha?: string;
  pullRequestUrl?: string;
}

export interface SessionCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  files: string[];
}

export interface PushResult {
  sha: string;
  /** 세션 시작 이후 커밋 수 */
  commits: number;
  /** 되돌리기 때문에 원격 브랜치를 이어 붙이지 않고 다른 기록으로 맞췄는지 */
  forced: boolean;
}

/** 원격 세션 브랜치에만 있던 커밋 (리뷰어가 올린 커밋 등) */
export interface RemoteCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
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

export interface CheckpointStoreOptions {
  gitBin?: string;
  /** 체크포인트 커밋 작성자. 사내 저장소가 작성자 이메일을 검사하면 바꿔야 한다 */
  author?: GitAuthor;
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/** 원격 커밋과 같은 곳을 고쳐 가져오지 못했다. 작업 복사본은 가져오기 전 그대로다 */
export class RemoteConflictError extends CheckpointError {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`원격 커밋과 같은 곳을 고쳐 충돌했습니다. 가져오지 않고 그대로 두었습니다: ${conflicts.join(', ')}`);
    this.name = 'RemoteConflictError';
    this.conflicts = conflicts;
  }
}

const SHA = /^[0-9a-f]{7,40}$/;
/** 가져오기 전에 원격 세션 브랜치를 받아 두는 곳. origin/*는 원본 폴더의 브랜치를 가리킬 수 있어 쓰지 않는다 */
const REMOTE_REF = 'refs/b-studio/remote';
const MAX_PATCH_CHARS = 200_000;
const MAX_BODY_CHARS = 8_000;
const CLONE_TIMEOUT_MS = 300_000;
const PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'b-studio', email: 'checkpoints@b-studio.local' };
/** 샌드박스가 프로젝트 폴더에 만드는 생성물. 사용자 프로젝트의 .gitignore를 건드리지 않고 이 저장소에서만 제외한다 */
const GENERATED = ['node_modules/', '.next/', 'build/', '.gradle/', '.venv/', '__pycache__/', '*.tsbuildinfo', 'next-env.d.ts'];

/**
 * 세션 작업 복사본의 Git 기록으로 체크포인트를 관리한다.
 * 게이트를 통과한 변경만 남기고, 통과하지 못한 변경은 되돌릴 수 있게 하는 것이 목적이다.
 * 원본이 Git 저장소면 세션 브랜치에서 작업하고, 체크포인트를 그대로 원격 브랜치로 올린다.
 */
export class CheckpointStore {
  readonly root: string;
  readonly #gitBin: string;
  readonly #author: GitAuthor;
  #start: string | undefined;

  constructor(root: string, { gitBin = 'git', author = DEFAULT_AUTHOR }: CheckpointStoreOptions = {}) {
    this.root = path.resolve(root);
    this.#gitBin = gitBin;
    this.#author = author;
  }

  /** 폴더가 커밋이 있는 Git 저장소의 루트인지 확인한다. 하위 폴더나 저장소가 아닌 폴더는 undefined */
  static async inspectSource(source: string, { gitBin = 'git' }: { gitBin?: string } = {}): Promise<SourceRepository | undefined> {
    const root = await resolveReal(source);
    const inRepo = (args: string[]) => runGit(gitBin, ['-C', root, ...args]);

    const toplevel = await inRepo(['rev-parse', '--show-toplevel']).then((out) => resolveReal(out.trim()), () => undefined);
    if (toplevel !== root) return undefined;
    const hasCommit = await inRepo(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(() => true, () => false);
    if (!hasCommit) return undefined;

    const base = await inRepo(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((out) => out.trim(), () => '');
    if (!base) throw new CheckpointError('원본 저장소가 브랜치가 아닌 커밋(detached HEAD)을 가리키고 있어 세션 브랜치를 만들 수 없습니다');
    const originUrl = await inRepo(['remote', 'get-url', 'origin']).then((out) => out.trim() || undefined, () => undefined);
    const status = await inRepo(['status', '--porcelain=v1', '--untracked-files=normal']);
    return { base, originUrl, dirtyFiles: status.split('\n').filter(Boolean).length };
  }

  /**
   * 원본 저장소의 커밋된 상태를 복제하고 세션 브랜치를 만든다.
   * 원본에 origin이 있으면 그 주소로, 없으면 원본 저장소로 올리도록 설정한다.
   */
  static async clone(
    source: string,
    root: string,
    { branch, ...options }: CheckpointStoreOptions & { branch: string },
  ): Promise<{ store: CheckpointStore; start: Checkpoint; source: SourceRepository }> {
    const gitBin = options.gitBin ?? 'git';
    const info = await CheckpointStore.inspectSource(source, { gitBin });
    if (!info) throw new CheckpointError('커밋이 있는 Git 저장소의 루트 폴더만 세션 브랜치로 시작할 수 있습니다');
    await runGit(gitBin, ['check-ref-format', '--branch', branch]).catch(() => {
      throw new CheckpointError(`브랜치 이름이 올바르지 않습니다: ${branch}`);
    });

    await mkdir(path.dirname(path.resolve(root)), { recursive: true });
    await runGit(gitBin, ['clone', '--quiet', '--branch', info.base, '--', await resolveReal(source), path.resolve(root)], {
      timeout: CLONE_TIMEOUT_MS,
    });

    const store = new CheckpointStore(root, options);
    if (info.originUrl) await store.#git(['remote', 'set-url', 'origin', info.originUrl]);
    await store.#git(['checkout', '-q', '-b', branch]);
    await store.#configure();
    const start = (await store.#git(['rev-parse', 'HEAD'])).trim();
    await store.#setMeta('start', start);
    await store.#setMeta('base', info.base);
    await store.#setMeta('branch', branch);
    return { store, start: await store.#checkpoint(start), source: info };
  }

  /** 저장소가 없으면 만들고, 지금 상태를 첫 체크포인트로 남긴다 */
  async init(message = '세션 시작'): Promise<Checkpoint> {
    const toplevel = await this.#git(['rev-parse', '--show-toplevel']).then((out) => resolveReal(out.trim()), () => undefined);
    if (toplevel !== (await resolveReal(this.root))) await this.#git(['init', '-q', '-b', 'main']);

    await this.#configure();
    await this.#git(['add', '-A']);
    await this.#git(['commit', '-q', '--allow-empty', '-m', oneLine(message)]);
    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    if (!(await this.#getMeta('start'))) await this.#setMeta('start', head);
    return this.#checkpoint(head);
  }

  /** 마지막 체크포인트 이후 바뀐 파일 (새 파일과 삭제 포함) */
  async pendingFiles(): Promise<string[]> {
    const entries = (await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
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
    return [...new Set(files)].sort();
  }

  /**
   * 바뀐 파일이 있으면 체크포인트로 남긴다. 본문에는 검증 결과처럼 PR에서 다시 쓸 기록을 넣는다.
   * allowEmpty는 파일은 그대로지만 데이터베이스만 바뀐 요청을 체크포인트로 남길 때 쓴다.
   */
  async commit(
    message: string,
    body?: string,
    { allowEmpty = false, findSecrets }: { allowEmpty?: boolean; findSecrets?: (text: string) => string[] } = {},
  ): Promise<Checkpoint | undefined> {
    const pending = await this.pendingFiles();
    if (!allowEmpty && pending.length === 0) return undefined;
    // 검증 게이트는 에이전트 도구로 쓴 파일만 보지만, 커밋은 명령이 만든 파일까지 담는다. 올리기 전 마지막으로 막는다
    if (findSecrets) {
      const leaks = await this.#secretLeaks(pending, `${message}\n${body ?? ''}`, findSecrets);
      if (leaks.length > 0) throw new CheckpointError(`시크릿 값이 들어 있어 체크포인트를 남기지 않았습니다: ${leaks.join(', ')}`);
    }
    await this.#git(['add', '-A']);
    const text = body?.trim();
    // 기본 정리 모드는 #으로 시작하는 줄(마크다운 제목)을 지우므로 공백만 정리한다
    await this.#git([
      'commit', '-q', '--cleanup=whitespace', ...(allowEmpty ? ['--allow-empty'] : []),
      '-m', oneLine(message), ...(text ? ['-m', capText(text, MAX_BODY_CHARS)] : []),
    ]);
    return this.#checkpoint('HEAD');
  }

  /** "파일 (시크릿 이름)" 목록. 값은 담지 않는다 */
  async #secretLeaks(files: readonly string[], text: string, findSecrets: (text: string) => string[]): Promise<string[]> {
    const leaks: string[] = [];
    const inText = findSecrets(text);
    if (inText.length > 0) leaks.push(`커밋 메시지 (${inText.join(', ')})`);
    for (const file of files) {
      const content = await readFile(path.join(this.root, file), 'utf8').catch(() => undefined);
      const found = content === undefined ? [] : findSecrets(content);
      if (found.length > 0) leaks.push(`${file} (${found.join(', ')})`);
    }
    return leaks;
  }

  /** 마지막 체크포인트 이후의 변경을 버린다. 무엇을 버렸는지 볼 수 있게 patch를 함께 돌려준다 */
  async discard(): Promise<{ files: string[]; patch: string }> {
    const files = await this.pendingFiles();
    if (files.length === 0) return { files, patch: '' };

    await this.#git(['add', '-A']);
    const patch = await this.#git(['diff', '--cached', '--no-color', 'HEAD']);
    await this.#git(['reset', '-q', '--hard', 'HEAD']);
    await this.#git(['clean', '-q', '-fd']);
    return { files, patch: capText(patch, MAX_PATCH_CHARS) };
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
    const patch = parent
      ? await this.#git(['diff', '--no-color', parent, commit])
      : await this.#git(['show', '--format=', '--patch', '--no-color', commit]);
    return capText(patch, MAX_PATCH_CHARS);
  }

  /**
   * 이 세션 기록에 있는 체크포인트로 되돌린다. 그 뒤의 체크포인트와 아직 남기지 않은 변경은 사라진다.
   * 돌려주는 파일 목록으로 어떤 서비스를 재시작할지 정한다.
   */
  async restore(sha: string): Promise<{ checkpoint: Checkpoint; files: string[] }> {
    const commit = await this.#resolve(sha);
    const inSession = (await this.#isAncestor(await this.#startSha(), commit)) && (await this.#isAncestor(commit, 'HEAD'));
    if (!inSession) throw new CheckpointError('현재 세션 기록에 없는 체크포인트입니다');

    const pending = await this.pendingFiles();
    const committed = (await this.#git(['diff', '--name-only', '-z', commit, 'HEAD'])).split('\0').filter(Boolean);
    await this.#git(['reset', '-q', '--hard', commit]);
    await this.#git(['clean', '-q', '-fd']);

    return { checkpoint: await this.#checkpoint(commit), files: [...new Set([...pending, ...committed])].sort() };
  }

  /** 원본 Git 저장소에서 시작한 세션만 원격 정보가 있다 */
  async repository(): Promise<RepositoryInfo | undefined> {
    const [base, branch] = await Promise.all([this.#getMeta('base'), this.#getMeta('branch')]);
    if (!base || !branch) return undefined;
    return {
      remoteUrl: (await this.#git(['remote', 'get-url', 'origin'])).trim(),
      base,
      branch,
      pushedSha: await this.#getMeta('pushed'),
      remoteSha: await this.#getMeta('remote'),
      pullRequestUrl: await this.#getMeta('pullrequest'),
    };
  }

  async recordPullRequest(url: string): Promise<void> {
    await this.#setMeta('pullrequest', url);
  }

  /** 세션 시작 이후 체크포인트 커밋. 오래된 것부터. 원격에서 가져온 커밋은 병합 커밋으로만 들어간다 */
  async sessionCommits(): Promise<SessionCommit[]> {
    const start = await this.#startSha();
    const records = (await this.#git(['log', '--first-parent', '--reverse', '--format=%H%x00%h%x00%s%x00%b%x1e', `${start}..HEAD`]))
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean);
    return Promise.all(
      records.map(async (record) => {
        const [sha = '', shortSha = '', subject = '', body = ''] = record.split('\0');
        return { sha, shortSha, subject, body: body.trim(), files: await this.#changedFiles(sha) };
      }),
    );
  }

  /**
   * 체크포인트를 세션 브랜치로 올린다.
   * 되돌리기 뒤에는 원격 브랜치를 다른 기록으로 맞춰야 하므로 강제로 올리되,
   * 원격이 스튜디오가 마지막으로 올린 상태와 다르면(다른 사람이 커밋했으면) 거부한다.
   */
  async push(): Promise<PushResult> {
    const info = await this.repository();
    if (!info) throw new CheckpointError('원격 저장소와 연결되지 않은 세션입니다');
    if ((await this.pendingFiles()).length > 0) throw new CheckpointError('체크포인트로 저장하지 않은 변경이 있어 올릴 수 없습니다');

    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const commits = Number((await this.#git(['rev-list', '--count', '--first-parent', `${await this.#startSha()}..HEAD`])).trim());
    if (commits === 0) throw new CheckpointError('올릴 체크포인트가 없습니다. 요청이 검증 게이트를 통과하면 체크포인트가 생깁니다');

    const ref = `refs/heads/${info.branch}`;
    // 한 번도 올리거나 가져오지 않았으면 빈 값: 원격에 같은 이름의 브랜치가 없어야 한다
    const expected = info.remoteSha ?? info.pushedSha ?? '';
    try {
      await this.#git(['push', `--force-with-lease=${ref}:${expected}`, 'origin', `HEAD:${ref}`], { timeout: PUSH_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof CheckpointError && error.message.includes('stale info')) {
        throw new CheckpointError(
          `원격의 ${info.branch} 브랜치가 스튜디오가 마지막으로 확인한 상태와 달라 덮어쓰지 않았습니다. 다른 사람이 올린 커밋이면 원격 변경을 가져온 뒤 다시 올리세요.`,
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
   * 가져온 결과는 검증을 통과한 뒤 acceptRemote()로 받아들여야 다음에 올릴 때 원격 상태로 인정된다
   */
  async integrateRemote(): Promise<RemoteSyncResult> {
    const info = await this.repository();
    if (!info) throw new CheckpointError('원격 저장소와 연결되지 않은 세션입니다');
    if ((await this.pendingFiles()).length > 0) throw new CheckpointError('체크포인트로 저장하지 않은 변경이 있어 원격 변경을 가져올 수 없습니다');

    const head = (await this.#git(['rev-parse', 'HEAD'])).trim();
    const ref = `refs/heads/${info.branch}`;
    const listed = (await this.#git(['ls-remote', '--heads', 'origin', ref], { timeout: PUSH_TIMEOUT_MS })).trim();
    if (!listed) return { status: 'up-to-date', commits: [], files: [], previous: head };

    await this.#git(['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:${REMOTE_REF}`], { timeout: PUSH_TIMEOUT_MS });
    const remote = (await this.#git(['rev-parse', REMOTE_REF])).trim();
    if (!(await this.#isAncestor(await this.#startSha(), remote))) {
      throw new CheckpointError(`원격의 ${info.branch} 브랜치가 이 세션의 시작 커밋을 포함하지 않아 가져오지 않았습니다`);
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
      const conflicts = (await this.#git(['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean).sort();
      await this.#git([picked ? 'cherry-pick' : 'merge', '--abort']).catch(() => {});
      await this.#git(['reset', '-q', '--hard', head]);
      await this.#git(['clean', '-q', '-fd']);
      if (conflicts.length > 0) throw new RemoteConflictError(conflicts);
      throw error;
    }

    const body = commits.map((commit) => `- ${commit.shortSha} ${commit.subject} (${commit.author})`).join('\n');
    await this.#git([
      'commit', '-q', '--allow-empty', '--cleanup=whitespace',
      '-m', `원격 커밋 ${commits.length}개 가져오기`, ...(body ? ['-m', capText(body, MAX_BODY_CHARS)] : []),
    ]);
    const files = (await this.#git(['diff', '--name-only', '-z', head, 'HEAD'])).split('\0').filter(Boolean).sort();
    return { status: picked ? 'picked' : 'merged', remoteSha: remote, commits, files, checkpoint: await this.#checkpoint('HEAD'), previous: head };
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
    const [sha = '', shortSha = '', subject = '', createdAt = ''] = (await this.#git(['show', '-s', '--format=%H%x00%h%x00%s%x00%cI', ref]))
      .trim()
      .split('\0');

    if (sha === (await this.#startSha())) {
      const base = await this.#getMeta('base');
      const files = (await this.#git(['ls-tree', '-r', '--name-only', '-z', sha])).split('\0').filter(Boolean);
      return { sha, shortSha, message: base ? `세션 시작 (${base} 브랜치)` : subject, createdAt, files };
    }
    return { sha, shortSha, message: subject, createdAt, files: await this.#changedFiles(sha) };
  }

  /** 첫 번째 부모와 비교한다. 병합 커밋은 기본 diff-tree 출력이 비어 있기 때문이다 */
  async #changedFiles(sha: string): Promise<string[]> {
    const parent = await this.#firstParent(sha);
    const output = parent
      ? await this.#git(['diff', '--name-only', '-z', parent, sha])
      : await this.#git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]);
    return output.split('\0').filter(Boolean);
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
    const hooks = path.join(this.root, '.git', 'b-studio-hooks');
    await mkdir(hooks, { recursive: true });
    await this.#git(['config', 'core.hooksPath', hooks]);
    await this.#git(['config', 'commit.gpgsign', 'false']);
    await this.#git(['config', 'user.name', this.#author.name]);
    await this.#git(['config', 'user.email', this.#author.email]);
    await this.#excludeGenerated();
  }

  async #excludeGenerated(): Promise<void> {
    const file = path.join(this.root, '.git', 'info', 'exclude');
    await mkdir(path.dirname(file), { recursive: true });
    const current = await readFile(file, 'utf8').catch(() => '');
    const lines = new Set(current.split('\n'));
    const missing = GENERATED.filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return;
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${separator}# b-studio 샌드박스 생성물\n${missing.join('\n')}\n`);
  }

  async #git(args: string[], options?: { timeout?: number }): Promise<string> {
    return runGit(this.#gitBin, ['-C', this.root, ...args], options);
  }
}

/** 셸을 거치지 않고 인자 배열로 실행한다. 원격 작업이 사람의 입력(비밀번호, 호스트 키 확인)을 기다리며 멈추지 않게 한다 */
async function runGit(gitBin: string, args: string[], { timeout }: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(gitBin, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
      },
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; killed?: boolean };
    const command = args[0] === '-C' ? args[2] : args[0];
    const stderr = redactCredentials(failure.stderr?.trim() ?? '');
    throw new CheckpointError(`git ${command} 실패${failure.killed ? ' (시간 초과)' : ''}${stderr ? `: ${stderr}` : ''}`);
  }
}

/** 오류 메시지가 화면과 로그로 나가므로 주소에 들어 있는 토큰을 지운다 */
export function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

async function resolveReal(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 120) || '체크포인트';
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... 길어서 ${text.length - max}자를 생략했습니다 ...]\n`;
}

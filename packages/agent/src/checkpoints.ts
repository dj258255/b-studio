import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Checkpoint {
  sha: string;
  shortSha: string;
  message: string;
  /** ISO 8601 */
  createdAt: string;
  /** 직전 체크포인트 대비 바뀐 파일 (첫 체크포인트는 전체 파일) */
  files: string[];
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

const SHA = /^[0-9a-f]{7,40}$/;
const MAX_PATCH_CHARS = 200_000;
/** 샌드박스가 프로젝트 폴더에 만드는 생성물. 사용자 프로젝트의 .gitignore를 건드리지 않고 이 저장소에서만 제외한다 */
const GENERATED = ['node_modules/', '.next/', 'build/', '.gradle/', '.venv/', '__pycache__/', '*.tsbuildinfo', 'next-env.d.ts'];

/**
 * 세션 작업 복사본의 Git 기록으로 체크포인트를 관리한다.
 * 게이트를 통과한 변경만 남기고, 통과하지 못한 변경은 되돌릴 수 있게 하는 것이 목적이다.
 */
export class CheckpointStore {
  readonly root: string;
  readonly #gitBin: string;

  constructor(root: string, { gitBin = 'git' }: { gitBin?: string } = {}) {
    this.root = path.resolve(root);
    this.#gitBin = gitBin;
  }

  /** 저장소가 없으면 만들고, 지금 상태를 첫 체크포인트로 남긴다 */
  async init(message = '세션 시작'): Promise<Checkpoint> {
    const toplevel = await this.#git(['rev-parse', '--show-toplevel']).then(
      (out) => path.resolve(out.trim()),
      () => undefined,
    );
    if (toplevel !== this.root) await this.#git(['init', '-q', '-b', 'main']);

    // 사용자 전역 설정(커밋 훅, 서명)이 체크포인트 커밋을 막거나 입력을 기다리며 멈추지 않도록 이 저장소에만 설정한다
    const hooks = path.join(this.root, '.git', 'b-studio-hooks');
    await mkdir(hooks, { recursive: true });
    await this.#git(['config', 'core.hooksPath', hooks]);
    await this.#git(['config', 'commit.gpgsign', 'false']);
    await this.#git(['config', 'user.name', 'b-studio']);
    await this.#git(['config', 'user.email', 'checkpoints@b-studio.local']);
    await this.#excludeGenerated();

    await this.#git(['add', '-A']);
    await this.#git(['commit', '-q', '--allow-empty', '-m', oneLine(message)]);
    return this.#checkpoint('HEAD');
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

  /** 바뀐 파일이 있으면 체크포인트로 남긴다 */
  async commit(message: string): Promise<Checkpoint | undefined> {
    if ((await this.pendingFiles()).length === 0) return undefined;
    await this.#git(['add', '-A']);
    await this.#git(['commit', '-q', '-m', oneLine(message)]);
    return this.#checkpoint('HEAD');
  }

  /** 마지막 체크포인트 이후의 변경을 버린다. 무엇을 버렸는지 볼 수 있게 patch를 함께 돌려준다 */
  async discard(): Promise<{ files: string[]; patch: string }> {
    const files = await this.pendingFiles();
    if (files.length === 0) return { files, patch: '' };

    await this.#git(['add', '-A']);
    const patch = await this.#git(['diff', '--cached', '--no-color', 'HEAD']);
    await this.#git(['reset', '-q', '--hard', 'HEAD']);
    await this.#git(['clean', '-q', '-fd']);
    return { files, patch: capPatch(patch) };
  }

  /** 최신 체크포인트부터 */
  async list(limit = 50): Promise<Checkpoint[]> {
    const shas = (await this.#git(['log', `-n${limit}`, '--format=%H'])).split('\n').filter(Boolean);
    return Promise.all(shas.map((sha) => this.#checkpoint(sha)));
  }

  async patch(sha: string): Promise<string> {
    const commit = await this.#resolve(sha);
    return capPatch(await this.#git(['show', '--format=', '--patch', '--no-color', commit]));
  }

  /**
   * 이 세션 기록에 있는 체크포인트로 되돌린다. 그 뒤의 체크포인트와 아직 남기지 않은 변경은 사라진다.
   * 돌려주는 파일 목록으로 어떤 서비스를 재시작할지 정한다.
   */
  async restore(sha: string): Promise<{ checkpoint: Checkpoint; files: string[] }> {
    const commit = await this.#resolve(sha);
    await this.#git(['merge-base', '--is-ancestor', commit, 'HEAD']).catch(() => {
      throw new CheckpointError('현재 기록에 없는 체크포인트입니다');
    });

    const pending = await this.pendingFiles();
    const committed = (await this.#git(['diff', '--name-only', '-z', commit, 'HEAD'])).split('\0').filter(Boolean);
    await this.#git(['reset', '-q', '--hard', commit]);
    await this.#git(['clean', '-q', '-fd']);

    return { checkpoint: await this.#checkpoint(commit), files: [...new Set([...pending, ...committed])].sort() };
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
    const [sha = '', shortSha = '', message = '', createdAt = ''] = (
      await this.#git(['show', '-s', '--format=%H%x00%h%x00%s%x00%cI', ref])
    )
      .trim()
      .split('\0');
    const files = (await this.#git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha])).split('\0').filter(Boolean);
    return { sha, shortSha, message, createdAt, files };
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

  /** 셸을 거치지 않고 인자 배열로 실행한다 */
  async #git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.#gitBin, ['-C', this.root, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new CheckpointError(`git ${args[0]} 실패${stderr ? `: ${stderr}` : ''}`);
    }
  }
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 120) || '체크포인트';
}

function capPatch(patch: string): string {
  if (patch.length <= MAX_PATCH_CHARS) return patch;
  return `${patch.slice(0, MAX_PATCH_CHARS)}\n[... 변경 내용이 길어 ${patch.length - MAX_PATCH_CHARS}자를 생략했습니다 ...]\n`;
}

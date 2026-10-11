import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError, type Workspace } from './workspace';

/**
 * b-studio 도구를 거치지 않고 바뀐 파일을 게이트에 알리는 자리(이슈 #670·#673).
 * 에이전트 CLI가 내장 도구로 파일을 직접 고치면 b-studio는 작업 복사본의 상태(git)로만 변경을 안다.
 * 호스트에서 도는 관문 러너와 컨테이너 안의 터미널 실행이 함께 쓴다.
 */

/** 바뀐 파일을 작업 공간(게이트가 보는 목록)에 옮긴다. 내용이 그대로인 파일은 다시 알리지 않는다 */
export class ChangeTracker {
  readonly #workspace: Workspace;
  readonly #pendingFiles: () => Promise<readonly string[]>;
  /** 파일 → 마지막으로 게이트에 알린 때의 지문 */
  readonly #tracked = new Map<string, string>();
  /** 실행 전부터 있던, 게이트가 다루지 않는 경로 → 그때의 지문. 그대로면 이번 실행의 탓이 아니다 */
  readonly #toleratedRejects = new Map<string, string>();
  #started = false;

  constructor(workspace: Workspace, pendingFiles: () => Promise<readonly string[]>) {
    this.#workspace = workspace;
    this.#pendingFiles = pendingFiles;
  }

  /**
   * 지금의 변경을 게이트에 알린다. changed는 지난번 이후 새로 바뀐 파일, rejected는 이번 실행에서 바뀌었는데 게이트가
   * 다룰 수 없는 경로(비밀 파일, 생성물, 프로젝트 밖)다. rejected를 건너뛰면 검증하지 않은 파일이 체크포인트에 들어간다.
   */
  async sync(): Promise<{ changed: string[]; rejected: string[] }> {
    const first = !this.#started;
    this.#started = true;
    const changed: string[] = [];
    const rejected: string[] = [];
    for (const file of await this.#pendingFiles()) {
      if (file.endsWith('/')) continue;
      const print = await fingerprint(path.resolve(this.#workspace.root, file));
      if (this.#tracked.get(file) === print) continue;
      try {
        // 링크는 검증 대상으로 받지 않는다. 게이트는 링크 너머의 내용을 보고 통과시키는데 체크포인트에는 링크만 들어간다.
        // 프로젝트 안에 밖을 가리키는 링크가 남아 있으면 그 뒤의 파일 도구 호출이 그것을 거쳐 나갈 수도 있다
        if (print.startsWith('link:')) throw new WorkspaceError(`${file}: 링크는 검증할 수 없습니다`);
        this.#workspace.trackExternalChanges([file]);
        this.#tracked.set(file, print);
        changed.push(file);
      } catch {
        if (first) this.#toleratedRejects.set(file, print);
        else if (this.#toleratedRejects.get(file) !== print) rejected.push(file);
      }
    }
    return { changed: changed.sort(), rejected: rejected.sort() };
  }
}

/**
 * 파일의 지문. 내용의 해시를 쓴다 — 수정 시각과 크기는 컨테이너 안 명령으로 맞춰 놓을 수 있어서, 게이트가 통과시킨 뒤에
 * 내용만 바꾼 파일을 "그대로"라고 보게 된다. 링크는 따라가지 않고 링크라는 사실과 가리키는 곳을 지문으로 삼는다.
 */
async function fingerprint(absolute: string): Promise<string> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return `link:${await readlink(absolute).catch(() => '')}`;
    if (!info.isFile()) return `other:${info.mode}`;
    return `file:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

/** 게이트가 다룰 수 없는 경로가 바뀌었을 때 에이전트에게 돌려주는 글 */
export function rejectedChangeFeedback(rejected: readonly string[]): string {
  return [
    '[b-studio 검증 게이트] 게이트가 검증할 수 없는 경로가 이번 실행에서 바뀌어 통과시키지 않았습니다.',
    ...rejected.slice(0, 20).map((file) => `- ${file}`),
    ...(rejected.length > 20 ? [`- 외 ${rejected.length - 20}개`] : []),
    '비밀 파일(.env 등)이나 생성물은 체크포인트에 넣지 않습니다. 필요 없는 파일이면 지우고, 생성물이면 .gitignore에 넣은 뒤 턴을 끝내세요.',
  ].join('\n');
}

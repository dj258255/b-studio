/**
 * 문자열 두 개(바꾸기 전·바꾼 뒤)의 통합 diff(unified diff)를 git으로 만든다. git이 저장소 어디서나 쓰는
 * 흔한 비교 방식이라 화면의 `DiffView`(apps/studio/lib/highlight.ts의 parsePatch)가 그대로 읽을 수 있다 —
 * 새 diff 그리기 코드를 만들지 않고 "생성 파일 다시 만들기"(ADR-101) 미리보기가 체크포인트 diff와 같은 모양으로 보인다.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * relativePath 자리의 내용이 oldContent에서 newContent로 바뀐 것을 git diff 형식 문자열로 돌려준다.
 * 내용이 같으면 빈 문자열. `git diff --no-index`는 작업 트리 밖의 임시 파일 두 개를 비교할 때 쓴다
 * (저장소 안이 아니어도 되고, 아직 디스크에 쓰지 않은 "쓸 내용"끼리도 비교할 수 있다).
 */
export async function unifiedDiff(relativePath: string, oldContent: string, newContent: string): Promise<string> {
  if (oldContent === newContent) return '';
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-regen-diff-'));
  try {
    const oldRelative = path.join('old', relativePath);
    const newRelative = path.join('new', relativePath);
    await mkdir(path.dirname(path.join(dir, oldRelative)), { recursive: true });
    await mkdir(path.dirname(path.join(dir, newRelative)), { recursive: true });
    await writeFile(path.join(dir, oldRelative), oldContent);
    await writeFile(path.join(dir, newRelative), newContent);
    const stdout = await gitDiffNoIndex(dir, oldRelative, newRelative);
    // 임시 폴더 경로(old/·new/)는 사람이 볼 필요가 없다 — 실제 생성 파일 경로로 되돌린다
    return stdout.split(oldRelative).join(relativePath).split(newRelative).join(relativePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** git diff --no-index는 차이가 있으면 exit code 1로 "실패"하는데, 그 stdout이 바로 diff 내용이다 */
async function gitDiffNoIndex(cwd: string, oldRelative: string, newRelative: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', oldRelative, newRelative], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string };
    if (typeof failure.stdout === 'string' && failure.stdout.length > 0) return failure.stdout;
    throw error;
  }
}

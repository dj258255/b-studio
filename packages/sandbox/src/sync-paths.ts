import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * 반영 확인 대상에 지운 파일과 함께 사라진 폴더를 더한다.
 * 파일 공유 캐시가 상위 폴더 목록에 지운 폴더를 15초 넘게 남기는데, 그 사이 서비스를 다시 띄우면
 * 빌드 도구가 목록에 있는 폴더를 읽다가 실패한다(트러블슈팅 26). 폴더는 내용 해시가 없으므로
 * 반영 확인이 MISSING을 돌려줄 때, 즉 상위 폴더 목록에서 사라질 때까지 기다리게 된다
 */
export async function withRemovedDirectories(root: string, files: readonly string[]): Promise<string[]> {
  const targets = new Set(files);
  for (const file of files) {
    if (await exists(path.join(root, file))) continue;
    for (let dir = path.posix.dirname(file); dir !== '.' && dir !== '/' && !(await exists(path.join(root, dir))); dir = path.posix.dirname(dir)) {
      targets.add(dir);
    }
  }
  return [...targets];
}

function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

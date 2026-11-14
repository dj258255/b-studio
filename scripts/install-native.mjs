// 빌드한 napi 모듈을 packages/sandbox/native/bstudio_node.node 자리에 둔다(build-native.mjs가 부른다)
import { randomBytes } from 'node:crypto';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * 빌드 결과 `source`를 `out` 자리에 둔다. 같은 폴더의 임시 파일에 복사한 뒤 `rename`으로 바꿔 넣는다(#1214).
 * - 기존 파일을 같은 inode에 덮어쓰면 macOS가 그 파일을 다시 매핑하는 프로세스를 SIGKILL로 죽인다(코드 서명을 vnode 단위로 캐시한다).
 *   새 inode로 바꿔 넣으면 새 프로세스는 새 모듈을, 이미 불러온 프로세스는 옛 inode를 계속 쓴다.
 * - `rename`은 대상이 심볼릭 링크여도 링크 자리를 바꿀 뿐 링크 너머에 쓰지 않는다.
 */
export function installNative(source, out) {
  const temporary = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

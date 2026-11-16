import path from 'node:path';
import { SANDBOX_ID } from '@b-studio/sandbox';

/**
 * 옛 세션 지우기·복구 판정(4f B2a 앞의 `sessions.ts`의 `deleteSession`·`assertWithinSessionsRoot`·`recover`의 판정 부분)을 그대로 떼어 둔 것이다.
 * 새 구현(Rust `crates/bstudio-session`의 `lifecycle`)과 견주는 차등 시험의 기준으로만 쓴다. 4g에서 옛 TS를 지울 때 함께 지운다.
 * 제품 코드는 이 파일을 쓰지 않는다. 옛 구현에는 지울 폴더를 저장 파일의 경로 글자로 정하는 구멍이 있었다(ADR-204): `legacyAssertWithinSessionsRoot`는 글자만 본다.
 */

export interface LegacyFail {
  status: number;
  message: string;
}

/** 옛 `assertWithinSessionsRoot`: 지울 폴더가 세션 저장소 루트 밖이거나 루트 그 자체면 거부한다(글자로만 본다) */
export function legacyAssertWithinSessionsRoot(root: string, dir: string): LegacyFail | undefined {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(dir);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { status: 500, message: `삭제할 폴더가 세션 저장소 밖에 있습니다: ${dir}` };
  }
  return undefined;
}

/** 옛 `deleteSession`의 판정(상태 → 내 폴더 세션의 상태 폴더 → 저장소 안인가). 디스크는 바꾸지 않는다 */
export function legacyDeleteCheck(input: { status: string; workspace?: string; root: string; workDir: string; stateDir?: string }): LegacyFail | undefined {
  if (input.status !== 'stopped' && input.status !== 'idle') {
    return { status: 409, message: '실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요' };
  }
  const workspace = input.workspace ?? 'copy';
  const dir = input.stateDir ?? input.workDir;
  if (workspace === 'local' && dir === input.workDir) {
    return { status: 500, message: '내 폴더 세션의 상태 폴더를 확인하지 못해 지우지 않았습니다' };
  }
  return legacyAssertWithinSessionsRoot(input.root, dir);
}

/** 옛 `recover`의 세션 하나 판정. `isAlive`는 주인 프로세스가 살아 있는지(`isProcessAlive`)다. 옛 구현은 이 프로세스가 아닐 때만 불렀다 */
export function legacyRecoverPlan(input: { status: string; ownerPid: number; selfPid: number; isAlive: (pid: number) => boolean; sandboxId: string }): {
  skip: boolean;
  interrupted: boolean;
  cleanupTerminal: boolean;
  sandboxIdOk: boolean;
} {
  return {
    skip: input.ownerPid !== input.selfPid && input.isAlive(input.ownerPid),
    interrupted: input.status !== 'stopped' && input.status !== 'idle',
    cleanupTerminal: input.status !== 'stopped',
    sandboxIdOk: SANDBOX_ID.test(input.sandboxId),
  };
}

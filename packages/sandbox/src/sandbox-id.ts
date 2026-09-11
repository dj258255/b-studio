import { SandboxError } from './errors';

/**
 * 제공자가 만드는 샌드박스 id: `studio-<프로젝트 이름>-<16진수 6자리>` (Kubernetes는 이름을 40자로 자른다).
 * Docker compose 프로젝트 이름과 Kubernetes 네임스페이스 이름으로 쓰므로, 저장된 값으로 무언가를 지우기 전에 형식을 확인한다
 */
export const SANDBOX_ID = /^studio-[a-z][a-z0-9-]*-[0-9a-f]{6}$/;

export function assertSandboxId(id: string): void {
  if (!SANDBOX_ID.test(id)) throw new SandboxError(`b-studio가 만든 샌드박스 id가 아닙니다: ${id}`);
}

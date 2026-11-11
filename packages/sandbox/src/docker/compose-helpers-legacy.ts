/** 옛 TS 구현을 차등 시험의 기준값으로 남긴 것(ADR-195 4f A4a). 제품 코드는 부르지 않는다 — Rust(crates/bstudio-guard)가 대신한다 */
const DOCKER_OUT_OF_SPACE_LEGACY = "Docker 디스크가 가득 찼습니다. 'studio sandbox prune --dry-run' 으로 남은 샌드박스 자원을 확인하고 정리하거나 Docker VM 디스크를 늘리세요.";

const PORT_BIND_CONFLICT = /failed to bind port .*address already in use|error starting userland proxy|address already in use|port is already allocated/i;

export function isPortBindConflict(stderr: string): boolean {
  return PORT_BIND_CONFLICT.test(stderr);
}

export function describeDockerFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('no space left on device') ? `${text}\n${DOCKER_OUT_OF_SPACE_LEGACY}` : text;
}

export function splitUpArgs(args: readonly string[]): { create: string[]; services: string[]; byId: boolean } {
  const [command = 'up', ...rest] = args;
  const services = rest.filter((arg) => !arg.startsWith('-'));
  return {
    create: [command, '--no-start', ...rest.filter((arg) => arg !== '--detach')],
    services,
    byId: services.length > 0 && rest.includes('--no-deps'),
  };
}

export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.B_STUDIO_CONTAINER_RUNTIME?.trim() || undefined;
}

export function sandboxBuildNoCache(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.B_STUDIO_SANDBOX_BUILD_NO_CACHE?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

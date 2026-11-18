/**
 * A4c-4 이전의 `LocalDockerProvider`가 docker에 넘기던 인자 배열과 던지던 오류 글(차등 시험의 기준값).
 * 지금 구현은 Rust(crates/bstudio-guard/src/compose_args.rs)다. 이 파일은 견주는 시험만 쓴다(ADR-195 4f A4c-4).
 *
 * `tail`·`edgePort`는 옛 코드와 같이 수를 받아 `String(...)`으로 만든다. 옛 클래스의 `selected`는 `Set`이었고,
 * 새 껍데기는 `[...selected]`를 넘기므로 여기서는 같은 순서의 배열을 받는다.
 */

export function composeCommandArgs(projectName: string, projectRoot: string, composePath: string, overridePath: string, args: readonly string[]): string[] {
  return ['compose', '--project-name', projectName, '--project-directory', projectRoot, '--file', composePath, '--file', overridePath, ...args];
}

export function sandboxCleanupArgs(projectName: string): string[] {
  return ['compose', '--project-name', projectName, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'];
}

export function serviceRunningArgs(name: string, running: boolean): string[] {
  return running ? ['up', '--detach', '--build', '--no-deps', name] : ['stop', name];
}

export function serviceRecreateArgs(name: string): string[] {
  return ['up', '--detach', '--build', '--no-deps', '--force-recreate', name];
}

export function edgePortArgs(edgeService: string, edgePort: number): string[] {
  return ['port', edgeService, String(edgePort)];
}

export function composePsArgs(name: string): string[] {
  return ['ps', '--all', '--format', 'json', name];
}

export function composeLogsArgs(services: readonly string[], follow: boolean, tail: number): string[] {
  return ['logs', ...(follow ? ['--follow'] : []), '--no-color', '--timestamps', '--tail', String(tail), ...services];
}

export function composeExecArgs(name: string, command: readonly string[]): string[] {
  return ['exec', '-T', name, ...command];
}

export function sandboxBuildArgs(noCache: boolean, selected: readonly string[] | undefined): string[] | undefined {
  const buildBase = noCache ? ['build', '--no-cache'] : ['build'];
  return !selected ? buildBase : selected.length === 0 ? undefined : [...buildBase, ...selected];
}

export function composeUpRemoveOrphansArgs(upArgs: readonly string[]): string[] {
  return ['up', '--detach', '--remove-orphans', ...upArgs];
}

export function composeFailureMessage(command: string, sandboxId: string): string {
  return `docker compose ${command} 실패 (${sandboxId})`;
}

export function composeServiceRequiredMessage(name: string, sandboxId: string): string {
  return `'${name}'은(는) 이 프로젝트의 compose 서비스가 아닙니다 (${sandboxId})`;
}

export function managedServiceRequiredMessage(name: string): string {
  return `'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`;
}

export function composeConfigUnreadableMessage(sandboxId: string): string {
  return `compose 설정을 읽지 못했습니다 (${sandboxId})`;
}

export function readinessStoppedMessage(failedFirst: string): string {
  return `${failedFirst} 서비스가 준비에 실패해 확인을 멈췄습니다`;
}

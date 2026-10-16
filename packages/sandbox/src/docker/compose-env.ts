/**
 * docker·compose CLI를 부를 때 넘기는 환경(이슈 #701).
 *
 * compose는 compose 파일의 `${VAR}`를 자기 프로세스 환경에서 채운다. compose 파일은 에이전트가 고칠 수 있으므로, studio의 환경을
 * 그대로 넘기면 `environment: { X: "${GITHUB_TOKEN}" }` 한 줄로 studio를 띄운 셸의 자격 증명이 샌드박스 컨테이너에 들어간다.
 * 가림은 선언된 시크릿만 알아 이 값은 로그에서도 가려지지 않는다.
 *
 * 허용 목록이다. CLI가 데몬·컨텍스트·자격 증명 도우미·빌드를 찾는 데 쓰는 이름만 넘기고, 선언된 시크릿을 그 위에 얹는다.
 * 목록에 없는 이름은 넘기지 않는다(compose는 빈 문자열로 채운다)
 */
const EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  // Windows에서 CLI와 자격 증명 도우미가 찾는 이름
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
]);
const PREFIXES = ['DOCKER_', 'COMPOSE_', 'BUILDKIT_', 'BUILDX_', 'LC_'];

export function composeEnvironment(secrets: Readonly<Record<string, string>> = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (EXACT.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix))) picked[name] = value;
  }
  // studio(Next)의 타입은 NODE_ENV를 필수로 두지만 CLI에는 넘기지 않는다
  return { ...picked, ...secrets } as NodeJS.ProcessEnv;
}

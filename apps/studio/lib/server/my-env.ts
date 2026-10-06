/**
 * "내 환경" 하위 탭(실행 탭, 읽기 전용 관찰)의 서버 쪽 로직. 사용자가 이 프로젝트 폴더에서 직접
 * `docker compose up`으로 띄운 컨테이너와, studio.yaml이 선언한 포트에서 호스트 프로세스가 듣고 있는지를 모은다.
 * b-studio가 띄운 샌드박스·운영 배포는 절대 보여주지 않는다(packages/sandbox/src/docker/host-containers.ts의
 * classifyOwnership이 라벨로 가린다). 조사 보고서(.claude/research/reports/에이전트 검증 화면과 컨테이너 자동 감지.md)의
 * "관찰은 하되 제어는 안 한다" 원칙에 따라 재시작·중지 같은 쓰기 동작은 이 파일에 두지 않는다
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  discoverUserContainers,
  execReadonlyDocker,
  matchDeclaredPorts,
  matchesProjectRoot,
  mergeHostContainerStats,
  parseHostContainers,
  parseLsofListening,
  parsePsRow,
  parseSsListening,
  probeActuator,
  type ActuatorProbe,
  type ComposeProjectGroup,
} from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { isSameOrigin } from './auth';
import { StudioError } from './errors';
import { findProject } from './projects';
import { getSnapshot, recoverSessions } from './sessions';

const execFileAsync = promisify(execFile);

/**
 * GET만 받는 "내 환경" 관찰 라우트의 같은 출처 검사. 상태를 바꾸지 않는 요청(decideRequest, auth.ts)은 미들웨어가
 * Origin을 보지 않지만, 이 기능은 도커 상태·로그·호스트 프로세스 정보를 읽어 DNS 리바인딩 등으로 다른 사이트가
 * 가져가면 안 되므로 GET도 라우트에서 직접 검사한다
 */
export function requireSameOrigin(headers: Headers): void {
  if (!isSameOrigin(headers)) throw new StudioError(403, '다른 출처에서 보낸 요청은 받지 않습니다');
}

export interface MyEnvComposeService {
  containerId: string;
  service: string;
  containerName: string;
  state: string;
  health?: 'healthy' | 'unhealthy' | 'starting';
  ports: Array<{ containerPort: number; protocol: string; hostPort?: number; url?: string }>;
  cpuPercent?: number;
  memoryBytes?: number;
}

export interface MyEnvComposeGroup {
  project: string;
  workingDir: string;
  matchReason: string;
  services: MyEnvComposeService[];
}

export interface MyEnvHostProcess {
  port: number;
  pid: number;
  command: string;
  cpuPercent?: number;
  rssBytes?: number;
  actuator?: ActuatorProbe & { logExcerpt?: string };
}

export interface MyEnvSnapshot {
  generatedAt: string;
  projectRoot: string;
  /** false면 docker CLI를 못 찾았거나 데몬에 닿지 못했다(컨테이너 묶음은 늘 빈 배열) */
  dockerAvailable: boolean;
  composeGroups: MyEnvComposeGroup[];
  hostProcesses: MyEnvHostProcess[];
}

async function resolveSessionProject(sessionId: string): Promise<LoadedProject> {
  await recoverSessions();
  const snapshot = getSnapshot(sessionId);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  const project = await findProject(snapshot.projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  return project;
}

function dockerBinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.B_STUDIO_DOCKER_BIN?.trim() || 'docker';
}

function buildComposeGroupViews(groups: readonly ComposeProjectGroup[], statsStdout: string): MyEnvComposeGroup[] {
  return groups.map((group) => ({
    project: group.project,
    workingDir: group.workingDir,
    matchReason: group.matchReason,
    services: mergeHostContainerStats(group.services, statsStdout).map((service) => ({
      containerId: service.id,
      service: service.composeService ?? service.name,
      containerName: service.name,
      state: service.state,
      health: service.health,
      ports: service.ports
        .filter((port) => port.hostPort !== undefined)
        .map((port) => ({ containerPort: port.containerPort, protocol: port.protocol, hostPort: port.hostPort, url: `http://127.0.0.1:${port.hostPort}` })),
      cpuPercent: service.cpuPercent,
      memoryBytes: service.memoryBytes,
    })),
  }));
}

async function listComposeGroups(projectRoot: string, dockerBin: string): Promise<{ groups: MyEnvComposeGroup[]; dockerAvailable: boolean }> {
  const ids = await execReadonlyDocker(dockerBin, ['ps', '-a', '--quiet']).catch(() => undefined);
  if (!ids || ids.exitCode !== 0) return { groups: [], dockerAvailable: false };

  const idList = ids.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (idList.length === 0) return { groups: [], dockerAvailable: true };

  const inspected = await execReadonlyDocker(dockerBin, ['inspect', ...idList]);
  if (inspected.exitCode !== 0) return { groups: [], dockerAvailable: true };

  const containers = parseHostContainers(inspected.stdout);
  const rawGroups = discoverUserContainers(containers, projectRoot);
  const runningNames = rawGroups.flatMap((group) => group.services.filter((service) => service.state === 'running').map((service) => service.name));
  const stats = runningNames.length > 0 ? await execReadonlyDocker(dockerBin, ['stats', '--no-stream', '--format', '{{json .}}', ...runningNames]).catch(() => undefined) : undefined;

  return { groups: buildComposeGroupViews(rawGroups, stats?.exitCode === 0 ? stats.stdout : ''), dockerAvailable: true };
}

/** lsof(macOS)/ss(Linux) + ps를 그때그때 불러온다. 둘 다 실패하면(명령이 없는 환경 등) 빈 출력으로 본다 */
async function runCommand(bin: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync(bin, args)).stdout;
  } catch (error) {
    // ps -p <없는 pid>는 0이 아닌 코드로 끝나지만 그 자체가 오류는 아니다(그사이 프로세스가 끝났을 수 있다)
    return (error as { stdout?: string }).stdout ?? '';
  }
}

async function listHostProcesses(declaredPorts: readonly number[]): Promise<MyEnvHostProcess[]> {
  if (declaredPorts.length === 0) return [];
  const listening =
    process.platform === 'linux' ? parseSsListening(await runCommand('ss', ['-ltnp'])) : parseLsofListening(await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']));
  const matched = matchDeclaredPorts(listening, declaredPorts);

  return Promise.all(
    matched.map(async (row): Promise<MyEnvHostProcess> => {
      const usage = parsePsRow(await runCommand('ps', ['-o', 'pid,pcpu,rss,command=', '-p', String(row.pid)]));
      const actuator = await probeActuator(row.port).catch((): undefined => undefined);
      return {
        port: row.port,
        pid: row.pid,
        command: usage?.command ?? row.command,
        cpuPercent: usage?.cpuPercent,
        rssBytes: usage ? usage.rssKb * 1_024 : undefined,
        actuator,
      };
    }),
  );
}

/** "내 환경" 탭이 몇 초마다 다시 부르는 한 번 읽기 스냅샷. docker·lsof/ss·Actuator 호출이 실패해도 전체를 던지지 않는다 */
export async function discoverMyEnv(sessionId: string): Promise<MyEnvSnapshot> {
  const project = await resolveSessionProject(sessionId);
  const { groups, dockerAvailable } = await listComposeGroups(project.root, dockerBinFromEnv());
  const declaredPorts = project.managed.map(([, spec]) => spec.port);
  const hostProcesses = await listHostProcesses(declaredPorts).catch(() => []);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: project.root,
    dockerAvailable,
    composeGroups: groups,
    hostProcesses,
  };
}

/**
 * 로그를 보여주기 전에, 요청한 컨테이너가 정말 이 프로젝트 폴더에서 뜬 "사용자" 컨테이너인지 한 번 더 확인한다.
 * 그렇지 않으면 임의의 컨테이너 id를 넣어 이 맥과 무관한 다른 프로젝트의 로그까지 읽을 수 있게 된다
 */
export async function resolveLogTarget(sessionId: string, containerId: string): Promise<{ dockerBin: string; containerId: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) throw new StudioError(400, '컨테이너 id가 올바르지 않습니다');
  const project = await resolveSessionProject(sessionId);
  const dockerBin = dockerBinFromEnv();
  const inspected = await execReadonlyDocker(dockerBin, ['inspect', containerId]).catch(() => undefined);
  if (!inspected || inspected.exitCode !== 0) throw new StudioError(404, '컨테이너를 찾지 못했습니다');
  const [container] = parseHostContainers(inspected.stdout);
  if (!container || container.owner !== 'user' || container.oneOff || !matchesProjectRoot(container.composeWorkingDir, project.root)) {
    throw new StudioError(403, '이 프로젝트 폴더에서 뜬 컨테이너만 로그를 볼 수 있습니다');
  }
  return { dockerBin, containerId: container.id };
}

/** Actuator logfile을 다시 읽는다(화면의 "더 보기"). 선언하지 않은 포트는 거부한다(127.0.0.1 밖으로는 절대 나가지 않는다) */
export async function fetchHostLog(sessionId: string, port: number): Promise<ActuatorProbe & { logExcerpt?: string }> {
  const project = await resolveSessionProject(sessionId);
  const declaredPorts = project.managed.map(([, spec]) => spec.port);
  if (!declaredPorts.includes(port)) throw new StudioError(403, '이 프로젝트가 studio.yaml에 선언한 포트만 확인할 수 있습니다');
  return probeActuator(port);
}

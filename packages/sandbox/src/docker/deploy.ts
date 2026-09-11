import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedProject } from '@b-studio/spec';
import { stringify } from 'yaml';
import { SandboxError } from '../errors';
import { loadComposeModel, type ComposeModel } from '../kubernetes/compose-model';
import { DEFAULT_READINESS, waitForReady } from '../readiness';
import { Redactor } from '../secrets';
import type { ContainerState } from '../types';
import {
  buildArgsFor,
  buildCaddyfile,
  DEPLOY_PROXY_IMAGE,
  deployNames,
  emptyDeployState,
  newReleaseId,
  planBaseCompose,
  planReleaseCompose,
  proxyListenPort,
  releasesToRetire,
  summarizeBuildOutput,
  trimRecords,
  type DeployRelease,
  type DeployState,
} from './deploy-plan';
import { parseHostPort } from './format';

export type DeployStage = 'prepare' | 'build' | 'base' | 'release' | 'switch' | 'cleanup';

export interface DeployLog {
  stage: DeployStage;
  service?: string;
  text: string;
}

export interface DeployerOptions {
  /** 프로젝트마다 배포 상태를 두는 폴더의 상위 폴더. 기본 ~/.cache/b-studio/deploys */
  stateRoot?: string;
  dockerBin?: string;
  /** compose 해석과 운영 컨테이너 환경에 넣을 시크릿 값. 로그에서는 가린다 */
  secrets?: Record<string, string>;
}

export interface DeployRunOptions {
  signal?: AbortSignal;
  onLog?: (log: DeployLog) => void;
  /** 배포한 사람 (스튜디오 인증을 켰을 때) */
  by?: string;
}

export interface DeployResult {
  release: DeployRelease;
  /** 전환하기 전에 운영 주소가 가리키던 릴리스 */
  previous?: string;
  /** 서비스 이름 → 운영 주소 */
  urls: Record<string, string>;
}

export interface DeployStatus {
  state: DeployState;
  urls: Record<string, string>;
  /** 운영 주소가 가리키는 릴리스의 컨테이너 상태와 프록시 상태 */
  containers: Array<{ name: string; state: ContainerState }>;
}

export class DeployError extends SandboxError {
  constructor(message: string, detail?: string) {
    super(message, detail);
    this.name = 'DeployError';
  }
}

/** 전환한 뒤 이전 릴리스로 들어온 요청이 끝날 시간을 준다 */
const DRAIN_MS = 3_000;
/** 되돌릴 수 있게 이미지를 남기는 이전 릴리스 수 */
const KEEP_PREVIOUS = 2;
const OUTPUT_LIMIT = 200_000;

export function defaultDeployRoot(): string {
  return path.resolve(process.env.B_STUDIO_DEPLOYS_DIR ?? path.join(homedir(), '.cache/b-studio/deploys'));
}

/**
 * 로컬 Docker를 운영 환경으로 쓰는 배포기.
 * - 부가 서비스(DB)는 기반 스택에 두어 릴리스를 바꿔도 데이터가 남는다
 * - managed 서비스는 운영 Dockerfile로 이미지를 만들어 릴리스마다 별도 compose 프로젝트로 띄운다
 * - 새 릴리스가 준비되면 고정 포트의 프록시(Caddy) 설정을 바꿔 무중단으로 전환하고, 이전 릴리스를 내린다
 * - 이미지를 남긴 이전 릴리스로는 빌드 없이 되돌린다. 데이터베이스 마이그레이션은 되돌리지 않는다
 */
export class DockerDeployer {
  readonly project: LoadedProject;
  readonly #stateDir: string;
  readonly #dockerBin: string;
  readonly #secrets: Record<string, string>;
  readonly #redactor: Redactor;
  readonly #names: ReturnType<typeof deployNames>;

  constructor(project: LoadedProject, { stateRoot = defaultDeployRoot(), dockerBin = 'docker', secrets = {} }: DeployerOptions = {}) {
    this.project = project;
    this.#stateDir = path.join(stateRoot, project.spec.name);
    this.#dockerBin = dockerBin;
    this.#secrets = secrets;
    this.#redactor = new Redactor(secrets);
    this.#names = deployNames(project.spec.name);
  }

  async status(): Promise<DeployStatus> {
    const state = await this.#readState();
    const containers: DeployStatus['containers'] = [];
    if (state.active) {
      const composeProject = this.#names.release(state.active);
      for (const [name] of this.project.managed) {
        const container = this.#names.container(composeProject, name);
        containers.push({ name: container, state: await this.#containerState(container) });
      }
      containers.push({ name: this.#names.proxy, state: await this.#containerState(this.#names.proxy) });
    }
    return { state, urls: state.active ? this.#urls(state.ports) : {}, containers };
  }

  /** 지금 프로젝트 폴더의 코드로 운영 이미지를 만들어 배포한다 */
  async deploy(source: DeployRelease['source'], { signal, onLog, by }: DeployRunOptions = {}): Promise<DeployResult> {
    return this.#locked(async () => {
      const log = this.#logger(onLog);
      const state = await this.#readState();
      const release: DeployRelease = {
        id: newReleaseId(),
        createdAt: new Date().toISOString(),
        source,
        ...(by ? { by } : {}),
        status: 'failed',
        images: {},
        baseServices: [],
      };
      try {
        log('prepare', `${this.project.spec.name} 릴리스 ${release.id}를 만듭니다 (${source.label})`);
        const config = await loadComposeModel(this.project, { dockerBin: this.#dockerBin, env: this.#environment() });
        release.baseServices = await this.#ensureBase(config, log, signal);
        for (const [name] of this.project.managed) {
          release.images[name] = await this.#build(config, name, release.id, log, signal);
        }
        await this.#writeCompose(`${release.id}.yaml`, planReleaseCompose(config, this.project, { releaseId: release.id, images: release.images }));
        return await this.#activate(state, release, 'deploy', log, signal);
      } catch (error) {
        await this.#recordFailure(state, release, error, log);
        throw error;
      }
    });
  }

  /** 이미지를 남겨 둔 이전 릴리스로 빌드 없이 되돌린다 */
  async rollback(releaseId: string, { signal, onLog, by }: DeployRunOptions = {}): Promise<DeployResult> {
    return this.#locked(async () => {
      const log = this.#logger(onLog);
      const state = await this.#readState();
      const release = state.releases.find((entry) => entry.id === releaseId);
      if (!release) throw new DeployError(`릴리스 ${releaseId}를 찾을 수 없습니다`);
      if (release.id === state.active) throw new DeployError(`릴리스 ${releaseId}는 이미 운영 중입니다`);
      if (release.status !== 'previous') throw new DeployError(`릴리스 ${releaseId}는 이미지를 남기지 않아 되돌릴 수 없습니다 (${release.status})`);
      for (const image of Object.values(release.images)) {
        const inspected = await this.#docker(['image', 'inspect', '--format', '{{.Id}}', image]);
        if (inspected.exitCode !== 0) throw new DeployError(`릴리스 ${releaseId}의 이미지 ${image}가 없어 되돌릴 수 없습니다`);
      }
      log('prepare', `릴리스 ${release.id}(${release.source.label})로 되돌립니다${by ? ` (${by})` : ''}`);
      // 되돌린 뒤 기반 스택이 멈춰 있을 수 있으므로 같은 기반 스택 설정으로 다시 확인한다
      const config = await loadComposeModel(this.project, { dockerBin: this.#dockerBin, env: this.#environment() });
      await this.#ensureBase(config, log, signal);
      try {
        return await this.#activate(state, release, 'rollback', log, signal);
      } catch (error) {
        state.history.unshift({ at: new Date().toISOString(), action: 'failed', release: release.id, from: state.active, error: headline(error) });
        await this.#writeState(state);
        throw error;
      }
    });
  }

  /** 운영 프록시, 모든 릴리스, 기반 스택과 운영 이미지를 지운다. volumes를 켜면 데이터베이스 볼륨도 지운다 */
  async remove({ volumes = false, onLog }: { volumes?: boolean; onLog?: (log: DeployLog) => void } = {}): Promise<void> {
    await this.#locked(async () => {
      const log = this.#logger(onLog);
      const state = await this.#readState();
      await this.#docker(['rm', '-f', this.#names.proxy]);
      // 기반 스택의 DB가 릴리스 네트워크에 붙어 있으면 네트워크를 지우지 못하므로 기반 스택부터 내린다
      await this.#docker(['compose', '--project-name', this.#names.base, 'down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])], { cwd: tmpdir() });
      const projects = new Set(
        (await this.#docker(['ps', '-a', '--filter', `label=b-studio.deploy=${this.project.spec.name}`, '--format', '{{.Label "com.docker.compose.project"}}'])).stdout
          .split('\n')
          .filter((name) => name.startsWith(`${this.#names.release('')}`)),
      );
      for (const composeProject of projects) await this.#docker(['compose', '--project-name', composeProject, 'down', '--remove-orphans'], { cwd: tmpdir() });
      for (const release of state.releases) await this.#removeImages(release, log);
      state.active = undefined;
      for (const release of state.releases) if (release.status !== 'failed') release.status = 'retired';
      await this.#writeState(state);
      log('cleanup', `운영 배포를 지웠습니다${volumes ? ' (데이터베이스 볼륨 포함)' : '. 데이터베이스 볼륨은 남겼습니다'}`);
    });
  }

  /** 새 릴리스를 띄우고 준비되면 프록시를 전환한다. 전환한 뒤 프록시를 거친 확인이 실패하면 이전 릴리스로 되돌린다 */
  async #activate(
    state: DeployState,
    release: DeployRelease,
    action: 'deploy' | 'rollback',
    log: (stage: DeployStage, text: string, service?: string) => void,
    signal?: AbortSignal,
  ): Promise<DeployResult> {
    const composeProject = this.#names.release(release.id);
    const file = path.join(this.#stateDir, 'compose', `${release.id}.yaml`);
    log('release', `릴리스 컨테이너를 만듭니다 (${composeProject})`);
    await this.#composeOrThrow(composeProject, file, ['up', '--no-start'], signal);
    const network = `${composeProject}_default`;
    // 서비스가 뜨기 전에 DB를 이 릴리스 네트워크에 붙여, 첫 연결부터 이름으로 찾게 한다
    for (const service of release.baseServices) {
      await this.#dockerOrThrow(['network', 'connect', '--alias', service, network, this.#names.container(this.#names.base, service)], signal, /already exists/);
    }
    await this.#composeOrThrow(composeProject, file, ['up', '--detach'], signal);

    await Promise.all(
      this.project.managed.map(async ([name, spec]) => {
        const { stdout } = await this.#composeOrThrow(composeProject, file, ['port', name, String(spec.port)], signal);
        const url = `http://127.0.0.1:${parseHostPort(stdout)}${spec.ready?.path ?? '/'}`;
        const container = this.#names.container(composeProject, name);
        log('release', `${name} 준비 확인: ${url}`, name);
        try {
          await waitForReady({
            url,
            expectStatus: spec.ready?.expectStatus ?? 200,
            policy: { ...DEFAULT_READINESS, timeoutMs: (spec.ready?.timeoutSeconds ?? 180) * 1_000 },
            getContainerState: () => this.#containerState(container),
            signal,
          });
        } catch (error) {
          const logs = await this.#docker(['logs', '--tail', '60', container]);
          throw new DeployError(`${name}이(가) 준비되지 않아 운영 주소를 바꾸지 않았습니다: ${headline(error)}`, this.#redactor.redact(`${logs.stdout}${logs.stderr}`));
        }
        log('release', `${name} 준비됨`, name);
      }),
    );

    const ports = await this.#assignPorts(state);
    await this.#ensureProxy(ports, log, signal);
    const previous = state.active !== release.id ? state.active : undefined;
    await this.#routeTo(release, signal);
    log('switch', `운영 주소를 릴리스 ${release.id}로 바꿨습니다`);
    try {
      for (const [name, spec] of this.project.managed) await this.#verifyThroughProxy(name, ports[name]!, spec.ready?.path ?? '/', spec.ready?.expectStatus ?? 200);
    } catch (error) {
      const back = previous ? state.releases.find((entry) => entry.id === previous) : undefined;
      if (back) {
        await this.#routeTo(back, signal).catch(() => {});
        log('switch', `프록시를 거친 확인에 실패해 운영 주소를 릴리스 ${back.id}로 되돌렸습니다`);
      }
      throw error;
    }

    const now = new Date().toISOString();
    for (const entry of state.releases) if (entry.id === previous) entry.status = 'previous';
    release.status = 'active';
    release.finishedAt = now;
    delete release.error;
    state.active = release.id;
    state.releases = trimRecords([release, ...state.releases.filter((entry) => entry.id !== release.id)], state.active);
    state.history = [{ at: now, action, release: release.id, ...(previous ? { from: previous } : {}) }, ...state.history].slice(0, 50);
    await this.#writeState(state);

    if (previous) {
      await sleep(DRAIN_MS, undefined, { signal }).catch(() => {});
      await this.#stopRelease(previous, log);
    }
    for (const entry of releasesToRetire(state.releases, KEEP_PREVIOUS)) {
      entry.status = 'retired';
      await this.#removeImages(entry, log);
    }
    await this.#writeState(state);
    return { release, ...(previous ? { previous } : {}), urls: this.#urls(ports) };
  }

  /** 기반 스택을 띄우거나 그대로 둔다. 붙일 서비스 이름을 돌려준다 */
  async #ensureBase(config: ComposeModel, log: (stage: DeployStage, text: string) => void, signal?: AbortSignal): Promise<string[]> {
    const plan = planBaseCompose(config, this.project);
    if (!plan) return [];
    const services = Object.keys(plan.services);
    const file = await this.#writeCompose('base.yaml', plan);
    log('base', `부가 서비스를 확인합니다: ${services.join(', ')}`);
    await this.#composeOrThrow(this.#names.base, file, ['up', '--detach', '--wait', '--remove-orphans'], signal);
    return services;
  }

  async #build(config: ComposeModel, name: string, releaseId: string, log: (stage: DeployStage, text: string, service?: string) => void, signal?: AbortSignal): Promise<string> {
    const source = config.services[name];
    const context = source?.build?.context;
    if (!context) throw new DeployError(`${name}: compose에 build.context가 없어 운영 이미지를 만들 수 없습니다`);
    const dockerfile = path.join(context, this.project.deploy[name]?.dockerfile ?? 'Dockerfile');
    const text = await readFile(dockerfile, 'utf8').catch(() => {
      throw new DeployError(`${name}: 운영용 ${path.relative(this.project.root, dockerfile)}이(가) 없습니다. 템플릿의 Dockerfile을 참고해 만드세요`);
    });
    const tag = this.#names.image(name, releaseId);
    const args = Object.entries(buildArgsFor(text, source.build, source.environment)).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
    log('build', `${name} 운영 이미지를 빌드합니다 (${path.relative(this.project.root, dockerfile)})`, name);
    const started = Date.now();
    const result = await this.#docker(['build', '--progress=plain', '--file', dockerfile, '--tag', tag, '--label', `b-studio.deploy=${this.project.spec.name}`, ...args, context], {
      signal,
      onLine: (line) => log('build', line, name),
    });
    if (result.exitCode !== 0) {
      signal?.throwIfAborted();
      throw new DeployError(`${name} 운영 이미지를 빌드하지 못했습니다`, this.#redactor.redact(summarizeBuildOutput(`${result.stdout}\n${result.stderr}`)));
    }
    log('build', `${name} 빌드 완료 (${((Date.now() - started) / 1_000).toFixed(1)}초)`, name);
    return tag;
  }

  /** 서비스마다 고정 포트를 정한다. studio.yaml에 적은 값이 우선이고, 없으면 처음 고른 빈 포트를 계속 쓴다 */
  async #assignPorts(state: DeployState): Promise<Record<string, number>> {
    const ports: Record<string, number> = {};
    for (const [name] of this.project.managed) {
      ports[name] = this.project.deploy[name]?.port ?? state.ports[name] ?? (await freePort());
    }
    state.ports = ports;
    return ports;
  }

  /** 공개 포트가 바뀌었으면 프록시를 다시 만든다. 포트는 컨테이너를 만들 때만 정할 수 있다 */
  async #ensureProxy(ports: Record<string, number>, log: (stage: DeployStage, text: string) => void, signal?: AbortSignal): Promise<void> {
    const expected = this.project.managed.map(([name], index) => `127.0.0.1:${ports[name]}:${proxyListenPort(index)}`).sort();
    const inspected = await this.#docker(['inspect', '--format', '{{.State.Status}} {{json .HostConfig.PortBindings}}', this.#names.proxy]);
    if (inspected.exitCode === 0) {
      const [status, ...rest] = inspected.stdout.trim().split(' ');
      const bindings = JSON.parse(rest.join(' ') || '{}') as Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
      const current = Object.entries(bindings)
        .flatMap(([containerPort, hosts]) => (hosts ?? []).map((host) => `${host.HostIp}:${host.HostPort}:${containerPort.split('/')[0]}`))
        .sort();
      if (status === 'running' && JSON.stringify(current) === JSON.stringify(expected)) return;
      log('switch', status === 'running' ? '공개 포트가 바뀌어 운영 프록시를 다시 만듭니다' : '멈춘 운영 프록시를 다시 만듭니다');
      await this.#docker(['rm', '-f', this.#names.proxy]);
    }
    await this.#dockerOrThrow(
      ['run', '--detach', '--name', this.#names.proxy, '--restart', 'unless-stopped', '--label', `b-studio.deploy=${this.project.spec.name}`, ...expected.flatMap((binding) => ['--publish', binding]), DEPLOY_PROXY_IMAGE],
      signal,
    );
    log('switch', `운영 프록시를 만들었습니다: ${this.project.managed.map(([name]) => `${name} → 127.0.0.1:${ports[name]}`).join(', ')}`);
  }

  /** 프록시를 릴리스 네트워크에 붙이고 설정을 바꾼다. caddy reload는 열린 연결을 끊지 않고 새 설정으로 바꾼다 */
  async #routeTo(release: DeployRelease, signal?: AbortSignal): Promise<void> {
    const composeProject = this.#names.release(release.id);
    await this.#dockerOrThrow(['network', 'connect', `${composeProject}_default`, this.#names.proxy], signal, /already exists/);
    const routes = this.project.managed.map(([name, spec], index) => ({ listen: proxyListenPort(index), upstream: `${this.#names.container(composeProject, name)}:${spec.port}` }));
    await this.#dockerOrThrow(['exec', '--interactive', this.#names.proxy, 'sh', '-c', 'cat > /etc/caddy/Caddyfile'], signal, undefined, undefined, buildCaddyfile(routes));
    await this.#dockerOrThrow(['exec', this.#names.proxy, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], signal);
  }

  async #verifyThroughProxy(service: string, port: number, probePath: string, expectStatus: number): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await fetch(`http://127.0.0.1:${port}${probePath}`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) }).then(
        async (response) => {
          await response.body?.cancel();
          return response.status;
        },
        (error: unknown) => describe(error),
      );
      if (status === expectStatus) return;
      last = String(status);
      await sleep(500);
    }
    throw new DeployError(`${service}: 운영 주소(127.0.0.1:${port})로 확인하지 못했습니다 (마지막 결과 ${last})`);
  }

  /** 릴리스를 내린다. 프록시와 DB를 먼저 네트워크에서 떼야 compose가 네트워크를 지울 수 있다 */
  async #stopRelease(releaseId: string, log: (stage: DeployStage, text: string) => void): Promise<void> {
    const composeProject = this.#names.release(releaseId);
    const network = `${composeProject}_default`;
    const attached = await this.#docker(['network', 'inspect', '--format', '{{range .Containers}}{{.Name}} {{end}}', network]);
    for (const container of attached.stdout.split(' ').filter((name) => name && !name.startsWith(`${composeProject}-`))) {
      await this.#docker(['network', 'disconnect', '--force', network, container]);
    }
    await this.#docker(['compose', '--project-name', composeProject, 'down', '--remove-orphans'], { cwd: tmpdir() });
    log('cleanup', `릴리스 ${releaseId}를 내렸습니다`);
  }

  async #removeImages(release: DeployRelease, log: (stage: DeployStage, text: string) => void): Promise<void> {
    for (const image of Object.values(release.images)) {
      const removed = await this.#docker(['image', 'rm', image]);
      if (removed.exitCode === 0) log('cleanup', `이미지를 지웠습니다: ${image}`);
    }
  }

  async #recordFailure(state: DeployState, release: DeployRelease, error: unknown, log: (stage: DeployStage, text: string) => void): Promise<void> {
    release.status = 'failed';
    release.error = headline(error);
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) release.errorDetail = detail.trim().slice(-4_000);
    release.finishedAt = new Date().toISOString();
    // 운영 주소는 바꾸지 않았으므로 새 릴리스만 치운다
    await this.#stopRelease(release.id, log).catch(() => {});
    await this.#removeImages(release, log);
    state.releases = trimRecords([release, ...state.releases.filter((entry) => entry.id !== release.id)], state.active);
    state.history = [{ at: release.finishedAt, action: 'failed' as const, release: release.id, ...(state.active ? { from: state.active } : {}), error: release.error }, ...state.history].slice(0, 50);
    await this.#writeState(state);
  }

  #urls(ports: Record<string, number>): Record<string, string> {
    return Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]));
  }

  async #containerState(name: string): Promise<ContainerState> {
    const inspected = await this.#docker(['inspect', '--format', '{{.State.Status}}', name]);
    const value = inspected.stdout.trim();
    return inspected.exitCode === 0 && value ? (value as ContainerState) : 'unknown';
  }

  #logger(onLog: DeployRunOptions['onLog']) {
    return (stage: DeployStage, text: string, service?: string) => onLog?.({ stage, text: this.#redactor.redact(text), ...(service ? { service } : {}) });
  }

  /** 같은 프로젝트를 두 곳에서 동시에 배포하지 않게 한다. 잠근 프로세스가 끝났으면 잠금을 넘겨받는다 */
  async #locked<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.#stateDir, { recursive: true });
    const lock = path.join(this.#stateDir, 'deploy.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(lock, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
        const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
        if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) throw new DeployError(`${this.project.spec.name}을(를) 다른 프로세스(${owner})가 배포하고 있습니다`);
        await unlink(lock).catch(() => {});
      }
    }
    try {
      return await task();
    } finally {
      await unlink(lock).catch(() => {});
    }
  }

  async #readState(): Promise<DeployState> {
    const text = await readFile(path.join(this.#stateDir, 'state.json'), 'utf8').catch(() => undefined);
    if (!text) return emptyDeployState(this.project.spec.name);
    const state = JSON.parse(text) as DeployState;
    if (state.version !== 1) throw new DeployError(`배포 상태 파일의 형식을 알 수 없습니다 (version ${String(state.version)})`);
    return state;
  }

  async #writeState(state: DeployState): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true });
    const file = path.join(this.#stateDir, 'state.json');
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temp, file);
  }

  async #writeCompose(name: string, content: unknown): Promise<string> {
    const dir = path.join(this.#stateDir, 'compose');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, stringify(content));
    return file;
  }

  #environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.#secrets };
  }

  #composeOrThrow(composeProject: string, file: string, args: string[], signal?: AbortSignal) {
    return this.#dockerOrThrow(['compose', '--project-name', composeProject, '--project-directory', this.project.root, '--file', file, ...args], signal);
  }

  async #dockerOrThrow(args: string[], signal?: AbortSignal, ignore?: RegExp, onLine?: (line: string) => void, input?: string) {
    const result = await this.#docker(args, { signal, onLine, input });
    if (result.exitCode !== 0 && !(ignore && ignore.test(result.stderr))) {
      signal?.throwIfAborted();
      throw new DeployError(`docker ${args.slice(0, 2).join(' ')} 실패`, this.#redactor.redact(result.stderr.slice(-4_000)));
    }
    return result;
  }

  /** 인자 배열로 실행하고 출력을 줄 단위로 넘긴다. 빌드 출력이 길어 끝부분만 모은다 */
  #docker(
    args: string[],
    { signal, onLine, input, cwd = this.project.root }: { signal?: AbortSignal; onLine?: (line: string) => void; input?: string; cwd?: string } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#dockerBin, args, { cwd, env: this.#environment(), signal, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = { stdout: '', stderr: '' };
      const pending = { stdout: '', stderr: '' };
      const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output[stream] = (output[stream] + text).slice(-OUTPUT_LIMIT);
        if (!onLine) return;
        const lines = (pending[stream] + text).split('\n');
        pending[stream] = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onLine(line);
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', reject);
      child.on('close', (code) => {
        if (onLine) for (const rest of [pending.stdout, pending.stderr]) if (rest.trim()) onLine(rest);
        resolve({ exitCode: code ?? 1, ...output });
      });
      child.stdin.end(input);
    });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('빈 포트를 찾지 못했습니다'))));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SandboxError는 원본 출력을 메시지 뒤에 붙이므로 기록에는 첫 줄만 남긴다 */
function headline(error: unknown): string {
  return describe(error).split('\n')[0]!;
}

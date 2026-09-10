import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { stringify } from 'yaml';
import { SandboxError } from '../errors';
import { DEFAULT_READINESS, waitForReady, type ReadinessPolicy } from '../readiness';
import type {
  ContainerState,
  ExecResult,
  LogLine,
  LogOptions,
  Sandbox,
  SandboxProvider,
  ServiceEndpoint,
  StartOptions,
} from '../types';
import { buildOverride, parseContainerState, parseHostPort, parseLogLine } from './format';

const execFileAsync = promisify(execFile);

export interface LocalDockerProviderOptions {
  /** docker 실행 파일 경로 (기본: PATH의 docker) */
  dockerBin?: string;
  /** 모든 서비스에 적용할 준비 정책. studio.yaml의 ready.timeoutSeconds가 우선한다 */
  readiness?: Partial<ReadinessPolicy>;
}

/**
 * 로컬 Docker(compose)로 샌드박스를 만든다.
 * 개발 환경과 사내 서버 한 대 운영용 구현이다. 컨테이너 격리만으로 부족하면
 * gVisor/Kata 기반 제공자로 교체한다.
 */
export class LocalDockerProvider implements SandboxProvider {
  readonly name = 'local-docker';
  readonly #options: LocalDockerProviderOptions;

  constructor(options: LocalDockerProviderOptions = {}) {
    this.#options = options;
  }

  async create(project: LoadedProject): Promise<Sandbox> {
    const id = `studio-${project.spec.name}-${randomBytes(3).toString('hex')}`;
    const workDir = await mkdtemp(path.join(tmpdir(), 'b-studio-'));
    const overridePath = path.join(workDir, 'compose.override.yaml');
    await writeFile(overridePath, stringify(buildOverride(project, id)));
    return new LocalDockerSandbox(id, project, workDir, overridePath, this.#options);
  }
}

class LocalDockerSandbox implements Sandbox {
  readonly id: string;
  readonly project: LoadedProject;
  readonly #workDir: string;
  readonly #overridePath: string;
  readonly #dockerBin: string;
  readonly #readiness: Partial<ReadinessPolicy>;

  constructor(
    id: string,
    project: LoadedProject,
    workDir: string,
    overridePath: string,
    options: LocalDockerProviderOptions,
  ) {
    this.id = id;
    this.project = project;
    this.#workDir = workDir;
    this.#overridePath = overridePath;
    this.#dockerBin = options.dockerBin ?? 'docker';
    this.#readiness = options.readiness ?? {};
  }

  async start(options: StartOptions = {}): Promise<ServiceEndpoint[]> {
    for (const [name] of this.project.managed) options.onStatus?.({ service: name, phase: 'starting' });
    await this.#ensureSharedVolumes();
    await this.#composeOrThrow(['up', '--detach', '--build', '--remove-orphans'], options.signal);
    return Promise.all(this.project.managed.map(([name]) => this.#awaitReady(name, options)));
  }

  async restart(name: string, options: StartOptions = {}): Promise<ServiceEndpoint> {
    this.#managed(name);
    options.onStatus?.({ service: name, phase: 'starting' });
    // 소스를 마운트하는 개발 이미지는 이미지가 그대로여도 컨테이너를 새로 만들어야 변경이 반영된다
    await this.#composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], options.signal);
    return this.#awaitReady(name, options);
  }

  async endpoint(name: string): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    const { stdout } = await this.#composeOrThrow(['port', name, String(service.port)]);
    return { service: name, containerPort: service.port, url: `http://127.0.0.1:${parseHostPort(stdout)}` };
  }

  async state(name: string): Promise<ContainerState> {
    const { stdout } = await this.#compose(['ps', '--all', '--format', 'json', name]);
    return parseContainerState(stdout);
  }

  async *logs({ services = [], tail = 200, signal }: LogOptions = {}): AsyncIterable<LogLine> {
    const args = this.#composeArgs(['logs', '--follow', '--no-color', '--timestamps', '--tail', String(tail), ...services]);
    const child = spawn(this.#dockerBin, args, { signal, stdio: ['ignore', 'pipe', 'ignore'] });
    // signal로 중단하면 AbortError가 발생하는데, 로그 구독 종료는 정상 흐름이다
    child.on('error', () => {});

    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        yield parseLogLine(raw);
      }
    } finally {
      child.kill();
    }
  }

  exec(name: string, command: string[]): Promise<ExecResult> {
    return this.#compose(['exec', '-T', name, ...command]);
  }

  async destroy(): Promise<void> {
    try {
      await this.#composeOrThrow(['down', '--volumes', '--remove-orphans']);
    } finally {
      await rm(this.#workDir, { recursive: true, force: true });
    }
  }

  async #awaitReady(name: string, { signal, onStatus }: StartOptions): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    const endpoint = await this.endpoint(name);

    if (service.ready) {
      try {
        await waitForReady({
          url: new URL(service.ready.path, endpoint.url).toString(),
          expectStatus: service.ready.expectStatus,
          policy: this.#policyFor(service),
          getContainerState: () => this.state(name),
          signal,
          onProbe: (probe) => onStatus?.({ service: name, phase: 'probing', probe }),
        });
      } catch (error) {
        onStatus?.({ service: name, phase: 'failed', reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    onStatus?.({ service: name, phase: 'ready', endpoint });
    return endpoint;
  }

  /** compose는 external 볼륨을 만들어 주지 않으므로 먼저 만든다. 이미 있으면 그대로 둔다 */
  async #ensureSharedVolumes(): Promise<void> {
    await Promise.all(
      this.project.sharedVolumes.map((name) =>
        execFileAsync(this.#dockerBin, ['volume', 'create', '--label', 'b-studio.cache=true', name]),
      ),
    );
  }

  #policyFor(service: ManagedServiceSpec): ReadinessPolicy {
    const timeoutSeconds = service.ready?.timeoutSeconds;
    return {
      ...DEFAULT_READINESS,
      ...this.#readiness,
      ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
    };
  }

  #managed(name: string): ManagedServiceSpec {
    const entry = this.project.managed.find(([serviceName]) => serviceName === name);
    if (!entry) throw new SandboxError(`'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`);
    return entry[1];
  }

  #composeArgs(args: string[]): string[] {
    return [
      'compose',
      '--project-name', this.id,
      '--project-directory', this.project.root,
      '--file', this.project.composePath,
      '--file', this.#overridePath,
      ...args,
    ];
  }

  async #compose(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.#dockerBin, this.#composeArgs(args), {
        signal,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      if (!isExecFailure(error)) throw error;
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr || error.message,
      };
    }
  }

  async #composeOrThrow(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.#compose(args, signal);
    if (result.exitCode !== 0) throw new SandboxError(`docker compose ${args[0]} 실패 (${this.id})`, result.stderr);
    return result;
  }
}

function isExecFailure(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && 'stdout' in error;
}

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
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
  SyncOptions,
  SyncResult,
} from '../types';
import { buildOverride, parseContainerState, parseHostPort, parseLogLine, parseSyncOutput } from './format';

const execFileAsync = promisify(execFile);

/** 파일 반영 확인에 쓰는 작은 이미지. 서비스 컨테이너가 죽어 있어도 확인할 수 있도록 별도 컨테이너로 돌린다 */
const SYNC_HELPER_IMAGE = 'busybox:1.37';

/**
 * 파일 경로는 셸 문자열에 끼워 넣지 않고 위치 인자로 넘긴다.
 * 디렉터리 목록(readdir)에 이름이 보이는지와 내용 해시를 함께 확인한다.
 * 빌드 도구는 목록과 속성으로 변경을 감지하므로 경로로 직접 여는 것만으로는 부족하다.
 */
const SYNC_SCRIPT = [
  'cd /project || exit 2',
  'for f in "$@"; do',
  '  if ls -1a "$(dirname "$f")" 2>/dev/null | grep -Fxq -- "$(basename "$f")"; then',
  '    h=$(sha256sum "$f" 2>/dev/null | cut -d " " -f 1)',
  '    echo "${h:-UNREADABLE} $f"',
  '  else',
  '    echo "MISSING $f"',
  '  fi',
  'done',
].join('\n');

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

  async sync(files: string[], { signal, timeoutMs = 60_000 }: SyncOptions = {}): Promise<SyncResult> {
    if (files.length === 0) return { elapsedMs: 0, checks: 0 };

    const expected = new Map(
      await Promise.all(files.map(async (file) => [file, await hashOrMissing(path.join(this.project.root, file))] as const)),
    );
    const started = Date.now();

    for (let checks = 1; ; checks++) {
      const result = await this.#docker(
        ['run', '--rm', '--volume', `${this.project.root}:/project:ro`, SYNC_HELPER_IMAGE, 'sh', '-c', SYNC_SCRIPT, 'sh', ...files],
        signal,
      );
      if (result.exitCode !== 0) throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr);

      const seen = parseSyncOutput(result.stdout);
      const pending = files.filter((file) => seen.get(file) !== expected.get(file));
      if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };

      if (Date.now() - started >= timeoutMs) {
        throw new SandboxError(`${Math.round(timeoutMs / 1_000)}초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: ${pending.join(', ')}`);
      }
      await sleep(250, undefined, { signal });
    }
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

  async *logs({ services = [], tail = 200, follow = true, signal }: LogOptions = {}): AsyncIterable<LogLine> {
    const args = this.#composeArgs([
      'logs',
      ...(follow ? ['--follow'] : []),
      '--no-color',
      '--timestamps',
      '--tail',
      String(tail),
      ...services,
    ]);
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

  exec(name: string, command: string[], { signal }: { signal?: AbortSignal } = {}): Promise<ExecResult> {
    return this.#compose(['exec', '-T', name, ...command], signal);
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

  #compose(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    return this.#docker(this.#composeArgs(args), signal);
  }

  async #docker(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.#dockerBin, args, {
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

async function hashOrMissing(file: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING';
    throw error;
  }
}

function isExecFailure(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && 'stdout' in error;
}

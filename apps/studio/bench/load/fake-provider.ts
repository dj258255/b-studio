/**
 * 부하 스모크 전용 가짜 샌드박스 제공자. Docker를 띄우지 않는다.
 *
 * 스튜디오의 실제 실행 경로(createSession → boot → SSE)를 그대로 지나가되, 컨테이너 대신
 * 서비스가 곧바로 ready가 되고 로그 스트림이 초당 rate개의 가짜 이벤트를 흘려보낸다.
 * 이 이벤트가 세션 이벤트 버스를 거쳐 SSE 구독자에게 도착하는 지연을 잰다.
 *
 * 이 파일은 부하 스크립트와 샌드박스 shim(sandbox-shim.ts)만 쓴다. 단위 테스트 대상이 아니다.
 */
import { writeFile } from 'node:fs/promises';
import type {
  ContainerState,
  ExternalCallResult,
  FileChange,
  LogLine,
  LogOptions,
  RelayedPath,
  Sandbox,
  SandboxProvider,
  ServiceEndpoint,
  ServiceUsage,
  StartOptions,
  SyncResult,
  ExecResult,
} from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';

const DEFAULT_RATE = 50;

export interface FakeSandboxStats {
  /** 로그 스트림이 만들어 낸 가짜 이벤트 수. 받은 수와 비교해 떨어진 이벤트를 센다 */
  producedEvents: number;
  sandboxes: number;
}

export const fakeSandboxStats: FakeSandboxStats = { producedEvents: 0, sandboxes: 0 };

export function resetFakeSandboxStats(): void {
  fakeSandboxStats.producedEvents = 0;
  fakeSandboxStats.sandboxes = 0;
}

/** 세션마다 초당 흘려보낼 이벤트 수. 스튜디오가 부르는 providerFromEnv()가 이 값을 읽는다 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  const rate = positiveNumber(env.B_STUDIO_BENCH_RATE, DEFAULT_RATE);
  let created = 0;
  return {
    name: 'bench-fake',
    async create(project: LoadedProject): Promise<Sandbox> {
      created += 1;
      fakeSandboxStats.sandboxes += 1;
      return new FakeSandbox(project, `studio-${project.spec.name}-bench${created}`, rate);
    },
  };
}

class FakeSandbox implements Sandbox {
  readonly project: LoadedProject;
  readonly id: string;
  #rate: number;
  #destroyed = false;

  constructor(project: LoadedProject, id: string, rate: number) {
    this.project = project;
    this.id = id;
    this.#rate = rate;
  }

  async start(options?: StartOptions): Promise<ServiceEndpoint[]> {
    const endpoints: ServiceEndpoint[] = [];
    for (const [name, service] of this.project.managed) {
      const endpoint = { service: name, containerPort: service.port, url: `http://127.0.0.1:${service.port}` };
      options?.onStatus?.({ service: name, phase: 'starting' });
      options?.onStatus?.({ service: name, phase: 'ready', endpoint });
      endpoints.push(endpoint);
    }
    options?.onBootNetwork?.(this.project.managed.map(([name]) => ({ service: name, rxBytes: 4_096, txBytes: 2_048 })));
    return endpoints;
  }

  async restart(service: string): Promise<ServiceEndpoint> {
    const managed = this.project.managed.find(([name]) => name === service);
    return { service, containerPort: managed?.[1].port ?? 0, url: `http://127.0.0.1:${managed?.[1].port ?? 0}` };
  }

  async sync(): Promise<SyncResult> {
    return { elapsedMs: 0, checks: 1 };
  }

  async endpoint(service: string): Promise<ServiceEndpoint> {
    const managed = this.project.managed.find(([name]) => name === service);
    return { service, containerPort: managed?.[1].port ?? 0, url: `http://127.0.0.1:${managed?.[1].port ?? 0}` };
  }

  async state(): Promise<ContainerState> {
    return 'running';
  }

  async stats(): Promise<ServiceUsage[]> {
    const memoryLimitBytes = 1_024 * 1_024 * 1_024;
    return this.project.managed.map(([service]) => ({ service, role: 'managed', state: 'running', cpuPercent: 1, memoryBytes: 32 * 1_024 * 1_024, memoryLimitBytes, oomKilled: false }));
  }

  async *logs(options?: LogOptions): AsyncIterable<LogLine> {
    const services = this.project.managed.map(([name]) => name);
    const signal = options?.signal;
    const intervalMs = 1_000 / this.#rate;
    let seq = 0;
    while (!this.#destroyed && !signal?.aborted) {
      const service = services[seq % services.length] ?? 'web';
      seq += 1;
      fakeSandboxStats.producedEvents += 1;
      yield { service, text: `bench-log ${seq}`, at: new Date() };
      await delay(intervalMs, signal);
    }
  }

  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async execToFile(_service: string, _command: string[], outputFile: string): Promise<ExecResult> {
    // 체크포인트마다 데이터베이스 덤프를 남기는 경로를 지나가야 boot이 끝난다. 빈 덤프 파일을 만들어 준다
    await writeFile(outputFile, '-- bench fake dump\n');
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async execFromFile(): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async relayChanges(changes: FileChange[]): Promise<RelayedPath[]> {
    return changes.filter((change) => change.kind !== 'deleted').map((change) => ({ service: this.project.managed[0]?.[0] ?? 'web', file: change.file }));
  }

  redact(text: string): string {
    return text;
  }

  findSecrets(): string[] {
    return [];
  }

  async callExternal(): Promise<ExternalCallResult> {
    return { decision: 'deny', status: 404, body: '', masked: 0 };
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

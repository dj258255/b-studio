import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { externalCallScript } from '../docker/external-call';
import { parseEgressDenial, parseSyncOutput } from '../docker/format';
import { EDGE_SERVICE, edgePortFor } from '../edge-config';
import { SandboxError } from '../errors';
import { DEFAULT_READINESS, waitForReady, type ReadinessPolicy } from '../readiness';
import { assertSandboxId } from '../sandbox-id';
import { Redactor } from '../secrets';
import type {
  CleanupCommand,
  ContainerState,
  CreateSandboxOptions,
  EgressDenial,
  ExecResult,
  ExternalCallRequest,
  ExternalCallResult,
  LogLine,
  LogOptions,
  Sandbox,
  SandboxProvider,
  ServiceEndpoint,
  ServiceUsage,
  StartOptions,
  SyncOptions,
  SyncResult,
} from '../types';
import { loadComposeModel, type ComposeModel } from './compose-model';
import { isPortForwardBroken, parseKubectlLogLine, parsePortForwardLine, podReady, podState, podUsage, type PodJson } from './format';
import { buildKubernetesManifests, SANDBOX_LABEL, SECRET_NAME, SERVICE_LABEL, type KubernetesObject } from './manifests';

const execFileAsync = promisify(execFile);
const EDGE_SCRIPT = new URL('../../edge/edge.mjs', import.meta.url);
const POD_READY_TIMEOUT_MS = 300_000;

/** build 서비스 이미지를 클러스터에 올리는 방법 */
export type ImageLoader = { kind: 'kind'; cluster: string } | { kind: 'registry'; prefix: string };

export interface KubernetesProviderOptions {
  kubectlBin?: string;
  dockerBin?: string;
  kindBin?: string;
  kubeconfig?: string;
  context?: string;
  /** 서비스 Pod에 쓸 RuntimeClass (예: gvisor) */
  runtimeClassName?: string;
  /** 호스트 경로 → 노드 경로. 프로젝트 소스를 hostPath로 마운트하므로 단일 노드 개발 클러스터(kind 등)용이다 */
  hostPathMounts: Array<{ hostPath: string; nodePath: string }>;
  images: ImageLoader;
  readiness?: Partial<ReadinessPolicy>;
}

/**
 * agent-sandbox가 설치된 Kubernetes 클러스터에 샌드박스를 만든다.
 * compose.yaml을 그대로 실행 정의로 쓰고, 서비스마다 Sandbox 리소스를 둔다 (ADR-028)
 */
export class KubernetesProvider implements SandboxProvider {
  readonly name = 'kubernetes';
  readonly isolation: string | undefined;
  readonly #options: KubernetesProviderOptions;

  constructor(options: KubernetesProviderOptions) {
    this.#options = options;
    this.isolation = options.runtimeClassName;
  }

  /** 세션의 모든 리소스(Sandbox, Secret, NetworkPolicy)가 네임스페이스 안에 있다 */
  cleanupCommand(sandboxId: string): CleanupCommand {
    assertSandboxId(sandboxId);
    const kubectl = new Kubectl(this.#options);
    return { command: kubectl.bin, args: kubectl.args(['delete', 'namespace', sandboxId, '--ignore-not-found', '--wait=false']) };
  }

  async cleanup(sandboxId: string): Promise<void> {
    const { command, args } = this.cleanupCommand(sandboxId);
    const result = await execCommand(command, args, {});
    if (result.exitCode !== 0) throw new SandboxError(`샌드박스 ${sandboxId}를 정리하지 못했습니다`, result.stderr);
  }

  async create(project: LoadedProject, { secrets = {} }: CreateSandboxOptions = {}): Promise<Sandbox> {
    const kubectl = new Kubectl(this.#options);
    // 클러스터 준비가 안 됐으면 이미지 빌드나 적용 도중이 아니라 지금 알린다
    const crd = await kubectl.run(['get', 'crd', 'sandboxes.agents.x-k8s.io', '-o', 'name']);
    if (crd.exitCode !== 0) throw new SandboxError('클러스터에 agent-sandbox가 설치되지 않았습니다 (sandboxes.agents.x-k8s.io CRD 없음)', crd.stderr);
    if (this.#options.runtimeClassName) {
      const runtimeClass = await kubectl.run(['get', 'runtimeclass', this.#options.runtimeClassName, '-o', 'name']);
      if (runtimeClass.exitCode !== 0) throw new SandboxError(`클러스터에 RuntimeClass '${this.#options.runtimeClassName}'이 없습니다`, runtimeClass.stderr);
    }

    // 네임스페이스 이름(63자, 소문자)으로도 쓴다
    const id = `studio-${project.spec.name.slice(0, 40)}-${randomBytes(3).toString('hex')}`;
    const compose = await loadComposeModel(project, { dockerBin: this.#options.dockerBin });
    const edgeScript = await readFile(EDGE_SCRIPT, 'utf8');
    return new KubernetesSandbox(id, project, compose, edgeScript, this.#options, secrets);
  }
}

class Kubectl {
  readonly #options: KubernetesProviderOptions;

  constructor(options: KubernetesProviderOptions) {
    this.#options = options;
  }

  args(args: string[]): string[] {
    return [
      ...(this.#options.kubeconfig ? ['--kubeconfig', this.#options.kubeconfig] : []),
      ...(this.#options.context ? ['--context', this.#options.context] : []),
      ...args,
    ];
  }

  get bin(): string {
    return this.#options.kubectlBin ?? 'kubectl';
  }

  run(args: string[], options: { signal?: AbortSignal; input?: string } = {}): Promise<ExecResult> {
    return execCommand(this.bin, this.args(args), options);
  }
}

class KubernetesSandbox implements Sandbox {
  readonly id: string;
  readonly project: LoadedProject;
  readonly #compose: ComposeModel;
  readonly #edgeScript: string;
  readonly #options: KubernetesProviderOptions;
  readonly #secrets: Record<string, string>;
  readonly #redactor: Redactor;
  readonly #kubectl: Kubectl;
  /** edge 포트 → 지금 열려 있는 port-forward의 로컬 포트 */
  readonly #ports = new Map<number, number>();
  /** 다시 연 port-forward도 같은 로컬 포트를 쓰게 해 미리보기 주소가 바뀌지 않게 한다 */
  readonly #localPorts = new Map<number, number>();
  #portForward?: ChildProcess;
  #portForwardErrors: string[] = [];
  #destroyed = false;

  constructor(id: string, project: LoadedProject, compose: ComposeModel, edgeScript: string, options: KubernetesProviderOptions, secrets: Record<string, string>) {
    this.id = id;
    this.project = project;
    this.#compose = compose;
    this.#edgeScript = edgeScript;
    this.#options = options;
    this.#secrets = secrets;
    this.#redactor = new Redactor(secrets);
    this.#kubectl = new Kubectl(options);
  }

  get #namespace(): string {
    return this.id;
  }

  async start(options: StartOptions = {}): Promise<ServiceEndpoint[]> {
    for (const [name] of this.project.managed) options.onStatus?.({ service: name, phase: 'starting' });

    const images = await this.#prepareImages(options.signal);
    const [namespace, ...rest] = buildKubernetesManifests({
      project: this.project,
      compose: this.#compose,
      namespace: this.#namespace,
      sandboxId: this.id,
      edgeScript: this.#edgeScript,
      runtimeClassName: this.#options.runtimeClassName,
      images,
      hostPathMounts: this.#options.hostPathMounts,
    });
    await this.#apply([namespace!], options.signal);
    // 시크릿 값은 파일에 쓰지 않고 kubectl 표준 입력으로만 넘긴다
    await this.#apply(
      [{ apiVersion: 'v1', kind: 'Secret', metadata: { name: SECRET_NAME, namespace: this.#namespace }, type: 'Opaque', stringData: this.#secrets }],
      options.signal,
    );
    await this.#apply(rest, options.signal);

    await this.#waitPodReady(EDGE_SERVICE, options.signal);
    await this.#startPortForward();

    const giveUp = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, giveUp.signal]) : giveUp.signal;
    let failedFirst: string | undefined;
    const onStatus: StartOptions['onStatus'] = options.onStatus
      ? (event) =>
          options.onStatus!(
            event.phase === 'failed' && failedFirst && event.service !== failedFirst && !options.signal?.aborted
              ? { ...event, reason: `${failedFirst} 서비스가 준비에 실패해 확인을 멈췄습니다` }
              : event,
          )
      : undefined;
    const endpoints = await Promise.all(
      this.project.managed.map(([name]) =>
        this.#awaitReady(name, { ...options, signal, onStatus }).catch((error: unknown) => {
          failedFirst ??= name;
          giveUp.abort(error);
          throw error;
        }),
      ),
    );
    // 준비 확인은 요청을 중간에 끊으므로, 그 port-forward는 이후 일부 요청이 멈춘다. 같은 로컬 포트로 새로 연다
    await this.#refreshPortForward(options.signal);
    return endpoints;
  }

  async restart(name: string, options: StartOptions = {}): Promise<ServiceEndpoint> {
    this.#managed(name);
    options.onStatus?.({ service: name, phase: 'starting' });
    const before = await this.#pod(name);
    // Sandbox 컨트롤러가 Pod를 다시 만든다. 소스는 hostPath로 마운트돼 있어 새 Pod가 바뀐 코드로 뜬다
    await this.#kubectlOrThrow(['-n', this.#namespace, 'delete', 'pod', name, '--wait=false', '--grace-period=2'], options.signal);
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    for (;;) {
      const pod = await this.#pod(name);
      if (pod?.metadata?.uid && pod.metadata.uid !== before?.metadata?.uid) break;
      if (Date.now() > deadline) throw new SandboxError(`${name} Pod가 다시 만들어지지 않았습니다`);
      await sleep(500, undefined, { signal: options.signal });
    }
    const endpoint = await this.#awaitReady(name, options);
    await this.#refreshPortForward(options.signal);
    return endpoint;
  }

  async sync(files: string[], { signal, timeoutMs = 60_000 }: SyncOptions = {}): Promise<SyncResult> {
    const targets = await this.#syncTargets(files);
    if (targets.size === 0) return { elapsedMs: 0, checks: 0 };
    const started = Date.now();
    for (let checks = 1; ; checks++) {
      const pending: string[] = [];
      for (const [service, entries] of targets) {
        const script = 'for f in "$@"; do if [ -e "$f" ]; then h=$(sha256sum "$f" 2>/dev/null | cut -d " " -f 1); echo "${h:-UNREADABLE} $f"; else echo "MISSING $f"; fi; done';
        const result = await this.#kubectl.run(['-n', this.#namespace, 'exec', service, '-c', service, '--', 'sh', '-c', script, 'sh', ...entries.map((entry) => entry.containerPath)], { signal });
        const seen = result.exitCode === 0 ? parseSyncOutput(result.stdout) : new Map<string, string>();
        for (const entry of entries) if (seen.get(entry.containerPath) !== entry.expected) pending.push(entry.file);
      }
      if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };
      if (Date.now() - started >= timeoutMs) {
        throw new SandboxError(`${Math.round(timeoutMs / 1_000)}초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: ${pending.join(', ')}`);
      }
      await sleep(250, undefined, { signal });
    }
  }

  async endpoint(name: string): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    const edgePort = edgePortFor(this.project, name);
    // port-forward가 다시 붙는 중이면 잠시 기다린다
    for (let attempt = 0; !this.#ports.has(edgePort) && attempt < 60; attempt++) await sleep(500);
    const local = this.#ports.get(edgePort);
    if (!local) throw new SandboxError(`${name} 서비스로 가는 port-forward가 열려 있지 않습니다`, this.#portForwardErrors.join('\n'));
    return { service: name, containerPort: service.port, url: `http://127.0.0.1:${local}` };
  }

  async state(name: string): Promise<ContainerState> {
    return podState(await this.#pod(name));
  }

  async stats(): Promise<ServiceUsage[]> {
    const result = await this.#kubectlOrThrow(['-n', this.#namespace, 'get', 'pods', '-l', `${SANDBOX_LABEL}=${this.id}`, '-o', 'json']);
    return (JSON.parse(result.stdout) as { items: PodJson[] }).items.map(podUsage);
  }

  async *logs({ services = [], tail = 200, follow = true, signal }: LogOptions = {}): AsyncIterable<LogLine> {
    const selector = services.length > 0 ? `${SANDBOX_LABEL}=${this.id},${SERVICE_LABEL} in (${services.join(',')})` : `${SANDBOX_LABEL}=${this.id}`;
    const args = this.#kubectl.args([
      '-n', this.#namespace, 'logs', '-l', selector, '--prefix', '--timestamps', '--tail', String(tail), '--max-log-requests', '50',
      ...(follow ? ['--follow'] : []),
    ]);
    const child = spawn(this.#kubectl.bin, args, { signal, stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => {});
    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const line = parseKubectlLogLine(raw);
        if (line) yield { ...line, text: this.#redactor.redact(line.text) };
      }
    } finally {
      child.kill();
    }
  }

  async exec(name: string, command: string[], { signal, input, raw = false }: { signal?: AbortSignal; input?: string; raw?: boolean } = {}): Promise<ExecResult> {
    const result = await this.#kubectl.run(['-n', this.#namespace, 'exec', ...(input !== undefined ? ['-i'] : []), name, '-c', name, '--', ...command], { signal, input });
    return raw ? result : { ...result, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr) };
  }

  redact(text: string): string {
    return this.#redactor.redact(text);
  }

  findSecrets(text: string): string[] {
    return this.#redactor.find(text);
  }

  async egressDenials({ since }: { since?: Date } = {}): Promise<EgressDenial[]> {
    const result = await this.#kubectl.run(['-n', this.#namespace, 'logs', EDGE_SERVICE, '--timestamps', '--tail', '500']);
    const denials: EgressDenial[] = [];
    for (const raw of result.stdout.split('\n')) {
      const line = parseKubectlLogLine(raw, EDGE_SERVICE);
      const denial = line && parseEgressDenial(line.text);
      if (denial && (!since || denial.at >= since)) denials.push(denial);
    }
    return denials;
  }

  async callExternal(name: string, request: ExternalCallRequest, { via, signal }: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult> {
    if (!(this.project.external ?? []).some(([external]) => external === name)) throw new SandboxError(`'${name}'은(는) 등록한 사내 API가 아닙니다`);
    if (!request.path.startsWith('/')) throw new SandboxError('경로는 "/"로 시작해야 합니다');
    const script = externalCallScript(this.#edgeScript, { name, via, ...request });
    const result = await this.#kubectl.run(['-n', this.#namespace, 'exec', '-i', EDGE_SERVICE, '-c', EDGE_SERVICE, '--', 'node', '--input-type=module', '-'], { signal, input: script });
    const last = result.stdout.trim().split('\n').at(-1);
    if (result.exitCode !== 0 || !last) throw new SandboxError('사내 API 호출을 실행하지 못했습니다', this.redact(result.stderr));
    const parsed = JSON.parse(last) as ExternalCallResult;
    return { ...parsed, body: this.redact(parsed.body) };
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
    this.#portForward?.kill();
    await this.#kubectlOrThrow(['delete', 'namespace', this.#namespace, '--wait=true', '--timeout=180s', '--ignore-not-found']);
  }

  async #prepareImages(signal?: AbortSignal): Promise<Record<string, string>> {
    const images: Record<string, string> = {};
    const docker = this.#options.dockerBin ?? 'docker';
    for (const [name, service] of Object.entries(this.#compose.services)) {
      if (!service.build) continue;
      const local = `b-studio/${this.project.spec.name}-${name}:dev`;
      const dockerfile = path.resolve(service.build.context, service.build.dockerfile ?? 'Dockerfile');
      const built = await execCommand(docker, ['build', '-t', local, '-f', dockerfile, service.build.context], { signal });
      if (built.exitCode !== 0) throw new SandboxError(`${name} 이미지를 빌드하지 못했습니다`, built.stderr);

      if (this.#options.images.kind === 'kind') {
        const loaded = await execCommand(this.#options.kindBin ?? 'kind', ['load', 'docker-image', local, '--name', this.#options.images.cluster], { signal });
        if (loaded.exitCode !== 0) throw new SandboxError(`${name} 이미지를 kind 클러스터에 올리지 못했습니다`, loaded.stderr);
        images[name] = local;
      } else {
        const remote = `${this.#options.images.prefix.replace(/\/$/, '')}/${local.replace(/^b-studio\//, '')}`;
        const tagged = await execCommand(docker, ['tag', local, remote], { signal });
        const pushed = tagged.exitCode === 0 ? await execCommand(docker, ['push', remote], { signal }) : tagged;
        if (pushed.exitCode !== 0) throw new SandboxError(`${name} 이미지를 레지스트리에 올리지 못했습니다`, pushed.stderr);
        images[name] = remote;
      }
    }
    return images;
  }

  async #apply(objects: KubernetesObject[], signal?: AbortSignal): Promise<void> {
    const result = await this.#kubectl.run(['apply', '-f', '-'], { signal, input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }) });
    if (result.exitCode !== 0) throw new SandboxError(`Kubernetes 리소스를 적용하지 못했습니다 (${this.id})`, this.redact(result.stderr));
  }

  async #pod(name: string): Promise<PodJson | undefined> {
    const result = await this.#kubectl.run(['-n', this.#namespace, 'get', 'pod', name, '-o', 'json', '--ignore-not-found']);
    return result.exitCode === 0 && result.stdout.trim() ? (JSON.parse(result.stdout) as PodJson) : undefined;
  }

  async #waitPodReady(name: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    while (!podReady(await this.#pod(name))) {
      if (Date.now() > deadline) throw new SandboxError(`${name} Pod가 준비되지 않았습니다 (${Math.round(POD_READY_TIMEOUT_MS / 1000)}초)`);
      await sleep(500, undefined, { signal });
    }
  }

  /** 미리보기·API 탐색기·준비 확인은 edge Pod의 포트로 들어간다. 연결이 끊기면 다시 연다 */
  async #startPortForward(): Promise<void> {
    const edgePorts = this.project.managed.map(([name]) => edgePortFor(this.project, name));
    if (edgePorts.length === 0) return;
    const specs = edgePorts.map((port) => `${this.#localPorts.get(port) ?? 0}:${port}`);
    const args = this.#kubectl.args(['-n', this.#namespace, 'port-forward', '--address', '127.0.0.1', `pod/${EDGE_SERVICE}`, ...specs]);
    const child = spawn(this.#kubectl.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#portForward = child;
    let established = false;
    child.on('error', () => {});
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.#portForwardErrors = [...this.#portForwardErrors, line].slice(-5);
      // 브라우저가 요청을 취소해도 같은 상태가 된다. 프로세스를 끝내면 아래 exit 처리가 같은 로컬 포트로 다시 연다
      if (isPortForwardBroken(line)) child.kill();
    });
    child.on('exit', () => {
      this.#ports.clear();
      // 예전 포트를 다시 잡지 못해 끝났으면 다음에는 빈 포트를 새로 받는다
      if (!established) this.#localPorts.clear();
      if (!this.#destroyed) setTimeout(() => void this.#startPortForward().catch(() => {}), 1_000).unref();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxError('port-forward가 30초 안에 열리지 않았습니다', this.#portForwardErrors.join('\n'))), 30_000);
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const forward = parsePortForwardLine(line);
        if (!forward) return;
        this.#ports.set(forward.remote, forward.local);
        this.#localPorts.set(forward.remote, forward.local);
        if (edgePorts.every((port) => this.#ports.has(port))) {
          established = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  /** 지금 port-forward를 끝내고, 같은 로컬 포트로 다시 열릴 때까지 기다린다 (트러블슈팅 21) */
  async #refreshPortForward(signal?: AbortSignal): Promise<void> {
    const previous = this.#portForward;
    const edgePorts = this.project.managed.map(([name]) => edgePortFor(this.project, name));
    if (!previous || edgePorts.length === 0) return;
    previous.kill();
    const deadline = Date.now() + 30_000;
    while (this.#portForward === previous || !edgePorts.every((port) => this.#ports.has(port))) {
      if (Date.now() > deadline) throw new SandboxError('port-forward를 다시 열지 못했습니다', this.#portForwardErrors.join('\n'));
      await sleep(200, undefined, { signal });
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

  /** 바뀐 파일마다 그 파일을 마운트한 서비스 컨테이너 안의 경로와 기대하는 해시 */
  async #syncTargets(files: string[]): Promise<Map<string, Array<{ file: string; containerPath: string; expected: string }>>> {
    const targets = new Map<string, Array<{ file: string; containerPath: string; expected: string }>>();
    for (const file of files) {
      const absolute = path.join(this.project.root, file);
      for (const [service, definition] of Object.entries(this.#compose.services)) {
        const bind = definition.volumes?.find((volume) => volume.type === 'bind' && volume.source && (absolute === volume.source || absolute.startsWith(`${volume.source}/`)));
        if (!bind?.source) continue;
        if (podState(await this.#pod(service)) !== 'running') continue;
        const entries = targets.get(service) ?? [];
        entries.push({ file, containerPath: path.posix.join(bind.target, path.relative(bind.source, absolute).split(path.sep).join('/')), expected: await hashOrMissing(absolute) });
        targets.set(service, entries);
        break;
      }
    }
    return targets;
  }

  #policyFor(service: ManagedServiceSpec): ReadinessPolicy {
    const timeoutSeconds = service.ready?.timeoutSeconds;
    return { ...DEFAULT_READINESS, ...this.#options.readiness, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1_000 } : {}) };
  }

  #managed(name: string): ManagedServiceSpec {
    const entry = this.project.managed.find(([serviceName]) => serviceName === name);
    if (!entry) throw new SandboxError(`'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`);
    return entry[1];
  }

  async #kubectlOrThrow(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.#kubectl.run(args, { signal });
    if (result.exitCode !== 0) throw new SandboxError(`kubectl ${args.find((arg) => !arg.startsWith('-') && arg !== this.#namespace) ?? ''} 실패 (${this.id})`, this.redact(result.stderr));
    return result;
  }
}

async function execCommand(bin: string, args: string[], { signal, input }: { signal?: AbortSignal; input?: string } = {}): Promise<ExecResult> {
  try {
    const running = execFileAsync(bin, args, { signal, maxBuffer: 256 * 1024 * 1024 });
    running.child.stdin?.end(input);
    const { stdout, stderr } = await running;
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (!(error instanceof Error) || !('stdout' in error)) throw error;
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr || failure.message };
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

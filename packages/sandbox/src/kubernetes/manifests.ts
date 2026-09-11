import type { LoadedProject } from '@b-studio/spec';
import { directHosts, EDGE_IMAGE, EDGE_PROXY_PORT, EDGE_SERVICE, edgeEnvironment, edgePortFor, proxyEnvironment } from '../edge-config';
import type { ComposeModel, ComposeService } from './compose-model';

export type KubernetesObject = Record<string, unknown> & { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string> } };

export const SANDBOX_LABEL = 'b-studio.sandbox';
export const SERVICE_LABEL = 'b-studio.service';
/** 샌드박스끼리 공유하는 의존성 캐시(pnpm, Gradle 등)를 두는 노드 경로 */
export const NODE_CACHE_ROOT = '/var/lib/b-studio/cache';
/** 시크릿 값을 담는 Secret 이름. 값은 매니페스트에 쓰지 않고 따로 넣는다 */
export const SECRET_NAME = 'b-studio-secrets';
const API_PORT = 80;
/** 서비스 Pod가 edge 프록시를 기다리는 init 컨테이너 이미지 */
const WAIT_IMAGE = 'busybox:1.37';

export class KubernetesTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubernetesTranslationError';
  }
}

export interface KubernetesManifestOptions {
  project: LoadedProject;
  compose: ComposeModel;
  namespace: string;
  sandboxId: string;
  edgeScript: string;
  /** 서비스 Pod에 쓸 RuntimeClass (예: gvisor) */
  runtimeClassName?: string;
  /** compose 서비스 이름 → 클러스터가 받을 수 있는 이미지. build 서비스는 빌드해 올린 이름을 넣는다 */
  images: Record<string, string>;
  /** 호스트 경로 앞부분 → 노드 경로 앞부분 (kind extraMounts 등). 소스 바인드 마운트에 쓴다 */
  hostPathMounts: ReadonlyArray<{ hostPath: string; nodePath: string }>;
}

/**
 * compose 서비스를 agent-sandbox `Sandbox`로 옮긴다.
 *  - 세션마다 네임스페이스 하나, compose 서비스마다 같은 이름의 Sandbox(service: true)라서 서비스 이름으로 서로 부른다
 *  - NetworkPolicy로 edge 말고는 네임스페이스 밖으로 나가지 못하게 한다
 *  - edge는 RuntimeClass를 걸지 않는다. kubectl port-forward는 Pod 네트워크 네임스페이스의 localhost로 연결하는데,
 *    gVisor 기본 네트워크 모드의 Pod는 거기서 포트가 보이지 않아 미리보기를 공개할 수 없다
 */
export function buildKubernetesManifests(options: KubernetesManifestOptions): KubernetesObject[] {
  const { project, compose, namespace, sandboxId } = options;
  const services = Object.keys(compose.services);
  const labels = (service?: string) => ({ [SANDBOX_LABEL]: sandboxId, ...(service ? { [SERVICE_LABEL]: service } : {}), 'app.kubernetes.io/managed-by': 'b-studio' });
  const proxyEnv = proxyEnvironment(directHosts(project, services));

  const objects: KubernetesObject[] = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: labels() } },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'sandbox-isolation', namespace, labels: labels() },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [{ podSelector: {} }] }],
        egress: [
          { to: [{ podSelector: {} }] },
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    },
    {
      // 허용 목록 판단은 edge가 한다. 여기서는 edge만 네임스페이스 밖으로 나갈 수 있게 연다
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'edge-egress', namespace, labels: labels(EDGE_SERVICE) },
      spec: { podSelector: { matchLabels: { [SERVICE_LABEL]: EDGE_SERVICE } }, policyTypes: ['Egress'], egress: [{}] },
    },
  ];

  for (const [name, service] of Object.entries(compose.services)) {
    objects.push(serviceSandbox(options, name, service, proxyEnv, labels(name)));
  }
  objects.push(edgeSandbox(options, services, labels(EDGE_SERVICE)));

  // 등록한 사내 API 이름으로 부르면 edge의 API 프록시로 가게 한다 (compose의 네트워크 별칭에 해당)
  for (const [name] of project.external ?? []) {
    objects.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace, labels: labels(EDGE_SERVICE) },
      spec: { selector: { [SERVICE_LABEL]: EDGE_SERVICE }, ports: [{ name: 'api', port: API_PORT, targetPort: API_PORT }] },
    });
  }
  return objects;
}

function serviceSandbox(
  { project, compose, namespace, images, hostPathMounts, runtimeClassName }: KubernetesManifestOptions,
  name: string,
  service: ComposeService,
  proxyEnv: Record<string, string>,
  labels: Record<string, string>,
): KubernetesObject {
  const image = images[name] ?? service.image;
  if (!image) throw new KubernetesTranslationError(`${name} 서비스의 이미지가 없습니다. build 서비스는 빌드한 이미지를 넘겨야 합니다`);

  const managed = project.managed.find(([managedName]) => managedName === name)?.[1];
  const secretEnv = (project.secrets ?? [])
    .filter(([, secret]) => secret.services.includes(name))
    .map(([secretName]) => ({ name: secretName, valueFrom: { secretKeyRef: { name: SECRET_NAME, key: secretName } } }));
  const composeEnv = Object.entries(service.environment ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => ({ name: key, value }));
  const { volumes, mounts } = translateVolumes(name, service, compose, hostPathMounts);
  const limits = resourceLimits(project, name);
  const probe = healthProbe(service);

  return sandbox(name, namespace, labels, {
    ...(runtimeClassName ? { runtimeClassName } : {}),
    // Kubernetes가 넣는 <서비스>_PORT 같은 환경 변수가 앱 설정과 겹치지 않게 한다
    enableServiceLinks: false,
    // compose의 depends_on(edge, service_healthy)에 해당한다. edge Pod가 준비돼야 헤드리스 Service 이름이 풀리므로,
    // 그 전에 뜨면 첫 다운로드(corepack 등)가 이름 풀이에 실패하고 컨테이너가 끝난다
    initContainers: [{ name: 'wait-for-edge', image: WAIT_IMAGE, command: ['sh', '-c', `until nc -z ${EDGE_SERVICE} ${EDGE_PROXY_PORT}; do sleep 1; done`] }],
    containers: [
      {
        name,
        image,
        ...(service.entrypoint ? { command: service.entrypoint } : {}),
        ...(service.command ? { args: service.command } : {}),
        ...(service.working_dir ? { workingDir: service.working_dir } : {}),
        env: [...Object.entries(proxyEnv).map(([key, value]) => ({ name: key, value })), ...composeEnv, ...secretEnv],
        ...(managed ? { ports: [{ containerPort: managed.port }] } : {}),
        ...(mounts.length > 0 ? { volumeMounts: mounts } : {}),
        ...(limits ? { resources: { limits } } : {}),
        ...(probe ? { readinessProbe: probe } : {}),
      },
    ],
    ...(volumes.length > 0 ? { volumes } : {}),
  });
}

function edgeSandbox({ project, namespace, edgeScript }: KubernetesManifestOptions, services: string[], labels: Record<string, string>): KubernetesObject {
  const authEnv = (project.external ?? []).flatMap(([, service]) =>
    service.policy.auth ? [{ name: service.policy.auth.secret, valueFrom: { secretKeyRef: { name: SECRET_NAME, key: service.policy.auth.secret } } }] : [],
  );
  const ports = [
    { name: 'proxy', containerPort: EDGE_PROXY_PORT },
    ...((project.external ?? []).length > 0 ? [{ name: 'api', containerPort: API_PORT }] : []),
    ...project.managed.map(([name]) => ({ name: `fwd-${edgePortFor(project, name)}`, containerPort: edgePortFor(project, name) })),
  ];
  return sandbox(EDGE_SERVICE, namespace, labels, {
    enableServiceLinks: false,
    containers: [
      {
        name: EDGE_SERVICE,
        image: EDGE_IMAGE,
        // compose와 달리 매니페스트 값은 변수 치환을 하지 않으므로 스크립트를 그대로 넣는다
        command: ['node', '--input-type=module', '-e', edgeScript],
        env: [...Object.entries(edgeEnvironment(project, services)).map(([key, value]) => ({ name: key, value })), ...authEnv],
        ports,
        readinessProbe: { tcpSocket: { port: EDGE_PROXY_PORT }, periodSeconds: 1, failureThreshold: 30 },
        resources: { limits: { memory: '128Mi', cpu: '500m' } },
      },
    ],
  });
}

function sandbox(name: string, namespace: string, labels: Record<string, string>, podSpec: Record<string, unknown>): KubernetesObject {
  return {
    apiVersion: 'agents.x-k8s.io/v1beta1',
    kind: 'Sandbox',
    metadata: { name, namespace, labels },
    spec: { service: true, podTemplate: { metadata: { labels }, spec: podSpec } },
  };
}

function translateVolumes(service: string, definition: ComposeService, compose: ComposeModel, hostPathMounts: KubernetesManifestOptions['hostPathMounts']) {
  const volumes: Array<Record<string, unknown>> = [];
  const mounts: Array<Record<string, unknown>> = [];
  (definition.volumes ?? []).forEach((volume, index) => {
    const volumeName = `v${index}`;
    mounts.push({ name: volumeName, mountPath: volume.target, ...(volume.read_only ? { readOnly: true } : {}) });
    if (volume.type === 'bind') {
      volumes.push({ name: volumeName, hostPath: { path: nodePath(service, volume.source ?? '', hostPathMounts), type: 'DirectoryOrCreate' } });
    } else if (volume.type === 'tmpfs') {
      volumes.push({ name: volumeName, emptyDir: { medium: 'Memory' } });
    } else if (volume.source && compose.volumes?.[volume.source]?.external) {
      // compose의 external 볼륨은 b-studio에서 샌드박스끼리 공유하는 의존성 캐시다. 같은 노드의 경로로 공유한다
      volumes.push({ name: volumeName, hostPath: { path: `${NODE_CACHE_ROOT}/${volume.source}`, type: 'DirectoryOrCreate' } });
    } else {
      // 샌드박스 전용 볼륨. Pod를 다시 만들면 비워지므로 설치 단계가 다시 돈다 (공유 캐시가 있어 내려받기는 반복하지 않는다)
      volumes.push({ name: volumeName, emptyDir: {} });
    }
  });
  return { volumes, mounts };
}

function nodePath(service: string, source: string, hostPathMounts: KubernetesManifestOptions['hostPathMounts']): string {
  const mount = hostPathMounts.find(({ hostPath }) => source === hostPath || source.startsWith(`${hostPath}/`));
  if (!mount) {
    throw new KubernetesTranslationError(`${service} 서비스의 바인드 마운트 ${source}를 클러스터 노드에서 찾을 수 없습니다. B_STUDIO_K8S_HOST_PATHS에 호스트 경로와 노드 경로를 적으세요`);
  }
  return `${mount.nodePath}${source.slice(mount.hostPath.length)}`;
}

function resourceLimits(project: LoadedProject, service: string): Record<string, string> | undefined {
  const limit = project.resources?.[service];
  if (!limit) return undefined;
  return {
    ...(limit.memory ? { memory: kubernetesMemory(limit.memory) } : {}),
    ...(limit.cpus ? { cpu: String(limit.cpus) } : {}),
  };
}

/** docker 표기(512m, 1.5g)를 Kubernetes 표기로 바꾼다. Kubernetes의 m은 1/1000이라 그대로 쓰면 안 된다 */
export function kubernetesMemory(docker: string): string {
  const match = /^(\d+(?:\.\d+)?)([kmg])$/i.exec(docker);
  if (!match) throw new KubernetesTranslationError(`메모리 한도 표기를 읽지 못했습니다: ${docker}`);
  return `${match[1]}${{ k: 'Ki', m: 'Mi', g: 'Gi' }[match[2]!.toLowerCase() as 'k' | 'm' | 'g']}`;
}

function healthProbe(service: ComposeService): Record<string, unknown> | undefined {
  const test = service.healthcheck?.test;
  if (!test || service.healthcheck?.disable || test[0] === 'NONE') return undefined;
  const command = test[0] === 'CMD-SHELL' ? ['sh', '-c', test.slice(1).join(' ')] : test[0] === 'CMD' ? test.slice(1) : undefined;
  if (!command) return undefined;
  return { exec: { command }, periodSeconds: Math.max(1, Math.round(durationSeconds(service.healthcheck?.interval) ?? 5)), failureThreshold: service.healthcheck?.retries ?? 3 };
}

function durationSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'm' ? amount * 60 : amount;
}

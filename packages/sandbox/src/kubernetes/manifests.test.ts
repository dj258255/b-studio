import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose-model';
import { buildKubernetesManifests, kubernetesMemory, KubernetesTranslationError, type KubernetesObject } from './manifests';

const ROOT = '/Users/dev/.cache/b-studio/sessions/orders-1';

const project = {
  managed: [
    ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }],
    ['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }],
  ],
  composeServices: ['web', 'api', 'db'],
  egress: [],
  resources: { api: { memory: '1536m', cpus: 2 }, db: { memory: '256m' } },
  secrets: [['PAYMENT_API_KEY', { services: ['api'] }], ['LEGACY_USERS_TOKEN', { services: [] }]],
  external: [
    ['legacy-users', { source: 'external', baseUrl: 'https://users.internal.example.com', preview: 'openapi', policy: { mask: [], auth: { header: 'Authorization', secret: 'LEGACY_USERS_TOKEN', prefix: 'Bearer ' } } }],
  ],
} as unknown as LoadedProject;

/** `docker compose config --format json`으로 확인한 예제 프로젝트 모양 */
const compose: ComposeModel = {
  services: {
    web: {
      build: { context: `${ROOT}/web`, dockerfile: 'Dockerfile.dev' },
      command: null,
      environment: { API_BASE_URL: 'http://api:8080' },
      volumes: [
        { type: 'bind', source: `${ROOT}/web`, target: '/app' },
        { type: 'volume', source: 'web-node-modules', target: '/app/node_modules' },
        { type: 'volume', source: 'pnpm-store', target: '/cache/pnpm' },
      ],
    },
    api: { build: { context: `${ROOT}/api` }, environment: { DATABASE_URL: 'jdbc:postgresql://db:5432/app', PASSTHROUGH: null } },
    db: {
      image: 'postgres:17-alpine',
      environment: { POSTGRES_DB: 'app' },
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app -d app'], interval: '2s', retries: 30 },
    },
  },
  volumes: { 'web-node-modules': { name: 'x_web-node-modules' }, 'pnpm-store': { name: 'b-studio-cache-pnpm', external: true } },
};

const build = (overrides: Partial<Parameters<typeof buildKubernetesManifests>[0]> = {}) =>
  buildKubernetesManifests({
    project,
    compose,
    namespace: 'b-studio-orders-1a2b3c',
    sandboxId: 'studio-orders-1a2b3c',
    edgeScript: 'console.log(`${edge}` + $x)',
    runtimeClassName: 'gvisor',
    images: { web: 'b-studio/orders-web:abc', api: 'b-studio/orders-api:abc' },
    hostPathMounts: [{ hostPath: '/Users/dev/.cache/b-studio', nodePath: '/b-studio' }],
    ...overrides,
  });

const find = (objects: KubernetesObject[], kind: string, name: string) => objects.find((object) => object.kind === kind && object.metadata.name === name)!;
const podSpec = (sandbox: KubernetesObject) => (sandbox.spec as { podTemplate: { spec: Record<string, any> } }).podTemplate.spec;
const envOf = (sandbox: KubernetesObject) => podSpec(sandbox).containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>;

describe('buildKubernetesManifests', () => {
  it('세션 네임스페이스에 서비스마다 같은 이름의 Sandbox를 두고, edge만 네임스페이스 밖으로 나가게 한다', () => {
    const objects = build();

    expect(objects.map((object) => `${object.kind}/${object.metadata.name}`)).toEqual([
      'Namespace/b-studio-orders-1a2b3c',
      'NetworkPolicy/sandbox-isolation',
      'NetworkPolicy/edge-egress',
      'Sandbox/web',
      'Sandbox/api',
      'Sandbox/db',
      'Sandbox/b-studio-edge',
      'Service/legacy-users',
    ]);
    expect(find(objects, 'Sandbox', 'web').spec).toMatchObject({ service: true });
    expect(find(objects, 'NetworkPolicy', 'edge-egress').spec).toEqual({
      podSelector: { matchLabels: { 'b-studio.service': 'b-studio-edge' } },
      policyTypes: ['Egress'],
      egress: [{}],
    });
  });

  it('서비스에는 RuntimeClass를 걸고 edge에는 걸지 않는다 (port-forward가 gVisor Pod의 포트를 보지 못함)', () => {
    const objects = build();
    for (const name of ['web', 'api', 'db']) expect(podSpec(find(objects, 'Sandbox', name))).toMatchObject({ runtimeClassName: 'gvisor', enableServiceLinks: false });
    expect(podSpec(find(objects, 'Sandbox', 'b-studio-edge'))).not.toHaveProperty('runtimeClassName');
  });

  it('서비스 Pod는 edge 프록시에 연결될 때까지 기다린 뒤 뜬다 (compose depends_on에 해당)', () => {
    const objects = build();
    for (const name of ['web', 'api', 'db']) {
      expect(podSpec(find(objects, 'Sandbox', name)).initContainers).toEqual([
        { name: 'wait-for-edge', image: 'busybox:1.37', command: ['sh', '-c', 'until nc -z b-studio-edge 3128; do sleep 1; done'] },
      ]);
    }
    expect(podSpec(find(objects, 'Sandbox', 'b-studio-edge'))).not.toHaveProperty('initContainers');
  });

  it('프록시 설정, compose 환경 변수, Secret 참조를 넣고 값이 null인 항목은 뺀다', () => {
    const api = envOf(find(build(), 'Sandbox', 'api'));

    expect(api).toContainEqual({ name: 'HTTPS_PROXY', value: 'http://b-studio-edge:3128' });
    expect(api).toContainEqual({ name: 'NO_PROXY', value: 'localhost,127.0.0.1,web,api,db,legacy-users' });
    expect(api).toContainEqual({ name: 'DATABASE_URL', value: 'jdbc:postgresql://db:5432/app' });
    expect(api).toContainEqual({ name: 'PAYMENT_API_KEY', valueFrom: { secretKeyRef: { name: 'b-studio-secrets', key: 'PAYMENT_API_KEY' } } });
    expect(api.some((entry) => entry.name === 'PASSTHROUGH')).toBe(false);
    expect(envOf(find(build(), 'Sandbox', 'web')).some((entry) => entry.name === 'PAYMENT_API_KEY')).toBe(false);
  });

  it('바인드 마운트는 노드 경로로, 공유 캐시는 노드 캐시 경로로, 전용 볼륨은 emptyDir로 옮긴다', () => {
    const web = podSpec(find(build(), 'Sandbox', 'web'));

    expect(web.containers[0].volumeMounts).toEqual([
      { name: 'v0', mountPath: '/app' },
      { name: 'v1', mountPath: '/app/node_modules' },
      { name: 'v2', mountPath: '/cache/pnpm' },
    ]);
    expect(web.volumes).toEqual([
      { name: 'v0', hostPath: { path: '/b-studio/sessions/orders-1/web', type: 'DirectoryOrCreate' } },
      { name: 'v1', emptyDir: {} },
      { name: 'v2', hostPath: { path: '/var/lib/b-studio/cache/pnpm-store', type: 'DirectoryOrCreate' } },
    ]);
  });

  it('노드에서 찾을 수 없는 바인드 마운트와 이미지가 없는 build 서비스는 이유와 함께 거부한다', () => {
    expect(() => build({ hostPathMounts: [] })).toThrow(KubernetesTranslationError);
    expect(() => build({ hostPathMounts: [] })).toThrow('web 서비스의 바인드 마운트');
    expect(() => build({ images: {} })).toThrow('web 서비스의 이미지가 없습니다');
  });

  it('자원 한도, healthcheck, edge 설정과 사내 API Service를 옮긴다', () => {
    const objects = build();
    expect(podSpec(find(objects, 'Sandbox', 'api')).containers[0].resources).toEqual({ limits: { memory: '1536Mi', cpu: '2' } });
    expect(podSpec(find(objects, 'Sandbox', 'db')).containers[0]).toMatchObject({
      image: 'postgres:17-alpine',
      resources: { limits: { memory: '256Mi' } },
      readinessProbe: { exec: { command: ['sh', '-c', 'pg_isready -U app -d app'] }, periodSeconds: 2, failureThreshold: 30 },
    });

    const edge = podSpec(find(objects, 'Sandbox', 'b-studio-edge')).containers[0];
    expect(edge.command).toEqual(['node', '--input-type=module', '-e', 'console.log(`${edge}` + $x)']);
    expect(edge.env).toContainEqual({ name: 'EDGE_FORWARDS', value: '20000=web:3000,20001=api:8080' });
    expect(edge.env).toContainEqual({ name: 'LEGACY_USERS_TOKEN', valueFrom: { secretKeyRef: { name: 'b-studio-secrets', key: 'LEGACY_USERS_TOKEN' } } });
    expect(edge.ports).toEqual([
      { name: 'proxy', containerPort: 3128 },
      { name: 'api', containerPort: 80 },
      { name: 'fwd-20000', containerPort: 20000 },
      { name: 'fwd-20001', containerPort: 20001 },
    ]);
    expect(find(objects, 'Service', 'legacy-users').spec).toEqual({
      selector: { 'b-studio.service': 'b-studio-edge' },
      ports: [{ name: 'api', port: 80, targetPort: 80 }],
    });
  });

  it('docker 메모리 표기를 Kubernetes 표기로 바꾼다', () => {
    expect(kubernetesMemory('512m')).toBe('512Mi');
    expect(kubernetesMemory('1.5g')).toBe('1.5Gi');
    expect(kubernetesMemory('64k')).toBe('64Ki');
    expect(() => kubernetesMemory('2GB')).toThrow(KubernetesTranslationError);
  });
});

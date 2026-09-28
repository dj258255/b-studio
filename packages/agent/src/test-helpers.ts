import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContainerState, LogLine, Sandbox, ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { OpenApiDocument } from './contract-diff';
import type { Steering } from './loop';

/** 단위 테스트 전용. 서비스 하나(api)짜리 주문 프로젝트를 임시 폴더에 만든다 */
export async function createOrdersProject(prefix: string): Promise<LoadedProject> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'api/src/Order.java'), 'class Order { String customerNam; }\n');
  return {
    root,
    spec: { name: 'orders' },
    managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } }]],
  } as unknown as LoadedProject;
}

/** 진행 중 지시 큐를 흉내 낸다. push하면 알림(onPush)이 기다리는 러너에게 전달된다 */
export function fakeSteering(): { steering: Steering; push: (text: string) => void } {
  const items: string[] = [];
  const listeners = new Set<() => void>();
  return {
    steering: {
      take: () => items.splice(0),
      onPush: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    push: (text) => {
      items.push(text);
      for (const listener of listeners) listener();
    },
  };
}

export const ORDERS_CONTRACT: OpenApiDocument = {
  paths: { '/api/orders': { get: {} } },
  components: { schemas: { OrderResponse: { properties: { id: { type: 'integer' }, memo: { type: 'string' } } } } },
};

/** restart 결과를 순서대로 돌려주는 가짜 샌드박스 */
export function fakeSandbox(project: LoadedProject, restartOutcomes: boolean[]): Sandbox & { restarts: string[] } {
  const restarts: string[] = [];
  return {
    id: 'fake',
    project,
    restarts,
    async start() {
      return [];
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async restart(service: string): Promise<ServiceEndpoint> {
      restarts.push(service);
      if (restartOutcomes.shift() === false) throw new Error('컨테이너가 종료됐습니다');
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async state(): Promise<ContainerState> {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs(): AsyncIterable<LogLine> {
      yield { service: 'api', text: 'Order.java:1: error: cannot find symbol', at: new Date() };
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact(text: string) {
      return text;
    },
    findSecrets() {
      return [];
    },
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  };
}

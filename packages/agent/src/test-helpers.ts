import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContainerState, LogLine, Sandbox, ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { OpenApiDocument } from './contract-diff';

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
    redact(text: string) {
      return text;
    },
    findSecrets() {
      return [];
    },
    async destroy() {},
  };
}

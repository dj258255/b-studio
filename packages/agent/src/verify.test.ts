import type { ContainerState, LogLine, Sandbox, ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { OpenApiDocument } from './contract-diff';
import { servicesForFiles } from './services';
import { formatVerificationReport, verifyChanges } from './verify';

const project = {
  root: '/tmp/orders',
  managed: [
    ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }],
    ['api', { source: 'managed', template: 'spring-boot', path: './api/', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } }],
  ],
} as unknown as LoadedProject;

const baseline: OpenApiDocument = {
  paths: { '/api/orders': { get: {} } },
  components: { schemas: { Order: { properties: { id: { type: 'integer' }, total: { type: 'integer' } } } } },
};

function fakeSandbox(failing: string[] = [], { syncFails = false } = {}): Sandbox & { restarts: string[]; calls: string[] } {
  const restarts: string[] = [];
  const calls: string[] = [];
  return {
    id: 'fake',
    project,
    restarts,
    calls,
    async start() {
      return [];
    },
    async sync(files: string[]) {
      calls.push(`sync:${files.join(',')}`);
      if (syncFails) throw new Error('60초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: api/src/main/java/Order.java');
      return { elapsedMs: 1200, checks: 3 };
    },
    async restart(service: string): Promise<ServiceEndpoint> {
      restarts.push(service);
      calls.push(`restart:${service}`);
      if (failing.includes(service)) throw new Error('컨테이너가 종료됐습니다 (마지막 확인: ECONNREFUSED, 컨테이너 exited)');
      return this.endpoint(service);
    },
    async endpoint(service: string) {
      return { service, containerPort: 0, url: `http://127.0.0.1/${service}/` };
    },
    async state(): Promise<ContainerState> {
      return 'running';
    },
    async *logs(): AsyncIterable<LogLine> {
      yield { service: 'api', text: 'error: cannot find symbol memo', at: new Date() };
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async destroy() {},
  };
}

describe('servicesForFiles', () => {
  it('서비스 경로 접두사로 매핑하고 서비스 밖 파일은 따로 모은다', () => {
    expect(servicesForFiles(project, ['api/src/A.java', 'web/app/page.tsx', 'apiary.txt', 'compose.yaml'])).toEqual({
      services: ['web', 'api'],
      unmatched: ['apiary.txt', 'compose.yaml'],
    });
  });
});

describe('verifyChanges', () => {
  it('바뀐 서비스만 재시작하고, 선택 필드 추가는 통과시킨다', async () => {
    const sandbox = fakeSandbox();
    const after = structuredClone(baseline);
    after.components!.schemas!.Order!.properties!.memo = { type: 'string' };

    const report = await verifyChanges({
      sandbox,
      project,
      changedFiles: ['api/src/main/java/Order.java'],
      baselines: new Map([['api', baseline]]),
      allowBreaking: false,
      fetcher: async () => after,
    });

    expect(sandbox.calls).toEqual(['sync:api/src/main/java/Order.java', 'restart:api']);
    expect(report.ok).toBe(true);
    expect(formatVerificationReport(report, { allowBreaking: false })).toContain('샌드박스 파일 반영 확인: 1.2초');
    expect(report.contracts[0]?.changes.map((c) => c.target)).toEqual(['Order.memo']);
  });

  it('허용하지 않았는데 호환을 깨면 실패로 본다', async () => {
    const after = structuredClone(baseline);
    delete after.components!.schemas!.Order!.properties!.total;

    const options = {
      sandbox: fakeSandbox(),
      project,
      changedFiles: ['api/src/main/java/Order.java'],
      baselines: new Map([['api', baseline]]),
      fetcher: async () => after,
    };
    expect((await verifyChanges({ ...options, allowBreaking: false })).ok).toBe(false);
    expect((await verifyChanges({ ...options, allowBreaking: true })).ok).toBe(true);
  });

  it('샌드박스가 파일 변경을 보지 못하면 재시작하지 않고 실패한다', async () => {
    const sandbox = fakeSandbox([], { syncFails: true });
    const report = await verifyChanges({
      sandbox,
      project,
      changedFiles: ['api/src/main/java/Order.java'],
      baselines: new Map([['api', baseline]]),
      allowBreaking: false,
      fetcher: async () => baseline,
    });

    expect(report.ok).toBe(false);
    expect(sandbox.restarts).toEqual([]);
    expect(formatVerificationReport(report, { allowBreaking: false })).toContain('파일 반영 확인 실패');
  });

  it('재시작에 실패하면 마지막 로그를 담고 그 서비스의 계약은 건너뛴다', async () => {
    const report = await verifyChanges({
      sandbox: fakeSandbox(['api']),
      project,
      changedFiles: ['api/src/main/java/Order.java'],
      baselines: new Map([['api', baseline]]),
      allowBreaking: false,
      fetcher: async () => {
        throw new Error('호출되면 안 됩니다');
      },
    });

    expect(report.ok).toBe(false);
    expect(report.contracts).toEqual([]);
    const text = formatVerificationReport(report, { allowBreaking: false });
    expect(text).toContain('api: 준비 실패');
    expect(text).toContain('cannot find symbol memo');
  });
});

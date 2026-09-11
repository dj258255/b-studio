import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContainerState, LogLine, Sandbox, ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { OpenApiDocument } from './contract-diff';
import { servicesForFiles } from './services';
import { findSecretLeaks, formatVerificationReport, mentionsDeletedFile, restartServicesFor, verifyChanges } from './verify';

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
    async stats() {
      return [];
    },
    async *logs(): AsyncIterable<LogLine> {
      yield { service: 'api', text: 'error: cannot find symbol memo', at: new Date() };
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
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
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

describe('restartServicesFor', () => {
  const deletedV2 = 'api/src/main/resources/db/migration/V2__memo.sql';

  /** V1만 남고 V2는 지워진 작업 복사본 */
  async function projectWithDeletedMigration(): Promise<LoadedProject> {
    const root = await mkdtemp(path.join(tmpdir(), 'restart-test-'));
    await mkdir(path.join(root, 'api/src/main/resources/db/migration'), { recursive: true });
    await writeFile(path.join(root, 'api/src/main/resources/db/migration/V1__orders.sql'), 'create table orders (id bigint);\n');
    return { ...project, root } as LoadedProject;
  }

  /** 재시작 결과를 순서대로 돌려주고, 실패하면 주어진 로그를 남기는 가짜 샌드박스 */
  function flakySandbox(outcomes: boolean[], logLine: string) {
    const base = fakeSandbox();
    const sandbox: Sandbox = {
      ...base,
      async restart(service: string) {
        base.restarts.push(service);
        if (outcomes.shift() === false) throw new Error('컨테이너가 종료됐습니다 (마지막 확인: ECONNRESET, 컨테이너 exited)');
        return base.endpoint(service);
      },
      async *logs(): AsyncIterable<LogLine> {
        yield { service: 'api', text: logLine, at: new Date() };
      },
    };
    return { sandbox, restarts: base.restarts };
  }

  it('지운 파일을 읽다 실패한 서비스는 잠시 뒤 한 번만 다시 재시작한다', async () => {
    const { sandbox, restarts } = flakySandbox(
      [false, true],
      '   > java.nio.file.NoSuchFileException: /app/src/main/resources/db/migration/V2__memo.sql',
    );

    const report = await restartServicesFor(sandbox, await projectWithDeletedMigration(), [deletedV2], undefined, { deletedFileRetryDelayMs: 1 });

    expect(restarts).toEqual(['api', 'api']);
    expect(report.restarted).toEqual([{ service: 'api', ready: true, retried: true }]);
    expect(formatVerificationReport({ ok: true, contracts: [], secretLeaks: [], ...report }, { allowBreaking: false })).toContain('한 번 더 재시작');
  });

  it('취소로 끊긴 재시작은 실패로 보고하지 않고 로그도 모으지 않은 채 그대로 던진다', async () => {
    const controller = new AbortController();
    const base = fakeSandbox();
    let logsRead = false;
    const sandbox: Sandbox = {
      ...base,
      async restart(service, options) {
        base.restarts.push(service);
        controller.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
        options?.signal?.throwIfAborted();
        return base.endpoint(service);
      },
      async *logs(): AsyncIterable<LogLine> {
        logsRead = true;
        yield { service: 'api', text: 'unused', at: new Date() };
      },
    };

    await expect(restartServicesFor(sandbox, project, ['api/src/Order.java'], { signal: controller.signal })).rejects.toThrow('요청을 취소했습니다');
    expect(base.restarts).toEqual(['api']);
    expect(logsRead).toBe(false);
  });

  it('지운 파일과 무관한 실패는 다시 시도하지 않는다', async () => {
    const { sandbox, restarts } = flakySandbox([false, true], 'error: cannot find symbol memo');

    const report = await restartServicesFor(sandbox, await projectWithDeletedMigration(), [deletedV2], undefined, { deletedFileRetryDelayMs: 1 });

    expect(restarts).toEqual(['api']);
    expect(report.restarted[0]).toMatchObject({ service: 'api', ready: false });
    expect(report.restarted[0]?.retried).toBeUndefined();
  });

  it('메모리 한도를 넘어 종료된 서비스는 원인을 먼저 알린다', async () => {
    const { sandbox } = flakySandbox([false], 'Killed');
    sandbox.stats = async () => [{ service: 'api', state: 'exited', exitCode: 137, oomKilled: true, memoryLimitBytes: 1536 * 1024 ** 2 }];

    const report = await restartServicesFor(sandbox, await projectWithDeletedMigration(), ['api/src/main/java/Order.java']);

    expect(report.restarted[0]).toMatchObject({ service: 'api', ready: false, oomKilled: true });
    expect(report.restarted[0]?.error).toMatch(/^메모리 한도 \(1\.50GiB\)를 넘어 종료됐습니다/);
  });

  it('재시작하는 동안 막힌 외부 접속을 중복 없이 보고한다', async () => {
    const { sandbox } = flakySandbox([false], 'Error when performing the request to https://registry.example.com/pnpm.tgz');
    const recent = new Date();
    let asked: Date | undefined;
    sandbox.egressDenials = async ({ since } = {}) => {
      asked = since;
      return [
        { host: 'registry.example.com', port: 443, reason: '허용 목록에 없는 호스트나 포트', at: recent },
        { host: 'registry.example.com', port: 443, reason: '허용 목록에 없는 호스트나 포트', at: recent },
      ];
    };

    const report = await restartServicesFor(sandbox, await projectWithDeletedMigration(), ['api/src/main/java/Order.java']);

    expect(report.restarted[0]?.blockedEgress).toEqual(['registry.example.com:443 (허용 목록에 없는 호스트나 포트)']);
    // 시계 차이를 감안해 재시작 직전보다 조금 이른 시점부터 묻는다
    expect(asked!.getTime()).toBeLessThan(recent.getTime());
    expect(formatVerificationReport({ ok: false, sync: { elapsedMs: 0 }, restarted: report.restarted, contracts: [], unverifiedFiles: [], secretLeaks: [] }, { allowBreaking: false })).toContain(
      '막힌 외부 접속 (studio.yaml network.egress에 없는 호스트): registry.example.com:443',
    );
  });

  it('바뀐 파일에 들어간 시크릿 값을 이름으로 찾고, 게이트 보고에 값은 넣지 않는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'secret-leak-'));
    await mkdir(path.join(root, 'api/src'), { recursive: true });
    await writeFile(path.join(root, 'api/src/PaymentClient.java'), 'class PaymentClient { String key = "sk_live_1234567890"; }\n');
    await writeFile(path.join(root, 'api/src/Order.java'), 'class Order { String key = System.getenv("PAYMENT_API_KEY"); }\n');
    const sandbox = { findSecrets: (text: string) => (text.includes('sk_live_1234567890') ? ['PAYMENT_API_KEY'] : []) } as unknown as Sandbox;

    const leaks = await findSecretLeaks(sandbox, root, ['api/src/PaymentClient.java', 'api/src/Order.java', 'api/src/Deleted.java']);

    expect(leaks).toEqual([{ file: 'api/src/PaymentClient.java', secrets: ['PAYMENT_API_KEY'] }]);
    const text = formatVerificationReport({ ok: false, sync: { elapsedMs: 0 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: leaks }, { allowBreaking: false });
    expect(text).toContain('시크릿 값이 파일에 들어갔습니다: api/src/PaymentClient.java (PAYMENT_API_KEY)');
    expect(text).not.toContain('sk_live_1234567890');
  });

  it('로그에 지운 파일 이름과 "없음" 오류가 함께 나올 때만 해당한다', () => {
    const deleted = ['api/src/main/resources/db/migration/V2__memo.sql'];
    expect(mentionsDeletedFile(['java.nio.file.NoSuchFileException: /app/src/main/resources/db/migration/V2__memo.sql'], deleted)).toBe(true);
    expect(mentionsDeletedFile(["stat: can't stat 'V2__memo.sql': No such file or directory"], deleted)).toBe(true);
    expect(mentionsDeletedFile(['Flyway migrated V2__memo.sql'], deleted)).toBe(false);
    expect(mentionsDeletedFile(['java.nio.file.NoSuchFileException: /app/other.sql'], deleted)).toBe(false);
  });
});

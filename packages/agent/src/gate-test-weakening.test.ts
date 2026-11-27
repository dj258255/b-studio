import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { VerificationGate, type GateOptions } from './gate';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import type { TestChangeEntry } from './workflow';
import { Workspace } from './workspace';

/**
 * 게이트가 시험 약화 검사(이슈 #1436)를 리뷰 단계에 끼우는 방식: 읽는 곳이 없으면 검사가 없고, 읽는 데 실패하면 통과가 아니라 실패이며,
 * 사람이 확인 변경을 허용했으면(allowCheckChanges) 통과로 바뀐다. 시험 파일을 읽는 git 쪽은 test-weakening.test.ts가 본다.
 */

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('gate-test-weakening-');
  await writeFile(path.join(project.root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  // 허용을 켠 게이트는 확인 선언을 디스크의 studio.yaml에서 다시 읽는다(YAML은 JSON을 받아들인다)
  await writeFile(
    path.join(project.root, 'studio.yaml'),
    JSON.stringify({
      version: 1,
      name: 'orders',
      services: {
        api: { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } },
        web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' },
      },
    }),
  );
});

async function run(options: { testChanges?: GateOptions['testChanges']; viaOutside?: boolean; allowCheckChanges?: boolean }) {
  const sandbox = fakeSandbox(project, [true, true, true]);
  const workspace = new Workspace(project.root);
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: 3,
    ...(options.allowCheckChanges ? { allowCheckChanges: true } : {}),
    ...(options.testChanges && !options.viaOutside ? { testChanges: options.testChanges } : {}),
    ...(options.testChanges && options.viaOutside ? { outsideChanges: { pendingFiles: async () => [], testChanges: options.testChanges } } : {}),
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: async () => ({ status: 200, text: '<h1>주문 목록</h1>' }),
    onEvent: () => {},
  });
  await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
  const outcome = await gate.check();
  return { outcome, check: gate.checks.find((entry) => entry.name === 'test-weakening') };
}

const deleted: TestChangeEntry[] = [{ status: 'D', path: 'web/cart.test.ts' }];

describe('시험 약화 검사의 게이트 연결', () => {
  it('읽는 곳을 받지 못한 호출부는 이 검사를 하지 않는다', async () => {
    const { outcome, check } = await run({});
    expect(outcome.kind).toBe('pass');
    expect(check).toBeUndefined();
  });

  it('지운 시험 파일이 있으면 리뷰 단계가 실패해 다시 하라고 돌려보낸다', async () => {
    const { outcome, check } = await run({ testChanges: async () => deleted });
    expect(outcome.kind).toBe('retry');
    expect(check).toMatchObject({ stage: 'review', ok: false });
    expect(check?.detail).toContain('web/cart.test.ts');
  });

  it('도구 밖 변경을 받는 길(outsideChanges)로 읽는 곳을 줘도 같다', async () => {
    const { outcome, check } = await run({ testChanges: async () => deleted, viaOutside: true });
    expect(outcome.kind).toBe('retry');
    expect(check?.ok).toBe(false);
  });

  it('변경 목록을 끝까지 읽지 못하면(던지면) 통과가 아니라 확인하지 못함으로 실패한다', async () => {
    const { outcome, check } = await run({
      testChanges: async () => {
        throw new Error('git diff 실패: 읽을 수 없습니다');
      },
    });
    expect(outcome.kind).toBe('retry');
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain('끝까지 확인하지 못했습니다(git diff 실패: 읽을 수 없습니다)');
  });

  it('읽는 데 쓰인 비밀 값은 가린다', async () => {
    const sandbox = fakeSandbox(project, [true, true, true]);
    sandbox.redact = (text: string) => text.replace('sk_live_123', '[가림]');
    const workspace = new Workspace(project.root);
    const gate = await VerificationGate.create({
      project,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      testChanges: async () => {
        throw new Error('경로 sk_live_123 실패');
      },
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher: async () => ({ status: 200, text: '<h1>주문 목록</h1>' }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await gate.check();
    const detail = gate.checks.find((entry) => entry.name === 'test-weakening')?.detail ?? '';
    expect(detail).toContain('[가림]');
    expect(detail).not.toContain('sk_live_123');
  });

  it('사람이 확인 변경을 허용했으면 통과하고 받아들인 것을 기록한다', async () => {
    const { outcome, check } = await run({ testChanges: async () => deleted, allowCheckChanges: true });
    expect(outcome.kind).toBe('pass');
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain('받아들였습니다');
  });

  it('허용이 있으면 읽지 못해도 막지 않는다', async () => {
    const { outcome, check } = await run({
      testChanges: async () => {
        throw new Error('실패');
      },
      allowCheckChanges: true,
    });
    expect(outcome.kind).toBe('pass');
    expect(check).toBeUndefined();
  });

  it('시험 파일을 건드리지 않은 변경은 검사를 남기지 않는다', async () => {
    const { outcome, check } = await run({ testChanges: async () => [{ status: 'M', path: 'api/src/Order.java' }] });
    expect(outcome.kind).toBe('pass');
    expect(check).toBeUndefined();
  });
});

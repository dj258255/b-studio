import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './loop';
import { ScriptedModelClient } from './scripted-client';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('loop-lazy-test-');
});

/** ensureSandbox 호출 횟수를 세는 콜백. 세션의 실제 기동 대신 이걸 넘긴다 */
function counter() {
  const state = { boots: 0 };
  return { state, ensureSandbox: async () => void (state.boots += 1) };
}

describe('샌드박스 지연 기동(ensureSandbox)', () => {
  it('읽기 도구만 쓰는 요청은 샌드박스를 끝까지 켜지 않는다', async () => {
    const { state, ensureSandbox } = counter();
    const result = await runAgent({
      request: 'Order.java를 읽고 설명해줘',
      project,
      sandbox: fakeSandbox(project, []),
      client: new ScriptedModelClient([{ toolCalls: [{ name: 'read_file', input: { path: 'api/src/Order.java' } }] }, { text: '읽었습니다.' }]),
      fetcher: async () => contract,
      ensureSandbox,
    });

    expect(result.status).toBe('done');
    expect(state.boots).toBe(0);
  });

  it('아무 도구도 쓰지 않는 답변은 게이트를 만들지 않아 검증 기록이 없다', async () => {
    const { state, ensureSandbox } = counter();
    const result = await runAgent({
      request: '이 프로젝트는 뭐야?',
      project,
      sandbox: fakeSandbox(project, []),
      client: new ScriptedModelClient([{ text: '주문 API 프로젝트입니다.' }]),
      fetcher: async () => contract,
      ensureSandbox,
    });

    expect(result).toMatchObject({ status: 'done', summary: '주문 API 프로젝트입니다.' });
    expect(state.boots).toBe(0);
    // 게이트를 만들지 않았으므로 검증 결과가 없다(샌드박스 없이 끝났다)
    expect(result.report).toBeUndefined();
  });

  it('샌드박스가 필요한 도구를 처음 부를 때 한 번만 켠다(같은 턴에 두 번 불러도 콜백은 두 번, 세션이 dedup)', async () => {
    const { state, ensureSandbox } = counter();
    const result = await runAgent({
      request: '컨테이너 상태를 봐줘',
      project,
      sandbox: fakeSandbox(project, []),
      client: new ScriptedModelClient([{ toolCalls: [{ name: 'service_stats', input: {} }] }, { text: '확인했습니다.' }]),
      fetcher: async () => contract,
      ensureSandbox,
    });

    expect(result.status).toBe('done');
    // ensureSandbox는 도구 실행 직전에 매번 불리지만, 실제 기동은 세션의 bootPromise가 한 번만 한다
    expect(state.boots).toBe(1);
  });

  it('첫 파일 변경 때도 샌드박스를 켜고, 그 뒤에 게이트가 돈다', async () => {
    const { state, ensureSandbox } = counter();
    const result = await runAgent({
      request: '새 클래스를 추가해줘',
      project,
      sandbox: fakeSandbox(project, [true]),
      client: new ScriptedModelClient([
        { toolCalls: [{ name: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }] },
        { text: '추가했습니다.' },
      ]),
      fetcher: async () => contract,
      ensureSandbox,
    });

    expect(state.boots).toBe(1);
    // 변경이 있으면 게이트가 만들어져 검증까지 돈다(체크포인트 단계 포함)
    expect(result.status).toBe('done');
    expect(result.report?.ok).toBe(true);
  });
});

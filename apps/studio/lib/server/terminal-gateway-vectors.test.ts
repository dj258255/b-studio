import { describe, expect, it } from 'vitest';
import { book, loadTable } from './frozen-vectors';
import { terminalHookRoutes, UNREADABLE_PRE_TOOL_DENY, UNREADABLE_PROMPT_BLOCK, type TerminalGatewayHandlers } from './terminal-gateway';

/**
 * 관문의 훅 답 꼴을 Rust로 옮기면서(4f C1 5단계) 옛 TS 구현이 낸 값을 `terminal-gateway-vectors.json`에 고정했다.
 * 같은 처리 결과·입력·본문 종류를 지금 구현에 주고 답(키 순서 포함 `JSON.stringify`)과 거절이 고정한 값과 같은지 견준다.
 */
const OLD = book(loadTable(new URL('./terminal-gateway-vectors.json', import.meta.url)));

interface Outcomes {
  note?: string;
  prompt?: { blocked?: string; note?: string };
  preTool?: { deny?: string; message?: string };
  stop?: { feedback?: string; message?: string };
  throwStop?: string;
}

function handlers(outcomes: Outcomes): TerminalGatewayHandlers {
  return {
    note: async () => outcomes.note,
    prompt: async () => outcomes.prompt ?? {},
    preTool: async () => outcomes.preTool ?? {},
    stop: async () => {
      if (outcomes.throwStop) throw new Error(outcomes.throwStop);
      return outcomes.stop ?? {};
    },
    sessionEnd: async () => {},
    stopFailure: async () => {},
    notification: async () => {},
    telemetry: async () => {},
    toolSpecs: () => [] as never,
    runTool: async () => ({ ok: true, content: '' }),
  };
}

type Result = { ok: true; text: string } | { ok: false; name: string; message: string };
async function observe(call: () => Promise<unknown>): Promise<Result> {
  try {
    return { ok: true, text: JSON.stringify(await call()) };
  } catch (error) {
    return { ok: false, name: (error as Error).name, message: (error as Error).message };
  }
}

const NASTY = ["'", '"', '$', '${x}', '`', '\\', '\n', '한글 😀 é', '--settings x', '']; 

const ROUTES = ['/ping', '/session-start', '/prompt', '/pre-tool', '/stop', '/session-end', '/stop-failure', '/notification', '/activity', '/statusline', '/v1/logs'] as const;
const META = [undefined, { body: 'object' }, { body: 'empty' }, { body: 'not_object' }, { body: 'invalid' }] as const;

describe('관문 훅 답: 옛 TS가 낸 값과 키 순서까지 같다', () => {
  it('읽지 못한 본문 거절 글도 같다', () => {
    expect(UNREADABLE_PRE_TOOL_DENY).toBe(OLD.get('UNREADABLE_PRE_TOOL_DENY'));
    expect(UNREADABLE_PROMPT_BLOCK).toBe(OLD.get('UNREADABLE_PROMPT_BLOCK'));
  });

  it('처리 결과와 본문 종류를 모두 바꿔도 같은 답·거절을 낸다', async () => {
    const outcomeSets: Outcomes[] = [
      {},
      { note: '안내', prompt: { note: '덧붙임' }, preTool: { message: '알림' }, stop: { message: '통과' } },
      { prompt: { blocked: '실행 중' }, preTool: { deny: '범위 밖' }, stop: { feedback: '검증 실패' } },
      // 빈 글은 거짓이다: 막지 않고 덧붙이지 않는다
      { note: '', prompt: { blocked: '', note: '' }, preTool: { deny: '', message: '' }, stop: { feedback: '', message: '' } },
      { prompt: { blocked: '막음', note: '덧붙임' }, stop: { feedback: '실패', message: '통과' } },
      { throwStop: '닫지 못했습니다' },
    ];
    let compared = 0;
    for (const [index, outcomes] of outcomeSets.entries()) {
      const now = terminalHookRoutes(handlers(outcomes));
      for (const route of ROUTES) {
        for (const meta of META) {
          const oldResult = OLD.get(`routes ${index} ${route} ${JSON.stringify(meta)}`);
          const newResult = await observe(() => now[route]({}, meta));
          expect({ route, meta, value: newResult }).toEqual({ route, meta, value: oldResult });
          compared += 1;
        }
      }
    }
    // 경로 표의 이름과 순서. 고정한 벡터 뒤에 감싸개의 exec 직전 검사 경로(`/startup-check`, #1475)가 더해졌다(옛 TS에는 없던 경로라 판정 벡터에는 없다)
    expect(Object.keys(terminalHookRoutes(handlers({})))).toEqual([...(OLD.get('route names') as string[]), '/startup-check']);
    expect(compared).toBe(outcomeSets.length * ROUTES.length * META.length);
  });

  it('거친 글자를 처리 결과에 넣어도 답이 같다', async () => {
    for (const [textIndex, text] of NASTY.entries()) {
      for (const [setIndex, outcomes] of [
        { note: text, stop: { message: text } },
        { prompt: { note: text }, preTool: { message: text } },
        { prompt: { blocked: text }, preTool: { deny: text }, stop: { feedback: text } },
      ].entries() as Iterable<[number, Outcomes]>) {
        const now = terminalHookRoutes(handlers(outcomes));
        for (const route of ['/session-start', '/prompt', '/pre-tool', '/stop'] as const) {
          for (const meta of META) {
            expect({ text, route, meta, value: await observe(() => now[route]({}, meta)) }).toEqual({ text, route, meta, value: OLD.get(`nasty ${textIndex} ${setIndex} ${route} ${JSON.stringify(meta)}`) });
          }
        }
      }
    }
  });

  it('대화 id는 텔레메트리·ping 말고 모든 훅에서 알리고, 기록이 던져도 답은 그대로다', async () => {
    const newSeen: string[] = [];
    const newRoutes = terminalHookRoutes({ ...handlers({}), conversation: (id: string) => void newSeen.push(id) });
    for (const route of [...ROUTES, '/ping', '/v1/logs'] as const) {
      await newRoutes[route]({ session_id: 'abc' });
    }
    expect(newSeen).toEqual(OLD.get('conversation seen'));

    // 기록이 던져도 답은 같다
    const throwing = (): TerminalGatewayHandlers => ({
      ...handlers({ stop: { feedback: '테스트 실패' } }),
      conversation: () => {
        throw new Error('저장 실패');
      },
    });
    expect(await terminalHookRoutes(throwing())['/stop']({ session_id: 'a1' })).toEqual(OLD.get('stop with throwing conversation'));
  });
});

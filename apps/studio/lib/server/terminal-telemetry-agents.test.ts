import { describe, expect, it } from 'vitest';
import { agentSignalsFromOtlp, apiRequestsFromOtlp } from './terminal-telemetry';

/**
 * 서브에이전트 신호(#843). 고정값은 2026-10-22에 진짜 CLI(Claude Code 2.1.308 `-p`, Codex 0.160.1 `exec` + multi_agent_v2)를
 * 가짜 모델 서버에 붙여 받은 OTLP 기록을 줄인 것이다
 */
const attr = (key: string, value: unknown): { key: string; value: unknown } => ({ key, value });
const str = (value: string) => ({ stringValue: value });
const int = (value: number | string) => ({ intValue: value });
const otlp = (records: unknown[]): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });

function claudeRequest(over: Array<{ key: string; value: unknown }>): unknown {
  return {
    timeUnixNano: '1750000000000000000',
    attributes: [
      attr('event.name', str('api_request')),
      attr('model', str('claude-sonnet-4-5')),
      attr('input_tokens', int('200')),
      attr('output_tokens', int('20')),
      attr('cache_read_tokens', int('0')),
      attr('cache_creation_tokens', int('0')),
      attr('request_id', str('req-sub')),
      ...over,
    ],
  };
}

function codexCompleted(conversation: string, input: number): unknown {
  return {
    timeUnixNano: '0',
    observedTimeUnixNano: '1750000000000000000',
    attributes: [
      attr('event.name', str('codex.sse_event')),
      attr('event.kind', str('response.completed')),
      attr('event.timestamp', str(`2026-10-22T08:02:2${input % 10}.000Z`)),
      attr('model', str('gpt-5.5')),
      attr('input_token_count', str(String(input))),
      attr('output_token_count', str('30')),
      attr('cached_token_count', str('100')),
      attr('conversation.id', str(conversation)),
    ],
  };
}

const MAIN = '01a162a1-cd00-7680-ba3a-542816c7e707';
const CHILD = '01a162a1-e79d-7c53-9d03-8ddf913abde1';

describe('apiRequestsFromOtlp — 서브에이전트 표시(#843)', () => {
  it('Claude: agent.name이 있으면 그 서브에이전트 종류를 싣고, 메인 요청(query_source sdk·repl_main_thread)에는 싣지 않는다', () => {
    const [sub, main, repl] = apiRequestsFromOtlp(
      otlp([
        claudeRequest([attr('query_source', str('agent:builtin:general-purpose')), attr('agent.name', str('general-purpose'))]),
        claudeRequest([attr('query_source', str('sdk')), attr('request_id', str('req-main'))]),
        claudeRequest([attr('query_source', str('repl_main_thread')), attr('request_id', str('req-repl'))]),
      ]),
    );
    expect(sub?.agent).toBe('general-purpose');
    expect(main?.agent).toBeUndefined();
    expect(repl?.agent).toBeUndefined();
  });

  it('Claude: agent.name이 없어도 query_source가 agent:<출처>:<이름>이면 그 이름을 쓴다. 이상한 값은 버린다', () => {
    const [named, odd] = apiRequestsFromOtlp(
      otlp([claudeRequest([attr('query_source', str('agent:custom:Explore'))]), claudeRequest([attr('query_source', str('agent:')), attr('request_id', str('req-2'))])]),
    );
    expect(named?.agent).toBe('Explore');
    expect(odd?.agent).toBeUndefined();
  });

  it('Codex: 응답 기록의 conversation.id를 대화 id로 싣는다(메인과 하위 에이전트가 다르다)', () => {
    const [main, child] = apiRequestsFromOtlp(otlp([codexCompleted(MAIN, 1000), codexCompleted(CHILD, 300)]));
    expect(main?.conversationId).toBe(MAIN);
    expect(child?.conversationId).toBe(CHILD);
    expect(child?.agent).toBeUndefined();
  });
});

describe('agentSignalsFromOtlp (#843)', () => {
  it('Claude: subagent_completed는 그 종류의 서브에이전트 하나가 끝났다는 신호다(도구 횟수 포함)', () => {
    const signals = agentSignalsFromOtlp(
      otlp([
        {
          attributes: [
            attr('event.name', str('subagent_completed')),
            attr('agent_type', str('general-purpose')),
            attr('total_tool_uses', str('1')),
            attr('total_tokens', str('330')),
            attr('model', str('claude-sonnet-4-5')),
          ],
        },
      ]),
    );
    expect(signals).toEqual([{ kind: 'subagent-done', agent: 'general-purpose', toolUses: 1 }]);
  });

  it('Codex: agent_communication의 spawn은 부모→자식 대화를, result는 자식이 끝났음을 알린다. 맡긴 글은 한 줄로 줄인다', () => {
    const signals = agentSignalsFromOtlp(
      otlp([
        {
          attributes: [
            attr('event.name', str('codex.agent_communication')),
            attr('kind', str('spawn')),
            attr('state', str('send')),
            attr('sender_thread_id', str(MAIN)),
            attr('receiver_thread_id', str(CHILD)),
            attr('content', str(`SUBTASK-PING answer pong\n둘째 줄 ${'x'.repeat(300)}`)),
          ],
        },
        {
          attributes: [
            attr('event.name', str('codex.agent_communication')),
            attr('kind', str('result')),
            attr('state', str('send')),
            attr('sender_thread_id', str(CHILD)),
            attr('receiver_thread_id', str(MAIN)),
            attr('content', str('[plaintext]')),
          ],
        },
      ]),
    );
    expect(signals).toEqual([
      { kind: 'spawn', parent: MAIN, child: CHILD, task: 'SUBTASK-PING answer pong' },
      { kind: 'result', child: CHILD },
    ]);
  });

  it('Codex: spawn_agent의 tool_result는 붙인 이름을, 다른 tool_result는 그 대화의 도구 활동을 알린다', () => {
    const tool = (name: string, conversation: string, output: string, agentName: string) => ({
      attributes: [
        attr('event.name', str('codex.tool_result')),
        attr('tool_name', str(name)),
        attr('tool_namespace', str('collaboration')),
        attr('success', str('true')),
        attr('agent_name', str(agentName)),
        attr('output', str(output)),
        attr('conversation.id', str(conversation)),
      ],
    });
    const signals = agentSignalsFromOtlp(otlp([tool('spawn_agent', MAIN, '{"task_name":"/root/ping_sub"}', '/root'), tool('exec_command', CHILD, '...', '/root/ping_sub')]));
    expect(signals).toEqual([
      { kind: 'spawned-name', parent: MAIN, name: '/root/ping_sub' },
      { kind: 'tool', conversation: CHILD, tool: 'exec_command' },
    ]);
  });

  it('모양이 틀린 기록·모르는 이벤트·빈 값은 건너뛰고, 한 본문에서 1,000개까지만 꺼낸다', () => {
    expect(agentSignalsFromOtlp(null)).toEqual([]);
    expect(agentSignalsFromOtlp(otlp([{ attributes: [attr('event.name', str('codex.agent_communication')), attr('kind', str('spawn'))] }]))).toEqual([]);
    expect(agentSignalsFromOtlp(otlp([{ attributes: [attr('event.name', str('subagent_completed'))] }]))).toEqual([]);
    const many = Array.from({ length: 1_200 }, () => ({ attributes: [attr('event.name', str('subagent_completed')), attr('agent_type', str('Explore'))] }));
    expect(agentSignalsFromOtlp(otlp(many))).toHaveLength(1_000);
  });
});

import { styleText } from 'node:util';
import { AnthropicModelClient, runAgent, type AgentEvent, type AgentUsage, type Effort } from '@b-studio/agent';
import type { LoadedProject } from '@b-studio/spec';
import { runSandboxSession } from '../session';
import { print, type Label } from '../ui';

export interface AgentCommandOptions {
  keep: boolean;
  logs: boolean;
  allowBreaking: boolean;
  model?: string;
  effort?: Effort;
}

/** 샌드박스를 띄우고 요청을 에이전트에게 맡긴다. 검증 게이트를 통과해야 종료 코드 0 */
export async function agent(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const client = new AnthropicModelClient({ model: options.model, effort: options.effort });

  // 샌드박스는 수십 초가 걸리므로 인증 문제는 먼저 드러낸다
  const preflight = await client.preflight();
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: ${client.model} (effort ${client.effort})`);
    const result = await runAgent({
      request,
      project,
      sandbox,
      client,
      allowBreaking: options.allowBreaking,
      signal,
      onEvent: printAgentEvent(label),
    });
    return result.status === 'done' ? 0 : 1;
  });
}

function printAgentEvent(label: Label) {
  return (event: AgentEvent) => {
    switch (event.type) {
      case 'turn':
        break;
      case 'text':
        print(label('agent'), event.text);
        break;
      case 'tool_call':
        print(label('agent'), styleText('dim', `→ ${event.name} ${summarizeInput(event.input)}`));
        break;
      case 'tool_result':
        if (!event.ok) print(label('agent'), styleText('yellow', `✗ ${event.name}: ${event.content.split('\n')[0]}`));
        break;
      case 'verify_start':
        print(label('studio'), `검증 게이트: 파일 ${event.files.length}개 → 서비스 재시작, 준비 판정, 계약 비교`);
        break;
      case 'verify_result':
        print(label('studio'), styleText(event.report.ok ? 'green' : 'red', event.text));
        break;
      case 'done':
        print(label('studio'), styleText('green', `완료 · ${event.result.turns}턴 · ${formatUsage(event.result.usage)}`));
        break;
      case 'failed':
        print(label('studio'), styleText('red', `실패: ${event.result.summary} · ${event.result.turns}턴 · ${formatUsage(event.result.usage)}`));
        break;
    }
  };
}

function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const args = input as Record<string, unknown>;
  if (Array.isArray(args.command)) return `${args.service} $ ${args.command.join(' ')}`;
  if (typeof args.method === 'string') return `${args.service} ${args.method} ${args.path}`;
  return [args.path, args.service].filter((value) => typeof value === 'string').join(' ');
}

function formatUsage(usage: AgentUsage): string {
  return `입력 ${usage.inputTokens} · 출력 ${usage.outputTokens} · 캐시 읽기 ${usage.cacheReadTokens} · 캐시 쓰기 ${usage.cacheWriteTokens} 토큰`;
}

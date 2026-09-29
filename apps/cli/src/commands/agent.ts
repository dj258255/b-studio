import { styleText } from 'node:util';
import {
  AnthropicModelClient,
  describeAccount,
  listCommandCodeModels,
  listOpenCodeModels,
  preflightClaudeCode,
  preflightCodex,
  preflightCommandCode,
  preflightOpenCode,
  runAgent,
  runClaudeCodeAgent,
  runCodexAgent,
  runCommandCodeAgent,
  runOpenCodeAgent,
  OPENCODE_MODEL_REQUIRED,
  type AgentEvent,
  type AgentUsage,
  type Effort,
} from '@b-studio/agent';
import type { LoadedProject } from '@b-studio/spec';
import { runSandboxSession } from '../session';
import { print, type Label } from '../ui';

export type Backend = 'api' | 'claude-code' | 'codex' | 'commandcode' | 'opencode';

/** `--backend`로 고를 수 있는 실행 방식 */
export const BACKENDS: readonly Backend[] = ['api', 'claude-code', 'codex', 'commandcode', 'opencode'];

export interface AgentCommandOptions {
  keep: boolean;
  logs: boolean;
  allowBreaking: boolean;
  backend: Backend;
  model?: string;
  effort?: Effort;
  /** commandcode·opencode 모드에서 무료 모델만 쓰도록 강제한다. 무료가 아닌 --model이면 거부한다 */
  freeOnly?: boolean;
}

/** 샌드박스를 띄우고 요청을 에이전트에게 맡긴다. 검증 게이트를 통과해야 종료 코드 0 */
export async function agent(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  if (options.backend === 'claude-code') return withClaudeCode(project, request, options);
  if (options.backend === 'codex') return withCodex(project, request, options);
  if (options.backend === 'commandcode') return withCommandCode(project, request, options);
  if (options.backend === 'opencode') return withOpenCode(project, request, options);
  return withApi(project, request, options);
}

/**
 * `--free-only`에서 고른 모델이 무료가 아니거나 지금 쓸 수 없으면 오류 문구를 돌려준다.
 * 목록에 없어 확인할 수 없으면 통과시킨다. commandcode·opencode 모델이 같은 모양이라 함께 받는다(`usable`은 opencode만 있다).
 */
export function freeOnlyViolation(model: string, models: readonly { id: string; free: boolean; usable?: boolean; reason?: string }[]): string | undefined {
  const found = models.find((candidate) => candidate.id === model);
  if (!found) return undefined;
  if (!found.free) return `--free-only: ${model}은(는) 무료 모델이 아닙니다`;
  if (found.usable === false) return `--free-only: ${model}은(는) 지금 쓸 수 없습니다${found.reason ? `: ${found.reason}` : ''}`;
  return undefined;
}

async function withApi(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const client = new AnthropicModelClient({ model: options.model, effort: options.effort });

  // 샌드박스는 수십 초가 걸리므로 인증 문제는 먼저 드러낸다
  const preflight = await client.preflight();
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: Claude API ${client.model} (effort ${client.effort})`);
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

async function withClaudeCode(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const preflight = await preflightClaudeCode({ cwd: project.root });
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: 로컬 Claude Agent (${describeAccount(preflight.account)})`);
    const result = await runClaudeCodeAgent({
      request,
      project,
      sandbox,
      model: options.model,
      effort: options.effort,
      account: preflight.account,
      allowBreaking: options.allowBreaking,
      signal,
      onEvent: printAgentEvent(label),
    });
    return result.status === 'done' ? 0 : 1;
  });
}

/**
 * 이 PC의 Codex CLI에 ChatGPT로 로그인한 계정으로 실행한다.
 * 한 번 실행이라 이어받을 대화가 없다. 스튜디오 모드와 달리 이전 요청 맥락도 넘기지 않는다.
 */
async function withCodex(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const preflight = await preflightCodex();
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: 로컬 ChatGPT Agent${options.model ? ` (${options.model})` : ' (계정 기본 모델)'}`);
    const result = await runCodexAgent({
      request,
      project,
      sandbox,
      model: options.model,
      effort: options.effort,
      allowBreaking: options.allowBreaking,
      signal,
      onEvent: printAgentEvent(label),
    });
    return result.status === 'done' ? 0 : 1;
  });
}

/**
 * 이 PC에 로그인한 Command Code CLI로 실행한다. 모델을 고를 수 있고, --free-only면 무료 모델만 쓴다.
 * 모델을 주지 않으면 계정 기본 모델(보통 DeepSeek)을 쓴다. 한 번 실행이라 이어받을 대화가 없어 맥락도 넘기지 않는다.
 */
async function withCommandCode(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const preflight = await preflightCommandCode();
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  if (options.freeOnly && options.model) {
    const violation = freeOnlyViolation(options.model, await listCommandCodeModels().catch(() => []));
    if (violation) {
      console.error(violation);
      return 2;
    }
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: 로컬 Command Code Agent${options.model ? ` (${options.model})` : ' (계정 기본 모델)'}`);
    const result = await runCommandCodeAgent({
      request,
      project,
      sandbox,
      model: options.model,
      allowBreaking: options.allowBreaking,
      signal,
      onEvent: printAgentEvent(label),
    });
    return result.status === 'done' ? 0 : 1;
  });
}

/**
 * 이 PC에 설치된 OpenCode CLI로 실행한다. `--model`이 필수다(기본 모델을 추측하지 않는다 — 무료 Zen 모델은 b-studio 구성에서 거절된다).
 * `--free-only`면 무료이면서 쓸 수 있는 모델만 쓴다. 한 번 실행이라 이어받을 대화가 없어 맥락도 넘기지 않는다.
 */
async function withOpenCode(project: LoadedProject, request: string, options: AgentCommandOptions): Promise<number> {
  const preflight = await preflightOpenCode();
  if (!preflight.ok) {
    console.error(preflight.reason);
    return 2;
  }

  const model = options.model?.trim();
  if (!model) {
    console.error(OPENCODE_MODEL_REQUIRED);
    return 2;
  }

  if (options.freeOnly) {
    const violation = freeOnlyViolation(model, await listOpenCodeModels().catch(() => []));
    if (violation) {
      console.error(violation);
      return 2;
    }
  }

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    print(label('studio'), `에이전트 시작: 로컬 OpenCode Agent (${model})`);
    const result = await runOpenCodeAgent({
      request,
      project,
      sandbox,
      model,
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
      case 'session':
        print(label('agent'), styleText('dim', `${event.backend}에서 ${event.model} 모델로 실행합니다`));
        break;
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
      case 'policy':
        print(label('policy'), styleText(event.decision === 'allow' ? 'dim' : 'yellow', `${event.decision === 'allow' ? '허용' : '차단'} · ${event.tool}${event.reason ? ` · ${event.reason}` : ''}`));
        break;
      case 'stage':
        print(label('studio'), styleText('dim', `작업 단계 · ${stageLabel(event.stage)}`));
        break;
      case 'workflow_check':
        print(
          label('studio'),
          styleText(event.check.ok ? 'green' : 'red', `${stageLabel(event.check.stage)} · ${event.check.name} · ${event.check.ok ? '통과' : '실패'}${event.check.attempts > 1 ? ` (시도 ${event.check.attempts}회)` : ''}`),
        );
        if (!event.check.ok && event.check.detail) print(label('studio'), styleText('dim', event.check.detail.split('\n').slice(0, 8).join('\n')));
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

function stageLabel(stage: string): string {
  return (
    {
      plan: '계획',
      implement: '구현',
      run: '실행',
      browser_check: '브라우저 확인',
      contract_check: 'API 계약 확인',
      test: '테스트',
      concurrency_check: '동시 요청 확인',
      review: '리뷰',
      checkpoint: '체크포인트',
    } as Record<string, string>
  )[stage] ?? stage;
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

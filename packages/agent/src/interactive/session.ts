import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../loop';
import { createHookRunner, type HookRunner } from './hooks';
import { InputParser } from './input';
import { loadSettings, parseArgs, type InteractiveSettings } from './settings';
import { computeCost, sendApiRequest, type Pricing } from './telemetry';
import { createTools, type InteractiveTools } from './tools';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** 요청 하나에서 모델을 부르는 횟수의 상한(끝나지 않는 도구 호출 반복을 끊는다) */
export const MAX_MODEL_CALLS_PER_REQUEST = 50;

export interface InteractiveSessionOptions {
  /** claude CLI와 같은 인자: `--settings <파일>`, `--mcp-config <값…>`(지금은 무시), `--model <id>`, 마지막 위치 인자는 첫 요청 */
  args: string[];
  cwd: string;
  client: ModelClient;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: NodeJS.WritableStream;
  /** 없으면 비용을 보내지 않는다(0이 아니라 칸이 없다) */
  pricing?: Pricing;
  system?: string;
  signal?: AbortSignal;
  /** 훅 명령의 환경(기본은 process.env). 설정의 env가 위에 덮인다 */
  env?: NodeJS.ProcessEnv;
  maxModelCalls?: number;
}

export function defaultSystemPrompt(cwd: string): string {
  return [
    `당신은 터미널에서 코드를 고치는 에이전트입니다. 작업 폴더는 ${cwd} 입니다.`,
    '도구(Read, Write, Edit, Glob, Grep)는 작업 폴더 안에서만 동작합니다. 밖의 경로나 링크로 나가는 경로는 거절됩니다.',
    '요청한 일을 끝내면 한 일을 짧게 알리고 도구 호출 없이 답하세요.',
  ].join('\n');
}

const textOf = (message: BetaMessage): string =>
  message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

const clip = (value: string, max = 120): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/**
 * 대화형 에이전트 한 세션. 서버에는 claude CLI처럼 보인다: 같은 설정 파일의 훅을 같은 입력 모양으로 부르고,
 * 터미널 stdin의 붙여 넣기+Enter(또는 마지막 위치 인자)를 요청으로 받고, 모델을 부를 때마다 OTLP api_request를 보낸다.
 * stdin이 끝나면 하던 요청을 마치고 돌려준다(signal이 끊기면 바로)
 */
export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  const { cwd, client, stdin, stdout } = options;
  const parsed = parseArgs(options.args);
  const settings: InteractiveSettings = loadSettings(parsed.settingsFile);
  const hooks: HookRunner = createHookRunner({ settings, cwd, sessionId: 'conversation-1', env: options.env });
  const tools: InteractiveTools = createTools(cwd);
  const system = options.system ?? defaultSystemPrompt(cwd);
  const maxCalls = options.maxModelCalls ?? MAX_MODEL_CALLS_PER_REQUEST;
  const messages: BetaMessageParam[] = [];
  let toolCount = 0;
  const print = (text: string) => void stdout.write(`${text}\n`);
  const aborted = () => options.signal?.aborted === true;

  async function handleRequest(prompt: string): Promise<void> {
    const submit = await hooks.call('UserPromptSubmit', { prompt });
    if (submit.decision === 'block') {
      print(`요청이 막혔습니다: ${typeof submit.reason === 'string' ? submit.reason : '(사유 없음)'}`);
      return;
    }
    messages.push({ role: 'user', content: prompt });
    let stopActive = false;
    for (let call = 0; ; call++) {
      if (aborted()) return;
      if (call >= maxCalls) {
        print(`모델 호출이 요청 하나의 상한(${maxCalls}회)에 닿아 멈춥니다`);
        return;
      }
      const startedAt = Date.now();
      let message: BetaMessage;
      try {
        message = await client.createMessage({ system, tools: tools.definitions, messages: [...messages] }, options.signal);
      } catch (error) {
        print(`모델 호출에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const input = message.usage?.input_tokens ?? 0;
      const output = message.usage?.output_tokens ?? 0;
      // 텔레메트리는 이 호출의 도구 훅보다 먼저 보낸다(서버는 텔레메트리 없이 쓰기 훅이 많으면 쓰기를 막는다). 실패해도 루프는 계속된다
      await sendApiRequest(settings, {
        requestId: message.id,
        model: parsed.model ?? message.model,
        input,
        output,
        cacheRead: message.usage?.cache_read_input_tokens ?? 0,
        cacheCreation: message.usage?.cache_creation_input_tokens ?? 0,
        costUsd: computeCost(options.pricing, input, output),
        durationMs: Date.now() - startedAt,
      }).catch(() => undefined);
      messages.push({ role: 'assistant', content: message.content as BetaMessageParam['content'] });
      const text = textOf(message);
      if (text) print(text);

      const toolUses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (toolUses.length > 0) {
        const results: BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const toolInput = (typeof use.input === 'object' && use.input !== null ? use.input : {}) as Record<string, unknown>;
          const hookInput = tools.hookInput(use.name, toolInput);
          const answer = await hooks.call('PreToolUse', { tool_name: use.name, tool_input: hookInput, tool_use_id: `toolu_${++toolCount}` });
          if (answer.hookSpecificOutput?.permissionDecision === 'deny') {
            const reason = answer.hookSpecificOutput.permissionDecisionReason ?? '거절됨';
            print(`  ${use.name} 거절: ${clip(reason)}`);
            results.push({ type: 'tool_result', tool_use_id: use.id, content: reason, is_error: true });
            continue;
          }
          // 훅에는 절대 경로로 풀어 알렸지만 실행은 모델이 준 입력을 작업 폴더 기준으로 다시 풀어 가둔다
          const outcome = await tools.execute(use.name, toolInput);
          print(`  ${use.name}${typeof toolInput.file_path === 'string' ? ` ${toolInput.file_path}` : ''}${outcome.isError ? ` 실패: ${clip(outcome.text)}` : ''}`);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.text, is_error: outcome.isError || undefined });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const stop = await hooks.call('Stop', { stop_hook_active: stopActive, last_assistant_message: text });
      if (stop.decision !== 'block') return;
      // 훅이 막으면 그 까닭을 모델에게 돌려주고 이어서 일하게 한다
      stopActive = true;
      messages.push({ role: 'user', content: typeof stop.reason === 'string' && stop.reason ? stop.reason : '끝내기 전에 더 확인해 주세요.' });
    }
  }

  // 요청은 하나씩 차례로 처리한다
  let chain: Promise<void> = Promise.resolve();
  const queue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch((error) => print(`오류: ${error instanceof Error ? error.message : String(error)}`));
  };

  print('대화형 에이전트가 준비됐습니다');
  queue(async () => void (await hooks.call('SessionStart', { source: 'startup' })));
  if (parsed.firstRequest) {
    const first = parsed.firstRequest;
    queue(() => handleRequest(first));
  }

  if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  const parser = new InputParser();
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    stdin.on('data', (chunk: string | Buffer) => {
      for (const request of parser.feed(String(chunk))) queue(() => handleRequest(request));
    });
    stdin.on('end', finish);
    stdin.on('close', finish);
    if (options.signal) {
      if (options.signal.aborted) finish();
      else options.signal.addEventListener('abort', finish, { once: true });
    }
  });
  await chain;
}

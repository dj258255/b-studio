import type Anthropic from '@anthropic-ai/sdk';
import { encodeNative } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { higherCliTier, nextCliTier, routeCliTier, tierLabel, type CliTier } from './cli-router';
import { clearedToolResultNote, clearOldToolResults, contextClearingFromEnv, isClearedToolResult, resolveContextClearing } from './context-clearing';
import {
  aggregateModelStats,
  classifyComplexity,
  classifyRisk,
  classifyTask,
  estimateCost,
  estimateTokens,
  routeModel,
  validateModelProfiles,
  type ModelCapability,
  type ModelProfile,
  type ModelStats,
  type RouteRequest,
  type RoutingDecision,
} from './model-router';
import { clipCommandOutput, clipText, isHtmlContent, isRepeatNote, repeatNote, visibleHtml } from './tool-output';

// Node 20+의 String.prototype.toWellFormed·isWellFormed(이 패키지의 lib 설정에는 아직 없다)
declare global {
  interface String {
    toWellFormed(): string;
    isWellFormed(): boolean;
  }
}

/**
 * 토큰 예산·모델 선택(tool-output·context-clearing·model-router·cli-router)을 Rust로 옮기면서(ADR-191 3f) 옛 TS 구현을 아래 `legacy`에
 * 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자(키 순서·NaN·-0 포함)로 견준다. `legacy`는 옮기기 전
 * 네 파일의 본문이다(`export`와 `import`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 의도한 차이는 두 가지만 맞춰 견준다: 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 결과도 `toWellFormed`로 같게 맞춘다),
 * 그리고 `Object.prototype` 이름의 모델 id(`constructor` 등)는 입력에 넣지 않는다(옛 구현은 그 id에서 프로토타입을 오염시켰다. 벡터 시험이 다룬다).
 *
 * 크기는 환경 변수로 바꾼다: BUDGET_ROUTING_DIFF_SEEDS(쉼표 목록), BUDGET_ROUTING_DIFF_ITERATIONS, BUDGET_ROUTING_DIFF_REPORT=1(분포 출력)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Anthropic = Anthropic;
const legacy = (() => {
    // ===== 옛 tool-output.ts =====
  /**
   * 도구 결과 예산과 자르기를 한 곳에 모은 순수 함수들.
   *
   * E2 실행 8회의 세션 기록에서 도구 결과가 토큰 누수의 대부분이었다(run_in_service 70%·http_request 14%·read_file 11%).
   * 결과는 실행이 끝날 때까지 컨텍스트에 남아 뒤 턴마다 캐시 읽기로 다시 계산되므로, 결과 본문을 줄이는 것이 곧 비용을 줄인다.
   * 여기서는 자르기 규칙만 정의하고, 실제 적용은 tools.ts가 한다(테스트가 쉽도록 순수 함수로 둔다).
   */

  /**
   * 명령 출력(stdout+stderr 합) 예산. 가장 큰 누수원(run_in_service)이라 가장 작게 둔다.
   * 테스트·빌드 로그의 실패 요약은 **뒤**에 있으므로(clipCommandOutput) 뒤쪽을 더 남긴다.
   */
  const COMMAND_OUTPUT_BUDGET = 6_000;
  /** HTTP 응답 본문 예산. HTML이면 태그를 벗긴 "보이는 글자" 기준으로 이 값을 적용한다(http_request 14%) */
  const HTTP_BODY_BUDGET = 4_000;
  /** read_file 예산. 파일은 앞에서부터 읽는 경우가 많아 앞쪽 위주로 남긴다(기존 30,000에서 줄임) */
  const READ_FILE_BUDGET = 12_000;
  /** service_logs는 줄 수 상한(1-400)을 그대로 두고, 글자 상한만 지금 값을 유지한다 */
  const LOGS_OUTPUT_LIMIT = 30_000;

  /**
   * 에이전트의 자가 확인 범위. full은 지금과 같고, lean은 게이트가 어차피 하는 확인(전체 빌드·테스트, 끝난 변경의 재시작·HTTP 확인)을
   * 에이전트가 되풀이하지 않게 안내하고, 성공한 명령의 출력을 짧게 돌려준다.
   * E6에서 b-studio의 호출은 그냥 Claude Code의 3.4배였고, 문맥 합의 32.7%가 run_in_service 결과를 다시 읽은 양이었다.
   */
  type SelfCheckMode = 'full' | 'lean';

  /** lean에서 성공한(종료 코드 0) 명령 출력 예산. 성공 로그는 대개 "통과"만 알면 되므로 끝부분 위주로 짧게 남긴다 */
  const LEAN_SUCCESS_OUTPUT_BUDGET = 800;

  /** 자른 사실을 숨기지 않고 한 줄로 알린다 */
  function clipNote(total: number, omitted: number, hint?: string): string {
    return `[... 전체 ${total}자 중 ${omitted}자 생략${hint ? `. ${hint}` : ''} ...]`;
  }

  /**
   * 명령 출력은 뒤쪽 위주로 남긴다(앞 25%·뒤 75%). 긴 테스트·빌드 로그의 실패 요약이 뒤에 있기 때문이다.
   * gzip처럼 스트림이 이상해도 안전하도록 코드 유닛이 아니라 UTF-16 슬라이스로 자른다(서로게이트 페어가 갈라질 수 있음은 감수).
   */
  function clipCommandOutput(text: string, budget: number = COMMAND_OUTPUT_BUDGET): string {
    if (text.length <= budget) return text;
    const head = Math.floor(budget * 0.25);
    const tail = budget - head;
    return `${text.slice(0, head)}\n${clipNote(text.length, text.length - budget, '필요하면 grep·tail로 좁혀 다시 실행')}\n${text.slice(-tail)}`;
  }

  /** 파일 등 일반 글은 앞쪽 위주로 남긴다(앞 80%·뒤 20%). 처음부터 읽는 경우가 많다 */
  function clipText(text: string, budget: number, hint?: string): string {
    if (text.length <= budget) return text;
    const head = Math.floor(budget * 0.8);
    const tail = budget - head;
    return `${text.slice(0, head)}\n${clipNote(text.length, text.length - budget, hint)}\n${text.slice(-tail)}`;
  }

  /**
   * HTML에서 보이는 글자만 남긴다. `<script>`·`<style>`·`<noscript>`와 주석을 **먼저 통째로** 지워
   * 스크립트 안의 `<`가 태그로 해석되지 않게 한다(개발 서버 페이지의 스크립트가 13,430자였다).
   * 그다음 나머지 태그를 벗기고, 기본 엔티티를 풀고, 공백을 정리한다. `<title>` 글자는 태그만 벗겨 남는다.
   */
  function visibleHtml(html: string): string {
    return html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      // &amp;는 마지막에 푼다. 먼저 풀면 &amp;lt;가 <로 잘못 풀린다
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** HTML인지 판별한다. content-type이 우선이고, 없으면 문서 시작으로 본다 */
  function isHtmlContent(contentType: string | undefined, text: string): boolean {
    if (contentType && /(text\/html|application\/xhtml\+xml)/i.test(contentType)) return true;
    return /^\s*(<!doctype html|<html[\s>])/i.test(text);
  }

  /** 반복 결과 대체 문구의 접두어. token-report가 이 문구로 "같은 결과 반복"을 센다 */
  const REPEAT_NOTE_PREFIX = '(앞의 ';

  /** 앞선 같은 호출의 결과와 같을 때 본문 대신 돌려주는 문구 */
  function repeatNote(call: number): string {
    return `${REPEAT_NOTE_PREFIX}${call}번째 호출 결과와 같습니다)`;
  }

  /** 어떤 결과가 반복 대체 문구인지 */
  function isRepeatNote(text: string): boolean {
    return text.startsWith(REPEAT_NOTE_PREFIX) && text.endsWith('번째 호출 결과와 같습니다)');
  }

  /**
   * 실행 단위 도구 결과 캐시. 한 실행(runAgent 한 번) 안에서 같은 도구·같은 입력의 결과가 앞과 완전히 같으면
   * 본문 대신 "(앞의 N번째 호출 결과와 같습니다)"를 돌려 결과 글자를 줄인다. 러너가 실행마다 새로 만든다.
   */
  interface ToolResultCache {
    /** `도구이름\u0000입력` → 앞선 호출의 본문과 순번 */
    entries: Map<string, { content: string; call: number }>;
    /** 이 실행에서 지금까지 실행한 도구 호출 수 */
    calls: number;
  }

  function createToolResultCache(): ToolResultCache {
    return { entries: new Map(), calls: 0 };
  }

  /** 같은 도구·같은 입력의 결과가 앞과 완전히 같으면 본문 대신 참조를 돌려준다. 돌려준 값이 모델에게 간다 */
  function dedupeResult(cache: ToolResultCache, name: string, input: unknown, content: string): string {
    cache.calls += 1;
    const key = `${name}\u0000${stableKey(input)}`;
    const previous = cache.entries.get(key);
    if (previous && previous.content === content) return repeatNote(previous.call);
    cache.entries.set(key, { content, call: cache.calls });
    return content;
  }

  /** 쓰기 도구가 성공하면 읽기 도구(read_file·read_lines·search_files·list_files) 캐시를 비운다. 같은 경로를 다시 읽으면 내용이 달라졌을 수 있다 */
  function invalidateReadCache(cache: ToolResultCache): void {
    for (const key of cache.entries.keys()) {
      const name = key.slice(0, key.indexOf('\u0000'));
      if (name === 'read_file' || name === 'read_lines' || name === 'search_files' || name === 'list_files') cache.entries.delete(key);
    }
  }

  /** 입력 객체의 키 순서가 달라도 같은 키가 되도록 정렬해 직렬화한다 */
  function stableKey(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? String(value);
  }

    // ===== 옛 context-clearing.ts =====
  /**
   * 컨텍스트가 커지면 오래된 도구 결과를 **묶어서** 비우는 순수 함수.
   *
   * 도구 결과는 실행이 끝날 때까지 대화에 남아 뒤 턴마다 캐시 읽기로 다시 계산된다. 그런데 앞 메시지를 바꾸면
   * 그 지점부터 프롬프트 캐시가 깨진다(다시 쓰기 비용). 그래서 매 턴 조금씩 지우지 않고, 임계치를 넘을 때
   * **한 번에 묶어서** 비운다. Anthropic의 context editing(`clear_tool_uses`·`clear_at_least`)과 같은 발상이다.
   *
   * 여기서는 규칙만 정의하고 실제 적용은 loop.ts가 한다(테스트가 쉽도록 순수 함수로 둔다).
   * Claude Code·Codex 러너는 대화를 직접 다루지 않는다(각 CLI가 자체 압축을 한다). 이번 범위 밖이다.
   */

  type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

  interface ContextClearingPolicy {
    /** 직전 턴의 컨텍스트(input+cache_read+cache_write)가 이 토큰 수 이상이면 비운다 */
    triggerTokens: number;
    /** 최근 도구 결과 N개는 남긴다 */
    keepRecent: number;
    /** 한 번에 최소 이만큼(글자) 줄지 않으면 비우지 않는다. 캐시를 깨면서 얻는 것이 없으면 그대로 둔다 */
    clearAtLeastChars: number;
  }

  /** 기본 정책. 임계치는 작은 모델 컨텍스트의 20% 남짓(60k)으로 잡았다 */
  const DEFAULT_CONTEXT_CLEARING: ContextClearingPolicy = { triggerTokens: 60_000, keepRecent: 4, clearAtLeastChars: 20_000 };

  /** 비운 자리에 남기는 표시의 접두어. 이 문구로 시작하면 이미 비운 것으로 본다 */
  const CLEARED_TOOL_RESULT_PREFIX = '[이전 도구 결과 생략: ';

  /** 비운 자리에 남기는 문구 */
  function clearedToolResultNote(chars: number): string {
    return `${CLEARED_TOOL_RESULT_PREFIX}${chars.toLocaleString('ko-KR')}자. 필요하면 같은 도구를 다시 부르세요]`;
  }

  /** 이미 비운 자리인지 */
  function isClearedToolResult(text: string): boolean {
    return text.startsWith(CLEARED_TOOL_RESULT_PREFIX);
  }

  interface ClearToolResults {
    /** 원본을 바꾸지 않은 새 배열. 비우지 않았으면 원본과 같은 내용의 복사본 */
    messages: BetaMessageParam[];
    clearedCount: number;
    /** 비우면서 줄어든 글자 수 */
    clearedChars: number;
  }

  /**
   * `role: 'user'` 메시지 안의 `tool_result` 블록 중 최근 keepRecent개를 뺀 것을 표시 문구로 바꾼다.
   * - `tool_use_id`와 `is_error`는 그대로 둔다 — API 규칙상 tool_use와 tool_result가 짝을 이뤄야 한다.
   * - 이미 비운 자리(표시 문구로 시작)는 다시 세지 않는다.
   * - 줄어드는 글자가 clearAtLeastChars보다 작으면 아무것도 바꾸지 않는다.
   * - 원본 배열·메시지·블록은 바꾸지 않는다.
   */
  function clearOldToolResults(messages: readonly BetaMessageParam[], policy: ContextClearingPolicy = DEFAULT_CONTEXT_CLEARING): ClearToolResults {
    const targets: Array<{ message: number; block: number; chars: number }> = [];
    messages.forEach((message, messageIndex) => {
      if (message.role !== 'user' || !Array.isArray(message.content)) return;
      message.content.forEach((block, blockIndex) => {
        if (block.type !== 'tool_result') return;
        const chars = contentChars(block.content);
        // 이미 비운 자리는 후보에서도 최근 N개에도 넣지 않는다
        if (typeof block.content === 'string' && isClearedToolResult(block.content)) return;
        targets.push({ message: messageIndex, block: blockIndex, chars });
      });
    });

    const candidates = targets.slice(0, Math.max(0, targets.length - policy.keepRecent));
    const clearedChars = candidates.reduce((sum, target) => sum + target.chars, 0);
    if (candidates.length === 0 || clearedChars < policy.clearAtLeastChars) {
      return { messages: [...messages], clearedCount: 0, clearedChars: 0 };
    }

    const cleared = new Set(candidates.map((target) => `${target.message}:${target.block}`));
    const next = messages.map((message, messageIndex) => {
      if (!Array.isArray(message.content)) return message;
      let changed = false;
      const content = message.content.map((block, blockIndex) => {
        if (block.type !== 'tool_result' || !cleared.has(`${messageIndex}:${blockIndex}`)) return block;
        changed = true;
        // tool_use_id·is_error 등 나머지 필드는 그대로 둔다
        return { ...block, content: clearedToolResultNote(contentChars(block.content)) };
      });
      return changed ? ({ ...message, content } as BetaMessageParam) : message;
    });

    return { messages: next, clearedCount: candidates.length, clearedChars };
  }

  /** 도구 결과 본문의 글자 수. 문자열이거나 텍스트 블록 배열일 수 있다 */
  function contentChars(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
      return content.reduce<number>((sum, block) => sum + (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text.length : 0), 0);
    }
    return 0;
  }

  /**
   * 환경 변수에서 기본 정책을 읽는다. `B_STUDIO_CONTEXT_CLEARING=on`일 때만 켠다(기본은 끔 — 효과를 재기 전).
   * 스튜디오 API 모드와 벤치가 이 값을 읽어 러너에 넘긴다.
   */
  function contextClearingFromEnv(env: Record<string, string | undefined>): ContextClearingPolicy | undefined {
    return env.B_STUDIO_CONTEXT_CLEARING?.trim().toLowerCase() === 'on' ? DEFAULT_CONTEXT_CLEARING : undefined;
  }

  /** 옵션과 환경 변수를 합쳐 실제 정책을 정한다. `false`는 환경 변수보다 우선한다(명시적으로 끔) */
  function resolveContextClearing(
    option: ContextClearingPolicy | false | undefined,
    env: Record<string, string | undefined>,
  ): ContextClearingPolicy | undefined {
    if (option === false) return undefined;
    if (option) return option;
    return contextClearingFromEnv(env);
  }

    // ===== 옛 model-router.ts =====
  type ModelProvider = 'anthropic' | 'openai' | 'google';
  type ModelCapability = 'tools' | 'reasoning' | 'long-context' | 'json';
  type RouteIntent = 'build' | 'ask' | 'evaluate';

  interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  }

  interface ModelProfile {
    /** 설정과 실행 기록에서 바뀌지 않는 식별자 */
    id: string;
    provider: ModelProvider;
    model: string;
    label: string;
    enabled?: boolean;
    capabilities: ModelCapability[];
    contextWindow: number;
    pricing: ModelPricing;
    /** 실측이 없을 때 쓰는 0~1 초기값 */
    baselineQuality: number;
    /** 실측이 없을 때 쓰는 예상 지연 */
    baselineLatencyMs: number;
    apiKeyEnv?: string;
    baseUrl?: string;
  }

  interface ModelObservation {
    modelId: string;
    passed: boolean;
    latencyMs: number;
    /** 가격표를 설정해 실제 사용량을 환산할 수 있을 때만 기록한다 */
    costUsd?: number;
  }

  interface ModelStats {
    runs: number;
    passes: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    pricedRuns: number;
  }

  interface RouteRequest {
    prompt: string;
    intent: RouteIntent;
    requiredCapabilities?: ModelCapability[];
    /** 한 번의 요청에 허용할 예상 비용. 가격을 0으로 둔 모델은 알 수 없는 비용으로 취급한다 */
    maxCostUsd?: number;
    preferredModelId?: string;
  }

  interface RouteCandidate {
    model: ModelProfile;
    eligible: boolean;
    score: number;
    estimatedCostUsd?: number;
    quality: number;
    latencyMs: number;
    reasons: string[];
  }

  interface RoutingDecision {
    selected: ModelProfile;
    complexity: 'simple' | 'normal' | 'complex';
    risk: 'normal' | 'high';
    inputTokens: number;
    outputTokens: number;
    candidates: RouteCandidate[];
    reason: string;
  }

  const COMPLEX = /아키텍처|architecture|migration|마이그레이션|distributed|분산|concurren|동시성|security|보안|refactor|리팩터|multi[- ]?service|멀티|성능|performance|incident|장애/i;
  const HIGH_RISK = /결제|payment|정산|권한|인증|authorization|authentication|secret|credential|삭제|delete|drop\s|truncate|production|운영|배포|deploy|migration|마이그레이션/i;
  const VALID_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  const VALID_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;

  function validateModelProfiles(input: unknown): ModelProfile[] {
    if (!Array.isArray(input) || input.length === 0) throw new Error('모델 레지스트리는 한 개 이상의 모델 배열이어야 합니다');
    const ids = new Set<string>();
    return input.map((value, index) => {
      if (!value || typeof value !== 'object') throw new Error(`모델 ${index + 1} 설정이 객체가 아닙니다`);
      const item = value as Partial<ModelProfile>;
      if (typeof item.id !== 'string' || !VALID_ID.test(item.id)) throw new Error(`모델 ${index + 1}의 id가 올바르지 않습니다`);
      if (ids.has(item.id)) throw new Error(`모델 id가 겹칩니다: ${item.id}`);
      ids.add(item.id);
      if (item.provider !== 'anthropic' && item.provider !== 'openai' && item.provider !== 'google') {
        throw new Error(`${item.id}의 provider는 anthropic, openai, google 중 하나여야 합니다`);
      }
      if (typeof item.model !== 'string' || !item.model.trim()) throw new Error(`${item.id}의 model이 필요합니다`);
      if (typeof item.label !== 'string' || !item.label.trim()) throw new Error(`${item.id}의 label이 필요합니다`);
      if (!Array.isArray(item.capabilities) || item.capabilities.some((capability) => !['tools', 'reasoning', 'long-context', 'json'].includes(capability))) {
        throw new Error(`${item.id}의 capabilities가 올바르지 않습니다`);
      }
      positive(item.contextWindow, `${item.id}.contextWindow`);
      between(item.baselineQuality, 0, 1, `${item.id}.baselineQuality`);
      positive(item.baselineLatencyMs, `${item.id}.baselineLatencyMs`);
      if (!item.pricing || typeof item.pricing !== 'object') throw new Error(`${item.id}.pricing이 필요합니다`);
      nonNegative(item.pricing.inputPerMillion, `${item.id}.pricing.inputPerMillion`);
      nonNegative(item.pricing.outputPerMillion, `${item.id}.pricing.outputPerMillion`);
      if (item.pricing.cacheReadPerMillion !== undefined) nonNegative(item.pricing.cacheReadPerMillion, `${item.id}.pricing.cacheReadPerMillion`);
      if (item.pricing.cacheWritePerMillion !== undefined) nonNegative(item.pricing.cacheWritePerMillion, `${item.id}.pricing.cacheWritePerMillion`);
      if (item.apiKeyEnv !== undefined && !VALID_ENV.test(item.apiKeyEnv)) throw new Error(`${item.id}.apiKeyEnv가 올바른 환경 변수 이름이 아닙니다`);
      if (item.baseUrl !== undefined) safeBaseUrl(item.baseUrl, item.id);
      return {
        id: item.id,
        provider: item.provider,
        model: item.model.trim(),
        label: item.label.trim(),
        enabled: item.enabled !== false,
        capabilities: [...new Set(item.capabilities)] as ModelCapability[],
        contextWindow: item.contextWindow!,
        pricing: { ...item.pricing },
        baselineQuality: item.baselineQuality!,
        baselineLatencyMs: item.baselineLatencyMs!,
        ...(item.apiKeyEnv ? { apiKeyEnv: item.apiKeyEnv } : {}),
        ...(item.baseUrl ? { baseUrl: item.baseUrl.replace(/\/$/, '') } : {}),
      };
    });
  }

  function aggregateModelStats(observations: readonly ModelObservation[]): Record<string, ModelStats> {
    const stats: Record<string, ModelStats> = {};
    for (const observation of observations) {
      if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) continue;
      if (observation.costUsd !== undefined && (!Number.isFinite(observation.costUsd) || observation.costUsd < 0)) continue;
      const current = (stats[observation.modelId] ??= { runs: 0, passes: 0, totalLatencyMs: 0, totalCostUsd: 0, pricedRuns: 0 });
      current.runs += 1;
      current.passes += observation.passed ? 1 : 0;
      current.totalLatencyMs += observation.latencyMs;
      if (observation.costUsd !== undefined) {
        current.totalCostUsd += observation.costUsd;
        current.pricedRuns += 1;
      }
    }
    return stats;
  }

  function routeModel(profiles: readonly ModelProfile[], request: RouteRequest, stats: Readonly<Record<string, ModelStats>> = {}): RoutingDecision {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('라우팅할 요청을 입력하세요');
    const enabled = profiles.filter((profile) => profile.enabled !== false);
    if (enabled.length === 0) throw new Error('사용할 수 있는 모델이 없습니다');

    const inputTokens = estimateTokens(prompt);
    const complexity = classifyComplexity(prompt, inputTokens);
    const risk = classifyRisk(prompt);
    const outputTokens = request.intent === 'build' ? (complexity === 'complex' ? 4_000 : complexity === 'normal' ? 2_000 : 1_000) : complexity === 'complex' ? 1_500 : 700;
    const required = new Set<ModelCapability>(request.requiredCapabilities ?? (request.intent === 'build' ? ['tools'] : []));

    const candidates = enabled.map((model) => rank(model, { request, stats: stats[model.id], required, inputTokens, outputTokens, complexity, risk }));
    candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.model.id.localeCompare(b.model.id));

    const preferred = request.preferredModelId ? candidates.find((candidate) => candidate.model.id === request.preferredModelId) : undefined;
    const chosen = preferred?.eligible ? preferred : candidates.find((candidate) => candidate.eligible);
    if (!chosen) {
      const reasons = candidates.flatMap((candidate) => candidate.reasons.filter((reason) => reason.startsWith('제외:')).map((reason) => `${candidate.model.label}: ${reason}`));
      throw new Error(`요청 조건을 만족하는 모델이 없습니다${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
    }

    return {
      selected: chosen.model,
      complexity,
      risk,
      inputTokens,
      outputTokens,
      candidates,
      reason: request.preferredModelId && chosen === preferred ? `사용자가 지정한 ${chosen.model.label}을 선택했습니다` : chosen.reasons.join(', '),
    };
  }

  function estimateCost(profile: ModelProfile, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | undefined {
    const { pricing } = profile;
    if (pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0) return undefined;
    return (
      usage.inputTokens * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion +
      (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
      (usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    ) / 1_000_000;
  }

  function rank(
    model: ModelProfile,
    context: {
      request: RouteRequest;
      stats?: ModelStats;
      required: Set<ModelCapability>;
      inputTokens: number;
      outputTokens: number;
      complexity: RoutingDecision['complexity'];
      risk: RoutingDecision['risk'];
    },
  ): RouteCandidate {
    const reasons: string[] = [];
    const missing = [...context.required].filter((capability) => !model.capabilities.includes(capability));
    const neededContext = context.inputTokens + context.outputTokens;
    const estimatedCostUsd = estimateCost(model, { inputTokens: context.inputTokens, outputTokens: context.outputTokens });
    const observedCostUsd = context.stats?.pricedRuns ? context.stats.totalCostUsd / context.stats.pricedRuns : undefined;
    // 실측 비용이 있으면 이 모델의 실제 평균 소비를 우선하고, 없으면 요청 길이와 가격표로 추정한다
    const rankedCostUsd = observedCostUsd ?? estimatedCostUsd;
    let eligible = true;
    if (missing.length > 0) {
      eligible = false;
      reasons.push(`제외: ${missing.join(', ')} 기능이 없습니다`);
    }
    if (model.contextWindow < neededContext) {
      eligible = false;
      reasons.push(`제외: 예상 ${neededContext.toLocaleString()}토큰이 컨텍스트 한도를 넘습니다`);
    }
    if (context.request.maxCostUsd !== undefined && estimatedCostUsd !== undefined && estimatedCostUsd > context.request.maxCostUsd) {
      eligible = false;
      reasons.push(`제외: 예상 비용 $${estimatedCostUsd.toFixed(4)}가 한도를 넘습니다`);
    }

    const priorRuns = 5;
    const observed = context.stats;
    const quality = observed ? (model.baselineQuality * priorRuns + observed.passes) / (priorRuns + observed.runs) : model.baselineQuality;
    const latencyMs = observed?.runs ? observed.totalLatencyMs / observed.runs : model.baselineLatencyMs;
    const latencyScore = 1 / (1 + latencyMs / 10_000);
    const costScore = rankedCostUsd === undefined ? 0.35 : 1 / (1 + rankedCostUsd * 20);
    const qualityWeight = context.risk === 'high' || context.complexity === 'complex' ? 0.65 : context.complexity === 'simple' ? 0.35 : 0.5;
    const costWeight = context.risk === 'high' || context.complexity === 'complex' ? 0.15 : context.complexity === 'simple' ? 0.45 : 0.3;
    const score = quality * qualityWeight + costScore * costWeight + latencyScore * 0.2;

    if (observed?.runs) reasons.push(`실측 통과율 ${Math.round((observed.passes / observed.runs) * 100)}% (${observed.runs}건)`);
    else reasons.push(`초기 품질 기준 ${Math.round(model.baselineQuality * 100)}%`);
    reasons.push(`예상 지연 ${Math.round(latencyMs).toLocaleString()}ms`);
    reasons.push(observedCostUsd !== undefined ? `실측 평균 비용 $${observedCostUsd.toFixed(4)}` : estimatedCostUsd === undefined ? '가격 미설정' : `예상 비용 $${estimatedCostUsd.toFixed(4)}`);
    if (context.risk === 'high') reasons.push('고위험 요청은 품질 가중치를 높임');
    else if (context.complexity === 'simple') reasons.push('단순 요청은 비용 가중치를 높임');

    return { model, eligible, score: eligible ? score : -1, estimatedCostUsd, quality, latencyMs, reasons };
  }

  /**
   * 요청 글자 수에서 토큰을 대충 잡는다(라우팅용 추정, 실제 비용은 공급자 usage로 따로 기록한다).
   * 계획-실행 분리(ADR-075)의 "계획을 건너뛸 만큼 작은 요청인가" 판정도 이 추정을 그대로 재사용한다(plan-brief.ts).
   */
  function estimateTokens(text: string): number {
    // 라우팅 전에 별도 토크나이저를 호출하지 않고 보수적으로 잡는다. 실제 비용은 공급자 usage로 다시 기록한다
    const ascii = [...text].filter((character) => character.codePointAt(0)! <= 0x7f).length;
    return Math.max(1, Math.ceil(ascii / 4 + (text.length - ascii) / 1.5));
  }

  /**
   * 요청의 복잡도를 simple/normal/complex로 나눈다. 모델 라우팅(routeModel)의 비용·품질 가중치뿐 아니라
   * 계획-실행 분리(ADR-075)가 "계획 호출을 할 만큼 큰 요청인가"를 판정할 때도 그대로 재사용한다(plan-brief.ts의 shouldPlanBrief) —
   * "크다/작다"의 뜻을 두 곳에서 따로 정의하지 않는다.
   */
  function classifyComplexity(prompt: string, inputTokens: number): RoutingDecision['complexity'] {
    const signals = (COMPLEX.test(prompt) ? 1 : 0) + (inputTokens >= 800 ? 1 : 0) + ((prompt.match(/\n/g)?.length ?? 0) >= 12 ? 1 : 0);
    return signals >= 2 ? 'complex' : signals === 1 ? 'normal' : 'simple';
  }

  /**
   * 요청에 인증·결제·마이그레이션처럼 실패 비용이 큰 키워드가 있는지(ADR-047의 HIGH_RISK 목록).
   * routeModel의 위험도 판정과 CLI 백엔드 자동 모델 선택(cli-router.ts)이 이 하나의 분류를 함께 쓴다 —
   * "위험하다"의 뜻을 두 라우터가 따로 정의하지 않는다.
   */
  function classifyRisk(prompt: string): RoutingDecision['risk'] {
    return HIGH_RISK.test(prompt) ? 'high' : 'normal';
  }

  /**
   * 요청의 작업 종류(복잡도 × 위험도). 실행 기록이 AI별 결과를 묶는 열쇠이고(#821), 라우터와 같은 분류를 쓴다.
   * 요청 글만 보고 정하므로 같은 글은 늘 같은 종류가 된다
   */
  function classifyTask(prompt: string): Pick<RoutingDecision, 'complexity' | 'risk'> {
    return { complexity: classifyComplexity(prompt, estimateTokens(prompt)), risk: classifyRisk(prompt) };
  }

  function positive(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name}은 0보다 큰 숫자여야 합니다`);
  }

  function nonNegative(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name}은 0 이상의 숫자여야 합니다`);
  }

  function between(value: unknown, min: number, max: number, name: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}은 ${min}~${max} 사이 숫자여야 합니다`);
  }

  function safeBaseUrl(value: string, id: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${id}.baseUrl이 올바른 URL이 아닙니다`);
    }
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error(`${id}.baseUrl에는 http(s) 주소만 쓸 수 있습니다`);
    if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
      throw new Error(`${id}.baseUrl의 원격 주소에는 https를 사용해야 합니다`);
    }
  }

    // ===== 옛 cli-router.ts =====
  /**
   * CLI 백엔드(claude-code) 자동 모델 선택(ADR-091). ADR-047의 라우터(model-router.ts)는 가격·컨텍스트·실측 통계를 아는
   * 후보 여러 개의 점수를 매겨 고르지만, 이 프로젝트에서 로컬 Claude Code 구독에는 그런 후보 목록이 없다 — 로그인한
   * 계정의 별칭(haiku·sonnet·opus) 중 하나를 이름으로 고를 뿐이다. 그래서 이 모듈은 점수 계산이 아니라
   * "세 단계 중 하나를 고르는 규칙표"다. fable은 단가를 몰라 자동 선택 후보에 넣지 않는다(사용자가 대화에서 직접 고를 때만).
   *
   * 복잡도·위험도 분류는 ADR-047이 쓰는 classifyComplexity·classifyRisk(model-router.ts)를 그대로 재사용한다 —
   * "복잡하다/위험하다"의 뜻을 두 라우터가 따로 정의하지 않는다.
   *
   * E8(계획-실행 분리, docs/experiments/2026-09-30-e8-plan-execute-split.md)과 E9(2026-10-01)는 세션 안에서 모델을
   * 바꿀 때마다(계획 모델 ↔ 실행 모델) 프롬프트 캐시가 다시 만들어져 비용이 크게 뛰는 것을 쟀다
   * (E8-split은 단일 모델보다 성공 1건당 비용이 538% 많았다). 이 라우터는 그 결과를 반영해 매 요청 다시 계산하지 않고
   * "그대로 두는 쪽"에 기운다 — 세션 안에서 어떤 단계가 검증 게이트를 통과했으면, 읽기 전용 질문이 아닌 한
   * 뒤이은 만들기 요청에서 그 단계 아래로 내리지 않는다(stickiness).
   */

  /** 자동 선택이 고를 수 있는 단계. 낮은 인덱스가 더 싸고 빠르다. fable은 단가를 몰라 여기 없다(명시적으로 고를 때만 쓴다) */
  const CLI_TIERS = ['haiku', 'sonnet', 'opus'] as const;
  type CliTier = (typeof CLI_TIERS)[number];

  /** 사람이 읽는 단계 이름(대화 이벤트·화면 문구용) */
  const TIER_LABELS: Record<CliTier, string> = { haiku: 'Haiku', sonnet: 'Sonnet 5', opus: 'Opus' };

  function tierLabel(tier: CliTier): string {
    return TIER_LABELS[tier];
  }

  function tierIndex(tier: CliTier): number {
    return CLI_TIERS.indexOf(tier);
  }

  /** tier보다 한 단계 위. 이미 최고 단계(opus)면 더 올릴 곳이 없어 undefined(승격 대상 없음) */
  function nextCliTier(tier: CliTier): CliTier | undefined {
    return CLI_TIERS[tierIndex(tier) + 1];
  }

  /** 두 단계 중 더 높은(더 비싼) 쪽. undefined는 "아직 쓴 적 없음"을 뜻해 있는 쪽을 그대로 돌려준다 */
  function higherCliTier(a: CliTier | undefined, b: CliTier): CliTier {
    if (!a) return b;
    return tierIndex(a) >= tierIndex(b) ? a : b;
  }

  interface CliRouteRequest {
    prompt: string;
    /** 'ask' = 읽기만 하는 질문(파일을 바꾸지 않음). 'build'만 만들기 요청으로 본다 */
    intent: RouteIntent;
    /** 이 세션에서 지금까지 성공적으로 쓴 가장 높은 단계(stickiness). 없으면 이번이 첫 자동 선택이다 */
    stickyTier?: CliTier;
  }

  interface CliRouteDecision {
    tier: CliTier;
    reason: string;
    /** ADR-047과 같은 분류값을 그대로 실어 대화 이벤트·관측에 남긴다 */
    complexity: RoutingDecision['complexity'];
    risk: RoutingDecision['risk'];
    /** stickiness가 이번 선택을 끌어올렸는지(화면·기록에 왜 이 단계인지 설명할 때 쓴다) */
    stuckTo: boolean;
  }

  /**
   * claude-code 'auto' 모델 선택(phase 1, 같은 세션 안에서만 — 백엔드를 넘나드는 전환은 phase 2).
   * 규칙:
   *  - 읽기만 하는 질문(intent === 'ask')은 항상 haiku. 구현 품질의 증거가 아니라 stickiness도 적용하지 않는다(ADR-047과 같은 원칙 — 질문 완료는 정답을 뜻하지 않는다).
   *  - 만들기 요청은 단순/보통이면 sonnet, 복잡하거나(ADR-047 COMPLEX) 위험하면(ADR-047 HIGH_RISK: 인증·결제·마이그레이션 등) opus.
   *    E9에서 Sonnet 단독이 가장 쌌고(성공 1건당 $0.233) Haiku 단독은 성공률이 떨어졌으므로(로딩에서 멈춘 화면을 못 고침),
   *    자동 선택은 만들기 요청에 haiku를 쓰지 않는다.
   *  - stickiness: 세션에서 이미 성공적으로 쓴 단계(stickyTier)가 이번에 계산한 단계보다 높으면 내리지 않는다
   *    (모델을 바꾸면 프롬프트 캐시가 새로 생겨 비용이 뛴다 — E8/E9).
   */
  function routeCliTier(request: CliRouteRequest): CliRouteDecision {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('라우팅할 요청을 입력하세요');
    const inputTokens = estimateTokens(prompt);
    const complexity = classifyComplexity(prompt, inputTokens);
    const risk = classifyRisk(prompt);

    if (request.intent === 'ask') {
      return { tier: 'haiku', reason: '읽기만 하는 질문이라 가장 가벼운 모델로 답합니다', complexity, risk, stuckTo: false };
    }

    const escalated = risk === 'high' || complexity === 'complex';
    const natural: CliTier = escalated ? 'opus' : 'sonnet';
    const naturalReason = risk === 'high' ? '인증·결제·마이그레이션 등 위험 신호가 있어' : complexity === 'complex' ? '요청이 복잡해' : '단순한 만들기 요청이라';

    if (request.stickyTier && tierIndex(request.stickyTier) > tierIndex(natural)) {
      return {
        tier: request.stickyTier,
        reason: `이 세션에서 이미 ${tierLabel(request.stickyTier)}로 성공했어 그대로 유지합니다(모델을 바꾸면 캐시가 새로 생겨 비용이 늘어납니다)`,
        complexity,
        risk,
        stuckTo: true,
      };
    }

    return { tier: natural, reason: `${naturalReason} ${tierLabel(natural)}을 선택합니다`, complexity, risk, stuckTo: false };
  }

  return {
    clipCommandOutput,
    clipText,
    visibleHtml,
    isHtmlContent,
    repeatNote,
    isRepeatNote,
    clearedToolResultNote,
    isClearedToolResult,
    clearOldToolResults,
    contextClearingFromEnv,
    resolveContextClearing,
    validateModelProfiles,
    aggregateModelStats,
    routeModel,
    estimateCost,
    estimateTokens,
    classifyComplexity,
    classifyRisk,
    classifyTask,
    routeCliTier,
    tierLabel,
    nextCliTier,
    higherCliTier,
  };
})();

// ---------------------------------------------------------------------------------------------------------------------
// 시험 본문
// ---------------------------------------------------------------------------------------------------------------------

const SEEDS = (process.env['BUDGET_ROUTING_DIFF_SEEDS'] ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env['BUDGET_ROUTING_DIFF_ITERATIONS'] ?? 3000);
const REPORT = process.env['BUDGET_ROUTING_DIFF_REPORT'] === '1';

/** 선형 합동은 입력이 쏠려(ADR-191 2b-1) mulberry32를 쓴다 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const chance = (rng: Rng, p: number): boolean => rng() < p;

/** 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(의도한 차이). 옛 구현의 결과도 같은 규칙으로 맞춘 뒤 견준다 */
function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toWellFormed(), wellFormed(item)]));
  return value;
}

/** 결과를 JSON 글자(키 순서·NaN·Infinity·-0 포함)로 견준다. 던지면 메시지 */
function outcome(fn: () => unknown): string {
  try {
    return `ok:${String(encodeNative(wellFormed(fn())))}`;
  } catch (error) {
    return `err:${(error as Error).message.toWellFormed()}`;
  }
}

interface Tally {
  runs: number;
  differ: number;
  first: string[];
  buckets: Record<string, number>;
}
const newTally = (): Tally => ({ runs: 0, differ: 0, first: [], buckets: {} });

function compare(tally: Tally, name: string, input: unknown, expected: string, actual: string, bucket: string): void {
  tally.runs += 1;
  tally.buckets[bucket] = (tally.buckets[bucket] ?? 0) + 1;
  if (expected !== actual) {
    tally.differ += 1;
    if (tally.first.length < 3) tally.first.push(`${name}\n입력: ${JSON.stringify(input)?.slice(0, 1500)}\n옛: ${expected.slice(0, 1500)}\n새: ${actual.slice(0, 1500)}`);
  }
}

// ── 입력 재료 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const WORDS = [
  'login', 'auth', '결제', 'payment', 'DELETE', 'drop', 'Drop', 'DROP', 'truncate', 'TRUNCATE', 'production', '운영', '배포', 'deploy', 'migration', '마이그레이션', 'secret', 'credential',
  '인증', '권한', '정산', 'authorization', 'authentication', '삭제', 'refactor', '리팩터', 'Architecture', '아키텍처', 'Distributed', '분산', 'concurrent', 'concurren', '동시성',
  'security', '보안', 'multi-service', 'multi service', 'multiservice', 'Multi Service', 'multi-  service', 'multi_service', '멀티', '성능', 'performance', 'incident', '장애', 'dropdown',
  'drop-in', 'drop x', 'drop ', 'drop﻿', 'drop\u0085', 'ſecurity', 'SECURITY'.toLowerCase().replace('s', 'ſ'), 'KelvinK', 'ＳＥＣＵＲＩＴＹ', 'button', '버튼', 'page', '페이지', 'table', 'create',
  '만들어줘', 'hello', 'world',
];
const SPACES = [' ', '  ', '\n', '\t', ' ', ' ', ' ', '﻿', '　', '\r\n', '\u0085', '​', '᠎', ' ', ' '];
const EXOTIC = ['🙂', '😀', '👨‍👩‍👧', 'é', 'ß', 'İ', 'ǅ', '한글', '漢字', '\u0000', '\u007f', 'é', '😀'];

function randText(rng: Rng, maxPieces = 8): string {
  const n = int(rng, 0, maxPieces);
  let out = '';
  for (let i = 0; i < n; i++) {
    const r = rng();
    out += r < 0.4 ? pick(rng, WORDS) : r < 0.7 ? pick(rng, SPACES) : r < 0.85 ? pick(rng, EXOTIC) : 'x'.repeat(int(rng, 0, 20));
  }
  return out;
}

/** estimateTokens가 target 언저리가 되도록 ASCII·한글 글자 수를 맞춘 요청 */
function promptNearTokens(rng: Rng, target: number): string {
  const hangul = int(rng, 0, 60);
  const ascii = Math.max(0, Math.floor((target - hangul / 1.5) * 4) + int(rng, -4, 4));
  return `${'a'.repeat(ascii)}${'가'.repeat(hangul)}`;
}

function randPrompt(rng: Rng): string {
  const r = rng();
  if (r < 0.15) return promptNearTokens(rng, int(rng, 797, 803)) + (chance(rng, 0.5) ? pick(rng, WORDS) : '');
  if (r < 0.3) {
    const base = pick(rng, ['', pick(rng, WORDS), 'plain']);
    return `${base}${'\n'.repeat(int(rng, 10, 14))}x`;
  }
  if (r < 0.4) return pick(rng, ['', ' ', '\n', ' ', '﻿', ' ', '　', ' \t\n ', '\u0085', '​']);
  return randText(rng, 6);
}

// ── 함수별 시험 ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Case = (rng: Rng, tally: Tally) => void;

function randBudget(rng: Rng, length: number): number {
  const r = rng();
  if (r < 0.25) return length;
  if (r < 0.35) return length - 1;
  if (r < 0.45) return length + 1;
  if (r < 0.5) return pick(rng, [0, -0, -5, 1, 2, 3]);
  if (r < 0.55) return pick(rng, [0.5, 1.5, 2.9, 99.5, -1.5, 10.25]);
  if (r < 0.57) return pick(rng, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  return int(rng, 1, Math.max(2, length * 2));
}

/** 서로게이트 쌍이 있는 글은 한가운데가 갈라질 수 있다(의도한 차이: 갈라진 자리는 U+FFFD) */
function randClipSubject(rng: Rng): string {
  const r = rng();
  if (r < 0.3) return randText(rng, 30);
  if (r < 0.6) return 'a'.repeat(int(rng, 0, 400)) + randText(rng, 3);
  if (r < 0.8) return '가🙂'.repeat(int(rng, 0, 60));
  return `${'x'.repeat(int(rng, 0, 120))}\n${'y'.repeat(int(rng, 0, 120))}`;
}

const CASES: Record<string, Case> = {
  clipCommandOutput(rng, tally) {
    const text = randClipSubject(rng);
    const budget = randBudget(rng, text.length);
    const expected = outcome(() => legacy.clipCommandOutput(text, budget));
    compare(tally, 'clipCommandOutput', { text, budget }, expected, outcome(() => clipCommandOutput(text, budget)), expected.includes('생략') ? '자름' : '안 자름');
  },
  clipText(rng, tally) {
    const text = randClipSubject(rng);
    const budget = randBudget(rng, text.length);
    const hint = pick(rng, [undefined, '', '줄 범위를 좁혀 다시 읽으세요', 'h🙂nt']);
    const expected = outcome(() => legacy.clipText(text, budget, hint));
    compare(tally, 'clipText', { text, budget, hint }, expected, outcome(() => clipText(text, budget, hint)), expected.includes('생략') ? '자름' : '안 자름');
  },
  visibleHtml(rng, tally) {
    const TAGS = [
      '<script>', '</script>', '<SCRIPT type="x">', '</ScRiPt >', '<script\n>', '</script >', '</script >', '<style>', '</style>', '<STYLE media=a>', '</Style  >', '<noscript>', '</NoScript>',
      '<scripts>', '<script-x>', '<script', '<scrip', '<styles>', '<noscripts>', '<!--', '-->', '<!-->', '<!---->', '<', '>', '<<', '>>', '<a href="x">', '</a>', '<p>', '<br/>', '<title>', '</title>',
      '&amp;', '&AMP;', '&lt;', '&LT;', '&gt;', '&quot;', '&#39;', '&apos;', '&APOS;', '&nbsp;', '&Nbsp;', '&amp;lt;', '&amp;amp;', '&#x27;', '&', ';', '/', 'ſcript', '<ſcript>',
    ];
    let html = '';
    for (let i = 0, n = int(rng, 0, 14); i < n; i++) html += chance(rng, 0.55) ? pick(rng, TAGS) : chance(rng, 0.5) ? pick(rng, SPACES) : pick(rng, ['hello', '안녕', '🙂', 'a<b', 'x>y', 'if (1 < 2) {}', 'text']);
    const expected = outcome(() => legacy.visibleHtml(html));
    compare(tally, 'visibleHtml', html, expected, outcome(() => visibleHtml(html)), html.length === 0 ? '빈 입력' : expected === `ok:${JSON.stringify(html)}` ? '그대로' : '벗김');
  },
  isHtmlContent(rng, tally) {
    const contentType = pick(rng, [undefined, '', 'text/html', 'TEXT/HTML; charset=utf-8', 'application/xhtml+xml', 'Application/XHTML+XML', 'application/json', 'text/plain', 'text/htmlx', 'texthtml', 'text/Ktml']);
    const lead = chance(rng, 0.5) ? '' : pick(rng, SPACES).repeat(int(rng, 1, 3));
    const start = pick(rng, ['<!doctype html>', '<!DOCTYPE HTML>', '<!doctype htmlx', '<!doctype  html', '<html>', '<HTML lang="ko">', '<html\n', '<html x', '<html', '<htmlx>', '<html >', '<ht', '', 'plain', '{"a":1}', '< html>']);
    const text = `${lead}${start}${randText(rng, 2)}`;
    const expected = outcome(() => legacy.isHtmlContent(contentType, text));
    compare(tally, 'isHtmlContent', { contentType, text }, expected, outcome(() => isHtmlContent(contentType, text)), expected);
  },
  repeatNote(rng, tally) {
    const call = pick(rng, [0, 1, 2, 10, 123456, 1e21, 1.5, -1, Number.NaN, 2 ** 53, int(rng, 0, 100000)]);
    const expected = outcome(() => legacy.repeatNote(call));
    compare(tally, 'repeatNote', call, expected, outcome(() => repeatNote(call)), 'ok');
    const text = pick(rng, [`(앞의 ${call}번째 호출 결과와 같습니다)`, '(앞의 ', '번째 호출 결과와 같습니다)', '(앞의 번째 호출 결과와 같습니다)', '(앞의 3번째 호출 결과와 같습니다', ` (앞의 3번째 호출 결과와 같습니다)`, randText(rng, 3), '(앞의 ', '(앞의 번째 호출 결과와 같습니다)x']);
    const e2 = outcome(() => legacy.isRepeatNote(text));
    compare(tally, 'isRepeatNote', text, e2, outcome(() => isRepeatNote(text)), e2);
  },
  clearedToolResultNote(rng, tally) {
    const chars = pick(rng, [0, 1, 999, 1000, 1001, 12345, 999999, 1000000, 1e21, 1.5e25, 2 ** 53, 1234.5, -1, int(rng, 0, 1e7), Number.NaN, Number.POSITIVE_INFINITY]);
    const expected = outcome(() => legacy.clearedToolResultNote(chars));
    compare(tally, 'clearedToolResultNote', chars, expected, outcome(() => clearedToolResultNote(chars)), 'ok');
    const text = pick(rng, [legacy.clearedToolResultNote(5), '[이전 도구 결과 생략: ', '[이전 도구 결과 생략', ' [이전 도구 결과 생략: x', randText(rng, 3)]);
    const e2 = outcome(() => legacy.isClearedToolResult(text));
    compare(tally, 'isClearedToolResult', text, e2, outcome(() => isClearedToolResult(text)), e2);
  },
  contextClearingFromEnv(rng, tally) {
    const value = pick(rng, [undefined, 'on', 'ON', ' On ', ' on ', 'off', '', 'on\n', 'o n', 'ｏｎ', 'onn', 'oN', '﻿on', 'ON ', 'true', '1']);
    const env = value === undefined ? {} : { B_STUDIO_CONTEXT_CLEARING: value };
    const expected = outcome(() => legacy.contextClearingFromEnv(env));
    compare(tally, 'contextClearingFromEnv', env, expected, outcome(() => contextClearingFromEnv(env)), expected === 'ok:undefined' ? '꺼짐' : '켜짐');
    const option = pick(rng, [undefined, false as const, { triggerTokens: 5, keepRecent: 1, clearAtLeastChars: 2 }]);
    const e2 = outcome(() => legacy.resolveContextClearing(option, env));
    compare(tally, 'resolveContextClearing', { option, env }, e2, outcome(() => resolveContextClearing(option, env)), e2 === 'ok:undefined' ? '꺼짐' : '켜짐');
  },
  clearOldToolResults(rng, tally) {
    const textOf = (): string => {
      const r = rng();
      const len = r < 0.1 ? 0 : r < 0.6 ? int(rng, 1, 40) : int(rng, 1, 300);
      return chance(rng, 0.3) ? '가🙂'.repeat(Math.ceil(len / 3)).slice(0, len).toWellFormed() : 'a'.repeat(len);
    };
    const messages: unknown[] = [];
    let n = 0;
    for (let m = int(rng, 0, 7); m > 0; m--) {
      const role = chance(rng, 0.8) ? 'user' : 'assistant';
      if (chance(rng, 0.1)) {
        messages.push({ role, content: textOf() });
        continue;
      }
      const blocks: unknown[] = [];
      for (let b = int(rng, 0, 4); b > 0; b--) {
        const r = rng();
        if (r < 0.15) blocks.push({ type: 'text', text: textOf() });
        else if (r < 0.25) blocks.push({ type: 'tool_use', id: `t${n}`, name: 'read_file', input: { path: 'a', big: textOf() } });
        else {
          n += 1;
          const k = rng();
          const content: unknown =
            k < 0.45
              ? textOf()
              : k < 0.6
                ? legacy.clearedToolResultNote(int(rng, 1, 5000))
                : k < 0.8
                  ? [{ type: 'text', text: textOf() }, { type: 'text', text: textOf() }]
                  : k < 0.9
                    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: textOf(), cache_control: { type: 'ephemeral' } }]
                    : pick(rng, [undefined, [], null, 5]);
          blocks.push({
            type: 'tool_result',
            tool_use_id: `t${n}`,
            ...(chance(rng, 0.3) ? { is_error: chance(rng, 0.5) } : {}),
            ...(chance(rng, 0.2) ? { cache_control: { type: 'ephemeral' }, extra: { nested: [1, 2, { a: null }] } } : {}),
            ...(content === undefined ? {} : { content }),
          });
        }
      }
      messages.push({ role, content: blocks, ...(chance(rng, 0.1) ? { cache_control: { type: 'ephemeral' } } : {}) });
    }
    const keepRecent = chance(rng, 0.9) ? int(rng, 0, 6) : pick(rng, [Number.NaN, -1, 1.5, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 100]);
    const probe = legacy.clearOldToolResults(messages as never, { triggerTokens: 1, keepRecent, clearAtLeastChars: 0 });
    const total = probe.clearedChars;
    const clearAtLeastChars = pick(rng, [total, total + 1, Math.max(0, total - 1), 0, 20, int(rng, 0, 600), Number.NaN, total + 0.5, -5]);
    const policy = { triggerTokens: 1, keepRecent, clearAtLeastChars };

    const before = JSON.stringify(messages);
    const run = (fn: typeof legacy.clearOldToolResults) => {
      const result = fn(messages as never, policy);
      const sameRefs = (result.messages as unknown[]).map((message, index) => (message === messages[index] ? 1 : 0)).join('');
      const sameBlocks = (result.messages as Array<{ content?: unknown }>)
        .map((message, index) => {
          const original = messages[index] as { content?: unknown };
          const originalBlocks = original.content as unknown[];
          return Array.isArray(message.content) && Array.isArray(originalBlocks) ? message.content.map((block, i) => (block === originalBlocks[i] ? 1 : 0)).join('') : '-';
        })
        .join('|');
      return { result, sameRefs, sameBlocks, newArray: result.messages !== (messages as never) };
    };
    const a = run(legacy.clearOldToolResults);
    const b = run(clearOldToolResults);
    expect(JSON.stringify(messages)).toBe(before);
    const expected = outcome(() => ({ ...a.result, refs: a.sameRefs, blocks: a.sameBlocks, newArray: a.newArray }));
    const actual = outcome(() => ({ ...b.result, refs: b.sameRefs, blocks: b.sameBlocks, newArray: b.newArray }));
    compare(tally, 'clearOldToolResults', { messages, policy }, expected, actual, a.result.clearedCount > 0 ? '비움' : total > 0 && clearAtLeastChars > total ? '문턱 못 넘음' : '비울 것 없음');
  },
  estimateTokens(rng, tally) {
    const text = randPrompt(rng);
    const expected = outcome(() => legacy.estimateTokens(text));
    compare(tally, 'estimateTokens', text, expected, outcome(() => estimateTokens(text)), text.length === 0 ? '빈 입력' : '값');
  },
  classify(rng, tally) {
    const prompt = randPrompt(rng);
    const tokens = chance(rng, 0.7) ? legacy.estimateTokens(prompt) : pick(rng, [799, 800, 801, 0, Number.NaN, Number.POSITIVE_INFINITY, 799.5]);
    const expected = outcome(() => ({ c: legacy.classifyComplexity(prompt, tokens), r: legacy.classifyRisk(prompt), t: legacy.classifyTask(prompt) }));
    const actual = outcome(() => ({ c: classifyComplexity(prompt, tokens), r: classifyRisk(prompt), t: classifyTask(prompt) }));
    compare(tally, 'classify', { prompt, tokens }, expected, actual, `${legacy.classifyComplexity(prompt, tokens)}/${legacy.classifyRisk(prompt)}`);
  },
  estimateCost(rng, tally) {
    const profile = randProfile(rng, 'm');
    const usage = {
      inputTokens: pick(rng, [0, 1, 1000, 123456, int(rng, 0, 100000), 0.5, Number.NaN]),
      outputTokens: pick(rng, [0, 1, 500, int(rng, 0, 20000), Number.POSITIVE_INFINITY]),
      ...(chance(rng, 0.5) ? { cacheReadTokens: pick(rng, [0, 100, int(rng, 0, 50000), Number.NaN]) } : {}),
      ...(chance(rng, 0.5) ? { cacheWriteTokens: pick(rng, [0, 100, int(rng, 0, 50000)]) } : {}),
    };
    const expected = outcome(() => legacy.estimateCost(profile, usage));
    compare(tally, 'estimateCost', { profile, usage }, expected, outcome(() => estimateCost(profile, usage)), expected === 'ok:undefined' ? '가격 0' : '값');
  },
  aggregateModelStats(rng, tally) {
    const ids = ['gpt-4o', 'claude-sonnet', 'a', 'A', '1', '10', '2', 'm.x', 'k_1', 'z', 'ab'];
    const observations = Array.from({ length: int(rng, 0, 12) }, () => ({
      modelId: pick(rng, ids),
      passed: chance(rng, 0.6),
      latencyMs: pick(rng, [0, 1, 100, 1500.5, int(rng, 0, 20000), -1, Number.NaN, Number.POSITIVE_INFINITY, -0]),
      ...(chance(rng, 0.6) ? { costUsd: pick(rng, [0, 0.01, 0.1234567, 1e-7, int(rng, 0, 100) / 7, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) } : {}),
    }));
    const expected = outcome(() => legacy.aggregateModelStats(observations));
    compare(tally, 'aggregateModelStats', observations, expected, outcome(() => aggregateModelStats(observations)), expected === 'ok:{}' ? '빈 결과' : '값');
  },
  routeModel(rng, tally) {
    const prompt = randPrompt(rng);
    const intent = pick(rng, ['build', 'ask', 'evaluate'] as const);
    const tokens = legacy.estimateTokens(prompt.trim() || 'x');
    const complexity = legacy.classifyComplexity(prompt.trim(), tokens);
    const outputTokens = intent === 'build' ? (complexity === 'complex' ? 4_000 : complexity === 'normal' ? 2_000 : 1_000) : complexity === 'complex' ? 1_500 : 700;
    const needed = tokens + outputTokens;
    const profiles = randProfiles(rng, needed);
    // 64개 이상은 비교 함수가 일관될 때만 같은 순서다(NaN 점수는 63개까지 V8과 같은 순서로 맞췄다)
    const stats: Record<string, ModelStats> = {};
    for (const profile of profiles) {
      if (chance(rng, 0.4)) {
        const runs = pick(rng, [0, 1, 3, int(rng, 0, 50)]);
        const priced = pick(rng, [0, 0, runs, int(rng, 0, runs || 1)]);
        stats[profile.id] = { runs, passes: Math.min(runs, int(rng, 0, runs)), totalLatencyMs: pick(rng, [0, runs * 1234.5, int(rng, 0, 100000), ...(profiles.length < 64 ? [Number.NaN] : [])]), totalCostUsd: pick(rng, [0, priced * 0.0123, int(rng, 0, 1000) / 100, 0.5]), pricedRuns: priced };
      }
    }
    // 예상 비용과 정확히 같은 한도, 컨텍스트 한도와 정확히 같은 토큰 수
    const costs = profiles.map((profile) => legacy.estimateCost(profile, { inputTokens: tokens, outputTokens })).filter((cost): cost is number => cost !== undefined);
    const maxCostUsd = chance(rng, 0.5) ? undefined : pick(rng, [0, 0.0001, 1, Number.NaN, ...costs, ...costs.map((cost) => cost * (1 + 1e-12)), ...costs.map((cost) => cost * (1 - 1e-12))]);
    const request: RouteRequest = {
      prompt,
      intent,
      ...(chance(rng, 0.3) ? { requiredCapabilities: pick(rng, [[], ['tools'], ['tools', 'tools'], ['reasoning', 'tools', 'json'], ['json', 'reasoning', 'long-context', 'reasoning']] as ModelCapability[][]) } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(chance(rng, 0.4) ? { preferredModelId: pick(rng, [...profiles.map((profile) => profile.id), 'nope', '']) } : {}),
    };
    const profileArg = chance(rng, 0.03) ? [] : profiles;
    const statsArg = chance(rng, 0.2) ? undefined : stats;
    const refs = (decision: RoutingDecision, list: readonly ModelProfile[]): string => `${list.indexOf(decision.selected)}/${decision.candidates.map((candidate) => list.indexOf(candidate.model)).join(',')}`;
    const run = (fn: typeof legacy.routeModel): string => {
      try {
        const decision = fn(profileArg, request, statsArg);
        return `${outcome(() => decision)}|refs:${refs(decision, profileArg)}`;
      } catch (error) {
        return `err:${(error as Error).message.toWellFormed()}`;
      }
    };
    const expected = run(legacy.routeModel);
    const actual = run(routeModel);
    const category = expected.startsWith('err:') ? (expected.includes('사용할 수 있는') ? '모델 없음' : '조건 맞는 모델 없음') : request.preferredModelId && expected.includes('사용자가 지정한') ? '지정 모델' : '선택';
    compare(tally, 'routeModel', { profiles: profileArg, request, stats: statsArg }, expected, actual, category);
    if (!expected.startsWith('err:')) {
      const decision = JSON.parse(expected.slice(3, expected.indexOf('|refs:'))) as { selected: { id: string }; candidates: Array<{ eligible: boolean; score: number | object }> };
      tally.buckets[`지표 선택 ${decision.selected.id}`] = (tally.buckets[`지표 선택 ${decision.selected.id}`] ?? 0) + 1;
      // 점수가 정확히 같은 적합 후보가 둘 이상이라 id 정렬이 순서를 정한 입력
      const scores = decision.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.score);
      if (new Set(scores).size < scores.length) tally.buckets['지표 동점 id 정렬'] = (tally.buckets['지표 동점 id 정렬'] ?? 0) + 1;
      if (decision.candidates.some((candidate) => typeof candidate.score === 'object')) tally.buckets['지표 NaN 점수'] = (tally.buckets['지표 NaN 점수'] ?? 0) + 1;
    }
  },
  validateModelProfiles(rng, tally) {
    const input = randValidationInput(rng);
    const expected = outcome(() => legacy.validateModelProfiles(input));
    compare(tally, 'validateModelProfiles', input, expected, outcome(() => validateModelProfiles(input)), expected.startsWith('err:') ? `거절 ${ERROR_KINDS.find((kind) => expected.includes(kind)) ?? '기타'}` : '통과');
  },
  cliRouter(rng, tally) {
    const prompt = randPrompt(rng);
    const intent = pick(rng, ['build', 'ask', 'build', 'evaluate'] as const);
    const stickyTier = pick(rng, [undefined, 'haiku', 'sonnet', 'opus', 'fable', '', 'Opus']) as CliTier | undefined;
    const expected = outcome(() => legacy.routeCliTier({ prompt, intent, stickyTier }));
    compare(tally, 'routeCliTier', { prompt, intent, stickyTier }, expected, outcome(() => routeCliTier({ prompt, intent, stickyTier })), expected.startsWith('err:') ? '빈 요청' : `${JSON.parse(expected.slice(3)).tier}${JSON.parse(expected.slice(3)).stuckTo ? '(유지)' : ''}`);
    const a = pick(rng, [undefined, 'haiku', 'sonnet', 'opus', 'fable', '']) as CliTier | undefined;
    const b = pick(rng, ['haiku', 'sonnet', 'opus', 'fable']) as CliTier;
    const e2 = outcome(() => ({ h: legacy.higherCliTier(a, b), n: legacy.nextCliTier(b), l: legacy.tierLabel(b) }));
    compare(tally, 'tiers', { a, b }, e2, outcome(() => ({ h: higherCliTier(a, b), n: nextCliTier(b), l: tierLabel(b) })), '단계');
  },
};

// ── 모델 입력 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const MODEL_IDS = ['gpt-4o', 'GPT-4o', 'claude-sonnet', 'claude.sonnet', 'claude_sonnet', 'a', 'A', 'a-b', 'ab', 'a1', 'a10', 'a2', 'b', 'B', 'x1', 'X1', 'gemini-2.5', 'Gemini-2.5', 'z9', 'Z9', 'm', 'M', '0', '00', '1', '10', '2', 'a.b', 'a_b', 'A-b', 'a-B'];
const CAPS: ModelCapability[] = ['tools', 'reasoning', 'long-context', 'json'];

function randPricing(rng: Rng): ModelProfile['pricing'] {
  const r = rng();
  if (r < 0.1) return { inputPerMillion: 0, outputPerMillion: 0 };
  if (r < 0.15) return { inputPerMillion: 0, outputPerMillion: 15 };
  if (r < 0.2) return { inputPerMillion: 3, outputPerMillion: 0 };
  return {
    inputPerMillion: pick(rng, [0.15, 3, 5, 2.5, int(rng, 1, 30) / 4, 0.075]),
    outputPerMillion: pick(rng, [0.6, 15, 25, 10, int(rng, 1, 100) / 4]),
    ...(chance(rng, 0.4) ? { cacheReadPerMillion: pick(rng, [0, 0.3, 0.075]) } : {}),
    ...(chance(rng, 0.4) ? { cacheWritePerMillion: pick(rng, [0, 3.75, 1.25]) } : {}),
  };
}

function randProfile(rng: Rng, id: string, needed = 3000): ModelProfile {
  return {
    id,
    provider: pick(rng, ['anthropic', 'openai', 'google'] as const),
    model: `model-${id}`,
    label: pick(rng, [`Label ${id}`, `레이블 ${id}`, `L🙂${id}`]),
    ...(chance(rng, 0.2) ? { enabled: pick(rng, [true, false]) } : {}),
    capabilities: CAPS.filter(() => chance(rng, 0.88)),
    contextWindow: pick(rng, [needed - 1, needed, needed + 1, 200000, 1_000_000, 200000, int(rng, needed, 300000), int(rng, 500, 300000)]),
    pricing: randPricing(rng),
    baselineQuality: pick(rng, [0, 1, 0.5, 0.8, 0.9, int(rng, 0, 100) / 100]),
    baselineLatencyMs: pick(rng, [1, 1000, 4000, 12000, int(rng, 1, 60000), 0.5]),
  };
}

function randProfiles(rng: Rng, needed: number): ModelProfile[] {
  const count = chance(rng, 0.01) ? int(rng, 60, 70) : int(rng, 1, 6);
  const ids = count <= MODEL_IDS.length && chance(rng, 0.9) ? [...MODEL_IDS].sort(() => rng() - 0.5).slice(0, count) : Array.from({ length: count }, () => pick(rng, MODEL_IDS));
  const first = randProfile(rng, ids[0]!, needed);
  return ids.map((id, index) => {
    if (index === 0) return first;
    // 앞 모델을 복제하면 점수가 정확히 같아 id 정렬로 가려진다
    if (chance(rng, 0.45)) return { ...first, id, label: `Label ${id}`, model: `model-${id}`, capabilities: [...first.capabilities], pricing: { ...first.pricing } };
    return randProfile(rng, id, needed);
  });
}

function validProfile(rng: Rng, id: string): Record<string, unknown> {
  return {
    id,
    provider: pick(rng, ['anthropic', 'openai', 'google']),
    model: pick(rng, ['m-1', '  m-2  ', ' m ']),
    label: pick(rng, ['Label', ' 레이블 ', 'L']),
    ...(chance(rng, 0.3) ? { enabled: pick(rng, [true, false, undefined, null, 0]) } : {}),
    capabilities: pick(rng, [['tools'], ['tools', 'tools', 'json'], [], ['json', 'reasoning']]),
    contextWindow: pick(rng, [1, 8000, 200000]),
    pricing: { inputPerMillion: pick(rng, [0, 3, 0.15]), outputPerMillion: pick(rng, [0, 15]), ...(chance(rng, 0.3) ? { cacheReadPerMillion: pick(rng, [0, 0.3, undefined]) } : {}), ...(chance(rng, 0.2) ? { 1: 5, extra: 'x', 10: 1, cacheWritePerMillion: 3 } : {}) },
    baselineQuality: pick(rng, [0, 1, 0.5, -0]),
    baselineLatencyMs: pick(rng, [1, 4000, 0.5]),
    ...(chance(rng, 0.3) ? { apiKeyEnv: pick(rng, ['OPENAI_API_KEY', 'A', 'A'.repeat(128), 'MY_KEY_2', 'OPENAI_API_KEY', 'MY_KEY_2', 'A'.repeat(129), 'lower', '1ABC', '', null, 5, ['A'], 'A B', 'A\n']) } : {}),
    ...(chance(rng, 0.4) ? { baseUrl: pick(rng, ['https://api.example.com/v1/', 'https://api.example.com//', 'http://localhost:3000', 'http://127.0.0.1/x/', 'https://api.example.com', 'https://x.com/a/', 'http://[::1]:80', 'http://example.com', 'ftp://x.com', 'not a url', 'https://u:p@x.com', 'https://user@x.com', '', null, 'HTTP://LOCALHOST/', '/', 'https://x.com\n', 'https://api.example.com/v1/', 'https://api.example.com/v2', 'https://b.example.com/']) } : {}),
  };
}

function randValidationInput(rng: Rng): unknown {
  const r = rng();
  if (r < 0.04) return pick(rng, [undefined, null, 5, 'x', {}, [], [null], [1], ['a'], [[]], [0]]);
  const count = int(rng, 1, 3);
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) items.push(validProfile(rng, chance(rng, 0.04) && i > 0 ? (items[0]!['id'] as string) : pick(rng, ['gpt-4o', 'claude.sonnet', 'a_b', 'Z9', 'x'.repeat(64), '9a', 'm1', 'k-2', `n${i}`, `p${i}`, `q${i}`, `r${i}`, `s${i}`, `t${i}`, ...(chance(rng, 0.15) ? ['x'.repeat(65), '-a', 'a b', '한글', 'a\n', '.a'] : [`u${i}`, 'x'.repeat(63)])])));
  // 일부 필드를 망가뜨린다
  if (chance(rng, 0.4)) {
    const target = pick(rng, items);
    const field = pick(rng, ['id', 'provider', 'model', 'label', 'capabilities', 'contextWindow', 'pricing', 'baselineQuality', 'baselineLatencyMs', 'apiKeyEnv', 'baseUrl', 'pricing.inputPerMillion', 'pricing.outputPerMillion', 'pricing.cacheReadPerMillion', 'pricing.cacheWritePerMillion']);
    const bad = pick(rng, [undefined, null, 0, -1, 1.5, 2, Number.NaN, Number.POSITIVE_INFINITY, '', ' ', 'x', 'tools', true, [], ['bogus'], ['tools', 1], {}, [1], -0, 1e308]);
    if (field.startsWith('pricing.')) {
      if (target['pricing'] && typeof target['pricing'] === 'object') (target['pricing'] as Record<string, unknown>)[field.slice(8)] = bad;
    } else target[field] = bad;
    if (bad === undefined) delete target[field];
  }
  if (chance(rng, 0.03)) items[int(rng, 0, items.length - 1)] = pick(rng, [null, 5, 'x', [], undefined]) as never;
  return items;
}

const ERROR_KINDS = ['id가 올바르지', '겹칩니다', 'provider', 'model이', 'label이', 'capabilities', 'contextWindow', 'baselineQuality', 'baselineLatencyMs', 'pricing이', 'inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'apiKeyEnv', 'baseUrl이 올바른', 'http(s) 주소', 'https를', '배열이어야', '객체가 아닙니다'];

const REQUIRED_BUCKETS: Record<string, string[]> = {
  clipCommandOutput: ['자름', '안 자름'],
  clipText: ['자름', '안 자름'],
  visibleHtml: ['벗김', '그대로', '빈 입력'],
  isHtmlContent: ['ok:true', 'ok:false'],
  repeatNote: ['ok', 'ok:true', 'ok:false'],
  clearedToolResultNote: ['ok', 'ok:true', 'ok:false'],
  contextClearingFromEnv: ['꺼짐', '켜짐'],
  clearOldToolResults: ['비움', '문턱 못 넘음', '비울 것 없음'],
  estimateTokens: ['값', '빈 입력'],
  classify: ['simple/normal', 'normal/normal', 'complex/normal', 'simple/high', 'normal/high', 'complex/high'],
  estimateCost: ['값', '가격 0'],
  aggregateModelStats: ['값', '빈 결과'],
  routeModel: ['선택', '지정 모델', '조건 맞는 모델 없음', '모델 없음'],
  validateModelProfiles: ['통과', ...ERROR_KINDS.map((kind) => `거절 ${kind}`)],
  cliRouter: ['opus', 'sonnet', 'haiku', 'opus(유지)', '빈 요청'],
};

// ── 실행 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// 일부러 무거운 성질·차등 시험이다(전체 코드 포인트, 긴 패치). 기본 5초는 따로 돌려도 부하 23에서 4초대라 전체 실행 때 넘는다
describe('토큰 예산·모델 선택: 옛 TS 구현과 Rust 껍데기의 차등 시험', { timeout: 120_000 }, () => {
  for (const [name, run] of Object.entries(CASES)) {
    it(`${name}: 같은 입력에 같은 결과(JSON 글자, 키 순서 포함)`, () => {
      const total: Tally = newTally();
      for (const seed of SEEDS) {
        const rng = mulberry32(seed * 1000 + name.length);
        const tally = newTally();
        for (let n = 0; n < ITERATIONS; n++) run(rng, tally);
        total.runs += tally.runs;
        total.differ += tally.differ;
        total.first.push(...tally.first);
        for (const [key, value] of Object.entries(tally.buckets)) total.buckets[key] = (total.buckets[key] ?? 0) + value;
        if (REPORT) console.log(`[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 분포 ${JSON.stringify(tally.buckets)}`);
      }
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      // 입력이 한쪽으로 쏠리지 않았는지: 함수마다 꼭 나와야 하는 결과가 각각 전체의 일정 비율 이상이다
      for (const bucket of REQUIRED_BUCKETS[name] ?? []) expect(total.buckets[bucket] ?? 0, `${name}: '${bucket}'`).toBeGreaterThanOrEqual(total.runs * (name === 'classify' ? 0.01 : name === 'validateModelProfiles' ? 0.003 : 0.02));
      if (name === 'routeModel') {
        expect(Object.keys(total.buckets).filter((key) => key.startsWith('지표 선택 ')).length).toBeGreaterThanOrEqual(15);
        expect(total.buckets['지표 동점 id 정렬'] ?? 0).toBeGreaterThanOrEqual(total.runs * 0.03);
        expect(total.buckets['지표 NaN 점수'] ?? 0).toBeGreaterThan(0);
      }
    });
  }

  it('대조 장치: 값 하나나 키 순서만 바꾼 "새 결과"도 차이로 잡는다', () => {
    const rng = mulberry32(9);
    const tally = newTally();
    for (let n = 0; n < 200; n++) {
      const profiles = randProfiles(rng, 3000);
      const request: RouteRequest = { prompt: 'login page', intent: 'build' };
      const expected = outcome(() => legacy.routeModel(profiles, request));
      if (expected.startsWith('err:')) continue;
      // 점수의 마지막 자리 하나, 키 순서, 이유 한 글자
      compare(tally, 'ulp', profiles, expected, expected.replace(/"score":([0-9.]+)/, (_m, d: string) => `"score":${Number(d) + Number.EPSILON}`), 'ulp');
      compare(tally, 'order', profiles, expected, expected.replace('"complexity":"simple","risk":"normal"', '"risk":"normal","complexity":"simple"'), 'order');
      compare(tally, 'reason', profiles, expected, expected.replace('예상 지연', '예상 지연 '), 'reason');
    }
    expect(tally.runs).toBeGreaterThan(300);
    expect(tally.differ).toBe(tally.runs);
  });

  it('참조 동일성: 고른 모델과 후보의 model은 입력 배열의 같은 객체다', () => {
    const profiles: ModelProfile[] = [
      { id: 'a', provider: 'anthropic', model: 'a', label: 'A', capabilities: ['tools'], contextWindow: 100000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.5, baselineLatencyMs: 1000, extra: { keep: 'me' } } as ModelProfile,
      { id: 'b', provider: 'openai', model: 'b', label: 'B', capabilities: ['tools'], contextWindow: 100000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.4, baselineLatencyMs: 1000 },
    ];
    const decision = routeModel(profiles, { prompt: 'hello', intent: 'build' });
    expect(decision.selected).toBe(profiles[0]);
    expect(decision.candidates.map((candidate) => candidate.model)).toEqual(profiles);
    expect(decision.candidates[0]!.model).toBe(profiles[0]);
    expect((decision.selected as unknown as { extra: unknown }).extra).toEqual({ keep: 'me' });
  });
});

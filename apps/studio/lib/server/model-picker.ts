/**
 * 대화 입력창의 모델 선택(#271 다음 요청, #283 다음 노력 단계). 세션 백엔드마다 고를 수 있는 모델 목록과
 * 노력(추론 강도) 단계를 만든다.
 *
 * claude-code는 로그인한 계정의 Claude Code가 실제로 보고하는 목록(Claude Agent SDK의 `supportedModels()`,
 * claude-code-models.ts가 1시간 캐시한다)을 그대로 보여준다 — 별칭이 실제로 풀리는 모델 id·설명·노력 단계 지원 여부가
 * CLI 버전·로그인 계정마다 달라질 수 있어, 스튜디오가 표를 미리 외우는 대신 그때그때 물어본다. 목록을 못 불러오면(CLI
 * 없음·로그인 안 됨·타임아웃) `CLAUDE_CODE_ALIASES`(2026-09-30 E8 실험에서 관측·확인한 값, ADR-089)로 되돌아간다.
 * codex는 스튜디오가 미리 아는 모델 목록이 없어 기본만 내려준다. commandcode·opencode는 각 CLI가 돌려주는
 * 목록(이미 세션을 만들 때 쓰던 목록)을 그대로 재사용한다. api는 모델 레지스트리(model-registry.ts)에서 인증 정보가
 * 설정된 모델만 추린다.
 *
 * **노력 단계.** 낮음/보통/높음/최대 네 단계로 통일해서 보여준다(0단계 근거는 각 백엔드 러너 코드에 있다).
 *  - claude-code: Claude Agent SDK의 `effort` 옵션이 그대로 `low|medium|high|xhigh|max`를 받는다
 *    (node_modules/@anthropic-ai/claude-agent-sdk의 sdk.d.ts `EffortLevel`). xhigh는 이 네 단계 UI에 넣지 않는다.
 *    모델마다 지원 여부가 다를 수 있어(`ModelInfo.supportedEffortLevels`, 예: Haiku는 없다) 고른 모델 기준으로
 *    판단한다. 세션이 노력 단계를 고르지 않았을 때 실제로 쓰이는 기본값(`DEFAULT_CLAUDE_CODE_EFFORT`, 현재 '높음')도
 *    `EffortPickerView.defaultLevel`로 함께 내려줘, 화면이 "보통"이 아니라 실제 기본값을 보여줄 수 있게 한다.
 *  - codex: `codex exec`에 `-c model_reasoning_effort=<level>`로 넘기는 것과 같은 값을 SDK의
 *    `ThreadOptions.modelReasoningEffort`가 그대로 받는다(`minimal|low|medium|high|xhigh|max|ultra|persistent`).
 *    고르지 않으면 플래그 자체를 넘기지 않아(CLI 자체 기본값에 맡긴다) `defaultLevel`이 없다.
 *  - commandcode: 실제 CLI(`cmd --help`)가 `--effort low|medium|high|xhigh|max`를 그대로 받는다(docs/getting-started.md).
 *    codex와 같은 이유로 `defaultLevel`이 없다.
 *  - opencode: 실제 CLI(`opencode run --help`)가 `--variant <level>`을 받는다("model variant (provider-specific
 *    reasoning effort, e.g., high, max, minimal)") — 제공자·모델마다 실제로 받아들이는 값이 다를 수 있어 note로 알린다.
 *    같은 이유로 `defaultLevel`이 없다.
 *  - api: Anthropic 클라이언트(anthropic-client.ts)만 `output_config.effort`로 실제로 보낸다. OpenAI 호환·Google
 *    클라이언트(provider-clients.ts)는 이 옵션을 보내는 자리가 없어 지원하지 않는다고 그대로 알린다.
 *  - demo: 모델을 부르지 않으므로 지원하지 않는다.
 */
import { DEFAULT_CLAUDE_CODE_EFFORT, type Effort, type ModelInfo, type ModelPricing } from '@b-studio/agent';
import type { SessionMode } from '../studio-events';
import { loadClaudeCodeModels } from './claude-code-models';
import { listStudioCommandCodeModels } from './commandcode-models';
import { listModelOptions } from './model-registry';
import { listStudioOpenCodeModels, OPENCODE_LOGIN_HINT } from './opencode-models';

export interface ModelPickerOption {
  /** 세션에 저장할 값. 빈 문자열은 "기본"(오버라이드 없음)을 뜻한다 */
  id: string;
  label: string;
  hint?: string;
  /** 강점을 짧게 표시하는 배지(권장·빠름·저렴·깊은 추론). 근거가 없는 백엔드(commandcode·opencode)에는 없다 */
  badges?: string[];
  /** 별칭이 실제로 풀리는 모델 id(관측값). claude-code에만 있다 */
  resolvedId?: string;
  /** 공식 단가(백만 토큰당 USD). 실측하지 않은 값은 넣지 않는다 */
  price?: ModelPricing;
  /** 알려진 컨텍스트 창(토큰). 모델 레지스트리에 있는 api 모델에만 있다 */
  contextWindow?: number;
  /** 공급자(anthropic·openai·google). api 백엔드에서 공급자별로 묶어 보여줄 때 쓴다 */
  provider?: string;
  /** 이 모델(옵션)이 노력 단계를 지원하는지. 백엔드 전체 지원 여부(effort.supported)와 다를 수 있다(api는 모델마다 다르다) */
  supportsEffort?: boolean;
  /** 지금은 고를 수 없다(로그인 안 됨 등) */
  disabled?: boolean;
  disabledReason?: string;
}

/** 화면에 보여주는 노력 단계 네 가지. SDK·CLI가 더 세분화해도(xhigh 등) 고르는 자리는 이 넷으로 통일한다 */
export type EffortLevel = Extract<Effort, 'low' | 'medium' | 'high' | 'max'>;

export interface EffortLevelOption {
  id: EffortLevel;
  label: string;
  /** 트레이드오프를 짧게 설명한다(느리지만 더 깊게 / 빠르고 싸게) */
  hint: string;
}

export const EFFORT_LEVELS: readonly EffortLevelOption[] = [
  { id: 'low', label: '낮음', hint: '빠르고 싸게 — 간단한 작업에 맞습니다' },
  { id: 'medium', label: '보통', hint: '속도와 깊이의 기본 균형' },
  { id: 'high', label: '높음', hint: '느리지만 더 깊게 생각합니다' },
  { id: 'max', label: '최대', hint: '가장 느리고 비싸지만 가장 깊게 생각합니다' },
];

export interface EffortPickerView {
  /** 이 백엔드(·api는 지금 고른 모델)에서 노력 단계를 바꿀 수 있는지 */
  supported: boolean;
  /** 지원하지 않을 때 보여줄 이유(툴팁 문구) */
  reason?: string;
  /** 세션에 저장된 값. 없으면 백엔드·클라이언트 기본값을 그대로 쓴다 */
  current?: EffortLevel;
  /** 고를 수 있는 단계. supported가 false면 빈 배열 */
  levels: readonly EffortLevelOption[];
  /** 지원은 하지만 실제 적용이 모델·제공자마다 다를 수 있다는 부가 안내(opencode) */
  note?: string;
  /**
   * `current`가 없을 때(아직 아무것도 고르지 않았을 때) 실제로 쓰이는 노력 단계. 러너가 그 값을 리터럴로
   * 기본 인자에 박아 둔 백엔드(지금은 claude-code, `DEFAULT_CLAUDE_CODE_EFFORT`)만 안다 — 그 값을 모르는
   * 백엔드(codex·commandcode·opencode는 플래그 자체를 넘기지 않아 CLI 자체 기본값에 맡긴다)는 없다.
   * 화면은 `current`가 없을 때 "보통"을 지어내는 대신 이 값을 "기본(⟨라벨⟩)"으로 보여줘야 한다.
   */
  defaultLevel?: EffortLevel;
}

export interface ModelPickerView {
  backend: SessionMode;
  /** 세션에 저장된 값. 없으면 "기본" */
  current?: string;
  options: ModelPickerOption[];
  /** 백엔드 전체에 걸리는 안내(예: 목록을 불러오지 못함, 무료만 모드) */
  note?: string;
  /** 이 백엔드·지금 고른 모델의 노력 단계 선택지 */
  effort: EffortPickerView;
}

const DEFAULT_LABEL = '기본';
const NOT_SUPPORTED_REASON = '이 백엔드는 노력 단계를 지원하지 않습니다';

/**
 * Claude Code 별칭 — 목록을 불러오지 못했을 때만 쓰는 대체 표(ADR-089). 평소에는 loadClaudeCodeModels()가
 * 로그인한 계정의 Claude Code에게 직접 물어본 값을 쓰고, 이 표는 CLI가 없거나 로그인이 안 됐거나 타임아웃일 때만 쓰인다.
 * E8에서 관측한 대로: opus → claude-opus-5, sonnet → claude-sonnet-5, haiku → claude-haiku-4-5.
 * fable → claude-fable-5-1은 2026-10-01 Claude Code 2.1.285에서 `claude -p --model fable`의 modelUsage로 확인했다.
 * 단가는 E8이 확인한 공식 단가다(입력/출력, 백만 토큰당 USD). fable은 공식 단가를 확인하지 못해 비워 둔다(지어내지 않는다) —
 * 같은 실행에서 캐시 쓰기 27,468토큰이 $0.55로 찍혀 opus보다 비싸다는 것만 안다.
 * 이름에 버전을 붙여 보여준다 — "Opus"만으로는 어느 세대인지 알 수 없다는 피드백.
 */
const CLAUDE_CODE_ALIASES: ModelPickerOption[] = [
  {
    id: 'fable',
    label: 'Fable 5.1',
    hint: '가장 새롭고 강한 모델입니다. Opus보다 비쌉니다',
    badges: ['최신'],
    resolvedId: 'claude-fable-5-1',
  },
  {
    id: 'opus',
    label: 'Opus 5',
    hint: '어려운 설계·디버깅에 강합니다',
    badges: ['깊은 추론'],
    resolvedId: 'claude-opus-5',
    price: { inputPerMillion: 5, outputPerMillion: 25 },
  },
  {
    id: 'sonnet',
    label: 'Sonnet 5',
    hint: '대부분의 작업에 균형 잡힌 선택입니다',
    badges: ['권장'],
    resolvedId: 'claude-sonnet-5',
    price: { inputPerMillion: 2, outputPerMillion: 10 },
  },
  {
    id: 'haiku',
    label: 'Haiku 4.5',
    hint: '가장 저렴하고 빠릅니다. 작은 수정에 적합합니다',
    badges: ['빠름', '저렴'],
    resolvedId: 'claude-haiku-4-5',
    price: { inputPerMillion: 1, outputPerMillion: 5 },
  },
];

/** opus·sonnet·haiku·fable 계열의 한국어 안내 — resolvedId 접두어(claude-code 옵션)·label 부분 문자열(api 레지스트리 옵션)
 * 양쪽에서 같은 표를 쓴다. 같은 모델이면 두 백엔드에서 같은 안내가 나와야 하기 때문이다 */
type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';
const FAMILY_INFO: Record<ClaudeFamily, { hint: string; badges: string[] }> = {
  opus: { hint: '어려운 설계·디버깅에 강합니다', badges: ['깊은 추론'] },
  sonnet: { hint: '대부분의 작업에 균형 잡힌 선택입니다', badges: ['권장'] },
  haiku: { hint: '가장 저렴하고 빠릅니다. 작은 수정에 적합합니다', badges: ['빠름', '저렴'] },
  fable: { hint: '가장 새롭고 강한 모델입니다. Opus보다 비쌉니다', badges: ['최신'] },
};

/** 예전에 저장된 세션 값(옛 별칭)이 지금의 어느 계열에 해당하는지 — SDK가 돌려주는 실제 id가 바뀌어도(예: "opus" → "opus[1m]") 이 계열 이름은 그대로다 */
const LEGACY_CLAUDE_CODE_ALIAS: Record<string, ClaudeFamily> = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' };

/** claude-code 옵션의 resolvedId(예: "claude-opus-5[1m]", "claude-haiku-4-5-20251001") 접두어로 계열을 가른다 */
function claudeFamilyOfResolvedId(resolvedId: string | undefined): ClaudeFamily | undefined {
  if (!resolvedId) return undefined;
  if (resolvedId.startsWith('claude-opus')) return 'opus';
  if (resolvedId.startsWith('claude-sonnet')) return 'sonnet';
  if (resolvedId.startsWith('claude-haiku')) return 'haiku';
  if (resolvedId.startsWith('claude-fable')) return 'fable';
  return undefined;
}

/** 실측한 공식 단가(입력/출력, 백만 토큰당 USD). resolvedId의 "[1m]"·날짜 접미사(-YYYYMMDD)를 지운 뒤 정확히
 * 일치할 때만 쓴다. 확인하지 못한 모델(예: Fable)은 이 표에 없다 — 단가를 지어내지 않는다 */
const KNOWN_CLAUDE_MODEL_PRICES: Record<string, ModelPricing> = {
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

function normalizeResolvedId(resolvedId: string): string {
  return resolvedId.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
}

function priceForResolvedId(resolvedId: string | undefined): ModelPricing | undefined {
  return resolvedId ? KNOWN_CLAUDE_MODEL_PRICES[normalizeResolvedId(resolvedId)] : undefined;
}

/**
 * SDK 설명의 첫 세그먼트( " · " 앞)에서 버전 이름을 뽑는다. "Opus 5 with 1M context"처럼 컨텍스트 창을 풀어
 * 쓴 표현은 "Opus 5 · 1M"으로 줄인다. 파싱할 수 없으면 SDK의 displayName을 그대로 쓴다.
 */
export function parseClaudeCodeVersionLabel(description: string, displayName: string): string {
  const firstSegment = description.split(' · ')[0]?.trim();
  if (!firstSegment) return displayName;
  const withContext = /^(.*) with 1M context$/i.exec(firstSegment);
  return withContext ? `${withContext[1]} · 1M` : firstSegment;
}

/** ModelInfo 하나를 화면이 쓰는 ModelPickerOption으로 옮긴다. value === ''는 SDK의 "기본" 행이다 */
export function mapClaudeCodeModel(info: ModelInfo): ModelPickerOption {
  const versionLabel = parseClaudeCodeVersionLabel(info.description, info.displayName);
  const family = claudeFamilyOfResolvedId(info.resolvedModel);
  const known = family ? FAMILY_INFO[family] : undefined;
  const isDefault = info.value === '';
  const supportsEffort = (info.supportedEffortLevels?.length ?? 0) > 0;
  return {
    id: info.value,
    label: isDefault ? `${DEFAULT_LABEL} (${versionLabel})` : versionLabel,
    hint: isDefault ? `로그인한 계정의 기본 모델을 그대로 씁니다 (지금은 ${versionLabel})` : (known?.hint ?? info.description),
    badges: isDefault ? undefined : known?.badges,
    resolvedId: info.resolvedModel,
    price: priceForResolvedId(info.resolvedModel),
    supportsEffort,
  };
}

/** modelId(현재 값 또는 예전 별칭)에 해당하는 옵션을 찾는다. 값으로 먼저 찾고, 없으면 별칭 계열(resolvedId 접두어)로 찾는다 */
function findClaudeCodeOption(options: readonly ModelPickerOption[], modelId: string | undefined): ModelPickerOption | undefined {
  if (!modelId) return undefined;
  const byValue = options.find((option) => option.id === modelId);
  if (byValue) return byValue;
  const family = LEGACY_CLAUDE_CODE_ALIAS[modelId];
  if (!family) return undefined;
  // "기본"(id === '')은 계열 매칭에서 뺀다 — 지금은 우연히 opus로 풀려도, 예전에 "Opus"를 직접 고른 세션이
  // "기본"으로 보이면(둘 다 같은 계열이라 나중에 기본이 바뀌면 더 어긋난다) 사용자가 고른 것과 다르게 보인다
  return options.find((option) => option.id !== '' && claudeFamilyOfResolvedId(option.resolvedId) === family);
}

interface ClaudeCodeModelsView {
  options: ModelPickerOption[];
  note?: string;
}

const CLAUDE_CODE_FALLBACK_NOTE_PREFIX = '모델 목록을 불러오지 못해 알려진 목록을 보여줍니다';

/**
 * claude-code 옵션 목록. 로그인한 계정의 Claude Code에게 실제로 물어보고(loadClaudeCodeModels, 1시간 캐시),
 * 실패하면(CLI 없음·로그인 안 됨·타임아웃) CLAUDE_CODE_ALIASES로 되돌아가 이유를 note에 남긴다.
 */
async function getClaudeCodeModelOptions(): Promise<ClaudeCodeModelsView> {
  const { models, error } = await loadClaudeCodeModels();
  if (!models || models.length === 0) {
    return {
      options: [{ id: '', label: DEFAULT_LABEL, hint: '로그인한 계정의 기본 모델을 그대로 씁니다' }, ...CLAUDE_CODE_ALIASES],
      note: error ? `${CLAUDE_CODE_FALLBACK_NOTE_PREFIX}: ${error}` : CLAUDE_CODE_FALLBACK_NOTE_PREFIX,
    };
  }
  const options = models.map(mapClaudeCodeModel);
  // SDK가 "기본" 행을 주지 않는(이론상) 경우를 대비한 안전망 — 평소에는 SDK 응답에 이미 들어 있다
  if (!options.some((option) => option.id === '')) {
    options.unshift({ id: '', label: DEFAULT_LABEL, hint: '로그인한 계정의 기본 모델을 그대로 씁니다' });
  }
  return { options };
}

/**
 * 이 세션 백엔드에서 고를 수 있는 모델 목록. current는 세션에 저장된 값을 그대로 돌려준다(화면 표시용).
 * currentEffort는 세션에 저장된 노력 단계(화면 표시용) — 고를 수 있는지는 backend(·api는 현재 modelId)로 따로 판단한다.
 */
export async function listSelectableModels(backend: SessionMode, current?: string, currentEffort?: string): Promise<ModelPickerView> {
  if (backend === 'demo') {
    // 데모는 준비된 대본을 실행할 뿐 모델을 부르지 않는다. 고를 것도, 노력을 조절할 것도 없다
    return {
      backend,
      current,
      options: [{ id: '', label: DEFAULT_LABEL, hint: '데모 모드는 준비된 대본을 그대로 실행합니다' }],
      effort: await effortPickerFor(backend, current, currentEffort),
    };
  }
  if (backend === 'claude-code') {
    const { options, note } = await getClaudeCodeModelOptions();
    // 예전에 저장된 세션 값이 옛 별칭(opus 등)이면 지금의 어느 옵션에 해당하는지로 바꿔서 돌려준다 —
    // 화면은 option.id === current로 체크 표시를 매기므로, 값이 안 바뀌면 체크 표시가 사라져 보인다
    const matched = findClaudeCodeOption(options, current);
    const normalizedCurrent = matched ? matched.id : current;
    return {
      backend,
      current: normalizedCurrent,
      options,
      note,
      effort: await effortPickerFor(backend, normalizedCurrent, currentEffort, options),
    };
  }
  if (backend === 'codex') {
    return {
      backend,
      current,
      options: [{ id: '', label: DEFAULT_LABEL, hint: 'Codex에 로그인한 계정의 기본 모델을 그대로 씁니다' }],
      note: 'Codex는 스튜디오가 미리 아는 모델 목록이 없어 기본만 고를 수 있습니다. 서버 환경 변수(B_STUDIO_CODEX_MODEL)로 다른 모델을 고정할 수 있습니다',
      effort: await effortPickerFor(backend, current, currentEffort),
    };
  }
  if (backend === 'commandcode') {
    const { models, freeOnly, error } = await listStudioCommandCodeModels();
    return {
      backend,
      current,
      options: [
        { id: '', label: DEFAULT_LABEL, hint: 'Command Code 계정의 기본 모델을 그대로 씁니다' },
        ...models.map((model) => ({ id: model.id, label: model.id, hint: describeCliModel(model.group, model.description, model.free) })),
      ],
      note: error ? `모델 목록을 불러오지 못해 기본만 고를 수 있습니다: ${error}` : freeOnly ? '무료 모델만 고를 수 있도록 설정돼 있습니다' : undefined,
      effort: await effortPickerFor(backend, current, currentEffort),
    };
  }
  if (backend === 'opencode') {
    const { models, freeOnly, error } = await listStudioOpenCodeModels();
    const usable = models.filter((model) => model.usable);
    return {
      backend,
      current,
      options: [
        { id: '', label: DEFAULT_LABEL, hint: 'OpenCode가 고르는 기본 모델을 그대로 씁니다' },
        ...usable.map((model) => ({ id: model.id, label: model.id, hint: describeCliModel(model.group, model.description, model.free) })),
      ],
      note: error ? `모델 목록을 불러오지 못해 기본만 고를 수 있습니다: ${error}` : usable.length === 0 ? OPENCODE_LOGIN_HINT : freeOnly ? '무료 모델만 고를 수 있도록 설정돼 있습니다' : undefined,
      effort: await effortPickerFor(backend, current, currentEffort),
    };
  }
  // api
  const models = listModelOptions().filter((model) => model.configured && model.enabled !== false);
  return {
    backend,
    current,
    options: [
      { id: '', label: '자동(라우터)', hint: '설정하지 않으면 요청마다 라우터가 알맞은 모델을 고릅니다', supportsEffort: false },
      ...models.map((model) => {
        const label = model.label || model.id;
        return {
          id: model.id,
          label,
          hint: aliasHint(label),
          badges: badgesFor(label),
          price: model.pricing.inputPerMillion > 0 || model.pricing.outputPerMillion > 0 ? model.pricing : undefined,
          contextWindow: model.contextWindow,
          provider: model.provider,
          supportsEffort: model.provider === 'anthropic',
        };
      }),
    ],
    effort: await effortPickerFor(backend, current, currentEffort),
  };
}

/** 이 백엔드에서 고를 수 있는 값인지(빈 문자열 = 기본은 언제나 허용). PATCH 라우트가 저장하기 전에 확인한다 */
export async function isSelectableModel(backend: SessionMode, modelId: string): Promise<{ ok: true } | { ok: false; reason?: string }> {
  if (!modelId) return { ok: true };
  const picker = await listSelectableModels(backend);
  const found = picker.options.find((option) => option.id === modelId);
  if (!found) return { ok: false };
  if (found.disabled) return { ok: false, reason: found.disabledReason };
  return { ok: true };
}

/**
 * 이 백엔드·모델에서 노력 단계를 고를 수 있는지. PATCH 라우트가 저장하기 전에 확인한다.
 * 빈 문자열(기본)은 언제나 허용한다.
 */
export async function isSelectableEffort(backend: SessionMode, modelId: string | undefined, effort: string): Promise<{ ok: true } | { ok: false; reason?: string }> {
  if (!effort) return { ok: true };
  const picker = await effortPickerFor(backend, modelId, undefined);
  if (!picker.supported) return { ok: false, reason: picker.reason ?? NOT_SUPPORTED_REASON };
  if (!picker.levels.some((level) => level.id === effort)) return { ok: false, reason: `이 백엔드에서 고를 수 없는 노력 단계입니다: ${effort}` };
  return { ok: true };
}

/** claude-code에서 세션이 노력 단계를 고르지 않았을 때 실제로 쓰이는 값(runClaudeCodeAgent의 기본 인자와 같다) */
const CLAUDE_CODE_DEFAULT_EFFORT_LEVEL = asEffortLevel(DEFAULT_CLAUDE_CODE_EFFORT);

/**
 * 이 백엔드(·api는 modelId로 고른 모델)에서 노력 단계 선택지를 만든다. 0단계 근거는 파일 머리말에 적었다.
 * claude-code는 옵션 목록을 이미 들고 있으면(listSelectableModels가 넘겨준다) 다시 불러오지 않고 그걸 쓴다 —
 * isSelectableEffort처럼 목록 없이 부르면 그때만 다시 불러온다(캐시돼 있어 비용이 크지 않다).
 */
export async function effortPickerFor(
  backend: SessionMode,
  modelId: string | undefined,
  current: string | undefined,
  claudeCodeOptions?: readonly ModelPickerOption[],
): Promise<EffortPickerView> {
  const currentLevel = asEffortLevel(current);
  if (backend === 'claude-code') {
    if (modelId) {
      const options = claudeCodeOptions ?? (await getClaudeCodeModelOptions()).options;
      const matched = findClaudeCodeOption(options, modelId);
      if (matched && matched.supportsEffort === false) {
        return { supported: false, current: currentLevel, levels: [], reason: '이 모델은 노력 단계를 지원하지 않습니다' };
      }
    }
    return { supported: true, current: currentLevel, levels: EFFORT_LEVELS, defaultLevel: CLAUDE_CODE_DEFAULT_EFFORT_LEVEL };
  }
  if (backend === 'codex' || backend === 'commandcode') {
    return { supported: true, current: currentLevel, levels: EFFORT_LEVELS };
  }
  if (backend === 'opencode') {
    return {
      supported: true,
      current: currentLevel,
      levels: EFFORT_LEVELS,
      note: '모델·제공자마다 실제로 받아들이는 값이 다를 수 있습니다(OpenCode의 --variant)',
    };
  }
  if (backend === 'api') {
    if (!modelId) {
      return { supported: false, current: currentLevel, levels: [], reason: '기본(라우터)에서는 노력 단계를 고를 수 없습니다. Anthropic 모델을 직접 고르면 쓸 수 있습니다' };
    }
    const model = listModelOptions().find((option) => option.id === modelId);
    if (model?.provider === 'anthropic') return { supported: true, current: currentLevel, levels: EFFORT_LEVELS };
    return { supported: false, current: currentLevel, levels: [], reason: '이 모델은 노력 단계를 지원하지 않습니다(Anthropic API 모델만 지원합니다)' };
  }
  // demo
  return { supported: false, current: currentLevel, levels: [], reason: NOT_SUPPORTED_REASON };
}

function asEffortLevel(value: string | undefined): EffortLevel | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max' ? value : undefined;
}

function describeCliModel(group: string, description: string, free: boolean): string {
  return `${group} · ${description}${free ? ' · 무료' : ''}`;
}

/** 이름에 opus·sonnet·haiku·fable이 들어간 API 레지스트리 모델은 claude-code와 같은 계열 안내를 준다(같은 모델이라 성격이 같다) */
function familyOfLabel(label: string): ClaudeFamily | undefined {
  const lower = label.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('fable')) return 'fable';
  return undefined;
}

function aliasHint(label: string): string | undefined {
  const family = familyOfLabel(label);
  return family ? FAMILY_INFO[family].hint : undefined;
}

/** claude-code와 같은 배지 규칙(이름에 opus·sonnet·haiku·fable이 들어간 api 모델에만 붙는다) */
function badgesFor(label: string): string[] | undefined {
  const family = familyOfLabel(label);
  return family ? FAMILY_INFO[family].badges : undefined;
}

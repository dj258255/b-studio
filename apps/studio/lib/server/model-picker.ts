/**
 * 대화 입력창의 모델 선택(#271 다음 요청). 세션 백엔드마다 고를 수 있는 모델 목록을 만든다.
 *
 * claude-code는 스튜디오가 아는 별칭(opus·sonnet·haiku)만 보여준다. 별칭이 실제로 풀리는 모델 id와 공식 단가는
 * E8 실험(2026-09-30)에서 관측·확인한 값이다(docs/experiments/2026-09-30-e8-plan-execute-split.md) — 추정치가 아니라
 * 그 실행에서 모델별 사용량에 그대로 찍힌 값이다. codex는 스튜디오가 미리 아는 모델 목록이 없어 기본만 내려준다.
 * commandcode·opencode는 각 CLI가 돌려주는 목록(이미 세션을 만들 때 쓰던 목록)을 그대로 재사용한다.
 * api는 모델 레지스트리(model-registry.ts)에서 인증 정보가 설정된 모델만 추린다.
 */
import type { ModelPricing } from '@b-studio/agent';
import type { SessionMode } from '../studio-events';
import { listStudioCommandCodeModels } from './commandcode-models';
import { listModelOptions } from './model-registry';
import { listStudioOpenCodeModels, OPENCODE_LOGIN_HINT } from './opencode-models';

export interface ModelPickerOption {
  /** 세션에 저장할 값. 빈 문자열은 "기본"(오버라이드 없음)을 뜻한다 */
  id: string;
  label: string;
  hint?: string;
  /** 별칭이 실제로 풀리는 모델 id(관측값). claude-code에만 있다 */
  resolvedId?: string;
  /** 공식 단가(백만 토큰당 USD). 실측하지 않은 값은 넣지 않는다 */
  price?: ModelPricing;
  /** 지금은 고를 수 없다(로그인 안 됨 등) */
  disabled?: boolean;
  disabledReason?: string;
}

export interface ModelPickerView {
  backend: SessionMode;
  /** 세션에 저장된 값. 없으면 "기본" */
  current?: string;
  options: ModelPickerOption[];
  /** 백엔드 전체에 걸리는 안내(예: 목록을 불러오지 못함, 무료만 모드) */
  note?: string;
}

const DEFAULT_LABEL = '기본';

/**
 * Claude Code 별칭. E8에서 관측한 대로: opus → claude-opus-5, sonnet → claude-sonnet-5, haiku → claude-haiku-4-5.
 * 단가는 그 실험이 확인한 공식 단가다(입력/출력, 백만 토큰당 USD). Claude Code가 별칭을 바꾸면 이 표도 따라 바뀔 수 있다.
 */
const CLAUDE_CODE_ALIASES: ModelPickerOption[] = [
  {
    id: 'opus',
    label: 'Opus',
    hint: '어려운 설계·디버깅에 강합니다',
    resolvedId: 'claude-opus-5',
    price: { inputPerMillion: 5, outputPerMillion: 25 },
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    hint: '대부분의 작업에 균형 잡힌 선택입니다',
    resolvedId: 'claude-sonnet-5',
    price: { inputPerMillion: 2, outputPerMillion: 10 },
  },
  {
    id: 'haiku',
    label: 'Haiku',
    hint: '가장 저렴하고 빠릅니다. 작은 수정에 적합합니다',
    resolvedId: 'claude-haiku-4-5',
    price: { inputPerMillion: 1, outputPerMillion: 5 },
  },
];

/** 이 세션 백엔드에서 고를 수 있는 모델 목록. current는 세션에 저장된 값을 그대로 돌려준다(화면 표시용) */
export async function listSelectableModels(backend: SessionMode, current?: string): Promise<ModelPickerView> {
  if (backend === 'demo') {
    // 데모는 준비된 대본을 실행할 뿐 모델을 부르지 않는다. 고를 것이 없다
    return { backend, current, options: [{ id: '', label: DEFAULT_LABEL, hint: '데모 모드는 준비된 대본을 그대로 실행합니다' }] };
  }
  if (backend === 'claude-code') {
    return {
      backend,
      current,
      options: [{ id: '', label: DEFAULT_LABEL, hint: '로그인한 계정의 기본 모델을 그대로 씁니다' }, ...CLAUDE_CODE_ALIASES],
    };
  }
  if (backend === 'codex') {
    return {
      backend,
      current,
      options: [{ id: '', label: DEFAULT_LABEL, hint: 'Codex에 로그인한 계정의 기본 모델을 그대로 씁니다' }],
      note: 'Codex는 스튜디오가 미리 아는 모델 목록이 없어 기본만 고를 수 있습니다. 서버 환경 변수(B_STUDIO_CODEX_MODEL)로 다른 모델을 고정할 수 있습니다',
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
    };
  }
  // api
  const models = listModelOptions().filter((model) => model.configured && model.enabled !== false);
  return {
    backend,
    current,
    options: [
      { id: '', label: DEFAULT_LABEL, hint: '설정하지 않으면 요청마다 라우터가 알맞은 모델을 고릅니다' },
      ...models.map((model) => ({
        id: model.id,
        label: model.label || model.id,
        hint: aliasHint(model.label || model.id),
        price: model.pricing.inputPerMillion > 0 || model.pricing.outputPerMillion > 0 ? model.pricing : undefined,
      })),
    ],
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

function describeCliModel(group: string, description: string, free: boolean): string {
  return `${group} · ${description}${free ? ' · 무료' : ''}`;
}

/** 이름에 opus·sonnet·haiku가 들어간 API 레지스트리 모델은 claude-code와 같은 안내를 준다(같은 모델이라 성격이 같다) */
function aliasHint(label: string): string | undefined {
  const lower = label.toLowerCase();
  if (lower.includes('opus')) return '어려운 설계·디버깅에 강합니다';
  if (lower.includes('sonnet')) return '대부분의 작업에 균형 잡힌 선택입니다';
  if (lower.includes('haiku')) return '가장 저렴하고 빠릅니다. 작은 수정에 적합합니다';
  return undefined;
}

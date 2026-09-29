/**
 * 스튜디오의 OpenCode 모델 목록.
 *
 * 러너의 `listOpenCodeModels()`(`opencode models` 파싱)를 10분 캐시해 화면에 내려주고,
 * 세션을 만들 때 고른 모델 id를 검증한다.
 *
 * 무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절되므로(3단계 실측) `usable: false`로 내려보내 화면에서 고를 수 없게 한다.
 * 정상 경로는 로그인한 제공자의 모델이다. "무료 모델만" 필터는 다른 제공자의 무료 모델을 위해 남기되 기본값은 꺼 둔다.
 * CLI가 없으면 빈 목록과 이유를 돌려주고, 그때의 세션 모델 검증은 id 형식만 본다.
 */
import { listOpenCodeModels, type OpenCodeModel } from '@b-studio/agent';
import { StudioError } from './errors';

/** 목록을 다시 불러오기까지의 간격 */
export const OPENCODE_MODELS_TTL_MS = 10 * 60_000;

/** 쓸 수 있는 모델이 하나도 없을 때 화면에 보여줄 안내 */
export const OPENCODE_LOGIN_HINT = '쓸 수 있는 모델이 없습니다. 터미널에서 `opencode auth login`으로 제공자에 로그인한 뒤 세션을 시작하세요.';

/** 무료만 모드를 켜는 값. 기본은 꺼짐이다(3단계 결정) */
const FREE_ONLY_ON = new Set(['1', 'true']);

/** 목록을 못 불러왔을 때만 쓰는 모델 id 형식 */
export const OPENCODE_MODEL_ID = /^[a-z0-9._:/-]{1,120}$/;

/** 화면에 내려줄 모델 한 줄. commandcode 목록과 같은 모양이라 화면 컴포넌트를 함께 쓴다 */
export interface OpenCodeModelView {
  id: string;
  description: string;
  group: string;
  free: boolean;
  isDefault: boolean;
  /** 쓸 수 있는지. false면 화면에서 비활성으로 두고 `reason`을 보여준다 */
  usable: boolean;
  reason?: string;
}

export interface OpenCodeModels {
  models: OpenCodeModelView[];
  freeOnly: boolean;
  /** 목록을 불러오지 못한 이유(CLI 없음 등). 있으면 models는 빈 목록이다 */
  error?: string;
}

/**
 * 무료만 모드 여부. 기본은 꺼짐이고 `B_STUDIO_OPENCODE_FREE_ONLY=1`(또는 `true`)이면 켠다.
 * 무료 Zen 모델은 쓸 수 없으므로(usable=false) 이 필터는 다른 제공자의 무료 모델을 고를 때만 쓴다.
 */
export function freeOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return FREE_ONLY_ON.has(env.B_STUDIO_OPENCODE_FREE_ONLY?.trim().toLowerCase() ?? '');
}

/** 지금 실행 모드가 opencode인지. 라우트의 사용자 입력 검증에만 쓴다 */
export function openCodeMode(env: Record<string, string | undefined> = process.env): boolean {
  return (env.B_STUDIO_MODE?.trim() || 'api') === 'opencode';
}

/** 러너 모델을 화면 모델로 바꾼다. opencode에는 기본 표시가 없어 isDefault는 항상 false다 */
export function toStudioModel(model: OpenCodeModel): OpenCodeModelView {
  return { id: model.id, description: model.name, group: model.provider, free: model.free, isDefault: false, usable: model.usable, ...(model.reason ? { reason: model.reason } : {}) };
}

/** 무료만 모드로 걸러낸다 */
export function filterFreeModels(models: readonly OpenCodeModelView[], freeOnly: boolean): OpenCodeModelView[] {
  return freeOnly ? models.filter((model) => model.free) : [...models];
}

/** 쓸 수 있는 모델이 하나도 없는지. 화면이 로그인 안내를 보여줄지 정한다 */
export function hasUsableModel(models: readonly OpenCodeModelView[]): boolean {
  return models.some((model) => model.usable);
}

/**
 * `opencode models` 결과를 ttl 동안 캐시한다. 실패는 던져서 캐시하지 않으므로 다음 요청에서 다시 시도한다.
 * `load`·`now`를 주입해 테스트에서 시간과 하위 프로세스를 바꿔 끼운다.
 */
export function createOpenCodeModelsCache(options: { load?: () => Promise<OpenCodeModel[]>; now?: () => number; ttlMs?: number } = {}) {
  const load = options.load ?? (() => listOpenCodeModels());
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? OPENCODE_MODELS_TTL_MS;
  let cached: { at: number; models: OpenCodeModelView[] } | undefined;
  return {
    async list(): Promise<OpenCodeModelView[]> {
      if (cached && now() - cached.at < ttlMs) return cached.models;
      const models = (await load()).map(toStudioModel);
      cached = { at: now(), models };
      return models;
    },
  };
}

const defaultCache = createOpenCodeModelsCache();

/** 목록 로딩 결과. 실패는 던지지 않고 이유로 돌려준다 */
async function loadModels(): Promise<{ models?: OpenCodeModelView[]; error?: string }> {
  try {
    return { models: await defaultCache.list() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 라우트가 화면에 내려줄 목록. 무료만 모드면 무료만 담고, 실패는 빈 목록과 이유로 돌려준다 */
export async function listStudioOpenCodeModels(): Promise<OpenCodeModels> {
  const freeOnly = freeOnlyEnabled();
  const { models, error } = await loadModels();
  if (!models) return { models: [], freeOnly, ...(error ? { error } : {}) };
  return { models: filterFreeModels(models, freeOnly), freeOnly };
}

/** 모델 선택 검증의 결과. 실패면 세션을 만들지 않는다(라우트가 400으로 바꾼다) */
export type ModelSelection = { ok: true; modelId?: string; warning?: string } | { ok: false; message: string };

/**
 * 모델 선택을 검증한다(순수 함수).
 * 목록이 있으면 그 안의 id만 허용하고, `freeOnly`면 무료가 아닌 id를, 쓸 수 없는 id(`usable: false`)를 거부한다.
 * 목록을 못 불러왔으면(CLI 없음 등) id 형식만 보고 경고를 남긴다.
 */
export function checkOpenCodeModelId(input: { modelId?: string; models?: readonly OpenCodeModelView[]; freeOnly: boolean }): ModelSelection {
  const id = input.modelId?.trim();
  if (!id) return { ok: true };
  const models = input.models;
  if (models && models.length > 0) {
    const found = models.find((model) => model.id === id);
    if (!found) return { ok: false, message: `모델 목록에 없는 id입니다: ${id}` };
    if (input.freeOnly && !found.free) return { ok: false, message: '무료 모델만 쓰도록 설정돼 있습니다' };
    if (!found.usable) return { ok: false, message: found.reason ?? `이 모델은 지금 쓸 수 없습니다: ${id}` };
    return { ok: true, modelId: id };
  }
  if (!OPENCODE_MODEL_ID.test(id)) return { ok: false, message: `모델 id 형식이 올바르지 않습니다: ${id}` };
  return { ok: true, modelId: id, warning: '모델 목록을 불러오지 못해 id 형식만 확인했습니다' };
}

/** 세션 모델 우선순위: 세션에서 고른 모델 → `B_STUDIO_OPENCODE_MODEL` → 없음(러너가 모델을 요구한다) */
export function resolveOpenCodeModel(selected: string | undefined, envModel: string | undefined): string | undefined {
  return selected?.trim() || envModel?.trim() || undefined;
}

/**
 * 라우트가 사용자 입력 `modelId`를 검증한다. 목록을 못 불러오면 형식만 보고 경고만 남긴다.
 * 검증에 실패하면 `StudioError(400)`을 던져 세션을 만들지 않는다.
 */
export async function validateOpenCodeModelSelection(modelId: string | undefined): Promise<string | undefined> {
  const { models } = await loadModels();
  const check = checkOpenCodeModelId({ modelId, models, freeOnly: freeOnlyEnabled() });
  if (!check.ok) throw new StudioError(400, check.message);
  if (check.warning) console.warn(`[b-studio] ${check.warning}`);
  return check.modelId;
}

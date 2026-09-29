/**
 * 스튜디오의 Command Code 모델 목록.
 *
 * 러너의 `listCommandCodeModels()`(`cmd --list-models` 파싱)를 10분 캐시해 화면에 내려주고,
 * 세션을 만들 때 고른 모델 id를 검증한다. `B_STUDIO_CMD_FREE_ONLY=1`이면 무료 모델만 돌려준다.
 * 로그인하지 않았거나 CLI가 없으면 빈 목록과 이유를 돌려주고, 그때의 세션 모델 검증은 id 형식만 본다.
 */
import { listCommandCodeModels, type CommandCodeModel } from '@b-studio/agent';
import { StudioError } from './errors';

/** 목록을 다시 불러오기까지의 간격 */
export const COMMAND_CODE_MODELS_TTL_MS = 10 * 60_000;

/** `B_STUDIO_CMD_FREE_ONLY`가 켜져 있으면 무료 모델만 쓴다 */
const FREE_ONLY_VALUES = new Set(['1', 'true']);

/** 목록을 못 불러왔을 때만 쓰는 모델 id 형식 */
export const COMMAND_CODE_MODEL_ID = /^[a-z0-9._:/-]{1,120}$/;

export interface CommandCodeModels {
  models: CommandCodeModel[];
  freeOnly: boolean;
  /** 목록을 불러오지 못한 이유(로그인 안 됨 등). 있으면 models는 빈 목록이다 */
  error?: string;
}

export function freeOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return FREE_ONLY_VALUES.has(env.B_STUDIO_CMD_FREE_ONLY?.trim().toLowerCase() ?? '');
}

/** 지금 실행 모드가 commandcode인지. 라우트의 사용자 입력 검증에만 쓴다 */
export function commandCodeMode(env: Record<string, string | undefined> = process.env): boolean {
  return (env.B_STUDIO_MODE?.trim() || 'api') === 'commandcode';
}

/** 무료만 모드로 걸러낸다 */
export function filterFreeModels(models: readonly CommandCodeModel[], freeOnly: boolean): CommandCodeModel[] {
  return freeOnly ? models.filter((model) => model.free) : [...models];
}

/**
 * `cmd --list-models` 결과를 ttl 동안 캐시한다. 실패는 던져서 캐시하지 않으므로 다음 요청에서 다시 시도한다.
 * `load`·`now`를 주입해 테스트에서 시간과 하위 프로세스를 바꿔 끼운다.
 */
export function createCommandCodeModelsCache(options: { load?: () => Promise<CommandCodeModel[]>; now?: () => number; ttlMs?: number } = {}) {
  const load = options.load ?? (() => listCommandCodeModels());
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? COMMAND_CODE_MODELS_TTL_MS;
  let cached: { at: number; models: CommandCodeModel[] } | undefined;
  return {
    async list(): Promise<CommandCodeModel[]> {
      if (cached && now() - cached.at < ttlMs) return cached.models;
      const models = await load();
      cached = { at: now(), models };
      return models;
    },
  };
}

const defaultCache = createCommandCodeModelsCache();

/** 목록 로딩 결과. 실패는 던지지 않고 이유로 돌려준다 */
async function loadModels(): Promise<{ models?: CommandCodeModel[]; error?: string }> {
  try {
    return { models: await defaultCache.list() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 라우트가 화면에 내려줄 목록. 무료만 모드면 무료만 담고, 실패는 빈 목록과 이유로 돌려준다 */
export async function listStudioCommandCodeModels(): Promise<CommandCodeModels> {
  const freeOnly = freeOnlyEnabled();
  const { models, error } = await loadModels();
  if (!models) return { models: [], freeOnly, ...(error ? { error } : {}) };
  return { models: filterFreeModels(models, freeOnly), freeOnly };
}

/** 모델 선택 검증의 결과. 실패면 세션을 만들지 않는다(라우트가 400으로 바꾼다) */
export type ModelSelection = { ok: true; modelId?: string; warning?: string } | { ok: false; message: string };

/**
 * 모델 선택을 검증한다(순수 함수).
 * 목록이 있으면 그 안의 id만 허용하고, `freeOnly`면 무료가 아닌 id를 거부한다.
 * 목록을 못 불러왔으면(로그인 안 됨 등) id 형식만 보고 경고를 남긴다.
 */
export function checkCommandCodeModelId(input: { modelId?: string; models?: readonly CommandCodeModel[]; freeOnly: boolean }): ModelSelection {
  const id = input.modelId?.trim();
  if (!id) return { ok: true };
  const models = input.models;
  if (models && models.length > 0) {
    const found = models.find((model) => model.id === id);
    if (!found) return { ok: false, message: `모델 목록에 없는 id입니다: ${id}` };
    if (input.freeOnly && !found.free) return { ok: false, message: '무료 모델만 쓰도록 설정돼 있습니다' };
    return { ok: true, modelId: id };
  }
  if (!COMMAND_CODE_MODEL_ID.test(id)) return { ok: false, message: `모델 id 형식이 올바르지 않습니다: ${id}` };
  return { ok: true, modelId: id, warning: '모델 목록을 불러오지 못해 id 형식만 확인했습니다' };
}

/** 세션 모델 우선순위: 세션에서 고른 모델 → `B_STUDIO_CMD_MODEL` → 없음(계정 기본) */
export function resolveCommandCodeModel(selected: string | undefined, envModel: string | undefined): string | undefined {
  return selected?.trim() || envModel?.trim() || undefined;
}

/**
 * 라우트가 사용자 입력 `modelId`를 검증한다. 목록을 못 불러오면 형식만 보고 경고만 남긴다.
 * 검증에 실패하면 `StudioError(400)`을 던져 세션을 만들지 않는다.
 */
export async function validateCommandCodeModelSelection(modelId: string | undefined): Promise<string | undefined> {
  const { models } = await loadModels();
  const check = checkCommandCodeModelId({ modelId, models, freeOnly: freeOnlyEnabled() });
  if (!check.ok) throw new StudioError(400, check.message);
  if (check.warning) console.warn(`[b-studio] ${check.warning}`);
  return check.modelId;
}

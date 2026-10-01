/**
 * 스튜디오의 Claude Code(로컬 Claude Agent) 모델 목록.
 *
 * 러너의 `fetchClaudeCodeModels()`(Claude Agent SDK의 `supportedModels()`)를 1시간 캐시해 화면에 내려준다.
 * 로그인한 계정·CLI 버전이 실제로 지원하는 별칭(opus·sonnet·haiku·fable 등)과 새 모델이 생기면 자동으로 반영되고,
 * 목록을 못 불러오면(CLI 없음·로그인 안 됨·타임아웃) model-picker.ts가 들고 있는 알려진 표로 되돌아간다
 * (단가·지원 여부를 지어내지 않기 위해 여기서는 원본 ModelInfo만 그대로 돌려주고, ModelPickerOption으로 옮기는 일은
 * model-picker.ts가 맡는다 — commandcode-models.ts/opencode-models.ts와 같은 나눔이다).
 *
 * 동시에 여러 요청이 들어와도(화면을 여러 탭에서 열거나 모델·노력 단계를 연달아 확인할 때) CLI를 두 번 부르지 않도록
 * 진행 중인 호출 하나를 공유한다(in-flight 중복 제거).
 */
import { fetchClaudeCodeModels, type ModelInfo } from '@b-studio/agent';

/** 목록을 다시 불러오기까지의 간격 */
export const CLAUDE_CODE_MODELS_TTL_MS = 60 * 60_000;

/** supportedModels()가 이 시간 안에 응답하지 않으면 실패로 본다(사용자가 화면을 여는 동안 계속 기다리게 하지 않는다) */
export const CLAUDE_CODE_MODELS_TIMEOUT_MS = 15_000;

/**
 * `fetchClaudeCodeModels()` 결과를 ttl 동안 캐시하고, 캐시가 비어 있는 동안 들어온 동시 요청은 진행 중인 호출
 * 하나를 함께 기다린다(Claude Code 프로세스를 여러 번 띄우지 않는다). 실패는 캐시하지 않아 다음 요청에서 다시 시도한다.
 * `load`·`now`를 주입해 테스트에서 시간과 SDK 호출을 바꿔 끼운다.
 */
export function createClaudeCodeModelsCache(options: { load?: () => Promise<ModelInfo[]>; now?: () => number; ttlMs?: number } = {}) {
  const load = options.load ?? (() => fetchClaudeCodeModels({ timeoutMs: CLAUDE_CODE_MODELS_TIMEOUT_MS }));
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? CLAUDE_CODE_MODELS_TTL_MS;
  let cached: { at: number; models: ModelInfo[] } | undefined;
  let inFlight: Promise<ModelInfo[]> | undefined;
  return {
    async list(): Promise<ModelInfo[]> {
      if (cached && now() - cached.at < ttlMs) return cached.models;
      if (inFlight) return inFlight;
      const attempt = load()
        .then((models) => {
          cached = { at: now(), models };
          return models;
        })
        .finally(() => {
          if (inFlight === attempt) inFlight = undefined;
        });
      inFlight = attempt;
      return attempt;
    },
  };
}

const defaultCache = createClaudeCodeModelsCache();

/** 목록 로딩 결과. 실패는 던지지 않고 이유로 돌려준다(model-picker.ts가 알려진 표로 되돌아간다) */
export async function loadClaudeCodeModels(): Promise<{ models?: ModelInfo[]; error?: string }> {
  try {
    return { models: await defaultCache.list() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

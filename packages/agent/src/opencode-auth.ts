import { run } from './cli-exec';
import { cliPreflightFailure, type CliPreflightFailure } from './cli-failure';

/** 실제 실행할 CLI. 이 PC에 설치된 `opencode`를 그대로 쓴다 */
export const COMMAND = 'opencode';

/** `listOpenCodeModels`가 무료 Zen 모델에 붙이는 쓸 수 없음 이유 */
export const OPENCODE_FREE_UNUSABLE_REASON = '무료 Zen 티어는 b-studio 구성(내장 도구 끔)을 거절합니다';
/** 모델을 고르지 않았을 때의 오류. 기본 모델을 추측하지 않는다(무료 Zen 모델을 기본값으로 두지 않는다) */
export const OPENCODE_MODEL_REQUIRED = 'OpenCode 모델을 골라야 합니다. -m <provider/model> 또는 B_STUDIO_OPENCODE_MODEL로 지정하세요';

/**
 * 샌드박스를 띄우기 전에 이 PC의 OpenCode CLI가 있는지 확인한다.
 * `opencode --version`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 */
export async function preflightOpenCode({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<{ ok: true } | CliPreflightFailure> {
  try {
    await run(command, ['--version'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return cliPreflightFailure(`OpenCode CLI를 찾지 못했습니다. 터미널에서 "${command}"가 실행되는지 확인하세요.`, error);
  }
}

export interface OpenCodeModel {
  /** `provider/model` 형식의 전체 id */
  id: string;
  /** 마지막 `/` 뒤의 짧은 이름 */
  name: string;
  /** 제공자(`opencode` 등) */
  provider: string;
  /** 이름에 `free`가 들어가는 무료 모델인지 */
  free: boolean;
  /** b-studio가 이 모델을 쓸 수 있는지. 무료 Zen(`opencode` 제공자 + free)은 내장 도구를 끈 구성에서 거절돼 false다(3단계 실측) */
  usable: boolean;
  /** 쓸 수 없을 때의 이유 */
  reason?: string;
}

/**
 * `opencode models` 텍스트를 파싱한다(순수 함수). 한 줄에 `provider/model` 하나이고 설명·기본 표시는 없다.
 * 무료 여부는 이름에 `free`가 들어가는지로만 본다(0단계 근거). `--verbose`의 JSON은 쓰지 않는다.
 * `usable`은 지금까지 확인한 사실만 반영한다: `opencode` 제공자의 무료 모델은 b-studio 구성에서 거절된다(3단계).
 */
export function parseOpenCodeModels(text: string): OpenCodeModel[] {
  const models: OpenCodeModel[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    // `provider/model` 형식만 받는다. 경고·안내 줄은 버린다
    const match = /^([a-z0-9][\w.-]*)\/([\w.:@+-]+)$/i.exec(id);
    if (!match) continue;
    seen.add(id);
    const provider = match[1]!;
    const name = match[2]!;
    const free = /free/i.test(name);
    // 무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절되므로 쓸 수 없다
    const gated = provider === 'opencode' && free;
    models.push(gated ? { id, name, provider, free, usable: false, reason: OPENCODE_FREE_UNUSABLE_REASON } : { id, name, provider, free, usable: true });
  }
  return models;
}

/** 이 PC에서 쓸 수 있는 OpenCode 모델 목록. `opencode models` 텍스트를 파싱한다(모델 호출 없음) */
export async function listOpenCodeModels({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<OpenCodeModel[]> {
  return parseOpenCodeModels(await run(command, ['models'], timeoutMs));
}

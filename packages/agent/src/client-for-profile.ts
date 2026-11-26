import { AnthropicModelClient, type Effort } from './anthropic-client';
import type { ModelClient } from './agent-types';
import type { ModelProfile } from './model-router';
import { createProviderClient } from './provider-clients';

/** 모델 설정이 키를 읽는 환경 변수 이름(설정에 없으면 공급자의 기본 이름) */
export function apiKeyEnvName(profile: ModelProfile): string {
  return profile.apiKeyEnv ?? (profile.provider === 'openai' ? 'OPENAI_API_KEY' : profile.provider === 'google' ? 'GOOGLE_API_KEY' : 'ANTHROPIC_API_KEY');
}

/**
 * 모델 설정으로 클라이언트를 만든다. 키는 process.env가 아니라 넘겨 받은 env에서만 읽는다
 * (스튜디오 서버는 process.env를, 자체 CLI는 모델 파일에서 만든 env를 넘긴다)
 */
export function clientForProfile(profile: ModelProfile, options: { env: Record<string, string | undefined>; effort?: Effort }): ModelClient {
  if (profile.provider === 'anthropic') {
    const name = profile.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    // 두 자격 증명을 모두 밝혀 넘긴다(고르지 않은 쪽과 빈 값은 null). undefined를 넘기면 SDK가 process.env의 키를 대신 읽어
    // 이 설정의 baseUrl로 보낸다 — 넘겨 받은 env에서만 읽는다는 약속이 깨진다
    const credential = options.env[name]?.trim() || null;
    const token = name === 'ANTHROPIC_AUTH_TOKEN';
    return new AnthropicModelClient({
      model: profile.model,
      baseURL: profile.baseUrl,
      apiKey: token ? null : credential,
      authToken: token ? credential : null,
      authLabel: name,
      ...(options.effort ? { effort: options.effort } : {}),
    });
  }
  return createProviderClient({ profile, env: options.env });
}

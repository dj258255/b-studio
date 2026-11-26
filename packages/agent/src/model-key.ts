import type { ModelProfile } from './model-router';

/** 이 컴퓨터(loopback)를 가리키는 호스트. `URL.hostname`은 IPv6를 괄호째 돌려준다(`[::1]`) */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 키 없이 부를 수 있는 모델인가: OpenAI 호환·Google 공급자이고 주소가 이 컴퓨터일 때(Ollama 같은 로컬 서버)다.
 * anthropic은 늘 키가 있어야 한다 — SDK가 키를 받지 못하면 환경 변수의 키로 대신해 그 주소로 보낸다(ADR-225).
 * 클라이언트(provider-clients), 서버(API 모드 터미널의 모델 파일), 자체 CLI가 같은 규칙으로 읽는다. 주소를 읽지 못하면 키가 필요한 것으로 본다
 */
export function keylessLocal(profile: Pick<ModelProfile, 'provider' | 'baseUrl'>): boolean {
  if (profile.provider === 'anthropic' || !profile.baseUrl) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(profile.baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * 세션 백엔드·모델을 설계 파이프라인(ADR-0XX)의 모델 계열로 뭉친다.
 * "검토는 다른 계열 모델이" 원칙을 지키려면 구현·검토가 같은 계열인지 알아야 한다 — claude-code 백엔드와
 * api 백엔드의 anthropic 모델은 둘 다 claude 계열이고, codex·commandcode(DeepSeek)·opencode는 각자 계열이다.
 * 순수 판정(reviewIndependence)은 @b-studio/agent의 design-pipeline.ts에 있다. 여기는 이 서버가 아는
 * SessionMode·모델 레지스트리에서 그 계열을 뽑아내는 자리만 맡는다.
 */
import type { ModelFamily } from '@b-studio/agent';
import type { SessionMode } from '@/lib/studio-events';
import { modelById } from './model-registry';

/**
 * 세션 백엔드와(api 모드면) 모델 레지스트리 id로 모델 계열을 가린다. 레지스트리에 없는 id거나 api인데
 * modelId가 없으면(계획 전 단계 등) 'unknown'을 돌려준다 — 모르는 값으로 "다른 계열"이라고 속단하지 않는다.
 */
export function modelFamily(backend: SessionMode, modelId?: string): ModelFamily {
  if (backend === 'claude-code') return 'claude';
  if (backend === 'codex') return 'openai';
  if (backend === 'commandcode') return 'commandcode';
  if (backend === 'opencode') return 'opencode';
  if (backend === 'api') {
    if (!modelId) return 'unknown';
    try {
      const provider = modelById(modelId).provider;
      if (provider === 'anthropic') return 'claude';
      if (provider === 'openai') return 'openai';
      if (provider === 'google') return 'google';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  // demo는 모델 호출이 없는 대본이라 계열이 없다
  return 'unknown';
}

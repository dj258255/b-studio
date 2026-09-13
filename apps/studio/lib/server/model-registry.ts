import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AnthropicModelClient,
  DEFAULT_MODEL,
  aggregateModelStats,
  createProviderClient,
  routeModel,
  validateModelProfiles,
  type ModelClient,
  type ModelProfile,
  type RouteIntent,
  type RoutingDecision,
} from '@b-studio/agent';
import { observations } from './model-observations';

export interface ModelOption extends ModelProfile {
  configured: boolean;
}

let cached: { key: string; models: ModelProfile[] } | undefined;

export function listModelOptions(): ModelOption[] {
  return loadModels().map((model) => ({ ...model, configured: credentialsConfigured(model) }));
}

export function routingDecision(prompt: string, intent: RouteIntent, preferredModelId?: string): RoutingDecision {
  const models = loadModels().filter((model) => credentialsConfigured(model));
  if (models.length === 0) throw new Error('인증 정보가 설정된 모델이 없습니다. 모델 레지스트리와 서버 환경 변수를 확인하세요');
  return routeModel(models, { prompt, intent, preferredModelId, requiredCapabilities: intent === 'build' ? ['tools'] : [] }, aggregateModelStats(observations()));
}

export function modelById(id: string): ModelProfile {
  const model = loadModels().find((candidate) => candidate.id === id && candidate.enabled !== false);
  if (!model) throw new Error(`모델 레지스트리에 ${id}가 없습니다`);
  return model;
}

export function clientForModel(model: ModelProfile): ModelClient {
  if (model.provider === 'anthropic') {
    const name = model.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const credential = process.env[name]?.trim();
    return new AnthropicModelClient({
      model: model.model,
      baseURL: model.baseUrl,
      ...(name === 'ANTHROPIC_AUTH_TOKEN' ? { authToken: credential } : { apiKey: credential }),
      authLabel: name,
    });
  }
  return createProviderClient({ profile: model });
}

function loadModels(): ModelProfile[] {
  const configuredPath = process.env.B_STUDIO_MODEL_REGISTRY?.trim();
  if (!configuredPath) return [defaultAnthropic()];
  const file = path.resolve(configuredPath);
  const stamp = statSync(file).mtimeMs;
  const key = `${file}:${stamp}`;
  if (cached?.key === key) return cached.models;
  const models = validateModelProfiles(JSON.parse(readFileSync(file, 'utf8')));
  cached = { key, models };
  return models;
}

function defaultAnthropic(): ModelProfile {
  return {
    id: 'anthropic-default',
    provider: 'anthropic',
    model: process.env.B_STUDIO_ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    label: 'Claude 기본 모델',
    capabilities: ['tools', 'reasoning', 'long-context', 'json'],
    contextWindow: numberEnv('B_STUDIO_ANTHROPIC_CONTEXT', 200_000),
    // 가격은 공급자가 바꿀 수 있으므로 기본값을 추정하지 않는다. 라우팅에 비용을 쓰려면 레지스트리에 명시한다
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    baselineQuality: 0.9,
    baselineLatencyMs: 5_000,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  };
}

function credentialsConfigured(model: ModelProfile): boolean {
  if (model.baseUrl) {
    const host = new URL(model.baseUrl).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  }
  const name = model.apiKeyEnv ?? (model.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : model.provider === 'openai' ? 'OPENAI_API_KEY' : 'GOOGLE_API_KEY');
  if (process.env[name]?.trim()) return true;
  // Anthropic SDK가 지원하는 표준 토큰·프로필 인증도 기존 단일 세션과 동일하게 인정한다
  return (
    model.provider === 'anthropic' &&
    (Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_PROFILE?.trim()) || existsSync(path.join(homedir(), '.config', 'anthropic')))
  );
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

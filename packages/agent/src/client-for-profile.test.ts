import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientForProfile } from './client-for-profile';
import type { ModelProfile } from './model-router';

const base = { label: 'x', contextWindow: 1000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.5, baselineLatencyMs: 100, capabilities: ['tools'] as ModelProfile['capabilities'] };
const request = { system: 's', tools: [], messages: [{ role: 'user' as const, content: 'hi' }] };

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const seen: Headers[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

describe('clientForProfile', () => {
  it('openai는 process.env가 아니라 넘긴 env의 키를 쓴다', async () => {
    const seen = stubFetch();
    vi.stubEnv('OPENAI_API_KEY', 'from-process-env');
    const profile: ModelProfile = { ...base, id: 'o', provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' };
    await clientForProfile(profile, { env: { OPENAI_API_KEY: 'from-options' } }).createMessage(request).catch(() => undefined);
    expect(seen[0]?.get('authorization')).toBe('Bearer from-options');
    vi.unstubAllEnvs();
  });

  it('anthropic은 이름이 ANTHROPIC_AUTH_TOKEN이면 Bearer 토큰으로, 아니면 x-api-key로 보낸다', async () => {
    const seen = stubFetch();
    const token: ModelProfile = { ...base, id: 'a', provider: 'anthropic', model: 'm', baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' };
    await clientForProfile(token, { env: { ANTHROPIC_AUTH_TOKEN: 'tok-1' } }).createMessage(request).catch(() => undefined);
    const key: ModelProfile = { ...token, apiKeyEnv: undefined };
    await clientForProfile(key, { env: { ANTHROPIC_API_KEY: 'key-1' } }).createMessage(request).catch(() => undefined);
    expect(seen[0]?.get('authorization')).toBe('Bearer tok-1');
    expect(seen[0]?.get('x-api-key')).toBeNull();
    expect(seen[1]?.get('x-api-key')).toBe('key-1');
  });

  it('anthropic은 process.env의 키·토큰을 대신 읽지 않는다(고르지 않은 쪽, 빈 값 모두)', async () => {
    const seen = stubFetch();
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token');
    const key: ModelProfile = { ...base, id: 'a', provider: 'anthropic', model: 'm', baseUrl: 'http://127.0.0.1:9' };
    await clientForProfile(key, { env: { ANTHROPIC_API_KEY: 'key-1' } }).createMessage(request).catch(() => undefined);
    await clientForProfile(key, { env: { ANTHROPIC_API_KEY: '  ' } }).createMessage(request).catch(() => undefined);
    await clientForProfile({ ...key, apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' }, { env: { ANTHROPIC_AUTH_TOKEN: 'tok-1' } }).createMessage(request).catch(() => undefined);
    vi.unstubAllEnvs();
    const headers = seen.flatMap((h) => [h.get('authorization'), h.get('x-api-key')]).filter(Boolean);
    expect(headers.join(' ')).not.toMatch(/env-key|env-token/);
    expect(seen[0]?.get('x-api-key')).toBe('key-1');
    expect(seen.at(-1)?.get('authorization')).toBe('Bearer tok-1');
  });
});

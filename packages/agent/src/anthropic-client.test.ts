import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicModelClient } from './anthropic-client';

// 개발자 PC에 실제 인증 정보가 있으면 이 테스트는 의미가 없으므로 건너뛴다
const hasCredentials =
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE) ||
  existsSync(path.join(homedir(), '.config/anthropic'));

describe('AnthropicModelClient.preflight', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
  });

  it.skipIf(hasCredentials)('인증 정보가 없으면 예외 대신 안내 메시지를 돌려준다', async () => {
    // 혹시 요청이 나가더라도 외부로 나가지 않게 막는다
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

    const result = await new AnthropicModelClient().preflight();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('ANTHROPIC_API_KEY');
  });
});

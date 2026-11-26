import { describe, expect, it } from 'vitest';
import { keylessLocal } from './model-key';

describe('keylessLocal', () => {
  it('OpenAI 호환·Google이 이 컴퓨터 주소면 키 없이 된다(IPv6는 괄호째 읽는다)', () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:11434/v1', 'https://LOCALHOST/v1']) {
      expect(keylessLocal({ provider: 'openai', baseUrl }), baseUrl).toBe(true);
      expect(keylessLocal({ provider: 'google', baseUrl }), baseUrl).toBe(true);
    }
  });

  it('anthropic, 주소 없음, 다른 호스트, 읽지 못하는 주소는 키가 필요하다', () => {
    expect(keylessLocal({ provider: 'anthropic', baseUrl: 'http://127.0.0.1:8080' })).toBe(false);
    expect(keylessLocal({ provider: 'openai' })).toBe(false);
    for (const baseUrl of ['https://api.example.com/v1', 'http://127.0.0.2/v1', 'http://localhost.example.com/v1', 'http://0.0.0.0/v1', 'not a url']) {
      expect(keylessLocal({ provider: 'openai', baseUrl }), baseUrl).toBe(false);
    }
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { parseDotenv, Redactor, resolveSecrets, SecretError } from './secrets';

const PROJECT = {
  secrets: [
    ['PAYMENT_API_KEY', { services: ['api'] }],
    ['WEBHOOK_TOKEN', { services: ['api'] }],
  ],
} as unknown as LoadedProject;

describe('resolveSecrets', () => {
  it('서버 환경 변수가 시크릿 파일보다 우선한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'secrets-test-'));
    const file = path.join(dir, 'orders.env');
    await writeFile(file, '# 결제 테스트 키\nPAYMENT_API_KEY="sk_test_from_file_123"\nexport WEBHOOK_TOKEN=whk_from_file_4567\n');

    const values = await resolveSecrets(PROJECT, { env: { B_STUDIO_SECRET_PAYMENT_API_KEY: 'sk_test_from_env_999' }, file });

    expect(values).toEqual({ PAYMENT_API_KEY: 'sk_test_from_env_999', WEBHOOK_TOKEN: 'whk_from_file_4567' });
  });

  it('빠지거나 짧은 값을 한꺼번에 알려 주고, 메시지에 값을 넣지 않는다', async () => {
    const error = await resolveSecrets(PROJECT, { env: { B_STUDIO_SECRET_WEBHOOK_TOKEN: 'short1' } }).then(
      () => expect.unreachable(),
      (e: unknown) => e as SecretError,
    );

    expect(error).toBeInstanceOf(SecretError);
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toMatch(/^PAYMENT_API_KEY: 값이 없습니다/);
    expect(error.issues[1]).toMatch(/^WEBHOOK_TOKEN: 8자보다 짧은 값/);
    expect(error.message).not.toContain('short1');
  });

  it('시크릿을 선언하지 않은 프로젝트는 아무것도 읽지 않는다', async () => {
    await expect(resolveSecrets({ secrets: [] } as unknown as LoadedProject, { file: '/nonexistent/secrets.env' })).resolves.toEqual({});
  });
});

describe('parseDotenv', () => {
  it('주석과 빈 줄을 건너뛰고 따옴표 한 쌍만 벗긴다', () => {
    expect(parseDotenv('\n# c\nA=1\nB = "two words"\nC=\'x=y\'\nD="unterminated\nnot a line\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x=y',
      D: '"unterminated',
    });
  });
});

describe('Redactor', () => {
  it('원래 값과 URL 인코딩된 값을 이름으로 가린다', () => {
    const redactor = new Redactor({ PAYMENT_API_KEY: 'sk_test/abc+123', DB_PASSWORD: 'correct horse battery' });

    expect(redactor.redact('key=sk_test/abc+123 url=/pay?key=sk_test%2Fabc%2B123')).toBe(
      'key=[PAYMENT_API_KEY 가림] url=/pay?key=[PAYMENT_API_KEY 가림]',
    );
    expect(redactor.find('password: correct horse battery')).toEqual(['DB_PASSWORD']);
    expect(redactor.find('nothing here')).toEqual([]);
  });

  it('base64로 인코딩한 출력도 앞에 붙은 바이트 수와 상관없이 찾고 가린다', () => {
    const value = 'sk_test_b_studio_4f9a2c71';
    const redactor = new Redactor({ PAYMENT_API_KEY: value });

    // 실측에서 가려지지 않았던 `echo "$PAYMENT_API_KEY" | base64` 출력
    expect(redactor.redact('c2tfdGVzdF9iX3N0dWRpb180ZjlhMmM3MQo=')).toBe('[PAYMENT_API_KEY 가림]Qo=');
    for (const prefix of ['', 'a', 'ab', 'user:', 'api-client:']) {
      const encoded = Buffer.from(`${prefix}${value}\n`).toString('base64');
      expect(redactor.redact(`Authorization: Basic ${encoded}`)).toContain('[PAYMENT_API_KEY 가림]');
      expect(redactor.find(encoded)).toEqual(['PAYMENT_API_KEY']);
    }
  });

  it('한 값이 다른 값을 포함하면 긴 값부터 가린다', () => {
    const redactor = new Redactor({ SHORT_TOKEN: 'abcdefgh', LONG_TOKEN: 'abcdefgh-12345678' });
    expect(redactor.redact('abcdefgh-12345678 / abcdefgh')).toBe('[LONG_TOKEN 가림] / [SHORT_TOKEN 가림]');
  });
});

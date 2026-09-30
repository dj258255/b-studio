import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectModelDefault, rememberProjectModelDefault, resetProjectModelDefaultsCache } from './model-defaults';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b-studio-model-defaults-'));
  process.env.B_STUDIO_MODEL_DEFAULTS_FILE = path.join(dir, 'model-defaults.json');
  resetProjectModelDefaultsCache();
});

afterEach(() => {
  delete process.env.B_STUDIO_MODEL_DEFAULTS_FILE;
  resetProjectModelDefaultsCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('projectModelDefault / rememberProjectModelDefault', () => {
  it('고른 적이 없으면 undefined다(사용자의 저장소가 아니라 스튜디오 상태 폴더에만 남는다)', () => {
    expect(projectModelDefault('orders', 'claude-code')).toBeUndefined();
  });

  it('프로젝트·백엔드별로 따로 기억하고, 다시 읽어도(캐시를 비워도) 남아 있다', () => {
    rememberProjectModelDefault('orders', 'claude-code', 'opus');
    rememberProjectModelDefault('orders', 'api', 'anthropic-sonnet');
    rememberProjectModelDefault('pay', 'claude-code', 'haiku');

    expect(projectModelDefault('orders', 'claude-code')).toBe('opus');
    expect(projectModelDefault('orders', 'api')).toBe('anthropic-sonnet');
    expect(projectModelDefault('pay', 'claude-code')).toBe('haiku');
    // 다른 프로젝트·백엔드 조합에는 새지 않는다
    expect(projectModelDefault('pay', 'api')).toBeUndefined();

    resetProjectModelDefaultsCache();
    expect(projectModelDefault('orders', 'claude-code')).toBe('opus');
  });

  it('"기본"으로 되돌리면(undefined) 빈 문자열로 남겨 다음 세션도 오버라이드 없이 시작한다', () => {
    rememberProjectModelDefault('orders', 'claude-code', 'opus');
    rememberProjectModelDefault('orders', 'claude-code', undefined);

    expect(projectModelDefault('orders', 'claude-code')).toBe('');
  });
});

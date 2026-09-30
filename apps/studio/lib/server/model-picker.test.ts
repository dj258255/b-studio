import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStudioCommandCodeModels: vi.fn(),
  listStudioOpenCodeModels: vi.fn(),
  listModelOptions: vi.fn(),
}));

vi.mock('./commandcode-models', () => ({ listStudioCommandCodeModels: mocks.listStudioCommandCodeModels }));
vi.mock('./opencode-models', () => ({ listStudioOpenCodeModels: mocks.listStudioOpenCodeModels, OPENCODE_LOGIN_HINT: '쓸 수 있는 모델이 없습니다' }));
vi.mock('./model-registry', () => ({ listModelOptions: mocks.listModelOptions }));

import { isSelectableModel, listSelectableModels } from './model-picker';

beforeEach(() => {
  mocks.listStudioCommandCodeModels.mockReset().mockResolvedValue({ models: [], freeOnly: false });
  mocks.listStudioOpenCodeModels.mockReset().mockResolvedValue({ models: [], freeOnly: false });
  mocks.listModelOptions.mockReset().mockReturnValue([]);
});

describe('listSelectableModels', () => {
  it('claude-code: 기본 + opus·sonnet·haiku 별칭을 관측한 실제 모델 id·공식 단가와 함께 내려준다', async () => {
    const picker = await listSelectableModels('claude-code', 'sonnet');

    expect(picker.current).toBe('sonnet');
    expect(picker.options.map((option) => option.id)).toEqual(['', 'opus', 'sonnet', 'haiku']);
    const opus = picker.options.find((option) => option.id === 'opus');
    expect(opus?.resolvedId).toBe('claude-opus-5');
    expect(opus?.price).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
    const sonnet = picker.options.find((option) => option.id === 'sonnet');
    expect(sonnet?.resolvedId).toBe('claude-sonnet-5');
    expect(sonnet?.hint).toContain('균형');
  });

  it('codex: 기본만 내려주고 목록이 없다는 안내를 남긴다', async () => {
    const picker = await listSelectableModels('codex');

    expect(picker.options.map((option) => option.id)).toEqual(['']);
    expect(picker.note).toContain('모델 목록이 없어');
  });

  it('commandcode: 기존 세션 생성 화면이 쓰던 목록(listStudioCommandCodeModels)을 그대로 재사용한다', async () => {
    mocks.listStudioCommandCodeModels.mockResolvedValue({
      models: [{ id: 'poolside/laguna-s-2.1-free', description: '무료 모델', group: 'Open Source', free: true, isDefault: false }],
      freeOnly: false,
    });

    const picker = await listSelectableModels('commandcode');

    expect(picker.options.map((option) => option.id)).toEqual(['', 'poolside/laguna-s-2.1-free']);
    expect(picker.options[1].hint).toContain('무료');
  });

  it('commandcode: 목록을 불러오지 못하면 기본만 남기고 이유를 안내한다', async () => {
    mocks.listStudioCommandCodeModels.mockResolvedValue({ models: [], freeOnly: false, error: '로그인이 필요합니다' });

    const picker = await listSelectableModels('commandcode');

    expect(picker.options.map((option) => option.id)).toEqual(['']);
    expect(picker.note).toContain('로그인이 필요합니다');
  });

  it('opencode: 쓸 수 없는(usable: false) 모델은 목록에서 뺀다', async () => {
    mocks.listStudioOpenCodeModels.mockResolvedValue({
      models: [
        { id: 'zen/free', description: '무료 Zen', group: 'Zen', free: true, isDefault: false, usable: false, reason: '거절됨' },
        { id: 'anthropic/claude', description: '로그인한 제공자', group: 'Anthropic', free: false, isDefault: false, usable: true },
      ],
      freeOnly: false,
    });

    const picker = await listSelectableModels('opencode');

    expect(picker.options.map((option) => option.id)).toEqual(['', 'anthropic/claude']);
  });

  it('api: 인증 정보가 설정된 모델만 추리고, opus·sonnet·haiku가 이름에 들어간 모델은 같은 안내를 준다', async () => {
    mocks.listModelOptions.mockReturnValue([
      { id: 'anthropic-sonnet', label: 'Claude Sonnet', configured: true, pricing: { inputPerMillion: 2, outputPerMillion: 10 } },
      { id: 'not-configured', label: '설정 안 됨', configured: false, pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
    ]);

    const picker = await listSelectableModels('api');

    expect(picker.options.map((option) => option.id)).toEqual(['', 'anthropic-sonnet']);
    expect(picker.options[1].hint).toContain('균형');
    expect(picker.options[1].price).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });
  });

  it('demo: 부를 모델이 없으므로 기본 하나만 내려준다', async () => {
    const picker = await listSelectableModels('demo');
    expect(picker.options.map((option) => option.id)).toEqual(['']);
  });
});

describe('isSelectableModel', () => {
  it('빈 문자열(기본)은 언제나 허용한다', async () => {
    expect(await isSelectableModel('claude-code', '')).toEqual({ ok: true });
  });

  it('목록에 있는 값만 허용한다', async () => {
    expect(await isSelectableModel('claude-code', 'opus')).toEqual({ ok: true });
    expect(await isSelectableModel('claude-code', 'gpt-5')).toEqual({ ok: false });
  });
});

import type { ModelInfo } from '@b-studio/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStudioCommandCodeModels: vi.fn(),
  listStudioOpenCodeModels: vi.fn(),
  listModelOptions: vi.fn(),
  loadClaudeCodeModels: vi.fn(),
}));

vi.mock('./commandcode-models', () => ({ listStudioCommandCodeModels: mocks.listStudioCommandCodeModels }));
vi.mock('./opencode-models', () => ({ listStudioOpenCodeModels: mocks.listStudioOpenCodeModels, OPENCODE_LOGIN_HINT: '쓸 수 있는 모델이 없습니다' }));
vi.mock('./model-registry', () => ({ listModelOptions: mocks.listModelOptions }));
vi.mock('./claude-code-models', () => ({ loadClaudeCodeModels: mocks.loadClaudeCodeModels }));

import { effortPickerFor, isSelectableEffort, isSelectableModel, listSelectableModels } from './model-picker';

/** SDK가 2026-10-01(Claude Code 2.1.285)에 실제로 돌려준 값(작업 지시의 "Facts" 절 그대로) */
const SDK_MODELS: ModelInfo[] = [
  {
    value: '',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'claude-fable-5-1[1m]',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5 · Efficient for routine tasks',
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
    // supportedEffortLevels 없음 — Haiku는 노력 단계를 지원하지 않는다
  },
];

beforeEach(() => {
  mocks.listStudioCommandCodeModels.mockReset().mockResolvedValue({ models: [], freeOnly: false });
  mocks.listStudioOpenCodeModels.mockReset().mockResolvedValue({ models: [], freeOnly: false });
  mocks.listModelOptions.mockReset().mockReturnValue([]);
  // 기본은 "불러오지 못함"으로 둔다 — CLAUDE_CODE_ALIASES(예전 별칭 opus·sonnet·haiku·fable)로 되돌아가,
  // 이 표를 전제로 한 기존 테스트(isSelectableModel 등)가 그대로 통과한다. SDK 매핑 자체를 보는 테스트는
  // mockResolvedValueOnce로 SDK_MODELS를 따로 준다
  mocks.loadClaudeCodeModels.mockReset().mockResolvedValue({ error: '로그인돼 있지 않습니다' });
});

describe('listSelectableModels', () => {
  describe('claude-code', () => {
    it('로그인한 Claude Code의 supportedModels() 목록을 버전 이름·계열 안내·단가로 옮긴다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });

      const picker = await listSelectableModels('claude-code', 'sonnet');

      expect(picker.note).toBeUndefined();
      expect(picker.options.map((option) => option.id)).toEqual(['', 'auto', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']);
      expect(picker.options.map((option) => option.label)).toEqual(['기본 (Opus 5 · 1M)', '자동', 'Opus 5 · 1M', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5']);
      // 자동(ADR-091)은 기본 행 바로 뒤에 붙는다
      const auto = picker.options.find((option) => option.id === 'auto')!;
      expect(auto.hint).toContain('검증에 실패하면 한 단계 올립니다');

      const def = picker.options.find((option) => option.id === '')!;
      expect(def.hint).toContain('Opus 5 · 1M');
      expect(def.resolvedId).toBe('claude-opus-5[1m]');
      // 기본이 지금 풀리는 모델(Opus)의 단가를 보여준다
      expect(def.price).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });

      const opus = picker.options.find((option) => option.id === 'opus[1m]')!;
      expect(opus.resolvedId).toBe('claude-opus-5[1m]');
      expect(opus.hint).toContain('설계·디버깅');
      expect(opus.badges).toEqual(['깊은 추론']);
      expect(opus.price).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });

      const fable = picker.options.find((option) => option.id === 'claude-fable-5-1[1m]')!;
      expect(fable.resolvedId).toBe('claude-fable-5-1');
      expect(fable.hint).toContain('새롭고 강한');
      expect(fable.badges).toEqual(['최신']);
      // 공식 단가를 확인하지 못한 모델은 단가를 지어내지 않는다
      expect(fable.price).toBeUndefined();

      const sonnet = picker.options.find((option) => option.id === 'sonnet')!;
      expect(sonnet.resolvedId).toBe('claude-sonnet-5');
      expect(sonnet.hint).toContain('균형');
      expect(sonnet.price).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });

      const haiku = picker.options.find((option) => option.id === 'haiku')!;
      // 날짜 접미사(-20251001)를 지운 뒤 단가 표와 맞춘다
      expect(haiku.resolvedId).toBe('claude-haiku-4-5-20251001');
      expect(haiku.price).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
      expect(haiku.supportsEffort).toBe(false);
    });

    it('목록을 불러오지 못하면(로그인 안 됨·타임아웃) 알려진 목록(CLAUDE_CODE_ALIASES)으로 되돌아가고 이유를 남긴다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ error: '60초 안에 응답하지 않았습니다' });

      const picker = await listSelectableModels('claude-code', 'sonnet');

      expect(picker.options.map((option) => option.id)).toEqual(['', 'auto', 'fable', 'opus', 'sonnet', 'haiku']);
      expect(picker.note).toContain('모델 목록을 불러오지 못해');
      expect(picker.note).toContain('60초 안에 응답하지 않았습니다');
    });

    it('예전에 저장된 세션 값이 옛 별칭(opus 등)이어도 지금 목록에서 선택된 값으로 바뀐다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });

      const opus = await listSelectableModels('claude-code', 'opus');
      expect(opus.current).toBe('opus[1m]');

      const fable = await listSelectableModels('claude-code', 'fable');
      expect(fable.current).toBe('claude-fable-5-1[1m]');

      // 값 그대로 있는 별칭(sonnet·haiku)은 바뀌지 않는다
      const sonnet = await listSelectableModels('claude-code', 'sonnet');
      expect(sonnet.current).toBe('sonnet');
    });

    it('아무 값도 없으면(세션이 고르지 않음) current는 그대로 없고, 별칭 매칭을 하지 않는다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });
      const picker = await listSelectableModels('claude-code');
      expect(picker.current).toBeUndefined();
    });

    it('노력 단계는 고른 모델 기준으로 판단한다 — Haiku는 지원하지 않는다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });

      const haikuPicker = await listSelectableModels('claude-code', 'haiku');
      expect(haikuPicker.effort.supported).toBe(false);
      expect(haikuPicker.effort.reason).toContain('노력 단계를 지원하지 않습니다');

      const sonnetPicker = await listSelectableModels('claude-code', 'sonnet');
      expect(sonnetPicker.effort.supported).toBe(true);
    });

    it('예전 별칭(haiku)으로 저장된 세션도 그 모델의 노력 단계 지원 여부를 따른다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });
      const picker = await listSelectableModels('claude-code', 'haiku');
      expect(picker.effort.supported).toBe(false);
    });

    it('아직 노력 단계를 고르지 않았으면 실제 기본값(높음)을 defaultLevel로 내려준다', async () => {
      mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });
      const picker = await listSelectableModels('claude-code', 'sonnet');
      expect(picker.effort.current).toBeUndefined();
      expect(picker.effort.defaultLevel).toBe('high');
    });
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

  it('목록에 있는 값만 허용한다(불러오지 못해 알려진 표로 되돌아간 상태 기준)', async () => {
    expect(await isSelectableModel('claude-code', 'opus')).toEqual({ ok: true });
    expect(await isSelectableModel('claude-code', 'gpt-5')).toEqual({ ok: false });
  });

  it('자동(auto)도 고를 수 있다', async () => {
    expect(await isSelectableModel('claude-code', 'auto')).toEqual({ ok: true });
  });
});

describe('effortPickerFor', () => {
  it('claude-code는 낮음·보통·높음·최대 네 단계를 지원하고, 실제 기본값(높음)을 defaultLevel로 내려준다', async () => {
    const picker = await effortPickerFor('claude-code', undefined, 'high');
    expect(picker.supported).toBe(true);
    expect(picker.levels.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'max']);
    expect(picker.current).toBe('high');
    expect(picker.defaultLevel).toBe('high');
  });

  it('codex·commandcode는 네 단계를 그대로 지원하지만 defaultLevel은 모른다(CLI 자체 기본값에 맡긴다)', async () => {
    for (const backend of ['codex', 'commandcode'] as const) {
      const picker = await effortPickerFor(backend, undefined, 'high');
      expect(picker.supported).toBe(true);
      expect(picker.levels.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'max']);
      expect(picker.current).toBe('high');
      expect(picker.defaultLevel).toBeUndefined();
    }
  });

  it('opencode는 지원하지만 모델마다 다를 수 있다는 안내를 남긴다', async () => {
    const picker = await effortPickerFor('opencode', undefined, undefined);
    expect(picker.supported).toBe(true);
    expect(picker.note).toContain('모델');
  });

  it('demo는 지원하지 않는다', async () => {
    const picker = await effortPickerFor('demo', undefined, undefined);
    expect(picker.supported).toBe(false);
    expect(picker.levels).toEqual([]);
  });

  it('api는 기본(라우터)에서는 지원하지 않고, Anthropic 모델을 고르면 지원한다', async () => {
    mocks.listModelOptions.mockReturnValue([
      { id: 'anthropic-sonnet', label: 'Claude Sonnet', provider: 'anthropic', configured: true, pricing: { inputPerMillion: 2, outputPerMillion: 10 } },
      { id: 'openai-gpt', label: 'GPT', provider: 'openai', configured: true, pricing: { inputPerMillion: 1, outputPerMillion: 4 } },
    ]);

    expect((await effortPickerFor('api', undefined, undefined)).supported).toBe(false);
    expect((await effortPickerFor('api', 'anthropic-sonnet', undefined)).supported).toBe(true);
    expect((await effortPickerFor('api', 'openai-gpt', undefined)).supported).toBe(false);
  });

  it('claude-code는 고른 모델이 노력 단계를 지원하지 않으면(Haiku) 거부한다', async () => {
    mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });
    const picker = await effortPickerFor('claude-code', 'haiku', undefined);
    expect(picker.supported).toBe(false);
    expect(picker.reason).toContain('노력 단계를 지원하지 않습니다');
  });
});

describe('isSelectableEffort', () => {
  it('빈 문자열(기본)은 언제나 허용한다', async () => {
    expect(await isSelectableEffort('demo', undefined, '')).toEqual({ ok: true });
  });

  it('지원하는 백엔드에서 목록에 있는 값만 허용한다', async () => {
    expect(await isSelectableEffort('claude-code', undefined, 'high')).toEqual({ ok: true });
    expect(await isSelectableEffort('claude-code', undefined, 'ultra')).toEqual({ ok: false, reason: expect.stringContaining('ultra') });
  });

  it('지원하지 않는 백엔드는 이유와 함께 거절한다', async () => {
    expect(await isSelectableEffort('demo', undefined, 'high')).toEqual({ ok: false, reason: expect.stringContaining('지원하지 않습니다') });
  });

  it('claude-code에서 노력 단계를 지원하지 않는 모델(Haiku)을 고르면 거절한다', async () => {
    mocks.loadClaudeCodeModels.mockResolvedValue({ models: SDK_MODELS });
    expect(await isSelectableEffort('claude-code', 'haiku', 'high')).toEqual({ ok: false, reason: expect.stringContaining('노력 단계를 지원하지 않습니다') });
  });
});

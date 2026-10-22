import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { chooseBackend, previewBackend, readBackendRules, resetBackendRulesCache, saveBackendRules, type RoutingDeps } from './backend-rules';

/**
 * 규칙 저장과 고르기(#822). 로그인 확인은 가짜(deps.ready)로 바꾼다 — 실제 CLI를 띄우지 않는다.
 */
let file: string;
const saved = process.env.B_STUDIO_BACKEND_RULES_FILE;

function deps(notReady: Record<string, string> = {}): RoutingDeps & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    allowed: () => ['claude-code', 'codex', 'commandcode'],
    defaultBackend: () => 'claude-code',
    async ready(backend) {
      checked.push(backend);
      if (notReady[backend]) throw new StudioError(409, notReady[backend]);
    },
  };
}

beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(tmpdir(), 'b-studio-rules-')), 'backend-rules.json');
  process.env.B_STUDIO_BACKEND_RULES_FILE = file;
  resetBackendRulesCache();
});

afterEach(() => {
  if (saved === undefined) delete process.env.B_STUDIO_BACKEND_RULES_FILE;
  else process.env.B_STUDIO_BACKEND_RULES_FILE = saved;
  resetBackendRulesCache();
});

describe('규칙 저장', () => {
  it('파일이 없으면 빈 규칙이다', () => {
    expect(readBackendRules(deps())).toEqual({ rules: { rules: [] } });
  });

  it('검사한 규칙만 0600 파일로 남기고 다시 읽는다', async () => {
    saveBackendRules({ rules: [{ when: { risk: 'high' }, backend: 'claude-code', model: 'opus' }], fallback: { backend: 'codex' } }, deps());
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    resetBackendRulesCache();
    expect(readBackendRules(deps()).rules).toEqual({ rules: [{ when: { risk: 'high' }, backend: 'claude-code', model: 'opus' }], fallback: { backend: 'codex' } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ fallback: { backend: 'codex' } });
  });

  it('틀린 규칙은 400으로 거부하고 파일을 바꾸지 않는다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }] }, deps());
    expect(() => saveBackendRules({ rules: [{ when: {}, backend: 'gemini' }] }, deps())).toThrow(StudioError);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ rules: [{ when: {}, backend: 'codex' }] });
  });

  it('파일이 깨졌거나 이제 허용하지 않는 백엔드를 가리키면 규칙 없이 고르고 그 까닭을 알린다', async () => {
    await writeFile(file, JSON.stringify({ rules: [{ when: {}, backend: 'gemini' }] }));
    const read = readBackendRules(deps());
    expect(read.rules).toEqual({ rules: [] });
    expect(read.error).toContain('규칙 1: 이 스튜디오가 허용하지 않는 백엔드입니다: gemini');
  });
});

describe('chooseBackend', () => {
  it('맞는 첫 규칙의 백엔드와 모델을 고르고 작업 종류를 함께 돌려준다', async () => {
    saveBackendRules({ rules: [{ when: { risk: 'high' }, backend: 'claude-code', model: 'opus' }, { when: {}, backend: 'codex' }] }, deps());
    const fake = deps();
    const decision = await chooseBackend({ request: '결제 완료 화면을 만들어 줘', intent: 'build', cwd: '/p' }, fake);
    expect(decision).toMatchObject({ backend: 'claude-code', model: 'opus', rule: 0, kind: { complexity: 'simple', risk: 'high' }, skipped: [] });
    expect(fake.checked).toEqual(['claude-code']);
  });

  it('로그인되지 않은 백엔드는 까닭을 남기고 건너뛰어 다음 후보로 간다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }], fallback: { backend: 'commandcode' } }, deps());
    const decision = await chooseBackend({ request: '버튼 글자를 바꿔 줘', intent: 'build', cwd: '/p' }, deps({ codex: '로컬 Codex를 쓸 수 없습니다: 로그인 필요' }));
    expect(decision).toMatchObject({ backend: 'commandcode', rule: 'fallback' });
    expect(decision.skipped).toEqual([{ rule: 0, backend: 'codex', reason: '로컬 Codex를 쓸 수 없습니다: 로그인 필요' }]);
  });

  it('규칙도 기본값도 맞지 않으면 서버의 기본 백엔드로 간다', async () => {
    const decision = await chooseBackend({ request: '버튼 글자를 바꿔 줘', intent: 'build', cwd: '/p' }, deps());
    expect(decision).toMatchObject({ backend: 'claude-code', rule: 'default' });
  });

  it('후보가 모두 로그인 전이면 409로 각 까닭을 알린다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }] }, deps());
    await expect(chooseBackend({ request: '고쳐 줘', intent: 'build', cwd: '/p' }, deps({ codex: 'Codex 로그인 필요', 'claude-code': 'Claude 로그인 필요' }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Codex 로그인 필요'),
    });
  });

  it('같은 백엔드가 후보에 두 번 나오면 로그인을 한 번만 확인한다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }, { when: {}, backend: 'codex', model: 'x' }] }, deps());
    const fake = deps({ codex: '안 됨' });
    await chooseBackend({ request: '고쳐 줘', intent: 'build', cwd: '/p' }, fake);
    expect(fake.checked).toEqual(['codex', 'claude-code']);
  });
});

describe('previewBackend', () => {
  it('로그인을 확인하지 않고 첫 후보와 규칙 설명을 돌려준다', () => {
    saveBackendRules({ rules: [{ when: { keywords: ['README'] }, backend: 'commandcode' }] }, deps());
    const fake = deps();
    expect(previewBackend({ request: 'README 고쳐 줘', intent: 'build' }, fake)).toMatchObject({ backend: 'commandcode', rule: 0, matched: '"README" 포함', kind: { complexity: 'simple', risk: 'normal' } });
    expect(previewBackend({ request: '버튼', intent: 'build' }, fake)).toMatchObject({ backend: 'claude-code', rule: 'default', matched: '맞는 규칙 없음' });
    expect(fake.checked).toEqual([]);
  });
});

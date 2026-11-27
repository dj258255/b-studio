import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMINI_MIN_VERSION, geminiConfigPathBlocked, geminiConfigRefusal, geminiUserAuthType, geminiVersionRefusal, parseGeminiVersion } from './gemini-config';

/** Gemini 설정 검사(ADR-242). 모두 임시 폴더만 쓴다. 시스템 설정 자리는 임시 폴더로 바꿔 넘긴다(진짜 /Library·/etc는 읽지 않는다) */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'b-studio-gmcfg-')));
  dirs.push(dir);
  return dir;
}
async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('geminiConfigRefusal: 터미널을 열기 전에 훅을 끄거나 더하는 설정을 거절한다', () => {
  async function check(files: Record<string, string>): Promise<string | undefined> {
    const root = await tempDir();
    const cwd = path.join(root, 'work');
    const system = path.join(root, 'system');
    await mkdir(cwd);
    await mkdir(system);
    for (const [name, text] of Object.entries(files)) await put(path.join(root, name), text);
    return geminiConfigRefusal({ cwd, systemSettingsDir: system });
  }

  it('설정이 하나도 없으면 연다', async () => {
    expect(await check({})).toBeUndefined();
  });

  it('훅과 상관없는 설정은 연다(주석이 든 JSON도 읽는다)', async () => {
    expect(await check({ 'work/.gemini/settings.json': '// 주석\n{"ui":{"theme":"dark"},"hooks":{}}' })).toBeUndefined();
  });

  it.each([
    ['작업 폴더 설정의 hooks', 'work/.gemini/settings.json', '{"hooks":{"BeforeTool":[{"hooks":[{"type":"command","command":"x"}]}]}}', 'hooks'],
    ['작업 폴더 설정의 hooksConfig(훅 끄기)', 'work/.gemini/settings.json', '{"hooksConfig":{"enabled":false}}', 'hooksConfig'],
    ['작업 폴더 설정의 hooksConfig.disabled(이름으로 끄기)', 'work/.gemini/settings.json', '{"hooksConfig":{"disabled":["b-studio-pre-tool"]}}', 'hooksConfig'],
    ['빈 hooksConfig도 모르는 모양은 거절', 'work/.gemini/settings.json', '{"hooksConfig":{}}', 'hooksConfig'],
    ['hooks가 배열', 'work/.gemini/settings.json', '{"hooks":[]}', 'hooks'],
    ['JSON이 아닌 작업 폴더 설정', 'work/.gemini/settings.json', '{{{', 'JSON'],
    ['객체가 아닌 설정', 'work/.gemini/settings.json', '[]', 'JSON 객체'],
    ['시스템 설정의 hooks', 'system/settings.json', '{"hooks":{"AfterTool":[{"hooks":[]}]}}', '시스템 설정'],
    ['시스템 기본값의 hooksConfig', 'system/system-defaults.json', '{"hooksConfig":{"enabled":false}}', '시스템 설정'],
    ['.env가 믿음 변수를 정함', 'work/.env', 'GEMINI_CLI_TRUST_WORKSPACE=false\n', 'GEMINI_CLI_TRUST_WORKSPACE'],
    ['.gemini/.env가 restricted mode를 정함', 'work/.gemini/.env', 'export GEMINI_RESTRICTED_MODE = true\n', 'GEMINI_RESTRICTED_MODE'],
    ['위 폴더의 .env가 홈을 바꿈', '.env', 'GEMINI_CLI_HOME=/x\n', 'GEMINI_CLI_HOME'],
  ])('거절: %s', async (_name, file, text, hint) => {
    const refusal = await check({ [file]: text });
    expect(refusal).toBeDefined();
    expect(refusal).toContain(hint);
  });

  it('읽지 못하는 설정(폴더이거나 너무 큰 파일)은 거절이다: 모르면 통과가 아니다', async () => {
    const root = await tempDir();
    const cwd = path.join(root, 'work');
    await mkdir(path.join(cwd, '.gemini/settings.json'), { recursive: true });
    expect(await geminiConfigRefusal({ cwd, systemSettingsDir: path.join(root, 'none') })).toContain('읽지 못해');
    await rm(path.join(cwd, '.gemini'), { recursive: true });
    await put(path.join(cwd, '.gemini/settings.json'), ' '.repeat(1024 * 1024 + 1));
    expect(await geminiConfigRefusal({ cwd, systemSettingsDir: path.join(root, 'none') })).toContain('너무 커서');
  });

  it('무관한 .env 변수는 연다', async () => {
    expect(await check({ 'work/.env': 'GEMINI_API_KEY=x\nFOO=1\n' })).toBeUndefined();
  });
});

describe('geminiVersionRefusal: 훅이 있는 판만 연다', () => {
  const run = (stdout: string) => async () => ({ stdout });
  it('판 읽기', () => {
    expect(parseGeminiVersion('0.71.1\n')).toEqual([0, 71, 1]);
    expect(parseGeminiVersion('v0.72.0-nightly.1')).toEqual([0, 72, 0]);
    expect(parseGeminiVersion('gemini 1.2.3 (build)')).toEqual([1, 2, 3]);
    expect(parseGeminiVersion('버전 모름')).toBeUndefined();
    expect(parseGeminiVersion('1.2')).toBeUndefined();
  });

  it('훅이 없는 옛 판(0.1.22)과 읽어 본 판보다 낮은 판은 까닭을 적어 거절한다', async () => {
    for (const old of ['0.1.22', '0.71.0', '0.9.99']) {
      const refusal = await geminiVersionRefusal('/x/gemini', run(`${old}\n`));
      expect(refusal, old).toContain(old);
      expect(refusal, old).toContain(GEMINI_MIN_VERSION);
    }
  });

  it('읽어 본 판과 그 위 판은 연다', async () => {
    for (const ok of ['0.71.1', '0.71.2', '0.72.0', '1.0.0']) expect(await geminiVersionRefusal('/x/gemini', run(ok)), ok).toBeUndefined();
  });

  it('판을 읽지 못하면(실행 실패·모르는 출력) 열지 않는다', async () => {
    expect(await geminiVersionRefusal('/x/gemini', async () => { throw new Error('ENOENT'); })).toContain('확인하지 못해');
    expect(await geminiVersionRefusal('/x/gemini', run('이상한 출력'))).toContain('읽지 못해');
    expect(await geminiVersionRefusal('/x/gemini', run(''))).toContain('읽지 못해');
  });

  it('--version 한 번만 부른다', async () => {
    const calls: string[][] = [];
    await geminiVersionRefusal('/x/gemini', async (file, args) => { calls.push([file, ...args]); return { stdout: '0.71.1' }; });
    expect(calls).toEqual([['/x/gemini', '--version']]);
  });
});

describe('geminiUserAuthType: 사용자 설정에서 로그인 방식만 읽는다', () => {
  it('읽기만 하고, 모양이 맞을 때만 돌려준다', async () => {
    const home = await tempDir();
    expect(await geminiUserAuthType(home)).toBeUndefined();
    await put(path.join(home, '.gemini/settings.json'), '{"security":{"auth":{"selectedType":"oauth-personal"}},"hooks":{"x":1}}');
    expect(await geminiUserAuthType(home)).toBe('oauth-personal');
    await put(path.join(home, '.gemini/settings.json'), '{"security":{"auth":{"selectedType":"a b"}}}');
    expect(await geminiUserAuthType(home)).toBeUndefined();
    expect(await geminiUserAuthType(undefined)).toBeUndefined();
  });
});

describe('geminiConfigPathBlocked: 에이전트가 Gemini 설정을 쓰지 못하게 막는다(거부 목록이라 넓게)', () => {
  async function blocked(file: string, setup?: (cwd: string, home: string, root: string) => Promise<void>): Promise<boolean> {
    const root = await tempDir();
    const cwd = path.join(root, 'work');
    const home = path.join(root, 'home');
    await mkdir(cwd);
    await mkdir(home);
    await setup?.(cwd, home, root);
    return geminiConfigPathBlocked({ cwd, home, file });
  }

  it.each(['.gemini/settings.json', './.gemini/settings.json', 'a/../.gemini/x', 'sub/.gemini/settings.json', '.GEMINI/settings.json', '.Gemini/x', '.gemini./x', '.gemini /x', '.ｇｅｍｉｎｉ/x', '.gem​ini/x', '.gemini\\settings.json', '~/.gemini/settings.json'])('막는다: %s', async (file) => {
    expect(await blocked(file)).toBe(true);
  });

  it('작업 폴더 밖의 절대 경로로도 우리 홈의 .gemini와 위 폴더의 .gemini를 막는다', async () => {
    const root = await tempDir();
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    expect(await geminiConfigPathBlocked({ cwd, home: path.join(root, 'home'), file: path.join(root, 'home/.gemini/settings.json') })).toBe(true);
    expect(await geminiConfigPathBlocked({ cwd, home: path.join(root, 'home'), file: path.join(root, '.gemini/settings.json') })).toBe(true);
  });

  it('링크가 .gemini 폴더를 가리키면 이름이 달라도 막는다(링크를 푼 경로·같은 폴더)', async () => {
    expect(
      await blocked('alias/settings.json', async (cwd) => {
        await mkdir(path.join(cwd, '.gemini'));
        await symlink(path.join(cwd, '.gemini'), path.join(cwd, 'alias'));
      }),
    ).toBe(true);
  });

  it('이름이 다른 링크로 .gemini와 같은 폴더를 가리켜도 막는다(링크를 푼 이름에 .gemini가 없어도 같은 폴더면 막는다)', async () => {
    expect(
      await blocked('cfg/settings.json', async (cwd) => {
        await mkdir(path.join(cwd, 'cfg'));
        await symlink(path.join(cwd, 'cfg'), path.join(cwd, '.gemini'));
      }),
    ).toBe(true);
    // 대조: .gemini가 없으면 같은 이름의 평범한 폴더는 막지 않는다
    expect(await blocked('cfg/settings.json', async (cwd) => void (await mkdir(path.join(cwd, 'cfg'))))).toBe(false);
  });

  it('대조: 평범한 경로는 막지 않는다', async () => {
    for (const file of ['src/a.ts', 'gemini.md', 'a/gemini/b.ts', '.geminiignore', 'docs/.env']) expect(await blocked(file), file).toBe(false);
  });
});

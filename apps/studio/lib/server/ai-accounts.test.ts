/**
 * ai-accounts.ts 테스트(#885). 임시 HOME·XDG_CONFIG_HOME만 쓰고, 사용자의 ~/.claude·~/.codex는 읽지도 쓰지도 않는다.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountProcessEnv,
  accountsFile,
  addAiAccount,
  aiAccountEnv,
  findAiAccount,
  listAiAccounts,
  removeAiAccount,
  resolveSessionAccount,
  updateAiAccount,
} from './ai-accounts';

let home: string;
let env: Record<string, string>;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'b-studio-ai-accounts-'));
  env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('계정 목록 파일', () => {
  it('XDG_CONFIG_HOME 아래에 두고, 없으면 ~/.config 아래에 둔다', () => {
    expect(accountsFile(env)).toBe(path.join(home, 'xdg', 'b-studio', 'accounts.json'));
    expect(accountsFile({ HOME: home })).toBe(path.join(home, '.config', 'b-studio', 'accounts.json'));
  });

  it('파일이 없으면 고른 CLI마다 기본 계정 하나씩이다(지금과 같다)', async () => {
    expect(await listAiAccounts(env, ['claude-code', 'codex'])).toEqual([
      { id: 'claude-code', name: '기본', backend: 'claude-code', builtin: true },
      { id: 'codex', name: '기본', backend: 'codex', builtin: true },
    ]);
  });

  it('계정을 더하면 0600 파일에 남고, 기본 계정 뒤에 붙는다', async () => {
    const added = await addAiAccount({ name: '피오', backend: 'claude-code', configDir: path.join(home, '.claude-fio') }, env);
    expect(added).toMatchObject({ name: '피오', backend: 'claude-code', configDir: path.join(home, '.claude-fio') });
    expect(added.id).toMatch(/^acct-[0-9a-f]{8}$/);
    const file = accountsFile(env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ accounts: [{ id: added.id, name: '피오', backend: 'claude-code', configDir: path.join(home, '.claude-fio') }] });
    expect((await listAiAccounts(env, ['claude-code'])).map((account) => account.name)).toEqual(['기본', '피오']);
    expect(await findAiAccount(added.id, env)).toEqual(added);
  });

  it('~/로 시작하는 폴더는 홈 아래로 풀고, 폴더를 만들지 않는다(CLI가 로그인할 때 만든다)', async () => {
    const added = await addAiAccount({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' }, env);
    expect(added.configDir).toBe(path.join(home, '.codex-marco'));
    await expect(lstat(path.join(home, '.codex-marco'))).rejects.toThrow();
  });

  it('이름은 앞뒤 빈칸과 제어 글자를 지우고 60자로 받는다', async () => {
    const added = await addAiAccount({ name: '  에리\u0007\u001b[31m ', backend: 'claude-code', configDir: '~/.claude-eri' }, env);
    expect(added.name).toBe('에리[31m');
    await expect(addAiAccount({ name: '가'.repeat(61), backend: 'claude-code', configDir: '~/.claude-a' }, env)).rejects.toMatchObject({ status: 400 });
    await expect(addAiAccount({ name: ' \u0007 ', backend: 'claude-code', configDir: '~/.claude-b' }, env)).rejects.toMatchObject({ status: 400 });
  });

  it('설정 폴더는 홈 아래의 절대 경로만 받고, 기본 계정 폴더·홈 자체·다른 계정 폴더는 받지 않는다', async () => {
    const bad = [
      { configDir: 'relative/dir', message: '절대 경로' },
      { configDir: '/etc/claude', message: '홈 폴더 아래' },
      { configDir: path.join(home, '..', 'other'), message: '홈 폴더 아래' },
      { configDir: home, message: '홈 폴더 아래' },
      { configDir: '~/.claude', message: '기본 계정' },
      { configDir: `~/.claude-x\u0000`, message: '제어 글자' },
    ];
    for (const { configDir, message } of bad) {
      await expect(addAiAccount({ name: '틀림', backend: 'claude-code', configDir }, env)).rejects.toThrow(message);
    }
    await expect(addAiAccount({ name: '틀림', backend: 'codex', configDir: '~/.codex' }, env)).rejects.toThrow('기본 계정');
    await addAiAccount({ name: '하나', backend: 'claude-code', configDir: '~/.claude-one' }, env);
    await expect(addAiAccount({ name: '둘', backend: 'claude-code', configDir: '~/.claude-one/' }, env)).rejects.toMatchObject({ status: 409 });
  });

  it('폴더가 이미 있으면 폴더여야 한다', async () => {
    await writeFile(path.join(home, 'not-dir'), 'x');
    await expect(addAiAccount({ name: '파일', backend: 'claude-code', configDir: '~/not-dir' }, env)).rejects.toThrow('폴더가 아닙니다');
    await mkdir(path.join(home, '.claude-old'));
    expect((await addAiAccount({ name: '있던 폴더', backend: 'claude-code', configDir: '~/.claude-old' }, env)).configDir).toBe(path.join(home, '.claude-old'));
  });

  it('설정 폴더를 따로 둘 수 없는 CLI는 계정을 더하지 않는다(기본 계정 이름만 바꾼다)', async () => {
    await expect(addAiAccount({ name: '타마', backend: 'gemini', configDir: '~/.gemini-2' }, env)).rejects.toThrow('계정을 하나만');
    await expect(addAiAccount({ name: '없음', backend: 'api' }, env)).rejects.toMatchObject({ status: 400 });
    await expect(addAiAccount({ name: '폴더 없음', backend: 'claude-code' }, env)).rejects.toThrow('설정 폴더');
  });

  it('그림은 sprites 폴더 안의 png·gif 파일 이름만 받는다', async () => {
    const added = await addAiAccount({ name: '트레버', backend: 'claude-code', configDir: '~/.claude-trevor', sprite: 'trevor.png' }, env);
    expect(added.sprite).toBe('trevor.png');
    // 움짤도 그림이다(#902)
    expect((await updateAiAccount(added.id, { sprite: 'pikachu.gif' }, env)).sprite).toBe('pikachu.gif');
    for (const sprite of ['../x.png', '/abs/x.png', 'x.jpg', '.hidden.png', 'a/b.png', 'a/b.gif']) {
      await expect(updateAiAccount(added.id, { sprite }, env)).rejects.toMatchObject({ status: 400 });
    }
    expect(await updateAiAccount(added.id, { sprite: null }, env)).not.toHaveProperty('sprite');
  });

  it('이름·그림만 고치고, 설정 폴더와 CLI는 바꾸지 않는다', async () => {
    const added = await addAiAccount({ name: '나디아', backend: 'claude-code', configDir: '~/.claude-nadia' }, env);
    expect(await updateAiAccount(added.id, { name: '나디아 2' }, env)).toMatchObject({ name: '나디아 2', configDir: path.join(home, '.claude-nadia') });
    await expect(updateAiAccount(added.id, { configDir: '~/.claude-other' }, env)).rejects.toMatchObject({ status: 400 });
    await expect(updateAiAccount(added.id, { backend: 'codex' }, env)).rejects.toMatchObject({ status: 400 });
    await expect(updateAiAccount('acct-00000000', { name: 'x' }, env)).rejects.toMatchObject({ status: 404 });
  });

  it('기본 계정도 이름·그림을 붙일 수 있고, 지우면 처음 기본 계정으로 돌아간다', async () => {
    expect(await updateAiAccount('codex', { name: '마르코', sprite: 'marco.png' }, env)).toEqual({ id: 'codex', name: '마르코', backend: 'codex', sprite: 'marco.png' });
    expect((await listAiAccounts(env, ['codex']))[0]).toEqual({ id: 'codex', name: '마르코', backend: 'codex', sprite: 'marco.png' });
    await removeAiAccount('codex', env);
    expect((await listAiAccounts(env, ['codex']))[0]).toEqual({ id: 'codex', name: '기본', backend: 'codex', builtin: true });
    await expect(removeAiAccount('codex', env)).rejects.toThrow('기본 계정');
  });

  it('지우기는 목록에서만 빼고 설정 폴더는 그대로 둔다', async () => {
    await mkdir(path.join(home, '.claude-keep'));
    await writeFile(path.join(home, '.claude-keep', 'settings.json'), '{}');
    const added = await addAiAccount({ name: '지울 것', backend: 'claude-code', configDir: '~/.claude-keep' }, env);
    await removeAiAccount(added.id, env);
    expect(await findAiAccount(added.id, env)).toBeUndefined();
    expect(await readFile(path.join(home, '.claude-keep', 'settings.json'), 'utf8')).toBe('{}');
    await expect(removeAiAccount(added.id, env)).rejects.toMatchObject({ status: 404 });
  });

  it('깨진 파일은 덮어쓰지 않고 까닭을 알린다', async () => {
    await mkdir(path.dirname(accountsFile(env)), { recursive: true });
    await writeFile(accountsFile(env), '{ not json');
    await expect(listAiAccounts(env, ['claude-code'])).rejects.toThrow('계정 목록 파일');
    await expect(addAiAccount({ name: 'x', backend: 'claude-code', configDir: '~/.claude-x' }, env)).rejects.toThrow('계정 목록 파일');
    expect(await readFile(accountsFile(env), 'utf8')).toBe('{ not json');
  });

  it('동시에 더해도 하나도 잃지 않는다', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, index) => addAiAccount({ name: `계정 ${index}`, backend: 'claude-code', configDir: `~/.claude-${index}` }, env)));
    expect((await listAiAccounts(env, ['claude-code'])).length).toBe(6);
  });
});

describe('계정의 환경 변수', () => {
  it('claude-code는 CLAUDE_CONFIG_DIR, codex는 CODEX_HOME, 기본 계정은 없다', async () => {
    const claude = await addAiAccount({ name: 'c', backend: 'claude-code', configDir: '~/.claude-c' }, env);
    const codex = await addAiAccount({ name: 'x', backend: 'codex', configDir: '~/.codex-x' }, env);
    expect(aiAccountEnv(claude)).toEqual({ CLAUDE_CONFIG_DIR: path.join(home, '.claude-c') });
    expect(aiAccountEnv(codex)).toEqual({ CODEX_HOME: path.join(home, '.codex-x') });
    expect(aiAccountEnv({ backend: 'codex' })).toEqual({});
    expect(accountProcessEnv(codex, { PATH: '/bin', CODEX_HOME: '/old' })).toEqual({ PATH: '/bin', CODEX_HOME: path.join(home, '.codex-x') });
    expect(accountProcessEnv(undefined, { PATH: '/bin' })).toBeUndefined();
  });

  it('세션의 계정: 없으면 기본, 목록에 없거나 CLI가 다르면 거절한다', async () => {
    const codex = await addAiAccount({ name: 'x', backend: 'codex', configDir: '~/.codex-x' }, env);
    expect(await resolveSessionAccount(undefined, 'codex', env)).toBeUndefined();
    expect(await resolveSessionAccount('codex', 'codex', env)).toBeUndefined();
    expect(await resolveSessionAccount(codex.id, 'codex', env)).toEqual(codex);
    await expect(resolveSessionAccount(codex.id, 'claude-code', env)).rejects.toMatchObject({ status: 400 });
    await expect(resolveSessionAccount('acct-ffffffff', 'codex', env)).rejects.toMatchObject({ status: 400 });
    await expect(resolveSessionAccount('../x', 'codex', env)).rejects.toMatchObject({ status: 400 });
  });
});

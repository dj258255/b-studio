import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_CODE_MOD_NAME } from './commandcode-mod';
import { commandCodeConfigPathBlocked, commandCodeModLoadRefusal, commandCodeModName } from './commandcode-config';

/**
 * Command Code의 설정이 b-studio의 mod를 끌 수 있는 자리(ADR-233). 임시 폴더만 쓴다: 가짜 HOME, 가짜 작업 폴더.
 * 진짜 `~/.commandcode`와 진짜 commandcode는 건드리지 않는다. 읽는 규칙은 설치된 cli.mjs(v1.93.4)의 `discoverMods`·`resolveModSettings`·`loadMods`를 따른다.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ home: string; cwd: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'b-studio-ccconf-'));
  dirs.push(base);
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'work');
  await mkdir(path.join(home, '.commandcode'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { home, cwd };
}

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('mod 이름 규칙(cli.mjs의 modNameFromPath)', () => {
  it('확장자(ts·js·mts·mjs)를 떼고, index는 폴더 이름이다', () => {
    expect(commandCodeModName(`/g/${COMMAND_CODE_MOD_NAME}`)).toBe('b-studio-mod');
    expect(commandCodeModName('/x/foo.mjs')).toBe('foo');
    expect(commandCodeModName('/x/dir/index.ts')).toBe('dir');
  });
});

describe('띄우기 전 검사: 설정이 b-studio의 mod를 끄거나 다른 mod를 붙이면 열지 않는다', () => {
  it('아무 설정도 없으면 열린다(대조)', async () => {
    const { home, cwd } = await sandbox();
    expect(await commandCodeModLoadRefusal({ cwd, home })).toBeUndefined();
  });

  it('빈 설정·mods가 없는 설정·관계없는 mods.disabled는 열린다(대조)', async () => {
    const { home, cwd } = await sandbox();
    await put(path.join(home, '.commandcode/settings.json'), '{}');
    await put(path.join(cwd, '.commandcode/settings.json'), JSON.stringify({ theme: 'dark', mods: { disabled: ['other-mod'], enabled: ['x'] } }));
    await put(path.join(cwd, '.commandcode/settings.local.json'), JSON.stringify({ mods: { disableAll: false } }));
    expect(await commandCodeModLoadRefusal({ cwd, home })).toBeUndefined();
  });

  const settingsFiles = [
    ['사용자 설정', (home: string) => path.join(home, '.commandcode/settings.json')],
    ['프로젝트 설정', (_home: string, cwd: string) => path.join(cwd, '.commandcode/settings.json')],
    ['프로젝트 로컬 설정', (_home: string, cwd: string) => path.join(cwd, '.commandcode/settings.local.json')],
  ] as const;

  for (const [label, file] of settingsFiles) {
    it(`${label}: JSON으로 읽지 못하면 연다고 말하지 않고 거절한다`, async () => {
      const { home, cwd } = await sandbox();
      await put(file(home, cwd), '{ "mods": ');
      const reason = await commandCodeModLoadRefusal({ cwd, home });
      expect(reason).toContain('읽지 못');
      expect(reason).toContain(path.basename(file(home, cwd)));
    });

    it(`${label}: mods.disableAll이 참이면 거절한다(--mod로 준 mod도 꺼진다)`, async () => {
      const { home, cwd } = await sandbox();
      await put(file(home, cwd), JSON.stringify({ mods: { disableAll: true } }));
      expect(await commandCodeModLoadRefusal({ cwd, home })).toContain('mods.disableAll');
    });

    it(`${label}: mods.disabled에 우리 mod 이름이 있으면 대소문자·확장자가 달라도 거절한다`, async () => {
      for (const name of ['b-studio-mod', 'B-Studio-Mod', 'b-studio-mod.ts', 'B-STUDIO-MOD.TS']) {
        const { home, cwd } = await sandbox();
        await put(file(home, cwd), JSON.stringify({ mods: { disabled: ['x', name] } }));
        expect(await commandCodeModLoadRefusal({ cwd, home }), name).toContain('mods.disabled');
      }
    });

    it(`${label}: mods.paths나 mods.sources로 다른 mod를 불러오게 하면 거절한다`, async () => {
      for (const mods of [{ paths: ['./evil.ts'] }, { sources: ['npm:evil'] }, { sources: [{ source: 'npm:evil', mods: ['a'] }] }, { sources: [42] }]) {
        const { home, cwd } = await sandbox();
        await put(file(home, cwd), JSON.stringify({ mods }));
        expect(await commandCodeModLoadRefusal({ cwd, home }), JSON.stringify(mods)).toContain('다른 mod');
      }
    });
  }

  it('프로젝트·사용자 mods 폴더에 mod가 있으면 거절한다(파일, 폴더 모두). 점으로 시작하는 것(.store)과 node_modules는 mod가 아니다(대조)', async () => {
    for (const where of ['project', 'user'] as const) {
      for (const entry of ['evil.ts', 'pkg/index.js']) {
        const { home, cwd } = await sandbox();
        const base = where === 'project' ? path.join(cwd, '.commandcode/mods') : path.join(home, '.commandcode/mods');
        await put(path.join(base, entry), 'export default () => {}');
        expect(await commandCodeModLoadRefusal({ cwd, home }), `${where} ${entry}`).toContain('mods 폴더');
      }
    }
    const { home, cwd } = await sandbox();
    await put(path.join(home, '.commandcode/mods/.store/state.json'), '{}');
    await put(path.join(home, '.commandcode/mods/node_modules/x/index.js'), '');
    expect(await commandCodeModLoadRefusal({ cwd, home })).toBeUndefined();
  });

  it('프로젝트 루트는 작업 폴더 위의 .git이 있는 폴더일 수 있다: 거기의 설정과 mods도 본다(cli.mjs의 resolveProjectRoot)', async () => {
    const { home, cwd } = await sandbox();
    const parent = path.dirname(cwd);
    await mkdir(path.join(parent, '.git'), { recursive: true });
    await put(path.join(parent, '.commandcode/settings.local.json'), JSON.stringify({ mods: { disableAll: true } }));
    expect(await commandCodeModLoadRefusal({ cwd, home })).toContain('mods.disableAll');
    await rm(path.join(parent, '.commandcode'), { recursive: true });
    await put(path.join(parent, '.commandcode/mods/evil.ts'), '');
    expect(await commandCodeModLoadRefusal({ cwd, home })).toContain('mods 폴더');
  });

  it('설정 파일이 폴더이거나 읽을 수 없으면 읽지 못한 것으로 거절한다(통과로 읽지 않는다)', async () => {
    const { home, cwd } = await sandbox();
    await mkdir(path.join(cwd, '.commandcode/settings.json'), { recursive: true });
    expect(await commandCodeModLoadRefusal({ cwd, home })).toContain('읽지 못');
  });
});

describe('쓰기 막기: Command Code의 설정·mod 자리(.commandcode)', () => {
  it('작업 폴더의 .commandcode 아래는 어떤 파일이든 막는다. 관계없는 경로는 연다(대조)', async () => {
    const { home, cwd } = await sandbox();
    for (const file of ['.commandcode/settings.json', '.commandcode/settings.local.json', '.commandcode/mods/evil.ts', '.commandcode/mods/deep/a/b.ts', '.commandcode']) {
      expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(cwd, file) }), file).toBe(true);
      expect(await commandCodeConfigPathBlocked({ cwd, home, file }), `상대 ${file}`).toBe(true);
    }
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(cwd, 'src/a.ts') })).toBe(false);
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: 'docs/commandcode.md' })).toBe(false);
  });

  it('대소문자·유니코드·겹친 구분자·..·끝의 점과 빈칸·보이지 않는 글자로 비켜 가지 못한다', async () => {
    const { home, cwd } = await sandbox();
    const variants = [
      '.COMMANDCODE/settings.json',
      '.CommandCode/Settings.JSON',
      '.commandcode//settings.json',
      './.commandcode/./settings.json',
      'src/../.commandcode/settings.json',
      '.commandcode./settings.json',
      '.commandcode /settings.json',
      '.command​code/settings.json',
      '.ｃommandcode/settings.json', // 전각 c
    ];
    for (const file of variants) {
      expect(await commandCodeConfigPathBlocked({ cwd, home, file }), JSON.stringify(file)).toBe(true);
      expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(cwd, file) }), `절대 ${JSON.stringify(file)}`).toBe(true);
    }
  });

  it('링크를 지나가도 막는다: 작업 폴더 안의 링크가 .commandcode를 가리키면 그 아래 쓰기는 막힌다', async () => {
    const { home, cwd } = await sandbox();
    await mkdir(path.join(cwd, '.commandcode/mods'), { recursive: true });
    await symlink(path.join(cwd, '.commandcode'), path.join(cwd, 'innocent'));
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(cwd, 'innocent/settings.json') })).toBe(true);
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: 'innocent/mods/evil.ts' })).toBe(true);
  });

  it('링크를 푼 실제 경로에 .commandcode 칸이 있으면 막는다(이름으로 가려진 링크, 보호 폴더가 아닌 .commandcode로 가는 것도)', async () => {
    const { home, cwd } = await sandbox();
    await mkdir(path.join(cwd, 'sub/.commandcode'), { recursive: true });
    await symlink(path.join(cwd, 'sub/.commandcode'), path.join(cwd, 'x'));
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: 'x/a.ts' })).toBe(true);
    // 대조: 같은 모양의 다른 폴더를 가리키는 링크는 막지 않는다
    await mkdir(path.join(cwd, 'docs'), { recursive: true });
    await symlink(path.join(cwd, 'docs'), path.join(cwd, 'y'));
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: 'y/a.ts' })).toBe(false);
  });

  it('이름이 달라도 같은 폴더(inode)면 막는다: .commandcode가 다른 이름의 폴더를 가리키는 링크일 때 그 폴더의 다른 링크로 가는 쓰기', async () => {
    const { home, cwd } = await sandbox();
    const real = path.join(path.dirname(cwd), 'cfg');
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(cwd, '.commandcode'));
    await symlink(real, path.join(cwd, 'innocent'));
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: 'innocent/settings.json' })).toBe(true);
  });

  it('~/ 표기를 홈으로 펴서 본다: 홈 안의 다른 이름이 .commandcode로 가는 링크여도 막는다', async () => {
    const { home, cwd } = await sandbox();
    await symlink(path.join(home, '.commandcode'), path.join(home, 'innocent'));
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: '~/innocent/settings.json' })).toBe(true);
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: '~/notes/a.md' })).toBe(false);
  });

  it('사용자 수준 설정(~/.commandcode)과 ~/ 표기도 막는다', async () => {
    const { home, cwd } = await sandbox();
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(home, '.commandcode/settings.json') })).toBe(true);
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: '~/.commandcode/mods/evil.ts' })).toBe(true);
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(home, 'notes.md') })).toBe(false);
  });

  it('.git이 있는 위 폴더의 .commandcode(프로젝트 루트)도 막는다', async () => {
    const { home, cwd } = await sandbox();
    const parent = path.dirname(cwd);
    await mkdir(path.join(parent, '.git'), { recursive: true });
    expect(await commandCodeConfigPathBlocked({ cwd, home, file: path.join(parent, '.commandcode/settings.json') })).toBe(true);
  });
});

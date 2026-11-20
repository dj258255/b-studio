import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { claudeConfigFile, execSurfaceChange, sourceFolderTrusted, trustSessionFolder, untrustSessionFolders } from './claude-trust';

const require = createRequire(import.meta.url);

// 실제 ~/.claude.json이나 CLAUDE_CONFIG_DIR을 건드리지 않는다: 모든 경로를 임시 폴더 안에 둔다
let base: string;
let sessionsRoot: string;
let configDir: string;
let configFile: string;

const sessionDir = (name: string) => path.join(sessionsRoot, name);

async function makeSession(name: string): Promise<string> {
  const dir = sessionDir(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeConfig(value: unknown, trailingNewline = false): Promise<string> {
  const text = JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : '');
  await writeFile(configFile, text, { mode: 0o600 });
  return text;
}

/** 시험이 읽는 설정 파일의 꼴 */
interface ConfigShape {
  projects: Record<string, { hasTrustDialogAccepted?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

async function readConfig(): Promise<ConfigShape> {
  return JSON.parse(await readFile(configFile, 'utf8'));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'b-studio-claude-trust-'));
  sessionsRoot = path.join(base, 'sessions');
  configDir = path.join(base, 'account');
  configFile = path.join(configDir, '.claude.json');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('설정 파일 위치', () => {
  it('계정 폴더가 있으면 그 폴더의 .claude.json이다', () => {
    expect(claudeConfigFile('/acct', { CLAUDE_CONFIG_DIR: '/env', B_STUDIO_TERMINAL_ENV: 'CLAUDE_CONFIG_DIR' }, '/home/u')).toBe('/acct/.claude.json');
  });

  it('기본 계정은 홈의 .claude.json이다. 서버의 CLAUDE_CONFIG_DIR은 터미널에 넘기기로 한 때만 따른다', () => {
    expect(claudeConfigFile(undefined, {}, '/home/u')).toBe('/home/u/.claude.json');
    // 터미널에는 정해 둔 이름만 넘어가므로 서버의 CLAUDE_CONFIG_DIR을 claude는 보지 못한다
    expect(claudeConfigFile(undefined, { CLAUDE_CONFIG_DIR: '/env' }, '/home/u')).toBe('/home/u/.claude.json');
    expect(claudeConfigFile(undefined, { CLAUDE_CONFIG_DIR: '/env', B_STUDIO_TERMINAL_ENV: 'HTTPS_PROXY, CLAUDE_CONFIG_DIR' }, '/home/u')).toBe('/env/.claude.json');
    expect(claudeConfigFile(undefined, { CLAUDE_CONFIG_DIR: '  ', B_STUDIO_TERMINAL_ENV: 'CLAUDE_CONFIG_DIR' }, '/home/u')).toBe('/home/u/.claude.json');
  });

  it('B_STUDIO_CLAUDE_CONFIG_DIR가 있으면 기본 계정은 그 폴더를 쓰고, 계정 폴더가 우선한다', () => {
    expect(claudeConfigFile(undefined, { B_STUDIO_CLAUDE_CONFIG_DIR: '/shell-set' }, '/home/u')).toBe('/shell-set/.claude.json');
    expect(claudeConfigFile('/acct', { B_STUDIO_CLAUDE_CONFIG_DIR: '/shell-set' }, '/home/u')).toBe('/acct/.claude.json');
  });
});

describe('신뢰 기록 쓰기', () => {
  it('세션 폴더를 realpath 키로 적고, 다른 값은 그대로 둔다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeConfig({ numStartups: 7, projects: { '/other': { hasTrustDialogAccepted: false, allowedTools: ['x'] } }, theme: 'dark' });
    const result = await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(result.ok).toBe(true);
    const after = await readConfig();
    const { realpath } = await import('node:fs/promises');
    expect(after.projects[await realpath(dir)]).toEqual({ hasTrustDialogAccepted: true });
    expect(after.projects['/other']).toEqual({ hasTrustDialogAccepted: false, allowedTools: ['x'] });
    expect(after.numStartups).toBe(7);
    expect(after.theme).toBe('dark');
    expect(Object.keys(after)).toEqual(['numStartups', 'projects', 'theme']);
  });

  it('이미 적힌 항목의 다른 값은 지키고 hasTrustDialogAccepted만 true로 한다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const { realpath } = await import('node:fs/promises');
    await writeConfig({ projects: { [await realpath(dir)]: { hasTrustDialogAccepted: false, lastCost: 1.5 } } });
    expect((await trustSessionFolder(dir, { sessionsRoot, configDir })).ok).toBe(true);
    expect((await readConfig()).projects[await realpath(dir)]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1.5 });
  });

  it('들여쓰기와 끝의 줄바꿈 꼴을 지키고, 바꿀 것이 없으면 파일을 다시 쓰지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const { realpath } = await import('node:fs/promises');
    const text = await writeConfig({ a: 1, projects: {} }, true);
    await trustSessionFolder(dir, { sessionsRoot, configDir });
    const after = await readFile(configFile, 'utf8');
    expect(after.endsWith('\n')).toBe(true);
    expect(after).toContain('\n  "projects": {');
    expect(after.startsWith(text.slice(0, text.indexOf('"projects"')))).toBe(true);
    // 두 번째 호출은 바꿀 것이 없다: mtime을 과거로 돌려 두고 다시 쓰지 않았는지 본다
    const past = new Date(1_000_000_000_000);
    await utimes(configFile, past, past);
    const second = await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect((await stat(configFile)).mtimeMs).toBe(past.getTime());
    expect(await readFile(configFile, 'utf8')).toBe(after);
    expect((await readConfig()).projects[await realpath(dir)].hasTrustDialogAccepted).toBe(true);
  });

  it('파일 권한을 원본과 같게 둔다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeConfig({ projects: {} });
    await chmod(configFile, 0o640);
    expect((await trustSessionFolder(dir, { sessionsRoot, configDir })).ok).toBe(true);
    expect((await stat(configFile)).mode & 0o777).toBe(0o640);
  });

  it('임시 파일을 남기지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeConfig({ projects: {} });
    await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(await readdir(configDir)).toEqual(['.claude.json']);
  });

  it('설정 파일이 링크면 링크를 지키고 가리키는 파일을 고친다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const real = path.join(base, 'dotfiles.json');
    await writeFile(real, JSON.stringify({ projects: {} }, null, 2));
    await symlink(real, configFile);
    expect((await trustSessionFolder(dir, { sessionsRoot, configDir })).ok).toBe(true);
    expect((await stat(configFile)).isFile()).toBe(true);
    const { lstat, realpath } = await import('node:fs/promises');
    expect((await lstat(configFile)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf8')).projects[await realpath(dir)].hasTrustDialogAccepted).toBe(true);
  });
});

describe('쓰지 않는 경우(fail-closed)', () => {
  it('설정 파일이 없으면 만들지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const result = await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(result.ok).toBe(false);
    expect(await readdir(configDir)).toEqual([]);
  });

  it('JSON이 깨졌으면 건드리지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeFile(configFile, '{ "projects": ');
    const result = await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('{ "projects": ');
    expect(await readdir(configDir)).toEqual(['.claude.json']);
  });

  it('최상위가 객체가 아니거나 projects가 객체가 아니면 쓰지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    for (const body of ['[]', 'null', '{"projects": []}', '{"projects": "x"}']) {
      await writeFile(configFile, body);
      expect((await trustSessionFolder(dir, { sessionsRoot, configDir })).ok).toBe(false);
      expect(await readFile(configFile, 'utf8')).toBe(body);
    }
  });

  it('다시 써도 같은 글이 되지 않는 꼴(우리가 바꾸지 않는 값까지 바뀔 수 있는 파일)은 쓰지 않는다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const body = '{"a":1,\n  "big": 12345678901234567890,\n  "projects": {}}';
    await writeFile(configFile, body);
    const result = await trustSessionFolder(dir, { sessionsRoot, configDir });
    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe(body);
  });

  it('세션 폴더 루트 밖의 경로는 적지 않는다', async () => {
    await writeConfig({ projects: {} });
    const before = await readFile(configFile, 'utf8');
    const outside = path.join(base, 'outside');
    await mkdir(outside, { recursive: true });
    const inside = await makeSession('proj-aaaa1111');
    const cases = [
      outside,
      sessionsRoot,
      base,
      path.join(sessionsRoot, '..', 'outside'),
      path.join(inside, '..', '..', 'outside'),
      path.join(sessionsRoot, 'missing-dir'),
      '/',
      '',
    ];
    for (const folder of cases) {
      const result = await trustSessionFolder(folder, { sessionsRoot, configDir });
      expect(result.ok, folder).toBe(false);
    }
    expect(await readFile(configFile, 'utf8')).toBe(before);
  });

  it('루트 안의 링크가 루트 밖을 가리키면 적지 않는다', async () => {
    await writeConfig({ projects: {} });
    const before = await readFile(configFile, 'utf8');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(outside, 'deep'), { recursive: true });
    await symlink(outside, path.join(sessionsRoot, 'link-out'));
    expect((await trustSessionFolder(path.join(sessionsRoot, 'link-out'), { sessionsRoot, configDir })).ok).toBe(false);
    expect((await trustSessionFolder(path.join(sessionsRoot, 'link-out', 'deep'), { sessionsRoot, configDir })).ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe(before);
  });

  it('루트 안의 링크가 루트 안을 가리켜도 링크 경로로는 적지 않는다(경로 꼴이 달라진다)', async () => {
    await writeConfig({ projects: {} });
    const target = await makeSession('proj-target');
    await symlink(target, path.join(sessionsRoot, 'alias'));
    expect((await trustSessionFolder(path.join(sessionsRoot, 'alias'), { sessionsRoot, configDir })).ok).toBe(false);
  });

  it('대소문자만 다른 경로는 적지 않는다(대소문자를 구분하지 않는 볼륨에서도, 구분하는 볼륨에서도)', async () => {
    await writeConfig({ projects: {} });
    const before = await readFile(configFile, 'utf8');
    await makeSession('proj-aaaa1111');
    const result = await trustSessionFolder(path.join(sessionsRoot, 'PROJ-AAAA1111'), { sessionsRoot, configDir });
    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe(before);
  });
});

describe('경쟁', () => {
  it('바꿔치기 직전에 파일이 바뀌면 다시 읽어 되풀이하고, 그 사이 바뀐 값을 지킨다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    const { realpath } = await import('node:fs/promises');
    await writeConfig({ counter: 1, projects: {} });
    let interfered = 0;
    const result = await trustSessionFolder(dir, {
      sessionsRoot,
      configDir,
      beforeCommit: async () => {
        // claude가 그 사이 같은 파일을 다시 썼다고 흉내 낸다(첫 시도에서만)
        if (interfered++ > 0) return;
        const current = JSON.parse(await readFile(configFile, 'utf8'));
        current.counter = 2;
        current.projects['/claude-wrote'] = { hasTrustDialogAccepted: true };
        await writeFile(configFile, JSON.stringify(current, null, 2));
      },
    });
    expect(result.ok).toBe(true);
    expect(interfered).toBe(2);
    const after = await readConfig();
    expect(after.counter).toBe(2);
    expect(after.projects['/claude-wrote']).toEqual({ hasTrustDialogAccepted: true });
    expect(after.projects[await realpath(dir)].hasTrustDialogAccepted).toBe(true);
    expect(await readdir(configDir)).toEqual(['.claude.json']);
  });

  it('같은 내용으로 mtime만 바뀌어도 바뀐 것으로 본다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeConfig({ projects: {} });
    let touched = 0;
    const result = await trustSessionFolder(dir, {
      sessionsRoot,
      configDir,
      beforeCommit: async () => {
        if (touched++ > 0) return;
        const later = new Date(Date.now() + 60_000);
        await utimes(configFile, later, later);
      },
    });
    expect(result.ok).toBe(true);
    expect(touched).toBe(2);
  });

  it('계속 바뀌면 상한까지 되풀이한 뒤 쓰지 않고 실패로 알린다', async () => {
    const dir = await makeSession('proj-aaaa1111');
    await writeConfig({ n: 0, projects: {} });
    let attempts = 0;
    const result = await trustSessionFolder(dir, {
      sessionsRoot,
      configDir,
      maxAttempts: 3,
      beforeCommit: async () => {
        attempts += 1;
        const current = JSON.parse(await readFile(configFile, 'utf8'));
        current.n = attempts;
        await writeFile(configFile, JSON.stringify(current, null, 2));
      },
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(3);
    const after = await readConfig();
    expect(after.projects).toEqual({});
    expect(await readdir(configDir)).toEqual(['.claude.json']);
  });

  it('동시에 여러 세션을 적어도 서로의 항목을 잃지 않는다', async () => {
    const dirs = await Promise.all(Array.from({ length: 8 }, (_, i) => makeSession(`proj-0000000${i}`)));
    await writeConfig({ projects: {} });
    const results = await Promise.all(dirs.map((dir) => trustSessionFolder(dir, { sessionsRoot, configDir })));
    expect(results.every((r) => r.ok)).toBe(true);
    const { realpath } = await import('node:fs/promises');
    const after = await readConfig();
    for (const dir of dirs) expect(after.projects[await realpath(dir)]?.hasTrustDialogAccepted).toBe(true);
  });
});

describe('신뢰 기록 지우기', () => {
  it('그 세션 폴더와 그 아래 키만 지우고 다른 항목은 그대로 둔다', async () => {
    const a = await makeSession('proj-aaaa1111');
    const b = await makeSession('proj-bbbb2222');
    await writeConfig({ keep: true, projects: { '/other': { hasTrustDialogAccepted: true } } });
    await trustSessionFolder(a, { sessionsRoot, configDir });
    await trustSessionFolder(b, { sessionsRoot, configDir });
    const { realpath } = await import('node:fs/promises');
    // claude가 하위 폴더 키를 따로 만들었다고 본다
    const current = await readConfig();
    current.projects[path.join(await realpath(a), 'sub')] = { hasTrustDialogAccepted: true };
    await writeFile(configFile, JSON.stringify(current, null, 2));

    const result = await untrustSessionFolders(a, { sessionsRoot, configDir });
    expect(result.ok).toBe(true);
    const after = await readConfig();
    expect(Object.keys(after.projects).sort()).toEqual(['/other', await realpath(b)].sort());
    expect(after.keep).toBe(true);
  });

  it('접두사만 같은 다른 세션 폴더는 지우지 않는다', async () => {
    const a = await makeSession('proj-aaaa1111');
    const longer = await makeSession('proj-aaaa11112');
    await writeConfig({ projects: {} });
    await trustSessionFolder(a, { sessionsRoot, configDir });
    await trustSessionFolder(longer, { sessionsRoot, configDir });
    await untrustSessionFolders(a, { sessionsRoot, configDir });
    const { realpath } = await import('node:fs/promises');
    expect(Object.keys((await readConfig()).projects)).toEqual([await realpath(longer)]);
  });

  it('폴더가 이미 지워졌어도 경로 글자로 그 키를 지운다', async () => {
    const a = await makeSession('proj-aaaa1111');
    await writeConfig({ projects: {} });
    await trustSessionFolder(a, { sessionsRoot, configDir });
    await rm(a, { recursive: true });
    expect((await untrustSessionFolders(a, { sessionsRoot, configDir })).ok).toBe(true);
    expect((await readConfig()).projects).toEqual({});
  });

  it('세션 폴더 루트 밖 경로로는 아무것도 지우지 않는다', async () => {
    await writeConfig({ projects: { '/other': { hasTrustDialogAccepted: true }, [base]: { hasTrustDialogAccepted: true } } });
    const before = await readFile(configFile, 'utf8');
    for (const folder of [base, sessionsRoot, '/', '/other', path.join(sessionsRoot, '..')]) {
      expect((await untrustSessionFolders(folder, { sessionsRoot, configDir })).ok, folder).toBe(false);
    }
    expect(await readFile(configFile, 'utf8')).toBe(before);
  });

  it('파일이 없거나 깨졌으면 지우지 않고 실패로 알린다', async () => {
    const a = await makeSession('proj-aaaa1111');
    expect((await untrustSessionFolders(a, { sessionsRoot, configDir })).ok).toBe(false);
    await writeFile(configFile, 'not json');
    expect((await untrustSessionFolders(a, { sessionsRoot, configDir })).ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('not json');
  });
});

describe('원본을 믿었을 때만 적는다(복사한 내용이 원본에서 오기 때문)', () => {
  async function source(name: string, git = true): Promise<string> {
    const dir = path.join(base, 'src', name);
    await mkdir(dir, { recursive: true });
    if (git) await mkdir(path.join(dir, '.git'));
    return realpathNative(dir);
  }
  const { realpath } = require('node:fs') as typeof import('node:fs');
  const realpathNative = (p: string) => new Promise<string>((ok, no) => realpath.native(p, (e, r) => (e ? no(e) : ok(r))));

  it('원본의 실제 경로 키가 true면 믿은 것이고, false·없음·다른 대소문자는 믿지 않은 것이다', async () => {
    const trusted = await source('trusted');
    const plain = await source('plain');
    const falsy = await source('falsy');
    await writeConfig({ projects: { [trusted]: { hasTrustDialogAccepted: true }, [falsy]: { hasTrustDialogAccepted: false }, [plain.toUpperCase()]: { hasTrustDialogAccepted: true } } });
    expect(await sourceFolderTrusted(trusted, { configDir })).toEqual({ trusted: true });
    expect(await sourceFolderTrusted(falsy, { configDir })).toMatchObject({ trusted: false });
    expect(await sourceFolderTrusted(plain, { configDir })).toMatchObject({ trusted: false });
  });

  it('git 저장소 안의 하위 폴더는 그 저장소 루트를 믿었으면 믿은 것이다(claude가 저장소 루트로 신뢰를 정한다)', async () => {
    const repo = await source('mono');
    const sub = path.join(repo, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    await writeConfig({ projects: { [repo]: { hasTrustDialogAccepted: true } } });
    expect(await sourceFolderTrusted(sub, { configDir })).toEqual({ trusted: true });
  });

  it('git 저장소의 바깥 상위 폴더를 믿은 것은 그 저장소를 믿은 것이 아니다', async () => {
    const repo = await source('inner');
    await writeConfig({ projects: { [path.dirname(repo)]: { hasTrustDialogAccepted: true } } });
    expect(await sourceFolderTrusted(repo, { configDir })).toMatchObject({ trusted: false });
  });

  it('설정 파일이 없거나 깨졌으면 모른다(믿지 않은 것으로 본다)', async () => {
    const repo = await source('nofile');
    expect(await sourceFolderTrusted(repo, { configDir })).toMatchObject({ trusted: false, missing: true });
    await writeFile(configFile, '{ broken');
    expect(await sourceFolderTrusted(repo, { configDir })).toMatchObject({ trusted: false });
  });

  it('세션 폴더의 실행 설정 파일이 원본과 바이트까지 같거나 없으면 그대로이고, 다르거나 새로 생겼거나 링크면 바뀐 것이다', async () => {
    const src = await source('surface');
    const work = await makeSession('surface-1');
    await mkdir(path.join(src, '.claude'), { recursive: true });
    await mkdir(path.join(work, '.claude'), { recursive: true });
    await writeFile(path.join(src, '.claude', 'settings.json'), '{"hooks":{}}');
    await writeFile(path.join(work, '.claude', 'settings.json'), '{"hooks":{}}');
    // 원본에만 있는 로컬 설정은 복사본에 없어도 된다
    await writeFile(path.join(src, '.claude', 'settings.local.json'), '{}');
    expect(await execSurfaceChange(work, src)).toBeUndefined();

    await writeFile(path.join(work, '.mcp.json'), '{"mcpServers":{"x":{"command":"sh"}}}');
    expect(await execSurfaceChange(work, src)).toContain('.mcp.json');
    await rm(path.join(work, '.mcp.json'));

    await writeFile(path.join(work, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh evil"}]}]}}');
    expect(await execSurfaceChange(work, src)).toContain('settings.json');

    await rm(path.join(work, '.claude', 'settings.json'));
    await symlink(path.join(src, '.claude', 'settings.json'), path.join(work, '.claude', 'settings.json'));
    expect(await execSurfaceChange(work, src)).toContain('settings.json');
  });
});

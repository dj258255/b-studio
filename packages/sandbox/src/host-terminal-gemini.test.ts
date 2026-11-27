import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMINI_HOOK, GEMINI_HOOK_NAME, GEMINI_SETTINGS_NAME } from './gemini-hook';
import { GEMINI_SANDBOX_ENVS, GEMINI_SETTINGS_ENVS, GEMINI_UNSET_ENVS, geminiSettingsContent } from './gemini-config';
import {
  expectedHostGatewayFiles,
  findHostCli,
  findUnhookedCliByArgv,
  geminiHomePath,
  hostBashRc,
  hostGeminiWrapper,
  hostZshFiles,
  openHostTerminal,
  shellQuote,
  type HostPty,
} from './host-terminal';

/**
 * Gemini 터미널(실험, ADR-242)의 감싸개·관문 파일·감시. 진짜 gemini도 PTY도 띄우지 않는다:
 * 감싸개는 진짜 `/bin/sh`로 돌리되 CLI 자리에 환경을 찍는 가짜 스크립트를 둔다. 관문 폴더·홈은 모두 임시 폴더다.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const address = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };
const dir = '/gateway/studio-gm';
const cli = { kind: 'gemini' as const, cliPath: '/opt/gm/lib/node_modules/@google/gemini-cli/bundle/gemini.js', nodePath: '/usr/bin/node' };

describe('Gemini 관문 파일', () => {
  it('훅 파일·설정·핑용 훅 스크립트·주소 파일·감싸개가 있고 권한이 맞다. 토큰은 주소 파일에만 있다', () => {
    const files = expectedHostGatewayFiles(address, dir, cli);
    expect(Object.keys(files).sort()).toEqual(['b-studio-gateway.json', 'b-studio-gemini-hook.mjs', 'b-studio-hook.mjs', 'bin/gemini', 'gemini-settings.json', 'shell/bashrc', 'shell/zsh/.zlogin', 'shell/zsh/.zprofile', 'shell/zsh/.zshenv', 'shell/zsh/.zshrc']);
    expect(files[GEMINI_HOOK_NAME]).toEqual({ content: GEMINI_HOOK, mode: 0o600 });
    expect(files[GEMINI_SETTINGS_NAME]).toEqual({ content: geminiSettingsContent(dir, cli.nodePath), mode: 0o600 });
    expect(files['bin/gemini']!.mode).toBe(0o700);
    expect(JSON.parse(files['b-studio-gateway.json']!.content)).toEqual({ url: address.hookUrl, token: address.hookToken });
    for (const [name, spec] of Object.entries(files)) if (name !== 'b-studio-gateway.json') expect(spec.content, name).not.toContain(address.hookToken);
  });

  it('설정에는 이벤트 일곱 개의 훅이 우리 명령 하나씩 있고, 막는 두 훅에만 실패 꼬리가 붙는다. 시간 상한은 밀리초다', () => {
    const settings = JSON.parse(geminiSettingsContent(dir, cli.nodePath)) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; name: string; command: string; timeout: number }> }>>; hooksConfig: unknown; general: unknown };
    expect(Object.keys(settings.hooks).sort()).toEqual(['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool', 'Notification', 'SessionEnd', 'SessionStart']);
    for (const [event, definitions] of Object.entries(settings.hooks)) {
      expect(definitions, event).toHaveLength(1);
      expect(definitions[0]!.matcher, event).toBeUndefined();
      expect(definitions[0]!.hooks, event).toHaveLength(1);
      const hook = definitions[0]!.hooks[0]!;
      expect(hook.type).toBe('command');
      expect(hook.command).toContain(shellQuote(path.join(dir, GEMINI_HOOK_NAME)));
      expect(hook.command.startsWith(shellQuote(cli.nodePath))).toBe(true);
    }
    expect(settings.hooks.BeforeTool![0]!.hooks[0]).toMatchObject({ timeout: 1_800_000, command: expect.stringContaining('pre-tool || {') });
    expect(settings.hooks.BeforeAgent![0]!.hooks[0]!.command).toContain('prompt || {');
    expect(settings.hooks.AfterAgent![0]!.hooks[0]).toMatchObject({ timeout: 3_600_000 });
    expect(settings.hooks.AfterAgent![0]!.hooks[0]!.command).not.toContain('||');
    expect(settings.hooksConfig).toEqual({ enabled: true, disabled: [] });
    expect(settings.general).toEqual({ enableAutoUpdate: false, enableAutoUpdateNotification: false });
  });

  it('경로에 $가 있으면 설정을 만들지 않는다(Gemini가 설정 글의 $이름을 환경 변수로 푼다)', () => {
    expect(() => geminiSettingsContent('/gateway/$HOME/x', cli.nodePath)).toThrow('$');
    expect(() => geminiSettingsContent(dir, '/opt/$NODE/node')).toThrow('$');
  });

  it('로그인 방식은 모양이 맞을 때만 옮긴다', () => {
    expect(JSON.parse(geminiSettingsContent(dir, cli.nodePath, 'oauth-personal')).security).toEqual({ auth: { selectedType: 'oauth-personal' } });
    expect(JSON.parse(geminiSettingsContent(dir, cli.nodePath, 'x"; rm -rf /')).security).toBeUndefined();
    expect(JSON.parse(geminiSettingsContent(dir, cli.nodePath)).security).toBeUndefined();
  });

  it('셸 시작 파일은 `gemini` 함수를 감싸개로 정의하고 첫 요청은 `-i`로 넘긴다', () => {
    expect(hostZshFiles(dir, 'gemini')['.zshrc']).toContain(`function gemini { ${shellQuote(path.join(dir, 'bin/gemini'))} "$@"; }`);
    expect(hostBashRc(dir, 'gemini')).toContain('-i "$BSTUDIO_FIRST_PROMPT_VALUE"');
  });
});

describe('Gemini 감싸개(진짜 셸로 돌린다)', () => {
  async function setup(): Promise<{ root: string; gateway: string; real: string; wrapper: string; fake: string }> {
    const root = await tempDir('b-studio-gm-wrap-');
    const gateway = path.join(root, 'gw');
    await mkdir(path.join(gateway, 'bin'), { recursive: true });
    const real = path.join(root, 'user-home');
    await mkdir(path.join(real, '.gemini'), { recursive: true });
    const fake = path.join(root, 'fake-gemini.sh');
    const sandboxNames = 'GEMINI_SANDBOX SANDBOX GEMINI_SANDBOX_IMAGE GEMINI_SANDBOX_PROXY_COMMAND SANDBOX_ENV SANDBOX_FLAGS SANDBOX_MOUNTS SANDBOX_PORTS SANDBOX_SET_UID_GID SEATBELT_PROFILE';
    await writeFile(
      fake,
      [
        '#!/bin/sh',
        'printf "HOME_ENV=%s\\n" "$GEMINI_CLI_HOME"',
        'printf "SYS=%s|%s|%s|%s\\n" "${GEMINI_CLI_SYSTEM_SETTINGS_PATH-unset}" "${GEMINI_CLI_SYSTEM_DEFAULTS_PATH-unset}" "${GEMINI_RESTRICTED_MODE-unset}" "${GEMINI_CLI_TRUST_WORKSPACE-unset}"',
        'printf "USER_HOME=%s\\n" "$B_STUDIO_GEMINI_USER_HOME"',
        `for v in ${sandboxNames}; do if env | grep -q "^$v="; then printf "SBX_%s=set\\n" "$v"; else printf "SBX_%s=unset\\n" "$v"; fi; done`,
        'for a in "$@"; do printf "ARG=%s\\n" "$a"; done',
        '',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    const wrapper = path.join(gateway, 'bin/gemini');
    await writeFile(wrapper, hostGeminiWrapper(gateway, { cliPath: fake }));
    await chmod(wrapper, 0o755);
    await writeFile(path.join(gateway, GEMINI_SETTINGS_NAME), geminiSettingsContent(gateway, cli.nodePath));
    return { root, gateway, real, wrapper, fake };
  }
  const exec = (wrapper: string, args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> =>
    new Promise((resolve) => execFile(wrapper, args, { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? ((error as { code?: number }).code ?? 1) : 0 })));

  it('홈을 관문 폴더 안의 홈으로 바꾸고, 설정을 복사하고, 시스템 설정·믿음 변수를 지우고, 사용자의 인자와 첫 요청을 그대로 뒤에 넘긴다. 모델·권한 인자는 붙이지 않는다', async () => {
    const { gateway, real, wrapper } = await setup();
    const sandboxEnv = Object.fromEntries(GEMINI_SANDBOX_ENVS.map((name) => [name, 'x']));
    const ran = await exec(wrapper, ['-i', '요청 글 "따옴표" $HOME'], { HOME: real, GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/evil.json', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/evil2.json', GEMINI_RESTRICTED_MODE: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'false', ...sandboxEnv });
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim().split('\n')).toEqual([
      `HOME_ENV=${geminiHomePath(gateway)}`,
      'SYS=unset|unset|unset|unset',
      `USER_HOME=${real}`,
      ...GEMINI_SANDBOX_ENVS.map((name) => `SBX_${name}=unset`),
      'ARG=-i',
      'ARG=요청 글 "따옴표" $HOME',
    ]);
    expect(await readFile(path.join(geminiHomePath(gateway), '.gemini/settings.json'), 'utf8')).toBe(geminiSettingsContent(gateway, cli.nodePath));
    const execLine = hostGeminiWrapper(gateway, { cliPath: '/x' }).split('\n').find((line) => line.startsWith('exec '));
    expect(execLine).toBe("exec '/x' \"$@\"");
    expect(hostGeminiWrapper(gateway, { cliPath: '/x' })).not.toMatch(/--model|--yolo|--approval-mode|--sandbox|--trust/);
    // 토큰은 감싸개에 없다
    expect(hostGeminiWrapper(gateway, { cliPath: '/x' })).not.toContain('token');
  });

  it('샌드박스를 켜는 환경 변수(0.71.1 소스에서 읽은 열 개)는 설정·믿음 변수와 함께 지운다. 대조: 지우지 않고 가짜 CLI를 바로 부르면 보인다', async () => {
    const { root, fake, wrapper } = await setup();
    expect([...GEMINI_SANDBOX_ENVS].sort()).toEqual(['GEMINI_SANDBOX', 'GEMINI_SANDBOX_IMAGE', 'GEMINI_SANDBOX_PROXY_COMMAND', 'SANDBOX', 'SANDBOX_ENV', 'SANDBOX_FLAGS', 'SANDBOX_MOUNTS', 'SANDBOX_PORTS', 'SANDBOX_SET_UID_GID', 'SEATBELT_PROFILE']);
    expect(GEMINI_UNSET_ENVS).toEqual([...GEMINI_SETTINGS_ENVS, ...GEMINI_SANDBOX_ENVS]);
    const script = hostGeminiWrapper('/gw', { cliPath: '/x' });
    const unsetLine = script.split('\n').find((line) => line.startsWith('unset '));
    expect(unsetLine?.slice('unset '.length).split(' ')).toEqual([...GEMINI_UNSET_ENVS]);
    // 대조군: 감싸개를 거치지 않으면 같은 환경이 그대로 보인다(시험이 값을 볼 수 있다는 증거)
    const direct = await exec(fake, [], { HOME: root, GEMINI_SANDBOX: 'docker', SANDBOX: '1', SEATBELT_PROFILE: 'p' });
    expect(direct.stdout).toContain('SBX_GEMINI_SANDBOX=set');
    expect(direct.stdout).toContain('SBX_SANDBOX=set');
    expect(direct.stdout).toContain('SBX_SEATBELT_PROFILE=set');
    const wrapped = await exec(wrapper, [], { HOME: root, GEMINI_SANDBOX: 'docker', SANDBOX: '1', SEATBELT_PROFILE: 'p', GEMINI_SANDBOX_IMAGE: 'evil' });
    expect(wrapped.stdout).not.toMatch(/SBX_\w+=set/);
  });

  it('로그인 파일만 사용자의 홈에서 링크로 잇는다. 사용자의 settings.json·확장은 잇지 않는다', async () => {
    const { gateway, real, wrapper } = await setup();
    for (const name of ['oauth_creds.json', 'google_accounts.json', 'installation_id', 'settings.json']) await writeFile(path.join(real, '.gemini', name), name);
    await mkdir(path.join(real, '.gemini/extensions/e'), { recursive: true });
    expect((await exec(wrapper, [], { HOME: real })).code).toBe(0);
    const home = path.join(geminiHomePath(gateway), '.gemini');
    expect(await readlink(path.join(home, 'oauth_creds.json'))).toBe(path.join(real, '.gemini/oauth_creds.json'));
    expect((await lstat(path.join(home, 'installation_id'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(home, 'settings.json'), 'utf8')).toBe(geminiSettingsContent(gateway, cli.nodePath));
    await expect(lstat(path.join(home, 'extensions'))).rejects.toThrow();
  });

  it('settings.json 자리에 심은 링크는 따라가지 않고 새 파일로 바꾼다. 링크의 대상은 건드리지 않는다', async () => {
    const { gateway, real, wrapper, root } = await setup();
    const victim = path.join(root, 'victim.json');
    await writeFile(victim, 'keep');
    const home = path.join(geminiHomePath(gateway), '.gemini');
    await mkdir(home, { recursive: true });
    await symlink(victim, path.join(home, 'settings.json'));
    expect((await exec(wrapper, [], { HOME: real })).code).toBe(0);
    expect(await readFile(victim, 'utf8')).toBe('keep');
    expect((await lstat(path.join(home, 'settings.json'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(home, 'settings.json'), 'utf8')).toBe(geminiSettingsContent(gateway, cli.nodePath));
  });

  it('홈이 링크이거나 홈 안에 extensions·policies·.env가 있으면 띄우지 않는다(훅을 더하거나 믿음을 바꿀 수 있다)', async () => {
    const { gateway, real, wrapper, root } = await setup();
    const home = path.join(geminiHomePath(gateway), '.gemini');
    for (const name of ['extensions', 'policies', '.env']) {
      await mkdir(home, { recursive: true });
      await (name === '.env' ? writeFile(path.join(home, name), 'X=1') : mkdir(path.join(home, name)));
      const ran = await exec(wrapper, [], { HOME: real });
      expect(ran.code, name).toBe(1);
      expect(ran.stderr, name).toContain(name);
      expect(ran.stdout, name).toBe('');
      await rm(path.join(home, name), { recursive: true, force: true });
    }
    // 대조: 치우면 뜬다
    expect((await exec(wrapper, [], { HOME: real })).code).toBe(0);
    // 홈 자체가 링크
    await rm(geminiHomePath(gateway), { recursive: true, force: true });
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), geminiHomePath(gateway));
    const linked = await exec(wrapper, [], { HOME: real });
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain('링크');
    await expect(lstat(path.join(root, 'elsewhere/.gemini'))).rejects.toThrow();
  });

  it('감싸개를 안쪽에서 다시 불러도(이미 우리 홈이 GEMINI_CLI_HOME) 우리 홈을 진짜 홈으로 읽어 자기 자신을 링크하지 않는다', async () => {
    const { gateway, real, wrapper } = await setup();
    await writeFile(path.join(real, '.gemini', 'oauth_creds.json'), 'creds');
    expect((await exec(wrapper, [], { HOME: real })).code).toBe(0);
    const again = await exec(wrapper, [], { HOME: real, GEMINI_CLI_HOME: geminiHomePath(gateway), B_STUDIO_GEMINI_USER_HOME: real });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`USER_HOME=${real}`);
    expect(await readlink(path.join(geminiHomePath(gateway), '.gemini/oauth_creds.json'))).toBe(path.join(real, '.gemini/oauth_creds.json'));
    // 진짜 홈을 모르는 채 우리 홈만 보이면 링크를 만들지 않는다(자기 자신을 가리키는 링크 방지)
    const alone = await exec(wrapper, [], { HOME: geminiHomePath(gateway) });
    expect(alone.code).toBe(0);
    expect((await lstat(path.join(geminiHomePath(gateway), '.gemini/oauth_creds.json'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(geminiHomePath(gateway), '.gemini/oauth_creds.json'))).not.toBe(path.join(geminiHomePath(gateway), '.gemini/oauth_creds.json'));
  });
});

describe('Gemini CLI 찾기와 모델 거절', () => {
  it('findHostCli: B_STUDIO_GEMINI_BIN 또는 PATH에서 찾고 링크는 풀어 진짜 파일로 띄운다(감시가 패키지 자리로 알아본다)', async () => {
    const root = await tempDir('b-studio-gm-bin-');
    const real = path.join(root, 'lib/node_modules/@google/gemini-cli/bundle/gemini.js');
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, '#!/usr/bin/env node\n');
    await chmod(real, 0o755);
    await mkdir(path.join(root, 'bin'));
    const link = path.join(root, 'bin/gemini');
    await symlink(real, link);
    expect((await findHostCli({ PATH: path.join(root, 'bin') }, 'gemini')).cliPath).toBe(real);
    expect((await findHostCli({ B_STUDIO_GEMINI_BIN: link, PATH: '/nonexistent' }, 'gemini')).cliPath).toBe(real);
    await expect(findHostCli({ PATH: '/nonexistent' }, 'gemini')).rejects.toThrow('gemini');
  });

  it('openHostTerminal은 gemini에 모델이 오면 거절한다(기본 모델로만 띄운다)', async () => {
    const pty: HostPty = { pid: 1, write: () => {}, resize: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} };
    await expect(openHostTerminal({ id: 'main', size: { cols: 80, rows: 24 }, cwd: '/w', gatewayDir: dir, cli: 'gemini', model: 'gemini-2.5-pro', spawnPty: () => pty })).rejects.toThrow('모델을 고르지 않습니다');
    await expect(openHostTerminal({ id: 'main', size: { cols: 80, rows: 24 }, cwd: '/w', gatewayDir: dir, cli: 'gemini', spawnPty: () => pty })).resolves.toBeDefined();
  });
});

describe('Gemini 감시: 훅이 붙지 않은 gemini를 잡는다(진짜 argv·환경으로 본다)', () => {
  const script = '/opt/gm/lib/node_modules/@google/gemini-cli/bundle/gemini.js';
  const processes = [
    { pid: 100, ppid: 1, args: '/bin/zsh -l -i' },
    { pid: 101, ppid: 100, args: `node ${script}` },
  ];
  const expected = { settingsPath: path.join(dir, 'settings.json'), cliPath: script, kind: 'gemini' as const };
  const home = geminiHomePath(dir);
  const found = (argv: string[], env: Array<{ name: string; value: string }> | null | 'throw') =>
    findUnhookedCliByArgv(100, [processes[0]!, { pid: 101, ppid: 100, args: argv.join(' ') }], expected, () => argv, () => { if (env === 'throw') throw new Error('권한 없음'); return env; })?.map((entry) => entry.pid);

  it('홈이 우리 홈이면 붙은 것이다', () => {
    expect(found(['node', script, '-i', '요청'], [{ name: 'GEMINI_CLI_HOME', value: home }])).toEqual([]);
  });

  it('홈이 다르거나 없거나, 시스템 설정·믿음 변수가 있거나, 샌드박스 인자가 있으면 붙지 않은 것이다', () => {
    const ok = { name: 'GEMINI_CLI_HOME', value: home };
    expect(found(['node', script], [])).toEqual([101]);
    expect(found(['node', script], [{ name: 'GEMINI_CLI_HOME', value: '/home/kim' }])).toEqual([101]);
    expect(found(['node', script], [ok, { name: 'GEMINI_CLI_TRUST_WORKSPACE', value: 'false' }])).toEqual([101]);
    expect(found(['node', script], [ok, { name: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', value: '/x' }])).toEqual([101]);
    expect(found(['node', script, '--sandbox'], [ok])).toEqual([101]);
    // 샌드박스를 켜는 환경 변수(값이 비었어도 있으면)도 붙지 않은 것이다
    for (const name of GEMINI_SANDBOX_ENVS) {
      expect(found(['node', script], [ok, { name, value: 'x' }]), name).toEqual([101]);
      expect(found(['node', script], [ok, { name, value: '' }]), `${name} 빈 값`).toEqual([101]);
    }
  });

  it('Rust 감시가 보는 환경 변수 이름 목록은 TS의 지우는 목록과 같다(두 곳이 어긋나면 한쪽만 닫힌다)', async () => {
    const source = await readFile(path.join(__dirname, '../../../crates/bstudio-session/src/terminal/watch.rs'), 'utf8');
    const body = /const GEMINI_SETTINGS_ENVS: \[&str; \d+\] = \[([^\]]*)\];/u.exec(source)?.[1] ?? '';
    const names = [...body.matchAll(/"([A-Z0-9_]+)"/gu)].map((match) => match[1]);
    expect(names.sort()).toEqual([...GEMINI_UNSET_ENVS].sort());
  });

  it('환경을 읽지 못하면 붙지 않은 것으로 본다. 끝난 프로세스(null)는 건너뛴다', () => {
    expect(found(['node', script], 'throw')).toEqual([101]);
    expect(found(['node', script], null)).toEqual([]);
  });
});

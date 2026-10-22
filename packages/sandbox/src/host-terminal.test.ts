import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_HOOK_SCRIPT, AGENT_NOTIFICATION_MATCHER, applyPatchPaths, CODEX_HOOK_SCRIPT, CODEX_HOOK_SCRIPT_NAME, GATEWAY_FILE_NAME, HOOK_SCRIPT_NAME } from './docker/agent-terminal';
import { SandboxError } from './errors';
import {
  checkHostGatewayConfig,
  codexGatewayArgs,
  expectedHostGatewayFiles,
  findHostCli,
  findUnhookedCli,
  hostBashRc,
  hostGatewaySettings,
  hostShellLaunch,
  hostTerminalEnv,
  hostZshFiles,
  HOST_TERMINAL_COMMAND,
  listProcesses,
  openHostTerminal,
  probeHostGateway,
  removeHostGatewayConfig,
  shellQuote,
  writeHostGatewayConfig,
  type HostPty,
} from './host-terminal';

/**
 * 이 컴퓨터에서 세션 터미널을 여는 길(ADR-173). 진짜 claude도 PTY도 도커도 부르지 않는다 —
 * 임시 폴더와 가짜 spawnPty, 테스트 안에서 띄운 로컬 HTTP 서버, 그리고 진짜 bash·zsh만 쓴다.
 */

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const address = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };
const cli = { kind: 'claude' as const, cliPath: '/usr/local/bin/claude', nodePath: '/usr/local/bin/node' };
const GATEWAY_FILES = ['settings.json', 'mcp.json', HOOK_SCRIPT_NAME, GATEWAY_FILE_NAME, path.join('bin', 'claude'), path.join('shell', 'bashrc'), path.join('shell', 'zsh', '.zshenv'), path.join('shell', 'zsh', '.zprofile'), path.join('shell', 'zsh', '.zshrc'), path.join('shell', 'zsh', '.zlogin')];

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

/** 감싸개 자리를 채우는 가짜. `WRAPPED <인자>`를 찍는다 */
async function writeShellGateway(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'bin', 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "WRAPPED $*"\n');
  await chmod(path.join(dir, 'bin', 'claude'), 0o700);
  await mkdir(path.join(dir, 'shell', 'zsh'), { recursive: true });
  for (const [name, content] of Object.entries(hostZshFiles(dir))) await writeFile(path.join(dir, 'shell', 'zsh', name), content);
  await writeFile(path.join(dir, 'shell', 'bashrc'), hostBashRc(dir));
}

/** 사용자의 PATH 앞에 놓을 가짜 claude. `UNWRAPPED`를 찍는다 */
async function writeFakeClaude(home: string): Promise<string> {
  const bin = path.join(home, 'fakebin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "UNWRAPPED $*"\n');
  await chmod(path.join(bin, 'claude'), 0o755);
  return bin;
}

describe('hostTerminalEnv', () => {
  it('스튜디오 프로세스의 표식·비밀·패키지 관리자 환경은 넘기지 않는다', () => {
    const env = hostTerminalEnv('/gateway', {
      PATH: '/repo/node_modules/.bin:/usr/bin',
      HOME: '/home/kim',
      LANG: 'ko_KR.UTF-8',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/home/kim/.config',
      SSH_AUTH_SOCK: '/tmp/ssh',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      NODE_ENV: 'development',
      npm_config_user_agent: 'pnpm',
      GH_TOKEN: 'secret',
      B_STUDIO_SECRET: 'secret',
    });
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_ENV', 'npm_config_user_agent', 'GH_TOKEN', 'B_STUDIO_SECRET']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.HOME).toBe('/home/kim');
    expect(env.LANG).toBe('ko_KR.UTF-8');
    expect(env.LC_ALL).toBe('C');
    expect(env.XDG_CONFIG_HOME).toBe('/home/kim/.config');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh');
  });

  it('PATH는 감싸개 폴더가 맨 앞이고, 스튜디오 프로세스의 PATH 항목은 넘기지 않는다', () => {
    const env = hostTerminalEnv('/gateway', { PATH: '/repo/node_modules/.bin:/usr/bin:/bin' });
    const parts = env.PATH!.split(path.delimiter);
    expect(parts[0]).toBe(path.join('/gateway', 'bin'));
    expect(parts).not.toContain('/repo/node_modules/.bin');
    // 관문 폴더가 없으면 감싸개 폴더 없이 기본 자리만
    expect(hostTerminalEnv(undefined, { PATH: '/repo/node_modules/.bin' }).PATH).toBe(['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter));
  });

  it('B_STUDIO_TERMINAL_ENV에 적은 이름만 더 넘기고, 틀린 이름은 던진다', () => {
    const env = hostTerminalEnv(undefined, { B_STUDIO_TERMINAL_ENV: 'HTTPS_PROXY, AWS_PROFILE', HTTPS_PROXY: 'http://p', AWS_PROFILE: 'dev', OTHER: 'x' });
    expect(env.HTTPS_PROXY).toBe('http://p');
    expect(env.AWS_PROFILE).toBe('dev');
    expect(env.OTHER).toBeUndefined();
    // 값이 없는 이름은 조용히 건너뛴다
    expect(hostTerminalEnv(undefined, { B_STUDIO_TERMINAL_ENV: 'MISSING' }).MISSING).toBeUndefined();
    expect(() => hostTerminalEnv(undefined, { B_STUDIO_TERMINAL_ENV: 'A-B' })).toThrow(SandboxError);
    expect(() => hostTerminalEnv(undefined, { B_STUDIO_TERMINAL_ENV: 'B_STUDIO_TOKEN' })).toThrow(SandboxError);
    expect(() => hostTerminalEnv(undefined, { B_STUDIO_TERMINAL_ENV: 'BAD NAME' })).toThrow(SandboxError);
  });
});

describe('shellQuote', () => {
  it('빈칸과 작은따옴표가 든 경로도 한 덩어리로 만든다', () => {
    expect(shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
  });
});

describe('hostShellLaunch', () => {
  it('zsh면 로그인·대화형으로 띄우고 ZDOTDIR을 관문 폴더로 바꾼다', () => {
    const launch = hostShellLaunch('/gateway', { SHELL: '/bin/zsh', HOME: '/home/kim' });
    expect(launch.file).toBe('/bin/zsh');
    expect(launch.args).toEqual(['-l', '-i']);
    expect(launch.env).toEqual({ ZDOTDIR: path.join('/gateway', 'shell', 'zsh'), BSTUDIO_USER_ZDOTDIR: '/home/kim' });
  });

  it('사용자가 ZDOTDIR을 두었으면 그 값을 기억한다', () => {
    expect(hostShellLaunch('/gateway', { SHELL: '/bin/zsh', ZDOTDIR: '/home/kim/.config/zsh' }).env.BSTUDIO_USER_ZDOTDIR).toBe('/home/kim/.config/zsh');
  });

  it('bash면 --rcfile로 우리 bashrc를 읽힌다', () => {
    const launch = hostShellLaunch('/gateway', { SHELL: '/usr/bin/bash' });
    expect(launch.file).toBe('/usr/bin/bash');
    expect(launch.args).toEqual(['--rcfile', path.join('/gateway', 'shell', 'bashrc'), '-i']);
    expect(launch.env).toEqual({});
  });

  it('그 밖의 셸(fish)은 /bin/sh로 대체 명령을 돌리고 감싸개 절대 경로를 알린다', () => {
    const launch = hostShellLaunch('/gateway', { SHELL: '/usr/bin/fish' });
    expect(launch.file).toBe('/bin/sh');
    expect(launch.args[0]).toBe('-c');
    expect(launch.args[1]).toContain(shellQuote(path.join('/gateway', 'bin', 'claude')));
    expect(launch.args[1]).toContain('검증이 붙지 않을 수 있습니다');
    expect(launch.env).toEqual({});
  });

  it('SHELL이 없으면 /bin/sh로 본다', () => {
    const launch = hostShellLaunch('/gateway', {});
    expect(launch.file).toBe('/bin/sh');
    expect(launch.args[0]).toBe('-c');
  });

  it('관문 폴더가 없으면 지금의 sh 명령 그대로 돈다', () => {
    expect(hostShellLaunch(undefined, { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/sh', args: ['-c', HOST_TERMINAL_COMMAND], env: {} });
  });
});

describe('hostGatewaySettings', () => {
  it('훅이 꺼지지 않게 disableAllHooks를 false로 정하고, 훅 명령이 이 node와 관문 폴더의 스크립트를 가리킨다', () => {
    const settings = hostGatewaySettings(address, '/gateway', '/n/bin/node');
    expect(settings.disableAllHooks).toBe(false);
    const sessionStart = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).SessionStart![0]!.hooks[0]!.command;
    expect(sessionStart).toContain("'/n/bin/node'");
    expect(sessionStart).toContain(`'${path.join('/gateway', HOOK_SCRIPT_NAME)}'`);
    expect(sessionStart).toContain('session-start');
    // B7: 사람을 기다리는 창에서 오는 알림 훅도 같은 관문 스크립트로 건다(관문 파일 기대값도 이 설정을 그대로 담는다)
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    expect(hooks.Notification![0]!.matcher).toBe(AGENT_NOTIFICATION_MATCHER);
    const notification = hooks.Notification![0]!.hooks[0]!.command;
    expect(notification).toContain(`'${path.join('/gateway', HOOK_SCRIPT_NAME)}'`);
    expect(notification).toContain('notification');
    expect(expectedHostGatewayFiles(address, '/gateway', { kind: 'claude', cliPath: '/usr/local/bin/claude', nodePath: '/n/bin/node' })['settings.json']!.content).toContain(`"${AGENT_NOTIFICATION_MATCHER}"`);
    // 텔레메트리 env도 같은 관문 주소·토큰으로 보낸다
    expect(settings.env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${address.hookUrl}/v1/logs`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${address.hookToken}`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
    });
  });
});

describe('writeHostGatewayConfig', () => {
  it('파일 열 개를 쓰고 권한을 좁히며, 감싸개가 그 폴더의 설정을 가리킨다. 두 번 불러도 같은 결과다', async () => {
    const root = await tempDir('b-studio-host-gateway-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    const files = {
      settings: path.join(dir, 'settings.json'),
      mcp: path.join(dir, 'mcp.json'),
      hook: path.join(dir, HOOK_SCRIPT_NAME),
      gateway: path.join(dir, GATEWAY_FILE_NAME),
      wrapper: path.join(dir, 'bin', 'claude'),
      bashrc: path.join(dir, 'shell', 'bashrc'),
    };
    for (const name of GATEWAY_FILES) expect(await exists(path.join(dir, name)), name).toBe(true);
    for (const file of Object.values(files)) expect(await exists(file)).toBe(true);

    // 토큰이 든 설정·주소와 셸 시작 파일은 600, 감싸개만 700
    expect(await modeOf(files.settings)).toBe(0o600);
    expect(await modeOf(files.gateway)).toBe(0o600);
    expect(await modeOf(files.mcp)).toBe(0o600);
    expect(await modeOf(files.hook)).toBe(0o600);
    expect(await modeOf(files.bashrc)).toBe(0o600);
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(await modeOf(path.join(dir, 'shell', 'zsh', name))).toBe(0o600);
    expect(await modeOf(files.wrapper)).toBe(0o700);
    // 폴더 셋도 700
    expect(await modeOf(path.join(dir, 'bin'))).toBe(0o700);
    expect(await modeOf(path.join(dir, 'shell'))).toBe(0o700);
    expect(await modeOf(path.join(dir, 'shell', 'zsh'))).toBe(0o700);

    const wrapper = await readFile(files.wrapper, 'utf8');
    expect(wrapper).toContain(`--settings '${files.settings}'`);
    expect(wrapper).toContain(`--mcp-config '${files.mcp}'`);
    expect(wrapper).toContain('"$@"');
    expect(wrapper).toContain(shellQuote(cli.cliPath));
    // .zshrc의 claude 함수(별칭을 지우고 함수로 정의)와 .zlogin의 첫 실행이 감싸개를 가리킨다
    expect(await readFile(path.join(dir, 'shell', 'zsh', '.zshrc'), 'utf8')).toContain(`unalias claude 2>/dev/null\nfunction claude { ${shellQuote(path.join(dir, 'bin', 'claude'))} "$@"; }`);
    expect(await readFile(path.join(dir, 'shell', 'zsh', '.zlogin'), 'utf8')).toContain('BSTUDIO_TERMINAL_STARTED');

    // 주소 파일의 URL이 준 주소 그대로다
    expect(JSON.parse(await readFile(files.gateway, 'utf8'))).toEqual({ url: address.hookUrl, token: address.hookToken });

    // 두 번 불러도 같은 폴더를 돌려주고 내용이 바뀌지 않는다
    expect(await writeHostGatewayConfig('studio-orders-abc', address, cli, root)).toBe(dir);
    expect(await readFile(files.wrapper, 'utf8')).toBe(wrapper);
  });

  it('세션마다 폴더가 다르다', async () => {
    const root = await tempDir('b-studio-host-gateway-');
    expect(await writeHostGatewayConfig('studio-orders-abc', address, cli, root)).not.toBe(await writeHostGatewayConfig('studio-orders-def', address, cli, root));
  });

  it('부를 때마다 모든 파일과 폴더의 권한을 다시 조인다(내용은 그대로)', async () => {
    const root = await tempDir('b-studio-host-chmod-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    const gateway = path.join(dir, GATEWAY_FILE_NAME);
    const wrapper = path.join(dir, 'bin', 'claude');
    const zshrc = path.join(dir, 'shell', 'zsh', '.zshrc');
    const bin = path.join(dir, 'bin');
    const shell = path.join(dir, 'shell');
    const zsh = path.join(dir, 'shell', 'zsh');
    // 누가 권한을 넓혀 놓았다(주소 파일에는 토큰이 있다)
    await chmod(gateway, 0o644);
    await chmod(zshrc, 0o644);
    await chmod(wrapper, 0o755);
    await chmod(bin, 0o755);
    await chmod(shell, 0o755);
    await chmod(zsh, 0o755);
    await chmod(dir, 0o755);
    const content = await readFile(gateway, 'utf8');

    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);

    expect(await modeOf(gateway)).toBe(0o600);
    expect(await modeOf(zshrc)).toBe(0o600);
    expect(await modeOf(wrapper)).toBe(0o700);
    expect(await modeOf(bin)).toBe(0o700);
    expect(await modeOf(shell)).toBe(0o700);
    expect(await modeOf(zsh)).toBe(0o700);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await readFile(gateway, 'utf8')).toBe(content);
  });
});

describe('removeHostGatewayConfig', () => {
  it('쓴 파일과 폴더를 지운다. 그 폴더에 다른 파일이 있으면 그 파일과 폴더는 남는다', async () => {
    const root = await tempDir('b-studio-host-remove-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    await removeHostGatewayConfig('studio-orders-abc', root);
    for (const name of GATEWAY_FILES) expect(await exists(path.join(dir, name)), name).toBe(false);
    expect(await exists(dir)).toBe(false);

    const dir2 = await writeHostGatewayConfig('studio-orders-def', address, cli, root);
    await writeFile(path.join(dir2, 'other.txt'), '남겨 둘 것');
    await removeHostGatewayConfig('studio-orders-def', root);
    expect(await readFile(path.join(dir2, 'other.txt'), 'utf8')).toBe('남겨 둘 것');
    expect(await exists(dir2)).toBe(true);
  });
});

describe('findHostCli', () => {
  it('B_STUDIO_CLAUDE_BIN의 절대 경로를 그대로 쓴다', async () => {
    const found = await findHostCli({ B_STUDIO_CLAUDE_BIN: '/opt/tools/claude', PATH: '/nonexistent' });
    expect(found.cliPath).toBe('/opt/tools/claude');
    expect(found.nodePath).toBe(process.execPath);
  });

  it('상대 경로는 무시하고 PATH에서 찾는다', async () => {
    const binDir = await tempDir('b-studio-host-cli-');
    const claude = path.join(binDir, 'claude');
    await writeFile(claude, '#!/bin/sh\n');
    await chmod(claude, 0o755);
    expect((await findHostCli({ B_STUDIO_CLAUDE_BIN: 'relative/claude', PATH: binDir })).cliPath).toBe(claude);
  });

  it('PATH에도 없으면 던진다', async () => {
    const empty = await tempDir('b-studio-host-empty-');
    await expect(findHostCli({ PATH: empty })).rejects.toThrow(SandboxError);
  });
});

describe('openHostTerminal', () => {
  it('사용자의 셸을 띄우고, 시작 파일의 환경을 더한 뒤 입력·크기를 전달하고 닫으면 SIGHUP을 보낸다', async () => {
    const writes: string[] = [];
    const sizes: Array<[number, number]> = [];
    const signals: Array<string | undefined> = [];
    const spawns: Array<{ file: string; args: string[]; options: { cwd: string; env: Record<string, string>; cols: number; rows: number } }> = [];
    const pty: HostPty = { pid: 4321, write: (data) => writes.push(data), resize: (cols, rows) => sizes.push([cols, rows]), kill: (signal) => signals.push(signal), onData: () => {}, onExit: () => {} };
    const spawnPty = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => {
      spawns.push({ file, args, options });
      return pty;
    };

    const terminal = await openHostTerminal({ id: 'main', size: { cols: 90, rows: 25 }, cwd: '/work/orders', gatewayDir: '/gateway', env: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/kim' }, spawnPty });
    expect(spawns[0]!.file).toBe('/bin/zsh');
    expect(spawns[0]!.args).toEqual(['-l', '-i']);
    expect(spawns[0]!.options.cwd).toBe('/work/orders');
    expect(spawns[0]!.options.cols).toBe(90);
    expect(spawns[0]!.options.rows).toBe(25);
    expect(spawns[0]!.options.env.PATH!.split(path.delimiter)[0]).toBe(path.join('/gateway', 'bin'));
    // 시작 파일이 쓸 추가 환경(ZDOTDIR)이 hostTerminalEnv 결과 위에 얹힌다
    expect(spawns[0]!.options.env.ZDOTDIR).toBe(path.join('/gateway', 'shell', 'zsh'));
    expect(spawns[0]!.options.env.BSTUDIO_USER_ZDOTDIR).toBe('/home/kim');
    expect(Object.keys(spawns[0]!.options.env).some((key) => key.startsWith('B_STUDIO_'))).toBe(false);
    expect(terminal.id).toBe('main');

    terminal.write('ls\r');
    expect(writes).toEqual(['ls\r']);
    await terminal.resize({ cols: 120, rows: 40 });
    expect(sizes).toEqual([[120, 40]]);

    // 닫으면 SIGHUP을 보내고, 그 뒤의 입력은 무시된다
    terminal.close();
    expect(signals).toEqual(['SIGHUP']);
    terminal.write('x');
    expect(writes).toEqual(['ls\r']);
  });

  it('터미널이 끝나면(exit) 그 뒤의 입력을 무시한다', async () => {
    const writes: string[] = [];
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const pty: HostPty = { pid: 1, write: (data) => writes.push(data), resize: () => {}, kill: () => {}, onData: () => {}, onExit: (listener) => void (exit = listener) };
    const terminal = await openHostTerminal({ id: 'main', size: { cols: 80, rows: 24 }, cwd: '/work', spawnPty: () => pty });

    const seen: Array<number | null> = [];
    terminal.onExit((code) => seen.push(code));
    exit!({ exitCode: 7 });
    expect(seen).toEqual([7]);
    terminal.write('x');
    expect(writes).toEqual([]);
  });

  it('가상 터미널을 열지 못하면 SandboxError로 알린다', async () => {
    await expect(
      openHostTerminal({
        id: 'main',
        size: { cols: 80, rows: 24 },
        cwd: '/work',
        spawnPty: () => {
          throw new Error('pty 없음');
        },
      }),
    ).rejects.toThrow('이 컴퓨터에서 터미널을 열지 못했습니다');
  });
});

describe('셸 시작 파일 (실제 셸)', () => {
  it('bash: 시작 파일이 PATH 앞에 claude를 두어도 함수가 이겨 감싸개를 부른다', async () => {
    const dir = await tempDir('b-studio-host-bash-');
    const home = await tempDir('b-studio-host-bash-home-');
    const fakeBin = await writeFakeClaude(home);
    // 사용자가 예전 설치 방식의 별칭을 두었다. 별칭은 함수보다 먼저 풀리므로, 우리 함수가 이기려면 별칭을 지워야 한다
    await writeFile(path.join(home, '.bash_profile'), `export PATH="${fakeBin}:$PATH"\nexport FROM_PROFILE=1\nalias claude='echo UNWRAPPED'\n`);
    await writeShellGateway(dir);
    const bashrc = path.join(dir, 'shell', 'bashrc');
    const run = (env: Record<string, string>, command: string): string => execFileSync('bash', ['--rcfile', bashrc, '-i', '-c', command], { env: { ...process.env, HOME: home, ...env }, encoding: 'utf8' });

    // 표식이 있으면 첫 실행을 건너뛰고, 사용자 .bash_profile이 PATH 앞에 둔 진짜 claude가 아니라 함수가 돈다
    const marked = run({ BSTUDIO_TERMINAL_STARTED: '1' }, 'claude a b; echo "$FROM_PROFILE"');
    expect(marked).toContain('WRAPPED a b');
    expect(marked).toContain('1');
    expect(marked).not.toContain('UNWRAPPED');

    // 표식이 없으면 시작할 때 한 번 claude를 띄운다
    const started = run({}, 'true');
    expect((started.match(/WRAPPED/g) ?? []).length).toBe(1);
    expect(started).toContain('claude에서 나왔습니다');
  });

  it.skipIf(!existsSync('/bin/zsh'))('zsh: 사용자 시작 파일을 그대로 읽고, 감싸개 함수와 첫 실행을 붙인다', async () => {
    const dir = await tempDir('b-studio-host-zsh-');
    const home = await tempDir('b-studio-host-zsh-home-');
    const fakeBin = await writeFakeClaude(home);
    await writeFile(path.join(home, '.zprofile'), 'export FROM_PROFILE=1\n');
    // 사용자가 예전 설치 방식의 별칭을 두었다. 별칭은 함수보다 먼저 풀리므로, 우리 함수가 이기려면 별칭을 지워야 한다
    await writeFile(path.join(home, '.zshrc'), `export PATH="${fakeBin}:$PATH"\nexport FROM_RC=1\nalias claude='echo UNWRAPPED'\n`);
    await writeShellGateway(dir);
    const zdotdir = path.join(dir, 'shell', 'zsh');
    const run = (env: Record<string, string>, command: string): string => execFileSync('/bin/zsh', ['-l', '-i', '-c', command], { env: { ...process.env, HOME: home, ZDOTDIR: zdotdir, BSTUDIO_USER_ZDOTDIR: home, ...env }, encoding: 'utf8' });

    // 표식이 있으면 첫 실행을 건너뛴다. 사용자 .zshrc가 PATH 앞에 둔 진짜 claude가 아니라 함수가 돈다
    const marked = run({ BSTUDIO_TERMINAL_STARTED: '1' }, 'claude a; print -r -- "$FROM_RC$FROM_PROFILE"; print -r -- "$HISTFILE"; print -r -- "$ZDOTDIR"');
    expect(marked).toContain('WRAPPED a');
    expect(marked).not.toContain('UNWRAPPED');
    const lines = marked.trim().split('\n');
    expect(lines).toContain('11');
    // 명령 기록은 관문 폴더가 아니라 사용자의 것으로 잡는다
    expect(lines).toContain(path.join(home, '.zsh_history'));
    expect(lines).toContain(zdotdir);

    // 표식이 없으면 .zlogin의 첫 실행이 claude를 한 번 띄운다
    const started = run({}, 'true');
    expect((started.match(/WRAPPED/g) ?? []).length).toBe(1);
    expect(started).toContain('claude에서 나왔습니다');
  });
});

describe('probeHostGateway', () => {
  it('관문이 200으로 답하면 참, 닿지 못하면 거짓', async () => {
    const dir = await tempDir('b-studio-host-probe-');
    await writeFile(path.join(dir, HOOK_SCRIPT_NAME), AGENT_HOOK_SCRIPT);
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(dir, GATEWAY_FILE_NAME), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'token' }));

    expect(await probeHostGateway(dir)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeHostGateway(dir)).toBe(false);
  });
});

describe('expectedHostGatewayFiles / checkHostGatewayConfig', () => {
  it('갓 쓴 폴더는 통과하고, 내용·권한·링크·폴더가 바뀌면 그 이름을 돌려준다', async () => {
    const root = await tempDir('b-studio-host-check-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    const expected = expectedHostGatewayFiles(address, dir, cli);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    // 내용이 바뀌면 그 파일 이름
    await writeFile(path.join(dir, 'settings.json'), '{}\n');
    expect(await checkHostGatewayConfig(dir, expected)).toEqual(['settings.json']);
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);

    // 없어지면 그 파일 이름
    await rm(path.join(dir, 'mcp.json'));
    expect(await checkHostGatewayConfig(dir, expected)).toEqual(['mcp.json']);
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);

    // 권한이 넓어지면 그 파일 이름(주소 파일에는 토큰이 있다)
    await chmod(path.join(dir, 'settings.json'), 0o644);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual(['settings.json']);
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);

    // 기대하는 파일 자리가 다른 곳을 가리키는 심볼릭 링크가 되면 그 파일 이름
    const elsewhere = path.join(root, 'elsewhere.json');
    await writeFile(elsewhere, expected['settings.json']!.content);
    await rm(path.join(dir, 'settings.json'));
    await symlink(elsewhere, path.join(dir, 'settings.json'));
    expect(await checkHostGatewayConfig(dir, expected)).toEqual(['settings.json']);
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    // 기대하지 않은 파일이 생긴 것은 위반으로 보지 않는다
    await writeFile(path.join(dir, 'extra.txt'), '남겨 둘 것');
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    // 폴더 권한이 넓어지면 그 폴더 이름(관문 폴더 자체는 '.')
    await chmod(path.join(dir, 'bin'), 0o755);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual(['bin']);
    await chmod(dir, 0o755);
    expect((await checkHostGatewayConfig(dir, expected)).sort()).toEqual(['.', 'bin']);
  });
});

describe('findUnhookedCli', () => {
  const settingsPath = '/Users/kim/.cache/b-studio/agent-gateway/studio-orders-abc/settings.json';
  const cliPath = '/Users/kim/.local/bin/claude';

  it('PTY 아래에서 우리 설정이 붙은 claude는 통과하고, 붙지 않은 것은 걸린다', () => {
    const processes = [
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 100, ppid: 1, args: '/bin/zsh -l -i' },
      { pid: 101, ppid: 100, args: `${cliPath} --settings ${settingsPath} --mcp-config /x/mcp.json` },
      { pid: 102, ppid: 100, args: `${cliPath} --resume` },
      { pid: 103, ppid: 100, args: 'node /Users/kim/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      // 감싸개(셸 스크립트)가 exec로 진짜 CLI가 되기 전 잠깐 보이는 모습. 첫 낱말이 /bin/sh라 CLI로 보지 않는다
      { pid: 104, ppid: 100, args: `/bin/sh /Users/kim/.cache/b-studio/agent-gateway/studio-orders-abc/bin/claude --settings x` },
      // PTY 밖(다른 부모)의 인자 없는 claude는 무시한다
      { pid: 999, ppid: 1, args: cliPath },
    ];
    expect(
      findUnhookedCli(100, processes, { settingsPath, cliPath }).map((entry) => entry.pid),
    ).toEqual([102, 103]);
  });

  it('손자 프로세스(셸 → 셸 → claude)도 찾는다', () => {
    const processes = [
      { pid: 100, ppid: 1, args: '/bin/zsh' },
      { pid: 110, ppid: 100, args: '/bin/bash' },
      { pid: 111, ppid: 110, args: cliPath },
    ];
    expect(findUnhookedCli(100, processes, { settingsPath, cliPath }).map((entry) => entry.pid)).toEqual([111]);
  });

  it('관문 경로에 빈칸이 있어도 붙은 것과 붙지 않은 것을 맞게 가른다', () => {
    const spaced = '/Users/kim/My Folder/.cache/b-studio/agent-gateway/studio-orders-abc/settings.json';
    const processes = [
      { pid: 100, ppid: 1, args: '/bin/zsh' },
      { pid: 101, ppid: 100, args: `${cliPath} --settings ${spaced} --mcp-config /x` },
      { pid: 102, ppid: 100, args: `${cliPath} --resume` },
    ];
    expect(findUnhookedCli(100, processes, { settingsPath: spaced, cliPath }).map((entry) => entry.pid)).toEqual([102]);
  });
});

describe('listProcesses', () => {
  it('이 테스트 프로세스가 목록에 있고 부모 pid가 process.ppid와 같다', async () => {
    const processes = await listProcesses();
    const self = processes.find((entry) => entry.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBe(process.ppid);
  });
});

describe('관문 폴더 안의 링크를 따라가지 않는다', () => {
  it('하위 폴더 자리가 관문 폴더 밖을 가리키는 링크여도 그 너머를 고치지 않고 자리를 새로 만든다', async () => {
    const root = await tempDir('b-studio-host-safe-');
    const outside = await tempDir('b-studio-host-safe-out-');
    const dir = await writeHostGatewayConfig('studio-orders-safe', address, cli, root);

    // bin 자리를 관문 폴더 밖을 가리키는 링크로 바꾼다
    await rm(path.join(dir, 'bin'), { recursive: true, force: true });
    await symlink(outside, path.join(dir, 'bin'));

    await writeHostGatewayConfig('studio-orders-safe', address, cli, root);

    // bin은 진짜 폴더가 되고 그 안에 감싸개가 있다
    expect((await stat(path.join(dir, 'bin'))).isDirectory()).toBe(true);
    expect(await exists(path.join(dir, 'bin', 'claude'))).toBe(true);
    // 밖의 폴더에는 아무것도 생기지 않았다
    expect(await readdir(outside)).toEqual([]);
    // 임시 파일이 남지 않는다
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('관문 폴더 자체가 링크면 쓰지 않고 던진다(그 너머를 건드리지 않는다)', async () => {
    const root = await tempDir('b-studio-host-linked-');
    const outside = await tempDir('b-studio-host-linked-out-');
    await symlink(outside, path.join(root, 'studio-orders-linked'));
    await expect(writeHostGatewayConfig('studio-orders-linked', address, cli, root)).rejects.toThrow('관문 폴더가 심볼릭 링크입니다');
    expect(await readdir(outside)).toEqual([]);
  });

  it('관문 폴더를 지울 때도 링크를 따라가지 않는다', async () => {
    const root = await tempDir('b-studio-host-remove-link-');
    const outside = await tempDir('b-studio-host-remove-out-');
    // 밖에 지워지면 안 되는 파일을 둔다
    await writeFile(path.join(outside, 'claude'), '건드리지 마라\n');
    const dir = await writeHostGatewayConfig('studio-orders-rm', address, cli, root);
    await rm(path.join(dir, 'bin'), { recursive: true, force: true });
    await symlink(outside, path.join(dir, 'bin'));

    await removeHostGatewayConfig('studio-orders-rm', root);

    // 밖의 파일은 그대로다
    expect(await readFile(path.join(outside, 'claude'), 'utf8')).toBe('건드리지 마라\n');
    // 관문 폴더와 그 링크 자리는 지워졌다
    expect(await exists(dir)).toBe(false);
  });
});


describe('Codex 터미널(#825)', () => {
  const codex = { kind: 'codex' as const, cliPath: '/opt/bin/codex', nodePath: '/usr/local/bin/node' };

  it('findHostCli는 B_STUDIO_CODEX_BIN을 쓰고, 없으면 PATH에서 codex를 찾는다', async () => {
    expect(await findHostCli({ B_STUDIO_CODEX_BIN: '/opt/tools/codex' }, 'codex')).toEqual({ kind: 'codex', cliPath: '/opt/tools/codex', nodePath: process.execPath });
    const binDir = await tempDir('b-studio-codex-bin-');
    await writeFile(path.join(binDir, 'codex'), '#!/bin/sh\n');
    await chmod(path.join(binDir, 'codex'), 0o755);
    expect((await findHostCli({ PATH: binDir }, 'codex')).cliPath).toBe(path.join(binDir, 'codex'));
    await expect(findHostCli({ PATH: await tempDir('b-studio-empty-') }, 'codex')).rejects.toThrow('codex CLI를 찾지 못했습니다');
  });

  it('설정 덮어쓰기: 훅 여섯 개·도구 서버·텔레메트리를 붙이고 훅을 켠다. 토큰은 인자에 넣지 않는다', () => {
    const args = codexGatewayArgs(address, '/root/gw', '/usr/local/bin/node');
    expect(args.filter((_, index) => index % 2 === 0).every((flag) => flag === '-c')).toBe(true);
    const values = args.filter((_, index) => index % 2 === 1);
    const command = (event: string) => JSON.stringify(`'/usr/local/bin/node' '/root/gw/${CODEX_HOOK_SCRIPT_NAME}' ${event}`);
    expect(values).toEqual([
      'features.hooks=true',
      `hooks.SessionStart=[{hooks=[{type="command",command=${command('session-start')},timeout=15}]}]`,
      `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${command('prompt')},timeout=60}]}]`,
      `hooks.PreToolUse=[{hooks=[{type="command",command=${command('pre-tool')},timeout=1800}]}]`,
      `hooks.Stop=[{hooks=[{type="command",command=${command('stop')},timeout=3600}]}]`,
      // Codex는 SessionEnd를 3초까지만 기다린다
      `hooks.SessionEnd=[{hooks=[{type="command",command=${command('session-end')},timeout=3}]}]`,
      `hooks.PermissionRequest=[{hooks=[{type="command",command=${command('notification')},timeout=15}]}]`,
      'mcp_servers.b-studio={url="http://127.0.0.1:41235/mcp",bearer_token_env_var="B_STUDIO_MCP_TOKEN"}',
      'otel.exporter={otlp-http={endpoint="http://127.0.0.1:41234/v1/logs",protocol="json"}}',
      'otel.log_user_prompt=false',
    ]);
    expect(args.join(' ')).not.toContain(address.hookToken);
    expect(args.join(' ')).not.toContain(address.mcpToken);
  });

  it('관문 폴더: 환경 파일(600)·감싸개(700)·주소 파일을 쓰고, 훅 스크립트는 관문 루트에 하나다. 세션이 달라도 훅 명령은 같다', async () => {
    const root = await tempDir('b-studio-codex-gateway-');
    const one = await writeHostGatewayConfig('studio-orders-abc', address, codex, root);
    const two = await writeHostGatewayConfig('studio-orders-def', { ...address, hookUrl: 'http://127.0.0.1:50000', mcpUrl: 'http://127.0.0.1:50001/mcp' }, codex, root);
    const realRoot = path.dirname(one);

    expect(await readFile(path.join(realRoot, CODEX_HOOK_SCRIPT_NAME), 'utf8')).toBe(CODEX_HOOK_SCRIPT);
    expect(await modeOf(path.join(realRoot, CODEX_HOOK_SCRIPT_NAME))).toBe(0o600);
    expect(await exists(path.join(one, 'settings.json'))).toBe(false);
    expect(await exists(path.join(one, HOOK_SCRIPT_NAME))).toBe(false);

    const env = await readFile(path.join(one, 'codex.env'), 'utf8');
    expect(await modeOf(path.join(one, 'codex.env'))).toBe(0o600);
    expect(env).toContain(`export B_STUDIO_GATEWAY_DIR=${shellQuote(one)}`);
    expect(env).toContain("export B_STUDIO_MCP_TOKEN='mcp-token'");
    expect(env).toContain("export OTEL_EXPORTER_OTLP_LOGS_HEADERS='Authorization=Bearer%20hook-token'");
    expect(JSON.parse(await readFile(path.join(one, GATEWAY_FILE_NAME), 'utf8'))).toEqual({ url: address.hookUrl, token: address.hookToken });

    const wrapper = await readFile(path.join(one, 'bin', 'codex'), 'utf8');
    expect(await modeOf(path.join(one, 'bin', 'codex'))).toBe(0o700);
    expect(wrapper).toContain(`. ${shellQuote(path.join(one, 'codex.env'))}`);
    expect(wrapper).toContain(`exec '/opt/bin/codex' '-c' 'features.hooks=true'`);
    expect(wrapper).not.toContain('hook-token');

    // 훅 명령 글은 세션과 상관없이 같다(Codex가 이 글의 해시로 신뢰를 기억한다)
    const hooksOf = (text: string) => text.match(/hooks\.[A-Za-z]+=\[\{hooks=.*?timeout=\d+\}\]\}\]/g);
    expect(hooksOf(wrapper)).toEqual(hooksOf(await readFile(path.join(two, 'bin', 'codex'), 'utf8')));
    expect(hooksOf(wrapper)).toHaveLength(6);

    // 셸 시작 파일은 codex 함수를 정의하고 codex를 띄운다
    const zshrc = await readFile(path.join(one, 'shell', 'zsh', '.zshrc'), 'utf8');
    expect(zshrc).toContain(`unalias codex 2>/dev/null\nfunction codex { ${shellQuote(path.join(one, 'bin', 'codex'))} "$@"; }`);
    expect(await readFile(path.join(one, 'shell', 'zsh', '.zlogin'), 'utf8')).toContain('  codex\n');
    expect(await readFile(path.join(one, 'shell', 'bashrc'), 'utf8')).toContain('[b-studio] codex에서 나왔습니다');

    // 기대 파일 검사가 갓 쓴 폴더를 통과시키고, 공용 훅 스크립트가 바뀌면 잡는다
    const expected = expectedHostGatewayFiles(address, one, codex);
    expect(await checkHostGatewayConfig(one, expected)).toEqual([]);
    await writeFile(path.join(realRoot, CODEX_HOOK_SCRIPT_NAME), '// 바꿈');
    expect(await checkHostGatewayConfig(one, expected)).toEqual([path.join('..', CODEX_HOOK_SCRIPT_NAME)]);
  });

  it('지울 때 그 세션의 파일만 지우고 공용 훅 스크립트는 남긴다', async () => {
    const root = await tempDir('b-studio-codex-gateway-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, codex, root);
    await removeHostGatewayConfig('studio-orders-abc', root);
    expect(await exists(dir)).toBe(false);
    expect(await exists(path.join(path.dirname(dir), CODEX_HOOK_SCRIPT_NAME))).toBe(true);
  });

  it('공용 훅 스크립트는 B_STUDIO_GATEWAY_DIR의 주소로 보내고, 관문 루트 밖의 폴더면 보내지 않고 막는다', async () => {
    const root = await tempDir('b-studio-codex-hook-');
    await writeFile(path.join(root, CODEX_HOOK_SCRIPT_NAME), CODEX_HOOK_SCRIPT);
    const received: string[] = [];
    const server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', (part: Buffer) => parts.push(part));
      request.on('end', () => {
        received.push(`${request.url} ${request.headers.authorization} ${Buffer.concat(parts).toString('utf8')}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ decision: 'block', reason: '되돌려 보냄' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const inside = path.join(root, 'studio-orders-abc');
    await mkdir(inside);
    await writeFile(path.join(inside, GATEWAY_FILE_NAME), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'token-1' }));
    // 같은 프로세스의 서버가 답해야 하므로 동기 실행(execFileSync)을 쓰지 않는다
    const run = (dir: string, event: string) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, [path.join(root, CODEX_HOOK_SCRIPT_NAME), event], { env: { B_STUDIO_GATEWAY_DIR: dir }, encoding: 'utf8', timeout: 20_000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
        child.stdin?.end('{"tool_name":"apply_patch"}');
      });

    expect(JSON.parse(await run(inside, 'stop'))).toEqual({ decision: 'block', reason: '되돌려 보냄' });
    expect(received).toEqual(['/stop Bearer token-1 {"tool_name":"apply_patch"}']);

    // 관문 루트 밖에 같은 꼴의 폴더를 만들어 가리키면 보내지 않는다. 쓰기 직전이면 도구를 막는다
    const outside = await tempDir('b-studio-codex-outside-');
    await writeFile(path.join(outside, GATEWAY_FILE_NAME), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'token-2' }));
    const denied = JSON.parse(await run(outside, 'pre-tool'));
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(received).toHaveLength(1);
  });

  it('probeHostGateway: codex 관문 폴더면 관문 루트의 공용 스크립트로 묻는다', async () => {
    const root = await tempDir('b-studio-codex-probe-');
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const dir = await writeHostGatewayConfig('studio-orders-abc', { ...address, hookUrl: `http://127.0.0.1:${port}` }, codex, root);
    expect(await probeHostGateway(dir, process.execPath, 'codex')).toBe(true);
    // claude 방식으로 물으면 그 폴더에 claude용 스크립트가 없어 닿지 못한다
    expect(await probeHostGateway(dir, process.execPath, 'claude')).toBe(false);
  });

  it('PTY 아래에서 공용 훅 스크립트가 붙은 codex는 통과하고, 붙지 않은 codex는 걸린다', () => {
    const settingsPath = '/Users/kim/.cache/b-studio/agent-gateway/studio-orders-abc/settings.json';
    const script = `/Users/kim/.cache/b-studio/agent-gateway/${CODEX_HOOK_SCRIPT_NAME}`;
    const processes = [
      { pid: 100, ppid: 1, args: '/bin/zsh -l -i' },
      { pid: 101, ppid: 100, args: `node /Users/kim/.local/lib/node_modules/@openai/codex/bin/codex.js -c features.hooks=true -c hooks.Stop=[{hooks=[{type="command",command="'/n' '${script}' stop"}]}]` },
      { pid: 102, ppid: 101, args: `/Users/kim/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/bin/codex -c hooks.Stop=[{hooks=[{type="command",command="'/n' '${script}' stop"}]}]` },
      { pid: 103, ppid: 100, args: '/opt/bin/codex --resume' },
      { pid: 104, ppid: 100, args: 'node /Users/kim/.local/lib/node_modules/@openai/codex/bin/codex.js' },
      // claude 터미널의 표식은 codex를 통과시키지 않는다
      { pid: 105, ppid: 100, args: `/opt/bin/codex --settings ${settingsPath}` },
    ];
    expect(findUnhookedCli(100, processes, { settingsPath, cliPath: '/opt/bin/codex', kind: 'codex' }).map((entry) => entry.pid)).toEqual([103, 104, 105]);
  });

  it('셸 실행: 관문 없는 터미널과 fish 대체 명령도 codex를 띄운다', () => {
    expect(hostShellLaunch(undefined, {}, 'codex').args[1]).toContain('\ncodex\n');
    const fish = hostShellLaunch('/gw/studio-1', { SHELL: '/opt/homebrew/bin/fish' }, 'codex');
    expect(fish.args[1]).toContain(shellQuote('/gw/studio-1/bin/codex'));
  });
});

describe('applyPatchPaths', () => {
  it('추가·고침·지움·옮길 곳의 경로를 모두 꺼낸다', () => {
    const patch = ['*** Begin Patch', '*** Add File: src/a.ts', '+x', '*** Update File: src/b.ts', '*** Move to: src/c.ts', '@@', '-y', '+z', '*** Delete File: old/d.ts', '*** End Patch', ''].join('\n');
    expect(applyPatchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'old/d.ts']);
  });

  it('패치가 아닌 글이면 빈 목록이다', () => {
    expect(applyPatchPaths('ls -la')).toEqual([]);
  });
});

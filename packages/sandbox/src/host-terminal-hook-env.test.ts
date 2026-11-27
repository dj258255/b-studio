import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOOK_SCRIPT,
  CODEX_GATEWAY_DIR_ENV,
  CODEX_HOOK_SCRIPT,
  CODEX_HOOK_SCRIPT_NAME,
  GATEWAY_FILE_NAME,
  HOOK_SCRIPT_NAME,
  STATUSLINE_FILE,
  agentManagedSettings,
} from './docker/agent-terminal';
import { OPENCODE_UNSET_ENVS, codexHookCommand, hostGatewaySettings, hostOpenCodeWrapper } from './host-terminal';

/**
 * 세션 터미널의 훅이 CLI의 환경을 물려받지 않는지(#1475). 훅 명령을 진짜 `/bin/sh`와 진짜 node로 돌리고, 훅 스크립트가 보는 환경을 찍어 본다.
 * 진짜 claude·codex·opencode는 띄우지 않는다. 관문 대신 임시 루프백 서버(임의 포트)를 쓴다.
 */
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const address = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };

type HookEntry = { type: string; command: string };
function commandsOf(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks: HookEntry[] }>>;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  commands.push((settings.statusLine as HookEntry).command);
  return commands;
}

function sh(command: string, env: Record<string, string>, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { env, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

/** macOS가 모든 프로세스에 스스로 넣는 변수(`__CF_USER_TEXT_ENCODING`)는 훅 스크립트가 찍는 목록에서 뺀다(코드를 적재하지 않는다) */
/** 코드 적재 변수를 담은 "사용자 셸" 환경: 훅 안의 node가 이 코드를 읽으면 표식 파일이 생긴다 */
async function hostileEnv(root: string): Promise<{ env: Record<string, string>; marker: string }> {
  const marker = path.join(root, 'evil-ran');
  const evil = path.join(root, 'evil.cjs');
  await writeFile(evil, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  return { marker, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, NODE_OPTIONS: `--require ${evil}`, NODE_PATH: root, B_STUDIO_NOT_FORWARDED: 'secret' } };
}

describe('Claude 이 컴퓨터 방식 훅 명령(#1475)', () => {
  it('모든 훅·상태 줄 명령이 빈 환경(/usr/bin/env -i)에서 절대 경로의 node로 뜬다', () => {
    const settings = hostGatewaySettings(address, '/gateway', '/n/bin/node');
    const commands = commandsOf(settings);
    expect(commands.length).toBeGreaterThan(15);
    for (const command of commands) {
      expect(command, command).toMatch(/^'\/usr\/bin\/env' -i (?:[A-Z_]+="\$[A-Z_]+" )*'\/n\/bin\/node' '\/gateway\/b-studio-hook\.mjs' [a-z-]+$/u);
    }
    // 판정하는 훅은 환경을 하나도 넘기지 않는다
    for (const command of commands.filter((value) => !value.endsWith(' statusline'))) expect(command, command).toMatch(/^'\/usr\/bin\/env' -i '\/n\/bin\/node' /u);
  });

  it('훅 스크립트가 받는 환경이 비어 있고, 사용자 셸의 NODE_OPTIONS·NODE_PATH 코드는 돌지 않는다', async () => {
    const root = await tempDir('b-studio-hookenv-');
    const { env, marker } = await hostileEnv(root);
    const script = path.join(root, HOOK_SCRIPT_NAME);
    await writeFile(script, `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING')));\n`);
    const settings = hostGatewaySettings(address, root, process.execPath);
    const prompt = commandsOf(settings).find((command) => command.endsWith(' prompt'))!;
    // 대조: 같은 환경으로 환경 없이 node를 바로 부르면 코드가 돈다(시험이 코드 적재를 볼 수 있다는 증거)
    const direct = await sh(`'${process.execPath}' '${script}' prompt`, env);
    expect(direct.stdout).toContain('NODE_OPTIONS');
    await rm(marker, { force: true });
    const result = await sh(prompt, env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('상태 줄만 PATH·HOME 같은 평범한 변수를 넘겨 사용자의 원래 상태 줄이 돌 수 있고, 코드 적재 변수와 b-studio 변수는 넘기지 않는다', async () => {
    const root = await tempDir('b-studio-hookenv-');
    const { env, marker } = await hostileEnv(root);
    const script = path.join(root, HOOK_SCRIPT_NAME);
    await writeFile(script, `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()));\n`);
    const statusline = commandsOf(hostGatewaySettings(address, root, process.execPath)).find((command) => command.endsWith(' statusline'))!;
    const result = await sh(statusline, env);
    expect(result.code).toBe(0);
    const names = JSON.parse(result.stdout) as string[];
    expect(names).toContain('PATH');
    expect(names).toContain('HOME');
    for (const bad of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'LD_PRELOAD', 'B_STUDIO_NOT_FORWARDED']) expect(names).not.toContain(bad);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('진짜 훅 스크립트가 환경 없이도 관문 주소 파일을 읽어 관문에 닿는다(실패 꼬리도 그대로: 닿지 못하면 막는다)', async () => {
    const root = await tempDir('b-studio-hookenv-');
    const { env, marker } = await hostileEnv(root);
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.authorization}`);
      request.resume();
      request.on('end', () => response.end(JSON.stringify({ ok: true })));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(root, HOOK_SCRIPT_NAME), AGENT_HOOK_SCRIPT);
    await writeFile(path.join(root, GATEWAY_FILE_NAME), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'tok' }));
    const settings = hostGatewaySettings(address, root, process.execPath);
    const prompt = commandsOf(settings).find((command) => command.endsWith(' prompt'))!;
    const reached = await sh(prompt, env, '{"prompt":"x"}');
    expect(JSON.parse(reached.stdout)).toEqual({ ok: true });
    expect(seen).toEqual(['/prompt Bearer tok']);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    // 주소 파일을 지우면(닿지 못함) 쓰기 직전의 훅은 막는 쪽으로 답한다
    await rm(path.join(root, GATEWAY_FILE_NAME));
    const preTool = commandsOf(settings).find((command) => command.endsWith(' pre-tool'))!;
    const denied = JSON.parse((await sh(preTool, env, '{}')).stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('사용자의 원래 상태 줄 명령은 넘겨 준 PATH·HOME으로 돈다', async () => {
    const root = await tempDir('b-studio-hookenv-');
    const { env } = await hostileEnv(root);
    await writeFile(path.join(root, HOOK_SCRIPT_NAME), AGENT_HOOK_SCRIPT);
    await writeFile(path.join(root, STATUSLINE_FILE), JSON.stringify({ command: 'printf "%s|%s|%s" "$HOME" "${NODE_OPTIONS-unset}" "$(command -v sh >/dev/null && echo path-ok)"' }));
    const statusline = commandsOf(hostGatewaySettings(address, root, process.execPath)).find((command) => command.endsWith(' statusline'))!;
    const result = await sh(statusline, env, '{}');
    expect(result.stdout).toBe(`${root}|unset|path-ok`);
  });
});

describe('Codex 훅 명령(#1475)', () => {
  const root = '/gateway-root';

  it('빈 환경에서 절대 경로의 node로 뜨고, 세션의 관문 폴더 변수만 넘긴다. 명령 글은 세션과 무관하다(Codex가 글의 해시로 믿음을 기억한다)', () => {
    const command = codexHookCommand(root, '/n/bin/node', 'prompt');
    expect(command).toBe(`'/usr/bin/env' -i ${CODEX_GATEWAY_DIR_ENV}="$${CODEX_GATEWAY_DIR_ENV}" '/n/bin/node' '${root}/${CODEX_HOOK_SCRIPT_NAME}' prompt`);
    expect(codexHookCommand(root, '/n/bin/node', 'prompt')).toBe(command);
  });

  it('훅 스크립트는 세션의 관문 폴더 변수만 받고 사용자 셸의 NODE_OPTIONS 코드는 돌지 않는다', async () => {
    const base = await tempDir('b-studio-hookenv-');
    const { env, marker } = await hostileEnv(base);
    await writeFile(path.join(base, CODEX_HOOK_SCRIPT_NAME), `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING')));\n`);
    const command = codexHookCommand(base, process.execPath, 'prompt');
    const result = await sh(command, { ...env, [CODEX_GATEWAY_DIR_ENV]: path.join(base, 'session') });
    expect(JSON.parse(result.stdout)).toEqual([CODEX_GATEWAY_DIR_ENV]);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('진짜 Codex 훅 스크립트가 넘겨 받은 관문 폴더의 주소 파일로 관문에 닿는다', async () => {
    const base = await tempDir('b-studio-hookenv-');
    const { env } = await hostileEnv(base);
    const session = path.join(base, 'session');
    await mkdir(session);
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end(JSON.stringify({ via: request.url })));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(base, CODEX_HOOK_SCRIPT_NAME), CODEX_HOOK_SCRIPT);
    await writeFile(path.join(session, GATEWAY_FILE_NAME), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'tok' }));
    const result = await sh(codexHookCommand(base, process.execPath, 'session-start'), { ...env, [CODEX_GATEWAY_DIR_ENV]: session }, '{}');
    expect(JSON.parse(result.stdout)).toEqual({ via: '/session-start' });
  });
});

describe('컨테이너 방식 훅 명령(#1475)', () => {
  it('관리 설정의 훅·상태 줄 명령이 빈 환경에서 컨테이너의 node로 뜬다', () => {
    const settings = agentManagedSettings({ hookUrl: address.hookUrl, hookToken: address.hookToken });
    const commands = commandsOf(settings);
    expect(commands.length).toBeGreaterThan(15);
    for (const command of commands) expect(command, command).toMatch(/^\/usr\/bin\/env -i \/usr\/local\/bin\/node \/etc\/claude-code\/b-studio-hook\.mjs [a-z-]+$/u);
  });
});

describe('OpenCode 환경 변수(#1475)', () => {
  it('설정·플러그인·권한·홈을 바꾸는 변수 여덟이 모두 감싸개의 unset 한 줄에 있다', () => {
    expect([...OPENCODE_UNSET_ENVS].sort()).toEqual(
      [
        'OPENCODE_CONFIG_CONTENT',
        'OPENCODE_CONFIG_DIR',
        'OPENCODE_DISABLE_DEFAULT_PLUGINS',
        'OPENCODE_PERMISSION',
        'OPENCODE_PURE',
        'OPENCODE_TEST_HOME',
        'OPENCODE_TEST_MANAGED_CONFIG_DIR',
        'OPENCODE_TUI_CONFIG',
      ].sort(),
    );
    const wrapper = hostOpenCodeWrapper('/gw', { cliPath: '/x' });
    const line = wrapper.split('\n').find((value) => value.startsWith('unset '));
    expect(line?.slice('unset '.length).split(' ')).toEqual([...OPENCODE_UNSET_ENVS]);
  });

  it('Rust 감시가 거절하는 이름 목록은 TS의 지우는 목록과 같다(PURE는 따로 본다)', async () => {
    const source = await readFile(path.join(__dirname, '../../../crates/bstudio-session/src/terminal/watch.rs'), 'utf8');
    const body = /const OPENCODE_PLUGIN_ENVS: \[&str; \d+\] = \[([^\]]*)\];/u.exec(source)?.[1] ?? '';
    const names = [...body.matchAll(/"([A-Z0-9_]+)"/gu)].map((match) => match[1]);
    expect([...names, 'OPENCODE_PURE'].sort()).toEqual([...OPENCODE_UNSET_ENVS].sort());
  });
});


import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CLI_PACKAGE,
  AGENT_GATEWAY_ENV,
  AGENT_GATEWAY_TARGET,
  AGENT_HOOK_EVENTS,
  AGENT_IMAGE,
  AGENT_TERMINAL_COMMAND,
  AGENT_READ_TOOLS,
  AGENT_WRITE_TOOL_MATCHER,
  agentContainerName,
  agentGatewayFiles,
  agentHomeVolume,
  agentManagedMcp,
  agentManagedSettings,
  agentResizeArgs,
  agentRunArgs,
  agentTerminalArgs,
  clampTerminalSize,
  ensureAgentContainer,
  openAgentTerminal,
  writeAgentGatewayConfig,
} from './agent-terminal';
import type { MaskVolume } from './git-mask';

const mask = (source: string, target: string): MaskVolume => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
const plan = {
  name: 'studio-orders-abc123-agent',
  sandboxId: 'studio-orders-abc123',
  projectRoot: '/work/orders',
  masks: [mask('/work/orders/.git', '/workspace/.git'), mask('/work/orders/.git/b-studio-empty', '/workspace/.git/b-studio')],
  homeVolume: agentHomeVolume('orders'),
};

describe('에이전트 컨테이너 (이슈 #673)', () => {
  it('보이는 호스트 폴더는 작업 복사본 하나이고, .git은 읽기 전용으로 덮는다', () => {
    const args = agentRunArgs(plan);
    const mounts = args.flatMap((arg, index) => (arg === '--mount' ? [args[index + 1]!] : []));
    expect(mounts).toEqual([
      'type=bind,source=/work/orders,target=/workspace',
      'type=bind,source=/work/orders/.git,target=/workspace/.git,readonly',
      'type=bind,source=/work/orders/.git/b-studio-empty,target=/workspace/.git/b-studio,readonly',
      'type=volume,source=b-studio-agent-home-orders,target=/home/node',
    ]);
    // 도커 소켓이나 홈 폴더 같은 다른 호스트 경로는 연결하지 않는다
    expect(args).not.toContain('--volume');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it('권한을 내려놓고 root가 아닌 사용자로, 읽기 전용 루트에서 돈다. 샌드박스를 정리할 때 찾을 라벨을 붙인다', () => {
    const args = agentRunArgs(plan);
    const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
    expect(valueOf('--user')).toBe('node');
    expect(valueOf('--cap-drop')).toBe('ALL');
    expect(valueOf('--security-opt')).toBe('no-new-privileges');
    expect(args).toContain('--read-only');
    expect(args).not.toContain('--privileged');
    expect(args).toContain('b-studio.sandbox=studio-orders-abc123');
    expect(args).toContain('b-studio.service=b-studio-agent');
    expect(args.slice(-3)).toEqual([AGENT_IMAGE, 'sleep', 'infinity']);
  });

  it('쉼표가 든 경로는 --mount의 다른 옵션으로 읽히므로 받지 않는다', () => {
    expect(() => agentRunArgs({ ...plan, projectRoot: '/work/a,readonly=false' })).toThrow('쉼표');
    expect(() => agentRunArgs({ ...plan, masks: [mask('/work/orders/.git', '/workspace/.git,target=/etc')] })).toThrow('쉼표');
  });

  it('홈 볼륨은 프로젝트마다 따로다. 한 프로젝트에서 바꿔 둔 설정이나 실행 파일이 다른 프로젝트의 세션에 따라가지 않는다', () => {
    expect(agentHomeVolume('orders')).toBe('b-studio-agent-home-orders');
    expect(agentHomeVolume('pay-2')).not.toBe(agentHomeVolume('orders'));
    // 볼륨 이름에 못 쓰는 글자를 바꾸다가 서로 다른 프로젝트가 같은 이름이 되지 않는다
    expect(agentHomeVolume('a/b')).not.toBe(agentHomeVolume('a-b'));
    expect(agentHomeVolume('a/b')).toMatch(/^b-studio-agent-home-[A-Za-z0-9_.-]+$/);
    expect(() => agentHomeVolume('')).toThrow('프로젝트 id');
    expect(() => agentRunArgs({ ...plan, homeVolume: 'x,target=/etc' })).toThrow('쉼표');
  });

  it('설치할 CLI는 판을 고정한다(터미널을 열 때마다 최신을 받지 않는다)', () => {
    expect(AGENT_CLI_PACKAGE).toMatch(/^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
    expect(AGENT_TERMINAL_COMMAND).toContain(`npm install --global --no-fund --no-audit ${AGENT_CLI_PACKAGE} `);
    expect(AGENT_TERMINAL_COMMAND).not.toMatch(/claude-code(?!@)\s*\|\|/);
  });

  it('컨테이너 이름에 쓸 수 없는 글자는 바꾼다', () => {
    expect(agentContainerName('studio-orders-abc123')).toBe('studio-orders-abc123-agent');
    expect(agentContainerName('studio/../x y')).toBe('studio-..-x-y-agent');
  });
});

describe('터미널의 기본 명령', () => {
  it('Ctrl-C를 받아도 감싼 셸은 죽지 않는다(죽으면 터미널이 통째로 끝난다). 신호를 무시하지는 않아 CLI는 그대로 받는다', () => {
    expect(AGENT_TERMINAL_COMMAND.split('\n')[0]).toBe('trap : INT');
    // 무시(trap '' INT)는 자식 프로세스에 물려 내려간다. 받아서 아무것도 하지 않는 쪽이어야 한다
    expect(AGENT_TERMINAL_COMMAND).not.toContain("trap '' INT");
  });
});

describe('가상 터미널', () => {
  it('컨테이너 안에서 script로 터미널을 만들고, 명령과 크기는 환경 변수로 넘긴다', () => {
    const args = agentTerminalArgs('c-agent', { id: 'main', size: { cols: 120, rows: 40 } });
    expect(args.slice(0, 2)).toEqual(['exec', '--interactive']);
    // 호스트 쪽은 파이프다. -t를 주면 "the input device is not a TTY"로 실패한다
    expect(args).not.toContain('--tty');
    expect(args).not.toContain('-t');
    expect(args).toContain('B_STUDIO_TTY_FILE=/tmp/b-studio-tty-main');
    expect(args).toContain('B_STUDIO_TTY_SIZE=rows 40 cols 120');
    expect(args).toContain(`B_STUDIO_TERMINAL_COMMAND=${AGENT_TERMINAL_COMMAND}`);
    const script = args.slice(args.indexOf('c-agent') + 1);
    expect(script[0]).toBe('script');
    // script가 돌리는 글에는 바깥에서 온 값이 끼어들지 않는다(변수 이름만 있다)
    expect(script[script.indexOf('--command') + 1]).toBe('stty $B_STUDIO_TTY_SIZE; tty > "$B_STUDIO_TTY_FILE"; exec sh -c "$B_STUDIO_TERMINAL_COMMAND"');
  });

  it('크기는 정수로 좁히고 범위 밖은 끝값으로 맞춘다. 숫자가 아니면 기본값이다', () => {
    expect(clampTerminalSize({ cols: 120.9, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize({ cols: 5, rows: 1 })).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize({ cols: 99999, rows: 99999 })).toEqual({ cols: 400, rows: 200 });
    expect(clampTerminalSize({ cols: '80; rm -rf /', rows: Number.NaN })).toEqual({ cols: 100, rows: 30 });
  });

  it('크기를 바꾸는 명령에는 숫자만 들어간다', () => {
    const args = agentResizeArgs('c-agent', 'main', { cols: '80; touch /tmp/x' as unknown as number, rows: 50 });
    expect(args.at(-1)).toBe('stty -F "$(cat "$B_STUDIO_TTY_FILE")" rows 50 cols 100');
    expect(args).toContain('B_STUDIO_TTY_FILE=/tmp/b-studio-tty-main');
  });

  it('터미널 id는 파일 이름에 들어가므로 정해진 글자만 받는다', () => {
    expect(() => agentTerminalArgs('c', { id: '../etc/passwd', size: { cols: 80, rows: 24 } })).toThrow('터미널 id');
    expect(() => agentResizeArgs('c', 'a b', { cols: 80, rows: 24 })).toThrow('터미널 id');
  });

  it('입력을 프로세스의 표준 입력에 쓰고, 출력은 바이트 그대로 전한다. 닫으면 프로세스를 끝낸다', () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: [] as string[], kill(signal: string) { this.killed.push(signal); return true; } });
    const spawned: Array<{ command: string; args: string[] }> = [];
    const terminal = openAgentTerminal('c-agent', {
      id: 'main',
      size: { cols: 80, rows: 24 },
      dockerBin: 'docker-test',
      spawnProcess: (command, args) => {
        spawned.push({ command, args });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    expect(spawned[0]!.command).toBe('docker-test');
    expect(spawned[0]!.args).toEqual(agentTerminalArgs('c-agent', { id: 'main', size: { cols: 80, rows: 24 } }));

    const chunks: Buffer[] = [];
    terminal.onData((chunk) => chunks.push(chunk));
    child.stdout.write(Buffer.from([0x1b, 0x5b, 0x32, 0x4a]));
    child.stderr.write('경고');
    expect(Buffer.concat(chunks).subarray(0, 4)).toEqual(Buffer.from([0x1b, 0x5b, 0x32, 0x4a]));
    expect(Buffer.concat(chunks).subarray(4).toString('utf8')).toBe('경고');

    const written: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    terminal.write('안녕\r');
    expect(written.join('')).toBe('안녕\r');

    let exit: number | null | undefined;
    terminal.onExit((code) => (exit = code));
    terminal.close();
    expect(child.killed).toEqual(['SIGTERM']);
    child.emit('close', 0);
    expect(exit).toBe(0);
    // 닫힌 뒤의 입력은 조용히 버린다
    expect(() => terminal.write('x')).not.toThrow();
  });
});

describe('관문 설정 (이슈 #673 2단계)', () => {
  it('관문 폴더는 CLI의 관리 설정 자리에 읽기 전용으로만 붙는다. 주지 않으면 붙이지 않는다', () => {
    const mountsOf = (args: string[]) => args.flatMap((arg, index) => (arg === '--mount' ? [args[index + 1]!] : []));
    expect(mountsOf(agentRunArgs(plan)).some((mount) => mount.includes(AGENT_GATEWAY_TARGET))).toBe(false);
    const mounts = mountsOf(agentRunArgs({ ...plan, gatewayDir: '/home/me/.cache/b-studio/agent-gateway/abc' }));
    expect(mounts.at(-1)).toBe('type=bind,source=/home/me/.cache/b-studio/agent-gateway/abc,target=/etc/claude-code,readonly');
    expect(() => agentRunArgs({ ...plan, gatewayDir: '/tmp/a,target=/workspace' })).toThrow('쉼표');
  });

  it('관리 설정은 훅 다섯과 b-studio 도구의 허락만 적는다. 읽기 도구가 아닌 모든 도구에 쓰기 직전의 훅을 건다', () => {
    const settings = agentManagedSettings() as { permissions: { allow: string[] }; hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions']);
    expect(settings.permissions.allow).toEqual(['mcp__b-studio']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const command = (name: string) => settings.hooks[name]![0]!.hooks[0]!;
    // node는 이름이 아니라 자리로 부른다. 터미널의 PATH 앞쪽(홈 폴더)에 같은 이름을 두어 훅을 바꿔치기하지 못한다
    expect(command('UserPromptSubmit').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs prompt');
    expect(command('Stop').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs stop');
    expect(command('SessionStart').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs session-start');
    expect(command('SessionEnd').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs session-end');
    expect(command('PreToolUse').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs pre-tool');
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe(AGENT_WRITE_TOOL_MATCHER);
    const hooked = (tool: string) => new RegExp(AGENT_WRITE_TOOL_MATCHER).test(tool);
    // 셸, 편집 도구, b-studio 도구에 건다. 모르는 도구(CLI에 새로 생긴 것)도 건다 — 빠지면 그 도구로 바꾼 파일은 변경 전 기준 없이 바뀐다
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'mcp__b-studio__run_in_service', 'SomeNewTool', 'Workflow']) expect(hooked(tool)).toBe(true);
    // 읽기 도구만 건너뛴다. 이름이 읽기 도구로 시작하거나 끝나기만 하는 다른 도구는 건다
    for (const tool of AGENT_READ_TOOLS) expect(hooked(tool)).toBe(false);
    for (const tool of ['ReadAndWrite', 'XRead', 'Read|Write', 'read']) expect(hooked(tool)).toBe(true);
    expect(AGENT_READ_TOOLS).not.toContain('Bash');
    expect(AGENT_READ_TOOLS).not.toContain('Write');
    // 게이트 한 번이 수 분 걸린다. 훅이 그보다 먼저 끊기면 결과가 에이전트에게 가지 못한다
    expect(command('Stop').timeout).toBeGreaterThanOrEqual(1800);
    expect(command('PreToolUse').timeout).toBeGreaterThanOrEqual(600);
  });

  it('설정 파일에는 주소도 토큰도 없다. 환경 변수의 이름만 적는다', async () => {
    const files = agentGatewayFiles();
    expect(Object.keys(files).sort()).toEqual(['b-studio-hook.mjs', 'managed-mcp.json', 'managed-settings.json']);
    const mcp = agentManagedMcp() as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(mcp.mcpServers['b-studio']).toEqual({ type: 'http', url: '${B_STUDIO_MCP_URL}', headers: { Authorization: 'Bearer ${B_STUDIO_MCP_TOKEN}' } });
    for (const content of Object.values(files)) {
      expect(content).not.toMatch(/https?:\/\/\d/);
      expect(content).not.toMatch(/[0-9a-f]{32}/);
    }
    expect(files['b-studio-hook.mjs']).toContain(`process.env.${AGENT_GATEWAY_ENV.hookToken}`);
  });

  it('호스트에 쓴 폴더의 이름은 내용에서 나온다. 같은 내용이면 건드리지 않고, 누가 고쳤으면 다시 쓴다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-gateway-config-'));
    const dir = await writeAgentGatewayConfig(root);
    expect(path.dirname(dir)).toBe(await realpath(root));
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect((await readdir(dir)).sort()).toEqual(['b-studio-hook.mjs', 'managed-mcp.json', 'managed-settings.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'managed-settings.json'), 'utf8'))).toEqual(agentManagedSettings());

    await writeFile(path.join(dir, 'managed-settings.json'), '{"hooks":{}}');
    expect(await writeAgentGatewayConfig(root)).toBe(dir);
    expect(JSON.parse(await readFile(path.join(dir, 'managed-settings.json'), 'utf8'))).toEqual(agentManagedSettings());
    // 임시 파일을 남기지 않는다
    expect((await readdir(dir)).sort()).toEqual(['b-studio-hook.mjs', 'managed-mcp.json', 'managed-settings.json']);
  });

  it('터미널에 넘길 환경 변수는 이름만 명령줄에 싣고 값은 프로세스의 환경으로 준다', () => {
    const args = agentTerminalArgs('c', { id: 'main', size: { cols: 80, rows: 24 }, inherit: ['B_STUDIO_GATEWAY_URL', 'B_STUDIO_GATEWAY_TOKEN'] });
    const envs = args.flatMap((arg, index) => (arg === '--env' ? [args[index + 1]!] : []));
    expect(envs).toContain('B_STUDIO_GATEWAY_URL');
    expect(envs).toContain('B_STUDIO_GATEWAY_TOKEN');
    expect(() => agentTerminalArgs('c', { id: 'main', size: { cols: 80, rows: 24 }, inherit: ['A=b'] })).toThrow('환경 변수의 이름');
    expect(() => agentTerminalArgs('c', { id: 'main', size: { cols: 80, rows: 24 }, inherit: ['--privileged'] })).toThrow('환경 변수의 이름');

    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    openAgentTerminal('c', {
      id: 'main',
      size: { cols: 80, rows: 24 },
      env: { B_STUDIO_GATEWAY_TOKEN: 'secret-token-value', B_STUDIO_GATEWAY_URL: 'http://host.docker.internal:1' },
      spawnProcess: (_bin, spawnArgs, env) => {
        spawned.push({ args: spawnArgs, env });
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
      },
    });
    expect(spawned[0]!.args.join(' ')).not.toContain('secret-token-value');
    expect(spawned[0]!.args.join(' ')).not.toContain('host.docker.internal');
    expect(spawned[0]!.env.B_STUDIO_GATEWAY_TOKEN).toBe('secret-token-value');
    // docker 자신이 쓸 환경(PATH 등)은 그대로 둔다
    expect(spawned[0]!.env.PATH).toBe(process.env.PATH);
  });
});

describe('훅 스크립트 (컨테이너 안에서 CLI의 훅이 실행한다)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function script(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-hook-script-'));
    const file = path.join(dir, 'b-studio-hook.mjs');
    await writeFile(file, agentGatewayFiles()['b-studio-hook.mjs']!);
    return file;
  }

  async function gateway(reply: (request: IncomingMessage, body: string) => { status: number; body: string }) {
    const seen: Array<{ url: string; authorization: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
        const answer = reply(request, body);
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
  }

  function run(file: string, event: string, env: Record<string, string>, input: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [file, event], { env: { PATH: process.env.PATH, ...env } }, (error, stdout) => resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout }));
      child.stdin!.end(input);
    });
  }

  it('훅의 입력을 그 종류의 경로로 보내고, 관문의 답을 그대로 출력한다', async () => {
    const file = await script();
    const { url, seen } = await gateway(() => ({ status: 200, body: JSON.stringify({ decision: 'block', reason: '검증 실패: 고치세요' }) }));
    const input = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '끝났습니다' });
    const result = await run(file, 'stop', { [AGENT_GATEWAY_ENV.hookUrl]: url, [AGENT_GATEWAY_ENV.hookToken]: 'tok' }, input);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: '검증 실패: 고치세요' });
    expect(seen).toEqual([{ url: '/stop', authorization: 'Bearer tok', body: input }]);
  });

  it('관문에 닿지 못하면: 파일을 바꿀 수 있는 도구는 거절하고, 요청은 막지 않되 알리고, 턴의 끝은 막지 않는다', async () => {
    const file = await script();
    const closed = { [AGENT_GATEWAY_ENV.hookUrl]: 'http://127.0.0.1:1', [AGENT_GATEWAY_ENV.hookToken]: 'tok' };
    const prompt = await run(file, 'prompt', closed, '{"prompt":"고쳐줘"}');
    expect(prompt.code).toBe(0);
    const said = JSON.parse(prompt.stdout) as { systemMessage?: string; decision?: string };
    expect(said.systemMessage).toContain('관문에 닿지 못했습니다');
    expect(said.systemMessage).toContain('체크포인트도 생기지 않습니다');
    // 요청을 막는 출력이 아니다
    expect(said.decision).toBeUndefined();

    // 쓰기 직전: 변경 전 기준을 잡지 못한 채 바뀌게 두지 않는다
    const tool = await run(file, 'pre-tool', closed, '{"tool_name":"Write"}');
    expect(tool.code).toBe(0);
    const denied = JSON.parse(tool.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(denied.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('관문에 닿지 못해');

    // 턴의 끝은 막지 않는다(막으면 CLI가 끝나지 않는다). 검증이 돌지 않았으니 체크포인트도 없다
    for (const event of ['stop', 'session-start', 'session-end']) expect(await run(file, event, closed, '{}')).toEqual({ code: 0, stdout: '' });
  });

  it('관문이 오류로 답했거나 읽을 수 없는 답을 주면 닿지 못한 것으로 본다(그 답을 CLI에 넘기지 않는다)', async () => {
    const file = await script();
    const failing = await gateway(() => ({ status: 500, body: JSON.stringify({ decision: 'block', reason: '서버 오류인데 막는 꼴' }) }));
    const env = { [AGENT_GATEWAY_ENV.hookUrl]: failing.url, [AGENT_GATEWAY_ENV.hookToken]: 'tok' };
    expect(await run(file, 'stop', env, '{}')).toEqual({ code: 0, stdout: '' });
    const garbled = await gateway(() => ({ status: 200, body: '<html>프록시 오류</html>' }));
    expect(await run(file, 'stop', { ...env, [AGENT_GATEWAY_ENV.hookUrl]: garbled.url }, '{}')).toEqual({ code: 0, stdout: '' });
    // 쓰기 직전의 훅은 오류 답도 거절로 바꾼다. 서버가 준 "{}"(허용)로 읽지 않는다
    const allowing = await gateway(() => ({ status: 500, body: '{}' }));
    const tool = await run(file, 'pre-tool', { ...env, [AGENT_GATEWAY_ENV.hookUrl]: allowing.url }, '{}');
    expect(JSON.parse(tool.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('관문의 주소가 없으면(관문 없이 연 터미널) 아무 데도 보내지 않고 아무것도 막지 않는다. 모르는 종류도 같다', async () => {
    const file = await script();
    const { url, seen } = await gateway(() => ({ status: 200, body: '{}' }));
    for (const event of ['prompt', 'pre-tool', 'stop', 'session-start', 'session-end']) {
      expect(await run(file, event, {}, '{}')).toEqual({ code: 0, stdout: '' });
      expect(await run(file, event, { [AGENT_GATEWAY_ENV.hookUrl]: url }, '{}')).toEqual({ code: 0, stdout: '' });
    }
    expect(await run(file, 'constructor', { [AGENT_GATEWAY_ENV.hookUrl]: url, [AGENT_GATEWAY_ENV.hookToken]: 'tok' }, '{}')).toEqual({ code: 0, stdout: '' });
    expect(seen).toEqual([]);
    // 훅으로 거는 종류는 설정이 거는 종류와 같다
    expect(Object.keys(AGENT_HOOK_EVENTS).sort()).toEqual(['pre-tool', 'prompt', 'session-end', 'session-start', 'stop']);
  });

  it('닿는지 묻는 일(ping)은 닿으면 0, 닿지 못하거나 관문이 오류로 답하거나 주소가 없으면 0이 아닌 값으로 끝난다', async () => {
    const file = await script();
    const up = await gateway(() => ({ status: 200, body: '{}' }));
    const env = { [AGENT_GATEWAY_ENV.hookUrl]: up.url, [AGENT_GATEWAY_ENV.hookToken]: 'tok' };
    expect((await run(file, 'ping', env, '')).code).toBe(0);
    expect(up.seen).toMatchObject([{ url: '/ping', authorization: 'Bearer tok' }]);
    expect((await run(file, 'ping', { ...env, [AGENT_GATEWAY_ENV.hookUrl]: 'http://127.0.0.1:1' }, '')).code).not.toBe(0);
    const refusing = await gateway(() => ({ status: 403, body: '{}' }));
    expect((await run(file, 'ping', { ...env, [AGENT_GATEWAY_ENV.hookUrl]: refusing.url }, '')).code).not.toBe(0);
    expect((await run(file, 'ping', {}, '')).code).not.toBe(0);
  });
});

describe('컨테이너를 띄운 뒤의 확인 (관문 설정)', () => {
  /** 가짜 docker: 부른 인자를 적고, inspect는 상태 파일을 돌려주고, run은 "띄운 뒤의 모습"을 상태로 옮긴다 */
  async function fakeDocker(): Promise<{ bin: string; dir: string; root: string; calls: () => Promise<string[]>; mounts: (extra: unknown[]) => string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-fake-docker-'));
    const root = path.join(dir, 'project');
    await mkdir(root);
    const bin = path.join(dir, 'docker');
    await writeFile(
      bin,
      ['#!/bin/sh', `D='${dir}'`, 'echo "$@" >> "$D/calls"', 'case "$1" in', '  inspect) [ -f "$D/inspect.json" ] && cat "$D/inspect.json" || exit 1 ;;', '  run) cp "$D/after-run.json" "$D/inspect.json" ;;', '  rm) rm -f "$D/inspect.json" ;;', 'esac', ''].join('\n'),
    );
    await chmod(bin, 0o755);
    const realRoot = await realpath(root);
    return {
      bin,
      dir,
      root,
      calls: async () => (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n'),
      mounts: (extra) => JSON.stringify([{ State: { Running: true }, Mounts: [{ Type: 'bind', Source: realRoot, Destination: '/workspace', RW: true }, ...extra] }]),
    };
  }
  const gatewayDir = '/Users/me/.cache/b-studio/agent-gateway/0123456789abcdef';

  it('관문 폴더가 읽기 전용으로 붙은 것을 확인하고서야 컨테이너를 내준다. 도커가 경로 앞에 붙인 접두어는 받아들인다', async () => {
    const docker = await fakeDocker();
    await writeFile(path.join(docker.dir, 'after-run.json'), docker.mounts([{ Type: 'bind', Source: `/host_mnt${gatewayDir}`, Destination: '/etc/claude-code', RW: false }]));
    expect(await ensureAgentContainer('sb', docker.root, { projectId: 'p', gatewayDir, dockerBin: docker.bin })).toBe('sb-agent');
    const calls = await docker.calls();
    expect(calls.find((call) => call.startsWith('run '))).toContain(`type=bind,source=${gatewayDir},target=/etc/claude-code,readonly`);
    // 이미 맞게 떠 있으면 다시 띄우지 않는다
    expect(await ensureAgentContainer('sb', docker.root, { projectId: 'p', gatewayDir, dockerBin: docker.bin })).toBe('sb-agent');
    expect((await docker.calls()).filter((call) => call.startsWith('run '))).toHaveLength(1);
  });

  it('띄웠는데 관문 폴더가 없거나, 쓸 수 있게 붙었거나, 다른 폴더가 붙었으면 지우고 던진다', async () => {
    for (const extra of [[], [{ Type: 'bind', Source: gatewayDir, Destination: '/etc/claude-code', RW: true }], [{ Type: 'bind', Source: '/Users/me/.cache/b-studio/agent-gateway/ffffffffffffffff', Destination: '/etc/claude-code', RW: false }]]) {
      const docker = await fakeDocker();
      await writeFile(path.join(docker.dir, 'after-run.json'), docker.mounts(extra));
      await expect(ensureAgentContainer('sb', docker.root, { projectId: 'p', gatewayDir, dockerBin: docker.bin })).rejects.toThrow('관문 설정을 확인하지 못해');
      expect((await docker.calls()).at(-1)).toBe('rm --force sb-agent');
    }
  });

  it('관문 없이 떠 있던 컨테이너(앞 판이 띄운 것)는 다시 쓰지 않고 새로 띄운다. 반대도 같다', async () => {
    const docker = await fakeDocker();
    const withGateway = docker.mounts([{ Type: 'bind', Source: gatewayDir, Destination: '/etc/claude-code', RW: false }]);
    // 관문 없이 떠 있다 → 관문을 붙여 달라고 하면 지우고 새로 띄운다
    await writeFile(path.join(docker.dir, 'inspect.json'), docker.mounts([]));
    await writeFile(path.join(docker.dir, 'after-run.json'), withGateway);
    await ensureAgentContainer('sb', docker.root, { projectId: 'p', gatewayDir, dockerBin: docker.bin });
    expect((await docker.calls()).slice(1, 3).map((call) => call.split(' ')[0])).toEqual(['rm', 'run']);
    // 관문을 붙인 채 떠 있다 → 관문 없이 달라고 하면 그것도 새로 띄운다
    await writeFile(path.join(docker.dir, 'after-run.json'), docker.mounts([]));
    await ensureAgentContainer('sb', docker.root, { projectId: 'p', dockerBin: docker.bin });
    const runs = (await docker.calls()).filter((call) => call.startsWith('run '));
    expect(runs).toHaveLength(2);
    expect(runs[1]).not.toContain('/etc/claude-code');
  });
});

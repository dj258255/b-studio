import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluationAssetCopies } from './evaluation-assets';
import {
  AGENT_CLI_PACKAGE,
  AGENT_GATEWAY_TARGET,
  AGENT_HOOK_EVENTS,
  AGENT_IMAGE,
  AGENT_NOTIFICATION_MATCHER,
  AGENT_READ_ONLY_MARK,
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
  agentTelemetryEnv,
  agentTerminalArgs,
  clampTerminalSize,
  ensureAgentContainer,
  openAgentTerminal,
  probeAgentGateway,
  removeAgentGatewayConfig,
  writeAgentGatewayConfig,
  type AgentGatewayAddress,
  isReadOnlyPrompt,
  unwrapPastedPrompt,
  agentCleanupCommand,
} from './agent-terminal';
import type { MaskVolume } from './git-mask';

const address: AgentGatewayAddress = { hookUrl: 'http://host.docker.internal:41001', hookToken: 'hook-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', mcpUrl: 'http://host.docker.internal:41002/mcp', mcpToken: 'mcp-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
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

  it('에이전트 컨테이너를 지우는 명령은 그 샌드박스의 컨테이너 이름만 가리킨다(스튜디오가 종료 신호를 받았을 때 떼어 놓고 돌린다)', () => {
    expect(agentCleanupCommand('studio-orders-abc123')).toEqual({ command: 'docker', args: ['rm', '--force', agentContainerName('studio-orders-abc123')] });
    expect(agentCleanupCommand('studio-orders-abc123', { dockerBin: 'docker-test' }).command).toBe('docker-test');
    // b-studio가 만든 샌드박스 id의 꼴이 아니면 명령을 만들지 않는다. 저장된 기록의 값으로 남의 컨테이너를 지우지 않는다
    for (const id of ['x; rm -rf /', 'pay', 'dbtower-mysql', '../studio-orders-abc123', 'studio-orders-ABC123', '']) expect(() => agentCleanupCommand(id), id).toThrow();
  });

  it('CLI에서 나온 뒤의 셸은 로그인 셸이 아니다 — 로그인 셸은 PATH를 기본값으로 되돌려 설치한 CLI를 찾지 못한다', () => {
    const lines = AGENT_TERMINAL_COMMAND.split('\n');
    expect(lines.at(-1)).toBe('exec bash');
    expect(AGENT_TERMINAL_COMMAND).not.toMatch(/bash\s+(-l|--login)/);
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

describe('붙여 넣은 요청의 감싸개를 벗긴다 (이슈 #733)', () => {
  it('감싸개 표시만 지우고 안의 글은 남긴다. 여는 표시 뒤와 닫는 표시 앞의 줄바꿈 하나도 함께 지운다', () => {
    expect(unwrapPastedPrompt('<pasted_content id="e4a3">\na 모듈을 만들어 주세요\n</pasted_content id="e4a3">')).toBe('a 모듈을 만들어 주세요');
    // id 없는 꼴도 벗긴다
    expect(unwrapPastedPrompt('<pasted_content>\n설명해 줘\n</pasted_content>')).toBe('설명해 줘');
    // 줄바꿈 없이 붙은 감싸개도 벗긴다
    expect(unwrapPastedPrompt('<pasted_content id="x">내용</pasted_content id="x">')).toBe('내용');
  });

  it('여러 번 붙여 넣으면 감싸개도 여러 개다. 사람이 친 글은 그대로 남는다', () => {
    expect(unwrapPastedPrompt('<pasted_content id="a">\n첫째\n</pasted_content id="a">\n<pasted_content id="b">\n둘째\n</pasted_content id="b">')).toBe('첫째\n둘째');
    expect(unwrapPastedPrompt('먼저 이걸 봐줘\n<pasted_content id="a">\n붙여 넣은 글\n</pasted_content id="a">')).toBe('먼저 이걸 봐줘\n붙여 넣은 글');
  });

  it('감싸개가 없으면 그대로 돌려준다. 안의 글에 표시와 비슷한 글자가 있어도 바꾸지 않는다', () => {
    expect(unwrapPastedPrompt('그냥 보통 요청입니다')).toBe('그냥 보통 요청입니다');
    expect(unwrapPastedPrompt('a < b && c > d (`<pasted>` 아님)')).toBe('a < b && c > d (`<pasted>` 아님)');
    expect(unwrapPastedPrompt('<pasted_content id="x">\nif (a < b) { c(); }\n</pasted_content id="x">')).toBe('if (a < b) { c(); }');
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

  it('관리 설정은 훅 여섯과 b-studio 도구의 허락, 텔레메트리 env를 적는다. 읽기 도구가 아닌 모든 도구에 쓰기 직전의 훅을 건다', () => {
    const settings = agentManagedSettings(address) as { permissions: { allow: string[] }; hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    expect(Object.keys(settings).sort()).toEqual(['disableAllHooks', 'env', 'hooks', 'permissions']);
    // 사용자 설정(에이전트가 쓸 수 있는 홈 폴더)이 훅을 통째로 끄지 못하게 관리 설정에서 값을 정해 둔다
    expect((settings as unknown as { disableAllHooks: boolean }).disableAllHooks).toBe(false);
    expect(settings.permissions.allow).toEqual(['mcp__b-studio']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const command = (name: string) => settings.hooks[name]![0]!.hooks[0]!;
    // node는 이름이 아니라 자리로 부른다. 터미널의 PATH 앞쪽(홈 폴더)에 같은 이름을 두어 훅을 바꿔치기하지 못한다
    expect(command('UserPromptSubmit').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs prompt');
    expect(command('Stop').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs stop');
    expect(command('SessionStart').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs session-start');
    expect(command('SessionEnd').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs session-end');
    expect(command('PreToolUse').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs pre-tool');
    // B7: 사람을 기다리는 창(권한 확인·되묻기·입력 필요·입력 대기)에서 알림 훅이 온다
    expect(command('Notification').command).toBe('/usr/local/bin/node /etc/claude-code/b-studio-hook.mjs notification');
    expect(settings.hooks.Notification![0]!.matcher).toBe(AGENT_NOTIFICATION_MATCHER);
    expect(AGENT_NOTIFICATION_MATCHER).toBe('permission_prompt|elicitation_dialog|agent_needs_input|idle_prompt');
    for (const kind of ['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'idle_prompt']) expect(new RegExp(AGENT_NOTIFICATION_MATCHER).test(kind), kind).toBe(true);
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

  it('관리 설정의 env가 CLI의 텔레메트리를 관문으로 보내게 한다(요청 글·도구 내용을 싣는 설정은 켜지 않는다)', () => {
    const env = (agentManagedSettings(address) as { env: Record<string, string> }).env;
    expect(env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${address.hookUrl}/v1/logs`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${address.hookToken}`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
    });
    // 요청 글·도구 내용을 싣는 설정은 켜지 않는다
    expect(Object.keys(env).some((name) => name.includes('PROMPTS') || name.includes('TOOL_DETAILS'))).toBe(false);
    // 이 컴퓨터 방식(127.0.0.1)에서도 주소 꼴이 그대로 맞는다
    expect(agentTelemetryEnv({ hookUrl: 'http://127.0.0.1:41001', hookToken: 't' }).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('http://127.0.0.1:41001/v1/logs');
  });

  it('주소와 토큰은 설정 파일에 적는다(CLI의 사용자 설정이 환경을 덮어쓸 수 있다). 스크립트는 파일에서 읽는다', () => {
    const files = agentGatewayFiles(address);
    expect(Object.keys(files).sort()).toEqual(['b-studio-gateway.json', 'b-studio-hook.mjs', 'managed-mcp.json', 'managed-settings.json']);
    expect(JSON.parse(files['b-studio-gateway.json']!)).toEqual({ url: address.hookUrl, token: address.hookToken });
    expect(agentManagedMcp(address)).toEqual({ mcpServers: { 'b-studio': { type: 'http', url: address.mcpUrl, headers: { Authorization: `Bearer ${address.mcpToken}` } } } });
    // 환경 변수로 푸는 자리(${...})가 없다
    for (const content of Object.values(files)) expect(content).not.toContain('${');
    // 텔레메트리 env는 훅 주소와 토큰을 싣는다. 이 파일도 600으로 쓴다. mcp 토큰은 여기 없다
    const env = (JSON.parse(files['managed-settings.json']!) as { env: Record<string, string> }).env;
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${address.hookUrl}/v1/logs`);
    expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe(`Authorization=Bearer ${address.hookToken}`);
    expect(files['managed-settings.json']).not.toContain(address.mcpToken);
    // 스크립트는 환경 변수에서 주소를 읽지 않는다
    expect(files['b-studio-hook.mjs']).not.toContain('process.env');
    expect(files['b-studio-hook.mjs']).toContain("new URL('./b-studio-gateway.json', import.meta.url)");
  });

  it('세션마다 따로 쓰고 이 사용자만 읽게 둔다. 주소가 바뀌면 다시 쓰고, 세션이 멈추면 자기가 쓴 것만 지운다', async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'b-studio-gateway-config-')), 'agent-gateway');
    const dir = await writeAgentGatewayConfig('studio-orders-abc123', address, root);
    expect(dir).toBe(path.join(await realpath(root), 'studio-orders-abc123'));
    expect((await readdir(dir)).sort()).toEqual(['b-studio-gateway.json', 'b-studio-hook.mjs', 'managed-mcp.json', 'managed-settings.json']);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(dir)) expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);

    // 스튜디오를 다시 띄우면 주소와 토큰이 바뀐다. 같은 폴더에 다시 쓴다(떠 있는 컨테이너는 이 폴더를 붙인 채다)
    const next = { ...address, hookUrl: 'http://host.docker.internal:52001', hookToken: 'new-hook-token' };
    expect(await writeAgentGatewayConfig('studio-orders-abc123', next, root)).toBe(dir);
    expect(JSON.parse(await readFile(path.join(dir, 'b-studio-gateway.json'), 'utf8'))).toEqual({ url: next.hookUrl, token: 'new-hook-token' });
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
    // 다른 세션은 다른 폴더다
    expect(await writeAgentGatewayConfig('studio-orders-zzz999', address, root)).not.toBe(dir);

    // 지울 때는 자기가 쓴 파일만 지운다. 모르는 파일이 있으면 그 파일과 폴더는 남긴다
    await writeFile(path.join(dir, 'someone-else.txt'), 'x');
    await removeAgentGatewayConfig('studio-orders-abc123', root);
    expect(await readdir(dir)).toEqual(['someone-else.txt']);
    await removeAgentGatewayConfig('studio-orders-zzz999', root);
    expect(await readdir(root)).toEqual(['studio-orders-abc123']);
    // 없는 세션을 지워도 아무 일도 없다
    await removeAgentGatewayConfig('never-existed', root);
  });

  it('샌드박스 id로 폴더 밖을 가리킬 수 없다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-gateway-config-'));
    await expect(writeAgentGatewayConfig('..', address, root)).rejects.toThrow('관문 설정 폴더를 정할 수 없습니다');
    await expect(writeAgentGatewayConfig('', address, root)).rejects.toThrow('관문 설정 폴더를 정할 수 없습니다');
    // 구분자는 다른 글자로 바뀐다
    expect(await writeAgentGatewayConfig('../../etc', address, root)).toBe(path.join(await realpath(root), '..-..-etc'));
    await expect(removeAgentGatewayConfig('..', root)).rejects.toThrow('관문 설정 폴더를 정할 수 없습니다');
  });

  it('터미널을 여는 명령줄과 환경에는 관문의 주소도 토큰도 없다', () => {
    const args = agentTerminalArgs('c', { id: 'main', size: { cols: 80, rows: 24 } });
    expect(args.join(' ')).not.toContain('host.docker.internal');
    expect(args.join(' ')).not.toContain('GATEWAY');
    const spawned: string[][] = [];
    openAgentTerminal('c', {
      id: 'main',
      size: { cols: 80, rows: 24 },
      spawnProcess: (_bin, spawnArgs) => {
        spawned.push(spawnArgs);
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
      },
    });
    expect(spawned).toEqual([args]);
  });
});

// node 프로세스를 여러 번 띄운다. 부하가 높을 때를 위해 넉넉히 준다
describe('훅 스크립트 (컨테이너 안에서 CLI의 훅이 실행한다)', { timeout: 30_000 }, () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 스크립트와, 그 옆에 놓이는 주소 파일을 임시 폴더에 쓴다. gateway를 주지 않으면 주소 파일이 없다 */
  async function script(gateway?: { url: string; token: string } | string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-hook-script-'));
    const file = path.join(dir, 'b-studio-hook.mjs');
    await writeFile(file, agentGatewayFiles(address)['b-studio-hook.mjs']!);
    if (gateway !== undefined) await writeFile(path.join(dir, 'b-studio-gateway.json'), typeof gateway === 'string' ? gateway : JSON.stringify(gateway));
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

  function run(file: string, event: string, input: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [file, event], { env: { PATH: process.env.PATH, ...env } }, (error, stdout) => resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout }));
      child.stdin!.end(input);
    });
  }
  const denied = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;

  it('훅의 입력을 그 종류의 경로로 보내고, 관문의 답을 그대로 출력한다', async () => {
    const { url, seen } = await gateway(() => ({ status: 200, body: JSON.stringify({ decision: 'block', reason: '검증 실패: 고치세요' }) }));
    const file = await script({ url, token: 'tok' });
    const input = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '끝났습니다' });
    const result = await run(file, 'stop', input);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: '검증 실패: 고치세요' });
    expect(seen).toEqual([{ url: '/stop', authorization: 'Bearer tok', body: input }]);
  });

  it('사람을 기다리는 알림은 /notification으로 보내고 빈 답을 그대로 낸다 — 결정을 바꾸지 않는다(B7)', async () => {
    const { url, seen } = await gateway(() => ({ status: 200, body: '{}' }));
    const file = await script({ url, token: 'tok' });
    const input = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Do you want to create …?' });
    expect(await run(file, 'notification', input)).toEqual({ code: 0, stdout: '{}' });
    expect(seen).toEqual([{ url: '/notification', authorization: 'Bearer tok', body: input }]);
  });

  it('주소는 옆의 파일에서만 읽는다. 환경 변수로 다른 주소를 줘도, 주소를 비워도 따르지 않는다', async () => {
    const real = await gateway(() => ({ status: 200, body: '{}' }));
    const decoy = await gateway(() => ({ status: 200, body: '{}' }));
    const file = await script({ url: real.url, token: 'tok' });
    // CLI의 사용자 설정(env)으로 환경을 덮어쓴 경우
    for (const env of [{ B_STUDIO_GATEWAY_URL: decoy.url, B_STUDIO_GATEWAY_TOKEN: 'evil' }, { B_STUDIO_GATEWAY_URL: '', B_STUDIO_GATEWAY_TOKEN: '' }]) {
      expect(await run(file, 'pre-tool', '{"tool_name":"Write"}', env)).toEqual({ code: 0, stdout: '{}' });
    }
    expect(real.seen).toHaveLength(2);
    expect(real.seen.every((request) => request.authorization === 'Bearer tok')).toBe(true);
    expect(decoy.seen).toEqual([]);
  });

  it('관문에 닿지 못하면: 파일을 바꿀 수 있는 도구는 거절하고, 요청은 막지 않되 알리고, 턴의 끝은 막지 않는다', async () => {
    const file = await script({ url: 'http://127.0.0.1:1', token: 'tok' });
    const prompt = await run(file, 'prompt', '{"prompt":"고쳐줘"}');
    expect(prompt.code).toBe(0);
    const said = JSON.parse(prompt.stdout) as { systemMessage?: string; decision?: string };
    expect(said.systemMessage).toContain('관문에 닿지 못했습니다');
    expect(said.systemMessage).toContain('체크포인트도 생기지 않습니다');
    // 요청을 막는 출력이 아니다
    expect(said.decision).toBeUndefined();

    // 쓰기 직전: 변경 전 기준을 잡지 못한 채 바뀌게 두지 않는다
    const tool = await run(file, 'pre-tool', '{"tool_name":"Write"}');
    expect(tool.code).toBe(0);
    expect(denied(tool.stdout)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied(tool.stdout).permissionDecisionReason).toContain('관문에 닿지 못해');

    // 턴의 끝은 막지 않는다(막으면 CLI가 끝나지 않는다). 검증이 돌지 않았으니 체크포인트도 없다
    for (const event of ['stop', 'session-start', 'session-end', 'notification']) expect(await run(file, event, '{}')).toEqual({ code: 0, stdout: '' });
  });

  it('읽기만 요청은 관문에 등록하지 못하면 보내지 않는다(보통 요청은 알리기만 하고 보낸다)', async () => {
    // 서버가 이 요청을 읽기만으로 알지 못한 채 진행되면, 뒤따르는 쓰기 도구가 보통 요청의 것으로 받아들여진다
    for (const config of [{ url: 'http://127.0.0.1:1', token: 'tok' }, undefined, '{깨진 json']) {
      const file = await script(config);
      const blocked = JSON.parse((await run(file, 'prompt', JSON.stringify({ prompt: '[읽기만] 구조를 설명해줘' }))).stdout) as { decision?: string; reason?: string; systemMessage?: string };
      expect(blocked.decision).toBe('block');
      expect(blocked.reason).toContain('읽기만 요청을 등록하지 못해');
      const plain = JSON.parse((await run(file, 'prompt', JSON.stringify({ prompt: '구조를 설명해줘' }))).stdout) as { decision?: string; systemMessage?: string };
      expect(plain.decision).toBeUndefined();
      expect(plain.systemMessage).toContain('관문에 닿지 못했습니다');
    }
    // 관문이 오류로 답해도 같다
    const failing = await gateway(() => ({ status: 500, body: '{}' }));
    expect(JSON.parse((await run(await script({ url: failing.url, token: 'tok' }), 'prompt', JSON.stringify({ prompt: '[읽기만] 설명' }))).stdout)).toMatchObject({ decision: 'block' });
    // 닿으면 관문의 답을 그대로 낸다(막지 않는다)
    const working = await gateway(() => ({ status: 200, body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '읽기만입니다' } }) }));
    expect(JSON.parse((await run(await script({ url: working.url, token: 'tok' }), 'prompt', JSON.stringify({ prompt: '[읽기만] 설명' }))).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '읽기만입니다' },
    });
  });

  it('읽기만 표시를 알아보는 규칙은 서버와 훅 스크립트가 같다', async () => {
    const invisible = String.fromCharCode(0x200b, 0xfeff, 0x202e, 0x2066);
    const cases: Array<[string, boolean]> = [
      ['[읽기만] 설명해줘', true],
      ['[읽기만]설명해줘', true],
      ['   \n\t[읽기만] 앞에 빈칸', true],
      [`${invisible}[읽기만] 앞에 보이지 않는 글자`, true],
      ['[읽기만] 조합형으로 들어온 표시'.normalize('NFD'), true],
      // 붙여 넣은 요청은 감싸개를 벗기고 맨 앞 규칙을 본다(이슈 #733)
      ['<pasted_content id="x">\n[읽기만] 설명해 줘\n</pasted_content id="x">', true],
      ['[읽기만] <pasted_content id="x">\n설명\n</pasted_content id="x">', true],
      ['<pasted_content id="x">\n설명\n[읽기만] 이거 고쳐줘\n</pasted_content id="x">', false],
      ['이 요청은 [읽기만]이 아니다', false],
      ['[ 읽기만 ] 띄어 쓴 것', false],
      ['［읽기만］ 전각 괄호', false],
      ['[읽기] 다른 낱말', false],
      ['', false],
    ];
    const file = await script({ url: 'http://127.0.0.1:1', token: 'tok' });
    for (const [prompt, expected] of cases) {
      expect(isReadOnlyPrompt(prompt), JSON.stringify(prompt)).toBe(expected);
      // 스크립트는 닿지 못했을 때 읽기만 요청만 막는다. 그 판정이 서버의 것과 같아야 한다
      const said = JSON.parse((await run(file, 'prompt', JSON.stringify({ prompt }))).stdout) as { decision?: string };
      expect(said.decision === 'block', JSON.stringify(prompt)).toBe(expected);
    }
    expect(AGENT_READ_ONLY_MARK).toBe('[읽기만]');
    // 요청 글이 글자가 아니면(훅 입력이 이상하면) 읽기만으로 보지 않고 보통 요청처럼 알린다
    expect(JSON.parse((await run(file, 'prompt', JSON.stringify({ prompt: 42 }))).stdout)).toMatchObject({ systemMessage: expect.stringContaining('관문에 닿지 못했습니다') });
    expect(JSON.parse((await run(file, 'prompt', '깨진 입력')).stdout)).toMatchObject({ systemMessage: expect.stringContaining('관문에 닿지 못했습니다') });
  });

  it('주소 파일이 없거나 읽을 수 없어도 닿지 못한 것과 같다(관문 없이 조용히 지나가는 길이 없다)', async () => {
    for (const config of [undefined, '{깨진 json', '{}', JSON.stringify({ url: '', token: 'tok' }), JSON.stringify({ url: 'http://127.0.0.1:1' }), JSON.stringify({ url: 'not a url', token: 'tok' })]) {
      const file = await script(config);
      expect(denied((await run(file, 'pre-tool', '{"tool_name":"Bash"}')).stdout).permissionDecision).toBe('deny');
      expect(JSON.parse((await run(file, 'prompt', '{}')).stdout).systemMessage).toContain('관문에 닿지 못했습니다');
      expect(await run(file, 'stop', '{}')).toEqual({ code: 0, stdout: '' });
      expect((await run(file, 'ping', '')).code).not.toBe(0);
    }
  });

  it('관문이 오류로 답했거나 읽을 수 없는 답을 주면 닿지 못한 것으로 본다(그 답을 CLI에 넘기지 않는다)', async () => {
    const failing = await gateway(() => ({ status: 500, body: JSON.stringify({ decision: 'block', reason: '서버 오류인데 막는 꼴' }) }));
    expect(await run(await script({ url: failing.url, token: 'tok' }), 'stop', '{}')).toEqual({ code: 0, stdout: '' });
    const garbled = await gateway(() => ({ status: 200, body: '<html>프록시 오류</html>' }));
    expect(await run(await script({ url: garbled.url, token: 'tok' }), 'stop', '{}')).toEqual({ code: 0, stdout: '' });
    // 쓰기 직전의 훅은 오류 답도 거절로 바꾼다. 서버가 준 "{}"(허용)로 읽지 않는다
    const allowing = await gateway(() => ({ status: 500, body: '{}' }));
    expect(denied((await run(await script({ url: allowing.url, token: 'tok' }), 'pre-tool', '{}')).stdout).permissionDecision).toBe('deny');
  });

  it('모르는 종류는 아무 데도 보내지 않는다', async () => {
    const { url, seen } = await gateway(() => ({ status: 200, body: '{}' }));
    const file = await script({ url, token: 'tok' });
    expect(await run(file, 'constructor', '{}')).toEqual({ code: 0, stdout: '' });
    expect(await run(file, '', '{}')).toEqual({ code: 0, stdout: '' });
    expect(seen).toEqual([]);
    // 훅으로 거는 종류는 설정이 거는 종류와 같다
    expect(Object.keys(AGENT_HOOK_EVENTS).sort()).toEqual(['notification', 'pre-tool', 'prompt', 'session-end', 'session-start', 'stop']);
  });

  it('닿는지 묻는 일(ping)은 닿으면 0, 닿지 못하거나 관문이 오류로 답하면 0이 아닌 값으로 끝난다', async () => {
    const up = await gateway(() => ({ status: 200, body: '{}' }));
    expect((await run(await script({ url: up.url, token: 'tok' }), 'ping', '')).code).toBe(0);
    expect(up.seen).toMatchObject([{ url: '/ping', authorization: 'Bearer tok' }]);
    expect((await run(await script({ url: 'http://127.0.0.1:1', token: 'tok' }), 'ping', '')).code).not.toBe(0);
    const refusing = await gateway(() => ({ status: 403, body: '{}' }));
    expect((await run(await script({ url: refusing.url, token: 'tok' }), 'ping', '')).code).not.toBe(0);
  });
});

// 가짜 docker(셸 스크립트)를 여러 번 띄운다. 전체 테스트가 함께 도는 부하에서는 기본 5초를 넘긴 적이 있다(단독으로는 1초 안팎)
describe('컨테이너를 띄운 뒤의 확인 (관문 설정)', { timeout: 30_000 }, () => {
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

  it('평가 자산의 복사본을 읽기 전용으로 붙여 띄운다. 작업 복사본의 원본 경로는 붙이지 않는다', async () => {
    const docker = await fakeDocker();
    const root = await realpath(docker.root);
    const assetRoot = await mkdtemp(path.join(tmpdir(), 'b-studio-agent-assets-'));
    const assets = ['tests/acceptance', 'expected.json'];
    const copies = evaluationAssetCopies(assets, assetRoot, 'sb');
    await writeFile(
      path.join(docker.dir, 'after-run.json'),
      docker.mounts([
        { Type: 'bind', Source: copies[0]!.source, Destination: '/workspace/tests/acceptance', RW: false },
        { Type: 'bind', Source: copies[1]!.source, Destination: '/workspace/expected.json', RW: false },
      ]),
    );

    expect(await ensureAgentContainer('sb', docker.root, { projectId: 'p', evaluationAssets: assets, evaluationAssetRoot: assetRoot, dockerBin: docker.bin })).toBe('sb-agent');
    const run = (await docker.calls()).find((call) => call.startsWith('run '))!;
    expect(run).toContain(`type=bind,source=${copies[0]!.source},target=/workspace/tests/acceptance,readonly`);
    // 파일 자산도 복사본이라 inode가 고정되지 않는다. 작업 복사본의 자산 경로는 붙이지 않는다
    expect(run).toContain(`type=bind,source=${copies[1]!.source},target=/workspace/expected.json,readonly`);
    expect(run).not.toContain(path.join(root, 'tests', 'acceptance'));
    expect(run).not.toContain(path.join(root, 'expected.json'));

    // 마스크 없이 떠 있으면(결과가 선언과 다르면) 지운다
    const missing = await fakeDocker();
    await writeFile(path.join(missing.dir, 'after-run.json'), missing.mounts([]));
    await expect(
      ensureAgentContainer('sb', missing.root, { projectId: 'p', evaluationAssets: ['tests/acceptance'], evaluationAssetRoot: assetRoot, dockerBin: missing.bin }),
    ).rejects.toThrow('보호와 관문 설정을 확인하지 못해');
    expect((await missing.calls()).at(-1)).toBe('rm --force sb-agent');
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

  it('컨테이너에서 관문에 닿는지는 훅과 같은 스크립트로 묻는다. 명령줄에 주소나 토큰을 싣지 않는다', async () => {
    const docker = await fakeDocker();
    expect(await probeAgentGateway('sb-agent', { dockerBin: docker.bin })).toBe(true);
    expect(await docker.calls()).toEqual(['exec sb-agent /usr/local/bin/node /etc/claude-code/b-studio-hook.mjs ping']);
    // docker가 0이 아닌 값으로 끝나면(스크립트가 닿지 못했다고 알리면) 닿지 못한 것이다
    await writeFile(docker.bin, '#!/bin/sh\nexit 1\n');
    expect(await probeAgentGateway('sb-agent', { dockerBin: docker.bin })).toBe(false);
    expect(await probeAgentGateway('sb-agent', { dockerBin: path.join(docker.dir, 'no-such-docker') })).toBe(false);
  });
});

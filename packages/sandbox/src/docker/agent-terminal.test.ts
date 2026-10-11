import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AGENT_HOME_VOLUME, AGENT_IMAGE, AGENT_TERMINAL_COMMAND, agentContainerName, agentResizeArgs, agentRunArgs, agentTerminalArgs, clampTerminalSize, openAgentTerminal } from './agent-terminal';
import type { MaskVolume } from './git-mask';

const mask = (source: string, target: string): MaskVolume => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
const plan = {
  name: 'studio-orders-abc123-agent',
  sandboxId: 'studio-orders-abc123',
  projectRoot: '/work/orders',
  masks: [mask('/work/orders/.git', '/workspace/.git'), mask('/work/orders/.git/b-studio-empty', '/workspace/.git/b-studio')],
};

describe('에이전트 컨테이너 (이슈 #673)', () => {
  it('보이는 호스트 폴더는 작업 복사본 하나이고, .git은 읽기 전용으로 덮는다', () => {
    const args = agentRunArgs(plan);
    const mounts = args.flatMap((arg, index) => (arg === '--mount' ? [args[index + 1]!] : []));
    expect(mounts).toEqual([
      'type=bind,source=/work/orders,target=/workspace',
      'type=bind,source=/work/orders/.git,target=/workspace/.git,readonly',
      'type=bind,source=/work/orders/.git/b-studio-empty,target=/workspace/.git/b-studio,readonly',
      `type=volume,source=${AGENT_HOME_VOLUME},target=/home/node`,
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
    expect(valueOf('--pull')).toBe('never');
    expect(args).toContain('b-studio.sandbox=studio-orders-abc123');
    expect(args).toContain('b-studio.service=b-studio-agent');
    expect(args.slice(-3)).toEqual([AGENT_IMAGE, 'sleep', 'infinity']);
  });

  it('쉼표가 든 경로는 --mount의 다른 옵션으로 읽히므로 받지 않는다', () => {
    expect(() => agentRunArgs({ ...plan, projectRoot: '/work/a,readonly=false' })).toThrow('쉼표');
    expect(() => agentRunArgs({ ...plan, masks: [mask('/work/orders/.git', '/workspace/.git,target=/etc')] })).toThrow('쉼표');
  });

  it('컨테이너 이름에 쓸 수 없는 글자는 바꾼다', () => {
    expect(agentContainerName('studio-orders-abc123')).toBe('studio-orders-abc123-agent');
    expect(agentContainerName('studio/../x y')).toBe('studio-..-x-y-agent');
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

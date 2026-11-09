import { describe, expect, it } from 'vitest';
import { native } from './native';

// TS → napi(class + ThreadsafeFunction) → Rust(bstudio-io, portable-pty) 경로 전체를 호스트 sh/cat으로 확인한다(ADR-193, 2c-4a, #1049).
// host-terminal.ts의 openHostTerminal 로직은 가짜 spawnPty로 host-terminal.test.ts가 보고, 여기서는 진짜 PTY 경계를 본다.
// env는 node-pty처럼 통째 치환하므로 PATH를 넣어 줘야 실행 파일을 찾는다(host-terminal도 PATH를 넘긴다).
const PATH_ENV = { PATH: '/usr/bin:/bin:/usr/local/bin' };

/** PTY를 열고 종료까지 기다려 모은 출력과 종료 코드를 준다. */
function run(
  file: string,
  args: string[],
  env: Record<string, string>,
  drive?: (pty: InstanceType<typeof native.HostPty>) => void,
): Promise<{ output: string; code: number; pid: number | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const pty = new native.HostPty(
      file,
      args,
      'xterm-256color',
      24,
      80,
      '/',
      env,
      (data) => chunks.push(data),
      (code) => resolve({ output: Buffer.concat(chunks).toString('utf8'), code, pid: pty.pid }),
    );
    drive?.(pty);
  });
}

describe('HostPty (Rust 경계, 양방향 PTY)', () => {
  it('출력을 역류하고 종료 코드를 준다', async () => {
    const { output, code, pid } = await run('sh', ['-c', 'echo hi; exit 7'], PATH_ENV);
    expect(code).toBe(7);
    expect(output).toContain('hi');
    expect(typeof pid === 'number' && pid > 0).toBe(true);
  });

  it('write한 입력이 PTY echo로 출력에 나온다', async () => {
    // cat은 입력을 되돌린다. PTY는 입력도 echo하므로 쓴 줄이 출력에 보인다. ^D(4)로 cat을 끝낸다.
    const { output } = await run('cat', [], PATH_ENV, (pty) => {
      pty.write(Buffer.from('hello\n', 'utf8'));
      pty.write(Buffer.from([4]));
    });
    expect(output).toContain('hello');
  });

  it('cwd와 env를 적용한다', async () => {
    const { output } = await run('sh', ['-c', 'printf "%s\\n" "$MARKER"'], { ...PATH_ENV, MARKER: 'from-env' });
    expect(output).toContain('from-env');
  });

  it('resize는 에러 없이 되고, kill은 자식을 끝낸다', async () => {
    const { code } = await run('sh', ['-c', 'sleep 30'], PATH_ENV, (pty) => {
      pty.resize(100, 40); // 던지지 않아야 한다
      pty.kill();
    });
    // kill로 끝났으므로 onExit가 왔다(코드는 플랫폼에 따라 다르지만 콜백이 온 것이 핵심).
    expect(typeof code).toBe('number');
  });

  it('없는 바이너리는 생성에서 던진다', () => {
    expect(
      () =>
        new native.HostPty(
          'this-binary-does-not-exist-xyz',
          [],
          'xterm-256color',
          24,
          80,
          '/',
          PATH_ENV,
          () => {},
          () => {},
        ),
    ).toThrow();
  });
});

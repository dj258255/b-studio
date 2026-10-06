import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReadonlyDockerArgs, execReadonlyDocker, ReadonlyDockerViolation, spawnReadonlyDocker } from './readonly-exec';

describe('assertReadonlyDockerArgs', () => {
  it.each(['ps', 'inspect', 'logs'])('%s는 허용한다', (sub) => {
    expect(() => assertReadonlyDockerArgs([sub])).not.toThrow();
  });

  it('stats는 --no-stream과 함께만 허용한다', () => {
    expect(() => assertReadonlyDockerArgs(['stats', '--no-stream'])).not.toThrow();
    expect(() => assertReadonlyDockerArgs(['stats'])).toThrow(ReadonlyDockerViolation);
  });

  it.each(['run', 'exec', 'rm', 'restart', 'stop', 'kill', 'compose', 'build', 'volume'])('%s는 거부한다', (sub) => {
    expect(() => assertReadonlyDockerArgs([sub])).toThrow(ReadonlyDockerViolation);
  });

  it('인자가 없으면 거부한다', () => {
    expect(() => assertReadonlyDockerArgs([])).toThrow(ReadonlyDockerViolation);
  });
});

async function fakeDocker(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-docker-readonly-'));
  const bin = path.join(dir, 'docker');
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe('execReadonlyDocker', () => {
  it('허용한 명령은 실제로 실행해 stdout을 돌려준다', async () => {
    const bin = await fakeDocker('if [ "$1" = "ps" ]; then echo "container-1"; exit 0; fi\necho "unexpected: $*" >&2\nexit 9');
    const result = await execReadonlyDocker(bin, ['ps', '-a', '--quiet']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('container-1');
  });

  it('화이트리스트를 벗어난 명령은 실행하지 않고 던진다', async () => {
    const bin = await fakeDocker('echo "이 스크립트는 절대 실행되면 안 된다" >&2\nexit 1');
    await expect(execReadonlyDocker(bin, ['rm', '-f', 'some-container'])).rejects.toThrow(ReadonlyDockerViolation);
  });
});

describe('spawnReadonlyDocker', () => {
  it('허용한 명령(logs --follow)은 스트리밍으로 띄운다', async () => {
    const bin = await fakeDocker('echo "line one"\nsleep 0.05');
    const child = spawnReadonlyDocker(bin, ['logs', '--follow', 'some-container']);
    const output = await new Promise<string>((resolve) => {
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
      child.on('close', () => resolve(buffer));
    });
    expect(output).toContain('line one');
  });

  it('화이트리스트를 벗어난 명령은 프로세스를 띄우지 않고 던진다', async () => {
    const bin = await fakeDocker('echo "이 스크립트는 절대 실행되면 안 된다" >&2\nexit 1');
    expect(() => spawnReadonlyDocker(bin, ['exec', '-it', 'some-container', 'sh'])).toThrow(ReadonlyDockerViolation);
  });
});

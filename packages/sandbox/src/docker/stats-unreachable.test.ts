import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { LocalDockerProvider } from './compose-provider';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const project = { spec: { name: 'shop' }, root: '/tmp/shop', composePath: '/tmp/shop/compose.yaml', managed: [], composeServices: ['api'], sharedVolumes: [], external: [], publicUrlRefs: [] } as unknown as LoadedProject;

/** `compose config`에는 빈 설정으로 답하고, `ps`에는 넘긴 셸 조각대로 답하는 가짜 docker */
async function fakeDocker(ps: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'stats-unreachable-'));
  dirs.push(dir);
  const bin = path.join(dir, 'docker');
  await writeFile(bin, `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    config) echo '{"services":{}}'; exit 0 ;;\n    ps) ${ps} ;;\n  esac\ndone\nexit 0\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe('사용량 조회가 도커에 닿지 않을 때 (트러블슈팅 123)', () => {
  it('컨테이너 목록을 읽지 못하면 빈 목록이 아니라 플랫폼 쪽 오류로 알린다', async () => {
    const dockerBin = await fakeDocker(`echo "Cannot connect to the Docker daemon at unix:///x/docker.sock. Is the docker daemon running?" >&2; exit 1`);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    const error = await sandbox.stats().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).platform).toBe(true);
    expect((error as SandboxError).message).toContain('컨테이너 목록을 읽지 못했습니다');
    expect((error as SandboxError).detail).toContain('Cannot connect to the Docker daemon');
  });

  it('도커가 답하지 않으면 상한에서 끊고 그 사실을 사유로 알린다(측정이 영영 멈추지 않는다)', async () => {
    const dockerBin = await fakeDocker(`sleep 30; exit 0`);
    const sandbox = await new LocalDockerProvider({ dockerBin, statsTimeoutMs: 300 }).create(project);
    const started = Date.now();
    const error = await sandbox.stats().then(() => undefined, (caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).platform).toBe(true);
    expect((error as SandboxError).detail).toBe('도커가 0.3초 안에 응답하지 않았습니다');
  });

  it('도커는 답하는데 컨테이너가 없으면 빈 목록이다(닿지 않는 것과 구분된다)', async () => {
    const dockerBin = await fakeDocker(`exit 0`);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    expect(await sandbox.stats()).toEqual([]);
  });
});

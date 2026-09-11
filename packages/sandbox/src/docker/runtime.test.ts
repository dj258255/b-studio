import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { LocalDockerProvider, runtimeFromEnv } from './compose-provider';

/** `docker info`에만 답하는 가짜 docker 실행 파일 */
async function fakeDocker(runtimesJson: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-docker-'));
  const bin = path.join(dir, 'docker');
  await writeFile(bin, `#!/bin/sh\nif [ "$1" = "info" ]; then echo '${runtimesJson}'; exit 0; fi\necho "unexpected: $*" >&2\nexit 9\n`);
  await chmod(bin, 0o755);
  return bin;
}

const project = { spec: { name: 'orders' }, managed: [], composeServices: [] } as unknown as LoadedProject;

describe('컨테이너 런타임 확인', () => {
  it('등록되지 않은 런타임은 샌드박스를 만들기 전에 등록된 목록과 함께 거부한다', async () => {
    const dockerBin = await fakeDocker('{"io.containerd.runc.v2":{},"runc":{}}');

    await expect(new LocalDockerProvider({ dockerBin, runtime: 'runsc' }).create(project)).rejects.toThrow(
      "컨테이너 런타임 'runsc'이 Docker 데몬에 등록되지 않았습니다 (등록된 런타임: io.containerd.runc.v2, runc)",
    );
  });

  it('등록된 런타임이면 샌드박스를 만든다', async () => {
    const dockerBin = await fakeDocker('{"runc":{},"runsc":{"path":"/usr/local/bin/runsc"}}');

    const sandbox = await new LocalDockerProvider({ dockerBin, runtime: 'runsc' }).create(project);

    expect(sandbox.id).toMatch(/^studio-orders-[0-9a-f]{6}$/);
  });

  it('서버 환경 변수에서 런타임을 읽고, 비어 있으면 데몬 기본값을 쓰게 한다', () => {
    expect(runtimeFromEnv({ B_STUDIO_CONTAINER_RUNTIME: ' runsc ' })).toBe('runsc');
    expect(runtimeFromEnv({ B_STUDIO_CONTAINER_RUNTIME: '' })).toBeUndefined();
    expect(runtimeFromEnv({})).toBeUndefined();
  });
});

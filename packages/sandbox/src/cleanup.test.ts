import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './docker/compose-provider';
import { SandboxError } from './errors';
import { KubernetesProvider } from './kubernetes/kubernetes-provider';
import { SANDBOX_ID } from './sandbox-id';

/** 받은 인자를 파일에 남기는 가짜 실행 파일 */
async function recordingBin(): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-cli-'));
  const bin = path.join(dir, 'cli');
  const log = path.join(dir, 'calls.log');
  await writeFile(bin, `#!/bin/sh\necho "$*" >> "${log}"\n`);
  await chmod(bin, 0o755);
  return { bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

describe('남은 샌드박스 정리', () => {
  it('Docker는 compose 파일 없이 프로젝트 이름으로 컨테이너·볼륨·네트워크를 지운다', async () => {
    const { bin, calls } = await recordingBin();
    await new LocalDockerProvider({ dockerBin: bin }).cleanup('studio-orders-1a2b3c');
    expect(await calls()).toEqual(['compose --project-name studio-orders-1a2b3c down --volumes --remove-orphans']);
  });

  it('Kubernetes는 세션 네임스페이스를 지운다', async () => {
    const { bin, calls } = await recordingBin();
    await new KubernetesProvider({ kubectlBin: bin, hostPathMounts: [], images: { kind: 'kind', cluster: 'b-studio' } }).cleanup('studio-orders-1a2b3c');
    expect(await calls()).toEqual(['delete namespace studio-orders-1a2b3c --ignore-not-found --wait=false']);
  });

  it('스튜디오가 강제 종료되기 전에 따로 띄울 수 있게 같은 정리 명령을 돌려준다', () => {
    expect(new LocalDockerProvider({ dockerBin: '/usr/local/bin/docker' }).cleanupCommand('studio-orders-1a2b3c')).toEqual({
      command: '/usr/local/bin/docker',
      args: ['compose', '--project-name', 'studio-orders-1a2b3c', 'down', '--volumes', '--remove-orphans'],
    });
    const kubernetes = new KubernetesProvider({
      kubectlBin: 'kubectl',
      kubeconfig: '/tmp/kubeconfig',
      context: 'kind-b-studio',
      hostPathMounts: [],
      images: { kind: 'kind', cluster: 'b-studio' },
    });
    expect(kubernetes.cleanupCommand('studio-orders-1a2b3c')).toEqual({
      command: 'kubectl',
      args: ['--kubeconfig', '/tmp/kubeconfig', '--context', 'kind-b-studio', 'delete', 'namespace', 'studio-orders-1a2b3c', '--ignore-not-found', '--wait=false'],
    });
    expect(() => kubernetes.cleanupCommand('kube-system')).toThrow(SandboxError);
  });

  it('b-studio가 만든 id 형식이 아니면 명령을 실행하지 않고 거부한다', async () => {
    const { bin, calls } = await recordingBin();
    const docker = new LocalDockerProvider({ dockerBin: bin });
    for (const id of ['dbtower', 'studio-orders', 'studio-orders-1a2b3c --volumes', 'kube-system', 'studio-Orders-1a2b3c']) {
      await expect(docker.cleanup(id)).rejects.toThrow(SandboxError);
    }
    expect(await calls()).toEqual([]);
    expect(SANDBOX_ID.test('studio-k8s-web-a8d02a')).toBe(true);
  });
});

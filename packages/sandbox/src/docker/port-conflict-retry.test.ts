import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { isPortBindConflict, LocalDockerProvider } from './compose-provider';

/** colima VM 안의 다른 컨테이너가 미리 고른 포트를 이미 쓰고 있을 때 docker compose가 남기는 전형적인 stderr */
const BIND_CONFLICT_STDERR =
  "Error response from daemon: driver failed programming external connectivity on endpoint studio-orders-up: failed to bind port 127.0.0.1:45231: address already in use";

/** 포트와 무관한 실패(이미지가 없음)의 전형적인 stderr — 재시도 대상이 아니다 */
const UNRELATED_STDERR = 'Error response from daemon: pull access denied for b-studio/missing-image, repository does not exist';

const project = {
  spec: { name: 'orders' },
  root: '/tmp/orders',
  composePath: '/tmp/orders/compose.yaml',
  managed: [],
  composeServices: [],
  sharedVolumes: [],
  external: [],
  publicUrlRefs: [{ service: 'web', envKey: 'API_BASE_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' }],
} as unknown as LoadedProject;

/**
 * compose up이 포트 바인드 충돌로 `failUpTimes`번 실패한 뒤 성공하는 가짜 docker 실행 파일.
 * up을 부를 때마다 override 파일(두 번째 --file 인자, *compose.override.yaml로 끝난다)을 스냅샷으로 남겨
 * 재시도마다 포트가 다시 뽑혔는지 확인할 수 있게 한다. down·build 호출은 로그에 그대로 남는다
 */
async function fakeDockerWithPortConflict(dir: string, failUpTimes: number, stderr: string): Promise<{ dockerBin: string; log: string; snapshotDir: string }> {
  const log = path.join(dir, 'args.log');
  const counter = path.join(dir, 'up-count');
  const snapshotDir = path.join(dir, 'snapshots');
  await writeFile(counter, '0');
  await mkdir(snapshotDir);

  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"

override=""
for a in "$@"; do
  case "$a" in
    *compose.override.yaml) override="$a" ;;
  esac
done

for a in "$@"; do
  case "$a" in
    config) printf '{"services":{}}\\n'; exit 0 ;;
    build) exit 0 ;;
    ps) exit 0 ;;
    down) exit 0 ;;
    up)
      count=$(cat "${counter}")
      count=$((count + 1))
      echo "$count" > "${counter}"
      cp "$override" "${snapshotDir}/up-$count.yaml"
      if [ "$count" -le ${failUpTimes} ]; then
        echo "${stderr}" >&2
        exit 1
      fi
      exit 0
      ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { dockerBin: bin, log, snapshotDir };
}

/** log 안에서 특정 토큰(공백으로 구분된 인자)을 포함한 명령 줄의 개수 */
function countCommandLines(log: string, token: string): number {
  return log
    .split('\n')
    .filter((line) => line.split(' ').includes(token)).length;
}

describe('isPortBindConflict', () => {
  it('바인드 충돌 stderr 패턴을 알아본다', () => {
    expect(isPortBindConflict(BIND_CONFLICT_STDERR)).toBe(true);
    expect(isPortBindConflict('Error starting userland proxy: listen tcp4 127.0.0.1:45231: bind: address already in use')).toBe(true);
    expect(isPortBindConflict('Bind for 127.0.0.1:45231 failed: port is already allocated')).toBe(true);
  });

  it('포트와 무관한 실패는 충돌로 보지 않는다', () => {
    expect(isPortBindConflict(UNRELATED_STDERR)).toBe(false);
  });
});

describe('compose up 포트 충돌 재시도', () => {
  it('바인드 충돌로 두 번 실패하면 포트를 다시 뽑아 재시도하고, down이 재시도 사이에 돈다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'port-retry-'));
    const { dockerBin, log, snapshotDir } = await fakeDockerWithPortConflict(dir, 2, BIND_CONFLICT_STDERR);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    await expect(sandbox.start()).resolves.toEqual([]);

    const args = await readFile(log, 'utf8');
    expect(countCommandLines(args, 'up')).toBe(3);
    expect(countCommandLines(args, 'down')).toBe(2);

    // 재시도마다 override에 새로 쓴 포트가 서로 달라야 한다(세트 전체를 다시 뽑는다)
    const [first, , third] = await Promise.all(
      [1, 2, 3].map((n) => readFile(path.join(snapshotDir, `up-${n}.yaml`), 'utf8')),
    );
    expect(first).not.toEqual(third);
  });

  it('3번 모두 포트 충돌로 실패하면 원래 오류에 재시도 포기 문구를 덧붙여 던진다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'port-retry-'));
    const { dockerBin, log } = await fakeDockerWithPortConflict(dir, 3, BIND_CONFLICT_STDERR);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    await expect(sandbox.start()).rejects.toThrow(/포트 충돌이 반복돼 3회 재시도 후 포기했습니다/);

    const args = await readFile(log, 'utf8');
    expect(countCommandLines(args, 'up')).toBe(3);
    expect(countCommandLines(args, 'down')).toBe(2);
  });

  it('포트와 무관한 실패는 재시도하지 않고 바로 던진다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'port-retry-'));
    const { dockerBin, log } = await fakeDockerWithPortConflict(dir, 3, UNRELATED_STDERR);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    await expect(sandbox.start()).rejects.toThrow(/pull access denied/);

    const args = await readFile(log, 'utf8');
    expect(countCommandLines(args, 'up')).toBe(1);
    expect(countCommandLines(args, 'down')).toBe(0);
  });
});

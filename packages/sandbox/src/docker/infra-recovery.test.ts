import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './compose-provider';

/**
 * 도그푸딩 마찰 130: 세션 상태는 ready인데 studio 밖에서(사람·다른 과정이) edge·부가 서비스 컨테이너를
 * 지워, 첫 http_request부터 "service ... is not running"으로 실패했다(트러블슈팅 86). ensureInfra()가
 * 실행 전에 핵심 컨테이너를 확인하고, 없으면 이 샌드박스의 compose 프로젝트 안에서만 다시 올리는지 본다.
 *
 * 실제 docker 없이 가짜 docker 실행 파일로 `compose ps`·`compose up`을 흉내 낸다(port-conflict-retry.test.ts와
 * 같은 방식). ps 호출마다 다른 출력을 주려고 호출 횟수를 파일에 센다.
 */
const project = {
  spec: { name: 'infra' },
  root: '/tmp/infra',
  composePath: '/tmp/infra/compose.yaml',
  managed: [],
  composeServices: ['mysql'],
  sharedVolumes: [],
  external: [],
  publicUrlRefs: [],
} as unknown as LoadedProject;

interface FakeDocker {
  dockerBin: string;
  log: string;
  psLog: string;
  upLog: string;
}

/**
 * ps 호출 결과를 순서대로 돌려주는(호출 1번째는 psResponses[0], 2번째는 [1]...) 가짜 docker.
 * up은 upExitCode(기본 0)로 끝나고, upStderr가 있으면 실패할 때 그 내용을 stderr로 낸다.
 */
async function fakeDockerForInfra(
  dir: string,
  psResponses: string[],
  { upExitCode = 0, upStderr = '' }: { upExitCode?: number; upStderr?: string } = {},
): Promise<FakeDocker> {
  const log = path.join(dir, 'args.log');
  const psLog = path.join(dir, 'ps-count');
  const upLog = path.join(dir, 'up.log');
  const psDir = path.join(dir, 'ps-responses');
  await writeFile(psLog, '0');
  await writeFile(upLog, '');
  await mkdir(psDir);
  await Promise.all(psResponses.map((body, index) => writeFile(path.join(psDir, `${index + 1}.json`), body)));

  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case " $* " in
  *" --no-trunc "*) printf 'm1\\n'; exit 0 ;;
  *" inspect m1 "*) printf '%s\\n' '[{"Id":"m1","Config":{"Labels":{"com.docker.compose.service":"b-studio-edge"}},"Mounts":[]}]'; exit 0 ;;
esac

for a in "$@"; do
  case "$a" in
    config) printf '{"services":{}}\\n'; exit 0 ;;
    ps)
      count=$(cat "${psLog}")
      count=$((count + 1))
      echo "$count" > "${psLog}"
      cat "${psDir}/$count.json" 2>/dev/null
      exit 0
      ;;
    up)
      printf '%s\\n' "$*" >> "${upLog}"
      if [ ${upExitCode} -ne 0 ]; then
        printf '%s' "${upStderr}" >&2
        exit ${upExitCode}
      fi
      exit 0
      ;;
    build) exit 0 ;;
    down) exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { dockerBin: bin, log, psLog, upLog };
}

describe('ensureInfra', () => {
  it('edge 컨테이너가 없으면 이 샌드박스 범위에서만 다시 올려 복구한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'infra-recover-'));
    // 1차 ps: mysql만 running, edge는 줄 자체가 없다(지워졌다) → missing=['b-studio-edge']
    // up 성공 → 2차 ps(missing 서비스만 다시 묻는다): edge가 running으로 돌아왔다
    const { dockerBin, upLog } = await fakeDockerForInfra(dir, ['[{"Service":"mysql","State":"running"}]', '[{"Service":"b-studio-edge","State":"running"}]']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    const result = await sandbox.ensureInfra!(['mysql']);

    expect(result).toEqual({ ok: true, recovered: ['b-studio-edge'] });
    const upArgs = await readFile(upLog, 'utf8');
    expect(upArgs.trim()).toContain('up');
    expect(upArgs).toContain('--no-deps');
    expect(upArgs).toContain('b-studio-edge');
    // 복구되지 않은(원래 떠 있던) mysql은 다시 올리라고 하지 않는다 — 이 세션 범위를 최소로 건드린다
    expect(upArgs).not.toContain('mysql');
  });

  it('핵심 컨테이너가 모두 떠 있으면 아무것도 다시 올리지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'infra-recover-'));
    const { dockerBin, upLog } = await fakeDockerForInfra(dir, ['[{"Service":"mysql","State":"running"},{"Service":"b-studio-edge","State":"running"}]']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    const result = await sandbox.ensureInfra!(['mysql']);

    expect(result).toEqual({ ok: true, recovered: [] });
    expect(await readFile(upLog, 'utf8')).toBe('');
  });

  it('다시 올리기(compose up) 자체가 실패하면 복구하지 못했다고 분명히 알린다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'infra-recover-'));
    const { dockerBin } = await fakeDockerForInfra(dir, ['[{"Service":"mysql","State":"running"}]'], {
      upExitCode: 1,
      upStderr: 'no space left on device',
    });
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    const result = await sandbox.ensureInfra!(['mysql']);

    expect(result.ok).toBe(false);
    expect(result.recovered).toEqual([]);
    expect(result.missing).toEqual(['b-studio-edge']);
    expect(result.reason).toContain('no space left on device');
  });

  it('다시 올렸지만 재확인해도 여전히 없으면 복구하지 못했다고 알린다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'infra-recover-'));
    // up은 성공(exit 0)하지만, 재확인 ps는 edge가 exited 상태라고 본다(끝까지 못 떴다)
    const { dockerBin } = await fakeDockerForInfra(dir, ['[{"Service":"mysql","State":"running"}]', '[{"Service":"b-studio-edge","State":"exited"}]']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    const result = await sandbox.ensureInfra!(['mysql']);

    expect(result.ok).toBe(false);
    expect(result.recovered).toEqual([]);
    expect(result.missing).toEqual(['b-studio-edge']);
    expect(result.reason).toContain('b-studio-edge');
  });
});

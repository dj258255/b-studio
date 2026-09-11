import { describe, expect, it } from 'vitest';
import { describeUsage, formatBytes, mergeUsage, parseDockerBytes, parseInspectOutput, parseStatsOutput } from './usage';

describe('parseDockerBytes', () => {
  it.each([
    ['43.12MiB', Math.round(43.12 * 1024 ** 2)],
    ['5.773GiB', Math.round(5.773 * 1024 ** 3)],
    ['1.2kB', 1200],
    ['0B', 0],
  ])('%s', (text, bytes) => {
    expect(parseDockerBytes(text)).toBe(bytes);
  });

  it('모르는 표기는 undefined', () => {
    expect(parseDockerBytes('--')).toBeUndefined();
  });
});

const STATS = [
  '{"BlockIO":"16MB / 52.5MB","CPUPerc":"0.02%","Container":"studio-orders-bb3675-db-1","ID":"c26fe87298e2","MemPerc":"0.73%","MemUsage":"43.12MiB / 5.773GiB","Name":"studio-orders-bb3675-db-1","NetIO":"28.8kB / 23.4kB","PIDs":"16"}',
  '{"CPUPerc":"187.35%","MemUsage":"1.203GiB / 1.5GiB","Name":"studio-orders-bb3675-api-1"}',
  '',
].join('\n');

const INSPECT = JSON.stringify([
  {
    Name: '/studio-orders-bb3675-db-1',
    State: { Status: 'running', ExitCode: 0, OOMKilled: false },
    HostConfig: { Memory: 0, NanoCpus: 0 },
    Config: { Labels: { 'com.docker.compose.service': 'db' } },
  },
  {
    Name: '/studio-orders-bb3675-api-1',
    State: { Status: 'running', ExitCode: 0, OOMKilled: false },
    HostConfig: { Memory: 1610612736, NanoCpus: 2000000000 },
    Config: { Labels: { 'com.docker.compose.service': 'api' } },
  },
  {
    Name: '/studio-orders-bb3675-web-1',
    State: { Status: 'exited', ExitCode: 137, OOMKilled: true },
    HostConfig: { Memory: 536870912 },
    Config: { Labels: { 'com.docker.compose.service': 'web' } },
  },
]);

describe('docker 출력 해석', () => {
  it('실행 중인 컨테이너는 사용량을, 종료된 컨테이너는 종료 코드와 메모리 부족 종료 여부를 담는다', () => {
    const usage = mergeUsage(parseInspectOutput(INSPECT), parseStatsOutput(STATS));

    expect(usage).toEqual([
      { service: 'api', state: 'running', cpuPercent: 187.35, memoryBytes: Math.round(1.203 * 1024 ** 3), memoryLimitBytes: 1610612736, cpuLimit: 2, exitCode: undefined, oomKilled: false },
      { service: 'db', state: 'running', cpuPercent: 0.02, memoryBytes: Math.round(43.12 * 1024 ** 2), memoryLimitBytes: undefined, cpuLimit: undefined, exitCode: undefined, oomKilled: false },
      { service: 'web', state: 'exited', cpuPercent: undefined, memoryBytes: undefined, memoryLimitBytes: 536870912, cpuLimit: undefined, exitCode: 137, oomKilled: true },
    ]);
  });

  it('사람이 읽는 표기로 요약한다', () => {
    const [api, , web] = mergeUsage(parseInspectOutput(INSPECT), parseStatsOutput(STATS));
    // 187.35는 이진 부동소수점으로 187.3499…라 toFixed(1)이 187.3이 된다
    expect(describeUsage(api!)).toBe('api: running, CPU 187.3% / 200%, 메모리 1.20GiB / 1.50GiB');
    expect(describeUsage(web!)).toBe('web: exited, CPU -, 메모리 - / 512MiB, 종료 코드 137 (메모리 한도를 넘어 종료됨)');
    expect(formatBytes(undefined)).toBe('-');
  });
});

import { describe, expect, it } from 'vitest';
import type { ServiceUsage } from '../types';
import { bootNetworkFromUsage, describeUsage, formatBytes, mergeUsage, parseDockerBytes, parseInspectOutput, parseStatsOutput } from './usage';

const MANAGED = new Set(['api', 'web']);

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

describe('parseStatsOutput NetIO', () => {
  it('수신/송신 바이트를 여러 단위로 읽는다', () => {
    const [row] = parseStatsOutput('{"Name":"api","CPUPerc":"0%","MemUsage":"10MiB / 1GiB","NetIO":"1.2MB / 43.12MiB"}');
    expect(row).toMatchObject({ networkRxBytes: 1_200_000, networkTxBytes: Math.round(43.12 * 1024 ** 2) });
  });

  it('NetIO가 없거나 "--"면 둘 다 undefined다', () => {
    const [missing, dash] = parseStatsOutput(
      ['{"Name":"api","CPUPerc":"0%","MemUsage":"10MiB / 1GiB"}', '{"Name":"web","CPUPerc":"0%","MemUsage":"10MiB / 1GiB","NetIO":"-- / --"}'].join('\n'),
    );
    expect(missing!.networkRxBytes).toBeUndefined();
    expect(missing!.networkTxBytes).toBeUndefined();
    expect(dash!.networkRxBytes).toBeUndefined();
    expect(dash!.networkTxBytes).toBeUndefined();
  });
});

const INSPECT = JSON.stringify([
  {
    Name: '/studio-orders-bb3675-db-1',
    RestartCount: 0,
    State: { Status: 'running', ExitCode: 0, OOMKilled: false, StartedAt: '2026-09-12T09:00:00Z' },
    HostConfig: { Memory: 0, NanoCpus: 0 },
    Config: { Labels: { 'com.docker.compose.service': 'db' } },
  },
  {
    Name: '/studio-orders-bb3675-api-1',
    RestartCount: 2,
    State: { Status: 'running', ExitCode: 0, OOMKilled: false, StartedAt: '2026-09-12T09:00:05Z', Health: { Status: 'healthy' } },
    HostConfig: { Memory: 1610612736, NanoCpus: 2000000000 },
    Config: { Labels: { 'com.docker.compose.service': 'api' } },
  },
  {
    Name: '/studio-orders-bb3675-web-1',
    RestartCount: 1,
    State: { Status: 'exited', ExitCode: 137, OOMKilled: true, StartedAt: '0001-01-01T00:00:00Z' },
    HostConfig: { Memory: 536870912 },
    Config: { Labels: { 'com.docker.compose.service': 'web' } },
  },
]);

describe('docker 출력 해석', () => {
  it('실행 중인 컨테이너는 사용량을, 종료된 컨테이너는 종료 코드와 메모리 부족 종료 여부를 담는다', () => {
    const usage = mergeUsage(parseInspectOutput(INSPECT), parseStatsOutput(STATS), MANAGED);

    expect(usage).toEqual([
      {
        service: 'api',
        containerName: 'studio-orders-bb3675-api-1',
        role: 'managed',
        state: 'running',
        health: 'healthy',
        cpuPercent: 187.35,
        memoryBytes: Math.round(1.203 * 1024 ** 3),
        memoryLimitBytes: 1610612736,
        cpuLimit: 2,
        restartCount: 2,
        startedAt: '2026-09-12T09:00:05Z',
        exitCode: undefined,
        oomKilled: false,
      },
      {
        service: 'db',
        containerName: 'studio-orders-bb3675-db-1',
        role: 'supporting',
        state: 'running',
        cpuPercent: 0.02,
        memoryBytes: Math.round(43.12 * 1024 ** 2),
        memoryLimitBytes: undefined,
        cpuLimit: undefined,
        networkRxBytes: 28_800,
        networkTxBytes: 23_400,
        restartCount: 0,
        startedAt: '2026-09-12T09:00:00Z',
        exitCode: undefined,
        oomKilled: false,
      },
      {
        service: 'web',
        containerName: 'studio-orders-bb3675-web-1',
        role: 'managed',
        state: 'exited',
        cpuPercent: undefined,
        memoryBytes: undefined,
        memoryLimitBytes: 536870912,
        cpuLimit: undefined,
        restartCount: 1,
        exitCode: 137,
        oomKilled: true,
      },
    ]);
  });

  it('시작한 적 없는 컨테이너(StartedAt 0001-01-01)와 헬스체크 없는 컨테이너는 값을 비운다', () => {
    // INSPECT 순서 그대로: db, api, web
    const [db, api, web] = parseInspectOutput(INSPECT);
    expect(db?.health).toBeUndefined();
    expect(api?.health).toBe('healthy');
    expect(web?.startedAt).toBeUndefined();
  });

  it('edge 프록시는 managedNames와 상관없이 platform으로 분류한다', () => {
    const edgeInspect = JSON.stringify([
      { Name: '/studio-orders-bb3675-b-studio-edge-1', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, Config: { Labels: { 'com.docker.compose.service': 'b-studio-edge' } } },
    ]);
    const [edge] = mergeUsage(parseInspectOutput(edgeInspect), [], MANAGED);
    expect(edge?.role).toBe('platform');
  });

  it('기동 네트워크 지표는 edge와 값이 없는 컨테이너를 뺀다', () => {
    const usage: ServiceUsage[] = [
      { service: 'api', state: 'running', oomKilled: false, networkRxBytes: 1_200_000, networkTxBytes: 3_400 },
      { service: 'b-studio-edge', state: 'running', oomKilled: false, networkRxBytes: 9_000_000, networkTxBytes: 8_000_000 },
      // 실행 중이 아니면 NetIO가 없어 빠진다
      { service: 'db', state: 'exited', oomKilled: false },
    ];
    expect(bootNetworkFromUsage(usage, 'b-studio-edge')).toEqual([{ service: 'api', rxBytes: 1_200_000, txBytes: 3_400 }]);
  });

  it('사람이 읽는 표기로 요약한다', () => {
    const [api, , web] = mergeUsage(parseInspectOutput(INSPECT), parseStatsOutput(STATS));
    // 187.35는 이진 부동소수점으로 187.3499…라 toFixed(1)이 187.3이 된다
    expect(describeUsage(api!)).toBe('api: running, CPU 187.3% / 200%, 메모리 1.20GiB / 1.50GiB');
    expect(describeUsage(web!)).toBe('web: exited, CPU -, 메모리 - / 512MiB, 종료 코드 137 (메모리 한도를 넘어 종료됨)');
    expect(formatBytes(undefined)).toBe('-');
  });
});

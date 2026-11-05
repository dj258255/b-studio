import { describe, expect, it } from 'vitest';
import { EDGE_SERVICE } from '../edge-config';
import { egressAuditExcerpt, parseContainerState, parseContainerStates, parseEgressDenial, parseHostPort, parseLogLine, parseRuntimes, parseSyncOutput, SyncObservations } from './format';
import { discoverUserContainers, classifyOwnership, matchesProjectRoot, mergeHostContainerStats, parseHostContainers } from './host-containers';
import { classifyActuatorProbe, isForwarderProcess, matchDeclaredPorts, parseLsofListening, parsePsRow, parseSsListening } from './host-processes';
import { composeVolumeName, describeSnapshotEvent, snapshotName, snapshotSlot, snapshotsToPrune } from './snapshots';
import { foreignProcesses, parseProcessScan } from './stray-processes';
import { bootNetworkFromUsage, describeUsage, formatBytes, mergeUsage, parseDockerBytes, parseInspectOutput, parseStatsOutput } from './usage';

/**
 * 출력 해석 함수를 Rust로 옮기면서(ADR-191 2단계 2b-1) JS가 문자열·숫자·JSON을 읽는 규칙 때문에 Rust 표준 함수와 다르게 읽기 쉬운
 * 입력을 고정한다. 기대값은 옮기기 전 TS 구현이 낸 값이다. "의도한 차이"라고 적은 테스트만 옛 TS와 다르다.
 */
const THROWS = Symbol('throws');

/** 던지면 THROWS로 바꾼다. Date는 ISO 문자열로, Map은 쌍 목록으로, 시각이 없는 줄의 지금 시각은 'NOW'로 바꿔 견준다 */
function observe(fn: () => unknown): unknown {
  try {
    return normalizeDates(fn());
  } catch {
    return THROWS;
  }
}
function normalizeDates(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : Math.abs(value.getTime() - Date.now()) < 5_000 ? 'NOW' : value.toISOString();
  if (value instanceof Map) return [...value].map(([key, item]) => [key, normalizeDates(item)]);
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeDates(item)]));
  return value;
}

function check(name: string, fn: (...args: never[]) => unknown, cases: Array<[unknown[], unknown]>): void {
  describe(name, () => {
    it.each(cases.map(([args, want], index) => ({ index, args, want })))(`$index: $args`, ({ args, want }) => {
      expect(observe(() => fn(...(args as never[])))).toEqual(want);
    });
  });
}

// `docker stats`의 크기 표기. 단위 대소문자, JS 공백(BOM·NBSP·U+3000은 공백, U+0085는 아님), 켈빈 기호, 지수·16진수 표기, 아주 큰 수
check('parseDockerBytes', parseDockerBytes as never, [
    [['0B'], 0],
    [['1.2kB'], 1200],
    [['43.12MiB'], 45214597],
    [['1.5KiB'], 1536],
    [['2gb'], 2000000000],
    [['1TIB'], 1099511627776],
    [[' 12 '], undefined],
    [[''], undefined],
    [['--'], undefined],
    [['1e3MB'], undefined],
    [['0x10B'], undefined],
    [['999999999999999999999999999999MiB'], 1.048576e+36],
    [['1\u212aB'], undefined],
    [['1.5\u3000MB'], 1500000],
    [['1\ufeffkb'], 1000],
    [['1\u0085kb'], undefined],
    [['.5MB'], undefined],
    [['5.MB'], undefined],
    [['-5MB'], undefined],
    [['1,5MB'], undefined],
    [['1 000B'], undefined],
    [['1ib'], undefined],
    [['1.B'], undefined],
    [['1 \u00a0 mib'], 1048576],
    [['7mB'], 7000000],
    [['0.1KiB'], 102],
    [['1024kb'], 1024000],
]);

// `Number.parseFloat`은 앞부분만 읽고(`1e3%`→1000, `0x1F%`→0, `Infinity%`→Infinity), `NetIO`가 문자열이 아니면 `split`에서 던진다. 줄 앞의 NBSP는 trim이 지우지만 JSON.parse는 던진다
check('parseStatsOutput', parseStatsOutput as never, [
    [['{"Name":"web-1","CPUPerc":"12.50%","MemUsage":"10MiB / 1GiB","NetIO":"28.8kB / 23.4kB"}'], [{ name: 'web-1', cpuPercent: 12.5, memoryBytes: 10485760, networkRxBytes: 28800, networkTxBytes: 23400 }]],
    [['{"Name":"web-1","CPUPerc":"--","MemUsage":"--","NetIO":"--"}'], [{ name: 'web-1', cpuPercent: 0 }]],
    [['{"Name":"a","CPUPerc":"1e3%"}\n{"Name":"b","CPUPerc":"Infinity%"}\n{"Name":"c","CPUPerc":"0x1F%"}'], [{ name: 'a', cpuPercent: 1000 }, { name: 'b', cpuPercent: Infinity }, { name: 'c', cpuPercent: 0 }]],
    [['{"Name":"a","CPUPerc":" 7"}\n{"Name":"b","CPUPerc":".5%"}\n{"Name":"c","CPUPerc":"-5%"}\n{"Name":"d","CPUPerc":"5%%"}'], [{ name: 'a', cpuPercent: 7 }, { name: 'b', cpuPercent: 0.5 }, { name: 'c', cpuPercent: -5 }, { name: 'd', cpuPercent: 5 }]],
    [['{"Name":5,"CPUPerc":7.5}'], [{ name: 5, cpuPercent: 7.5 }]],
    [['{"Name":null,"CPUPerc":null,"MemUsage":null,"NetIO":null}'], [{ name: '', cpuPercent: 0 }]],
    [['{"Name":"a","CPUPerc":[1,2]}'], [{ name: 'a', cpuPercent: 1 }]],
    [['{"Name":"a","CPUPerc":true}'], [{ name: 'a', cpuPercent: 0 }]],
    [['{"Name":"a","NetIO":5}'], THROWS],
    [['{"Name":"a","MemUsage":{"x":1}}'], THROWS],
    [['\u00a0{"Name":"a"}'], THROWS],
    [['  {"Name":"a"}  \n\nnoise\r\n{"Name":"b"}\r\n'], [{ name: 'a', cpuPercent: 0 }, { name: 'b', cpuPercent: 0 }]],
    [['{"Name":"a",}'], THROWS],
    [['{"Name":"a","MemUsage":"10MiB","NetIO":"1kB / 2kB / 3kB"}'], [{ name: 'a', cpuPercent: 0, memoryBytes: 10485760, networkRxBytes: 1000, networkTxBytes: 2000 }]],
    [['{"Name":"a","MemUsage":"1.5GiB / 2GiB","NetIO":"0B / 0B"}'], [{ name: 'a', cpuPercent: 0, memoryBytes: 1610612736, networkRxBytes: 0, networkTxBytes: 0 }]],
    [[''], []],
]);

// `docker inspect` 배열. 값의 종류가 어긋나도 JS가 읽는 대로 읽고(문자열 NanoCpus는 수로), 배열이 아니거나 행이 null이면 던진다
check('parseInspectOutput', parseInspectOutput as never, [
    [['[{"Name":"/web-1","RestartCount":2,"State":{"Status":"running","ExitCode":0,"OOMKilled":false,"StartedAt":"2026-01-01T00:00:00Z","Health":{"Status":"healthy"}},"HostConfig":{"Memory":268435456,"NanoCpus":500000000},"Config":{"Labels":{"com.docker.compose.service":"web"}}}]'], [{ name: 'web-1', service: 'web', state: 'running', exitCode: 0, oomKilled: false, memoryLimitBytes: 268435456, cpuLimit: 0.5, restartCount: 2, startedAt: '2026-01-01T00:00:00Z', health: 'healthy' }]],
    [['[{"Name":"x","State":{"Status":"exited","ExitCode":137,"OOMKilled":true,"StartedAt":"0001-01-01T00:00:00Z"},"HostConfig":{"Memory":0,"NanoCpus":0}}]'], [{ name: 'x', service: 'unknown', state: 'exited', exitCode: 137, oomKilled: true }]],
    [['[{"HostConfig":{"NanoCpus":"2000000000","Memory":"5"},"State":{"Status":"weird","Health":{"Status":"none"}}}]'], [{ name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false, memoryLimitBytes: '5', cpuLimit: 2 }]],
    [['[{"Name":"//x","Config":{"Labels":"abc"},"State":{"Status":5,"ExitCode":null,"OOMKilled":null}}]'], [{ name: '/x', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }]],
    [['[{"Name":5}]'], THROWS],
    [['[{"Name":null,"RestartCount":null,"State":7,"HostConfig":[],"Config":"x"}]'], [{ name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false, restartCount: null }]],
    [['[null]'], THROWS],
    [['[5,"x",true,[]]'], [{ name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }, { name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }, { name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }, { name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }]],
    [['{}'], THROWS],
    [['null'], THROWS],
    [['  '], []],
    [[''], []],
    [['[1,]'], THROWS],
    [['\ufeff[]'], []],
    [[' \n[]\t'], []],
    [['[{"HostConfig":{"NanoCpus":1100000000}},{"HostConfig":{"NanoCpus":1}}]'], [{ name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false, cpuLimit: 1.1 }, { name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false, cpuLimit: 1e-9 }]],
    [['[{"Config":{"Labels":{"com.docker.compose.service":null}}},{"Config":{"Labels":{"com.docker.compose.service":5}}}]'], [{ name: '', service: 'unknown', state: 'unknown', exitCode: 0, oomKilled: false }, { name: '', service: 5, state: 'unknown', exitCode: 0, oomKilled: false }]],
]);

// 서비스 이름 정렬은 UTF-16 순서이고(`～`가 `😀`보다 뒤), stats는 실행 중인 컨테이너에만 붙고, 종료 코드는 exited·dead에만 남는다
check('mergeUsage', mergeUsage as never, [
    [[[{ name: 'web-1', service: 'web', state: 'running', exitCode: 0, oomKilled: false, startedAt: '2026-01-01T00:00:00Z', restartCount: 1, health: 'healthy', memoryLimitBytes: 268435456, cpuLimit: 0.5 }, { name: 'db-1', service: 'db', state: 'exited', exitCode: 137, oomKilled: false }, { name: 'edge-1', service: 'edge', state: 'running', exitCode: 0, oomKilled: false }, { name: 'x-1', service: 'x', state: 'created', exitCode: 3, oomKilled: true, startedAt: 'zzz' }], [{ name: 'web-1', cpuPercent: 12.5, memoryBytes: 1048576, networkRxBytes: 10, networkTxBytes: 20 }, { name: 'db-1', cpuPercent: 99, memoryBytes: 5 }], new Set(['web'])], [{ service: 'db', containerName: 'db-1', role: 'supporting', state: 'exited', exitCode: 137, oomKilled: false }, { service: 'edge', containerName: 'edge-1', role: 'supporting', state: 'running', oomKilled: false }, { service: 'web', containerName: 'web-1', role: 'managed', state: 'running', health: 'healthy', cpuPercent: 12.5, memoryBytes: 1048576, memoryLimitBytes: 268435456, cpuLimit: 0.5, networkRxBytes: 10, networkTxBytes: 20, restartCount: 1, startedAt: '2026-01-01T00:00:00Z', oomKilled: false }, { service: 'x', containerName: 'x-1', role: 'supporting', state: 'created', oomKilled: true }]],
    [[[{ name: 'a', service: '\uff5e', state: 'dead', exitCode: 1, oomKilled: false }, { name: 'b', service: '😀', state: 'dead', exitCode: 2, oomKilled: false }, { name: 'c', service: 'B', state: 'dead', exitCode: 3, oomKilled: false }, { name: 'd', service: 'a', state: 'dead', exitCode: 4, oomKilled: false }, { name: 'e', service: 'a', state: 'dead', exitCode: 5, oomKilled: false }], [], new Set([])], [{ service: 'B', containerName: 'c', role: 'supporting', state: 'dead', exitCode: 3, oomKilled: false }, { service: 'a', containerName: 'd', role: 'supporting', state: 'dead', exitCode: 4, oomKilled: false }, { service: 'a', containerName: 'e', role: 'supporting', state: 'dead', exitCode: 5, oomKilled: false }, { service: '😀', containerName: 'b', role: 'supporting', state: 'dead', exitCode: 2, oomKilled: false }, { service: '\uff5e', containerName: 'a', role: 'supporting', state: 'dead', exitCode: 1, oomKilled: false }]],
    [[[{ name: 'w', service: 'w', state: 'running', exitCode: 0, oomKilled: false }], [{ name: 'w', cpuPercent: Infinity, memoryBytes: NaN, networkRxBytes: -0 }], new Set([])], [{ service: 'w', containerName: 'w', role: 'supporting', state: 'running', cpuPercent: Infinity, memoryBytes: NaN, networkRxBytes: -0, oomKilled: false }]],
    [[[{ name: 'w', service: 'w', state: 'running', exitCode: 0, oomKilled: false }], [null], new Set([])], THROWS],
    [[[{ name: 'w', service: 'w', state: 'exited', exitCode: 0, oomKilled: false }], [null], new Set([])], [{ service: 'w', containerName: 'w', role: 'supporting', state: 'exited', exitCode: 0, oomKilled: false }]],
    [[[null], [], new Set([])], THROWS],
]);

// edge와 값이 없는 컨테이너는 빼고, 0과 Infinity는 값으로 센다
check('bootNetworkFromUsage', bootNetworkFromUsage as never, [
    [[[{ service: 'web', networkRxBytes: 0, networkTxBytes: 0 }, { service: 'edge', networkRxBytes: 1, networkTxBytes: 1 }, { service: 'db', networkRxBytes: 5 }, { service: 'api', networkRxBytes: Infinity, networkTxBytes: 7 }], 'edge'], [{ service: 'web', rxBytes: 0, txBytes: 0 }, { service: 'api', rxBytes: Infinity, txBytes: 7 }]],
    [[[], 'edge'], []],
]);

// `Math.round`는 가운데를 +무한대 쪽으로(음수에서 Rust `round`와 다름), `toFixed`는 정확한 값을 반올림한다
check('formatBytes', formatBytes as never, [
    [[undefined], '-'],
    [[0], '0KiB'],
    [[1], '0KiB'],
    [[511], '0KiB'],
    [[512], '1KiB'],
    [[1023], '1KiB'],
    [[1024], '1KiB'],
    [[1536], '2KiB'],
    [[2560], '3KiB'],
    [[524288], '512KiB'],
    [[1048575], '1024KiB'],
    [[1048576], '1MiB'],
    [[1572864], '2MiB'],
    [[2621440], '3MiB'],
    [[1073741823], '1024MiB'],
    [[1073741824], '1.00GiB'],
    [[1079110533.12], '1.00GiB'],
    [[2142114938.88], '2.00GiB'],
    [[10732049530.88], '9.99GiB'],
    [[1610612736], '1.50GiB'],
    [[5000000000000], '4656.61GiB'],
    [[-512], '0KiB'],
    [[-1536], '-1KiB'],
    [[-0], '0KiB'],
    [[NaN], 'NaNKiB'],
    [[Infinity], 'InfinityGiB'],
    [[-Infinity], '-InfinityKiB'],
    [[1e+300], '9.313225746154786e+290GiB'],
]);

// `cpuLimit * 100`은 JS 수 표기(`1.1*100`→`110.00000000000001`), CPU는 `toFixed(1)`(0.05→0.1, 1.25→1.3), 137은 강제 종료 안내
check('describeUsage', describeUsage as never, [
    [[{ service: 'api', state: 'exited', cpuPercent: 1.25, cpuLimit: 1.1, exitCode: 137, memoryBytes: 1048576, memoryLimitBytes: 2097152 }], 'api: exited, CPU 1.3% / 110.00000000000001%, 메모리 1MiB / 2MiB, 종료 코드 137 (강제 종료, 메모리 부족일 수 있음)'],
    [[{ service: 'api', state: 'exited', exitCode: 137, oomKilled: true }], 'api: exited, CPU -, 메모리 -, 종료 코드 137 (메모리 한도를 넘어 종료됨)'],
    [[{ service: 'api', state: 'exited', exitCode: 1 }], 'api: exited, CPU -, 메모리 -, 종료 코드 1'],
    [[{ service: 'db', state: 'running' }], 'db: running, CPU -, 메모리 -'],
    [[{ service: 'db', state: 'running', cpuPercent: 0.05, cpuLimit: 0.7, memoryBytes: 1610612736 }], 'db: running, CPU 0.1% / 70%, 메모리 1.50GiB'],
    [[{ service: 'db', state: 'running', cpuPercent: 99.95, cpuLimit: 300000000000000000000 }], 'db: running, CPU 100.0% / 3e+22%, 메모리 -'],
    [[{ service: 'db', state: 'running', cpuPercent: NaN, memoryBytes: NaN, memoryLimitBytes: 5 }], 'db: running, CPU NaN%, 메모리 NaNKiB / 0KiB'],
    [[{ service: 'db', state: 'running', cpuPercent: 1e+21 }], 'db: running, CPU 1e+21%, 메모리 -'],
    [[{ service: 'db', state: 'running', cpuPercent: null }], THROWS],
    [[{ service: 'db', state: 'exited', exitCode: '137' }], 'db: exited, CPU -, 메모리 -, 종료 코드 137'],
    [[{ service: 'db', state: 'exited', exitCode: null, memoryBytes: null }], 'db: exited, CPU -, 메모리 0KiB, 종료 코드 null'],
]);

// 라벨 이름 존재만 본다(sandbox가 deploy보다 앞)
check('classifyOwnership', classifyOwnership as never, [
    [[{ 'b-studio.sandbox': 'x' }], 'sandbox'],
    [[{ 'b-studio.deploy': 'x' }], 'deploy'],
    [[{ 'b-studio.deploy': 'x', 'b-studio.sandbox': '' }], 'sandbox'],
    [[{  }], 'user'],
    [[{ 'b-studio.sandbox2': 'x' }], 'user'],
]);

// `Object.entries` 순서는 정수 꼴 키(`8080`)가 먼저이고, IPv6 바인딩은 IPv4가 없을 때만 대표가 된다. `HostPort`는 `parseInt`로 앞부분만 읽는다
check('parseHostContainers', parseHostContainers as never, [
    [['[{"Id":"abc","Name":"/web-1","State":{"Status":"running","Health":{"Status":"healthy"}},"Config":{"Labels":{"com.docker.compose.project":"proj","com.docker.compose.service":"web","com.docker.compose.project.working_dir":"/p","com.docker.compose.oneoff":"True"}},"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"::","HostPort":"8080"},{"HostIp":"0.0.0.0","HostPort":"8080"}]}}}]'], [{ id: 'abc', name: 'web-1', owner: 'user', composeProject: 'proj', composeService: 'web', composeWorkingDir: '/p', oneOff: true, state: 'running', health: 'healthy', ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }], labels: { 'com.docker.compose.project': 'proj', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': '/p', 'com.docker.compose.oneoff': 'True' } }]],
    [['[{"NetworkSettings":{"Ports":{"9":null,"8080":[{"HostIp":"0.0.0.0","HostPort":"9090"}],"80/tcp":null,"x/tcp":null,"53/udp":[],"5432/tcp/x":[{}],"80/":[{"HostIp":"::","HostPort":"1"}],"":[],"4294967295":null}}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [{ containerPort: 9, protocol: 'tcp' }, { containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 9090 }, { containerPort: 80, protocol: 'tcp' }, { containerPort: 53, protocol: 'udp' }, { containerPort: 5432, protocol: 'tcp' }, { containerPort: 80, protocol: '', hostIp: '::', hostPort: 1 }, { containerPort: 4294967295, protocol: 'tcp' }], labels: {  } }]],
    [['[{"NetworkSettings":{"Ports":{"81/tcp":[{"HostIp":"0.0.0.0","HostPort":"99x"}],"82/tcp":[{"HostIp":"0.0.0.0","HostPort":""}],"83/tcp":[{"HostIp":"0.0.0.0","HostPort":1000}],"84/tcp":[{"HostPort":" 5"}],"85/tcp":[{"HostIp":"::"}],"86/tcp":[{"HostPort":"99999999999999999999999"}]}}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [{ containerPort: 81, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 99 }, { containerPort: 82, protocol: 'tcp', hostIp: '0.0.0.0' }, { containerPort: 83, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 1000 }, { containerPort: 84, protocol: 'tcp', hostPort: 5 }, { containerPort: 85, protocol: 'tcp', hostIp: '::' }, { containerPort: 86, protocol: 'tcp', hostPort: 1e+23 }], labels: {  } }]],
    [['[{"NetworkSettings":{"Ports":{"80/tcp":null,"9":null,"8080":null,"b":null,"7":null}}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [{ containerPort: 7, protocol: 'tcp' }, { containerPort: 9, protocol: 'tcp' }, { containerPort: 8080, protocol: 'tcp' }, { containerPort: 80, protocol: 'tcp' }], labels: {  } }]],
    [['[{"NetworkSettings":{"Ports":{"80/tcp":[null]}}}]'], THROWS],
    [['[{"NetworkSettings":{"Ports":{"80/tcp":{}}}}]'], THROWS],
    [['[{"NetworkSettings":{"Ports":{"80/tcp":"ab"}}}]'], THROWS],
    [['[{"NetworkSettings":{"Ports":"ab"}}]'], THROWS],
    [['[{"NetworkSettings":{"Ports":5}},{"NetworkSettings":{"Ports":true}},{"NetworkSettings":{"Ports":0}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: {  } }, { id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: {  } }, { id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: {  } }]],
    [['[{"NetworkSettings":{"Ports":[[{"HostIp":"1.2.3.4","HostPort":"5"}]]}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [{ containerPort: 0, protocol: 'tcp', hostIp: '1.2.3.4', hostPort: 5 }], labels: {  } }]],
    [['[{"Config":{"Labels":{"b-studio.sandbox":"x","com.docker.compose.oneoff":"true"}}},{"Config":{"Labels":{"b-studio.deploy":""}}},{"Config":{"Labels":{"com.docker.compose.oneoff":"False"}}}]'], [{ id: '', name: '', owner: 'sandbox', oneOff: true, state: 'unknown', ports: [], labels: { 'b-studio.sandbox': 'x', 'com.docker.compose.oneoff': 'true' } }, { id: '', name: '', owner: 'deploy', oneOff: false, state: 'unknown', ports: [], labels: { 'b-studio.deploy': '' } }, { id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: { 'com.docker.compose.oneoff': 'False' } }]],
    [['[{"Config":{"Labels":"abc"}}]'], THROWS],
    [['[{"Config":{"Labels":["x"]}}]'], [{ id: '', name: '', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: ['x'] }]],
    [['[{"Config":{"Labels":{"com.docker.compose.project":5,"com.docker.compose.service":null}}}]'], [{ id: '', name: '', owner: 'user', composeProject: 5, composeService: null, oneOff: false, state: 'unknown', ports: [], labels: { 'com.docker.compose.project': 5, 'com.docker.compose.service': null } }]],
    [['[{"Id":5,"Name":"/a","State":{"Status":"weird"}},{"Name":null,"State":{"Status":"running","Health":{"Status":"bogus"}}}]'], [{ id: 5, name: 'a', owner: 'user', oneOff: false, state: 'unknown', ports: [], labels: {  } }, { id: '', name: '', owner: 'user', oneOff: false, state: 'running', ports: [], labels: {  } }]],
    [['[{"Name":5}]'], THROWS],
    [['[null]'], THROWS],
    [['{}'], THROWS],
    [[''], []],
    [['[]'], []],
]);

// `path.resolve` 규칙(끝의 `/`, 겹친 구분자, `..`, 점), `/pp`는 `/p` 아래가 아니고 루트는 모든 것을 품는다
check('matchesProjectRoot', matchesProjectRoot as never, [
    [['/p', '/p'], true],
    [['/p/a', '/p'], true],
    [['/pp', '/p'], false],
    [['/p/', '/p'], true],
    [['/p//a/../b', '/p/'], true],
    [['/q', '/'], true],
    [['/', '/'], true],
    [['', '/p'], false],
    [[undefined, '/p'], false],
    [['/p/..a', '/p'], true],
    [['/p/../q', '/p'], false],
    [['/P', '/p'], false],
    [['/p/가', '/p'], true],
    [['/p\\a', '/p'], false],
]);

// 사용자 컨테이너만 compose 프로젝트별로 묶고, 일회성 컨테이너는 빼고, 프로젝트 이름은 UTF-16 순서로 낸다
check('discoverUserContainers', discoverUserContainers as never, [
    [[[{ name: 'a', owner: 'user', oneOff: false, composeProject: '\uff5e', composeWorkingDir: '/p/a' }, { name: 'b', owner: 'user', oneOff: false, composeProject: '😀', composeWorkingDir: '/p/b' }, { name: 'c', owner: 'sandbox', oneOff: false, composeProject: 's', composeWorkingDir: '/p' }, { name: 'd', owner: 'user', oneOff: true, composeProject: 'o', composeWorkingDir: '/p' }, { name: 'e', owner: 'user', oneOff: false, composeProject: '\uff5e', composeWorkingDir: '/p/c' }, { name: 'f', owner: 'user', oneOff: false, composeProject: 'Z', composeWorkingDir: '/q' }, { name: 'g', owner: 'user', oneOff: false, composeProject: 'a', composeWorkingDir: '/pp' }, { name: 'h', owner: 'user', oneOff: false, composeProject: 'a', composeWorkingDir: '/p' }, { name: 'i', owner: 'user', oneOff: false, composeWorkingDir: '/p' }, { name: 'j', owner: 'user', oneOff: false, composeProject: 'x' }], '/p'], [{ project: 'a', workingDir: '/p', matchReason: 'com.docker.compose.project.working_dir="/p" (프로젝트 폴더와 일치)', services: [{ name: 'h', owner: 'user', oneOff: false, composeProject: 'a', composeWorkingDir: '/p' }] }, { project: '😀', workingDir: '/p/b', matchReason: 'com.docker.compose.project.working_dir="/p/b" (프로젝트 폴더와 일치)', services: [{ name: 'b', owner: 'user', oneOff: false, composeProject: '😀', composeWorkingDir: '/p/b' }] }, { project: '\uff5e', workingDir: '/p/a', matchReason: 'com.docker.compose.project.working_dir="/p/a" (프로젝트 폴더와 일치)', services: [{ name: 'a', owner: 'user', oneOff: false, composeProject: '\uff5e', composeWorkingDir: '/p/a' }, { name: 'e', owner: 'user', oneOff: false, composeProject: '\uff5e', composeWorkingDir: '/p/c' }] }]],
    [[[{ name: 'a', owner: 'user', oneOff: false, composeProject: 'p', composeWorkingDir: 5 }], '/p'], THROWS],
    [[[{ name: 'a', owner: 'user', oneOff: false, composeProject: 'p', composeWorkingDir: 0 }], '/p'], []],
    [[[null], '/p'], THROWS],
    [[[], '/p'], []],
]);

// 컨테이너 이름으로 맞춰 CPU·메모리를 붙이고, 못 맞춘 컨테이너는 그대로 둔다
check('mergeHostContainerStats', mergeHostContainerStats as never, [
    [[[{ id: '1', name: 'web-1' }, { id: '2', name: 'db-1' }], '{"Name":"web-1","CPUPerc":"5%","MemUsage":"1MiB / 1GiB"}\n{"Name":"web-1","CPUPerc":"9%"}'], [{ id: '1', name: 'web-1', cpuPercent: 5, memoryBytes: 1048576 }, { id: '2', name: 'db-1' }]],
    [[[{ id: '1', name: 'web-1' }], ''], [{ id: '1', name: 'web-1' }]],
    [[[{ id: '1', name: 'web-1' }], '{'], THROWS],
    [[[{ id: '1', name: '5' }], '{"Name":5,"CPUPerc":"1%"}'], [{ id: '1', name: '5' }]],
]);

// `/i`는 ASCII 글자의 대소문자만 가린다(긴 s와 켈빈 기호는 ASCII와 같지 않다)
check('isForwarderProcess', isForwarderProcess as never, [
    [['limactl'], true],
    [['LIMA'], true],
    [['ssh'], true],
    [['SSH-agent'], true],
    [['Com.Docker.backend'], true],
    [['vpnkit-bridge'], true],
    [['com_docker'], false],
    [['node'], false],
    [[''], false],
    [['\u017f\u017fh'], false],
    [['\u017fsh'], false],
    [['vpn\u212ait'], false],
    [['xxLimaxx'], true],
]);

// `\s`는 BOM·NBSP·U+3000을 가르고 U+0085는 가르지 않는다. 포트는 마지막 콜론 뒤 숫자, pid는 `parseInt`(부호·앞부분)
check('parseLsofListening', parseLsofListening as never, [
    [['COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 123 me 20u IPv6 0x1 0t0 TCP *:3000 (LISTEN)\njava 124 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:8080 (LISTEN)\n'], [{ pid: 123, command: 'node', port: 3000 }, { pid: 124, command: 'java', port: 8080 }]],
    [['H\nnode 124 me TCP 127.0.0.1:8080\nbad x me TCP *:80 (LISTEN)\nshort\n\nnode 9 me TCP *:abc (LISTEN)\nsolo (LISTEN)\n(LISTEN)\n'], [{ pid: 124, command: 'node', port: 8080 }]],
    [['H\nnode +7 me TCP *:80 (LISTEN)\nnode -5 me TCP *:81 (LISTEN)\nnode 12x me TCP *:82 (LISTEN)\nnode 1e3 me TCP *:83 (LISTEN)'], [{ pid: 7, command: 'node', port: 80 }, { pid: -5, command: 'node', port: 81 }, { pid: 12, command: 'node', port: 82 }, { pid: 1, command: 'node', port: 83 }]],
    [['H\nnode -0 me TCP *:80 (LISTEN)'], [{ pid: -0, command: 'node', port: 80 }]],
    [['H\nnode 1 me TCP *:80: (LISTEN)\nnode 2 me TCP [::1]:5432 (LISTEN)\nnode 3 me TCP *:99999999999999999999 (LISTEN)\nnode 4 me TCP : (LISTEN)'], [{ pid: 2, command: 'node', port: 5432 }, { pid: 3, command: 'node', port: 100000000000000000000 }]],
    [['H\nnode\ufeff123\u3000me\u00a0TCP\u00a0*:80\u00a0(LISTEN)'], [{ pid: 123, command: 'node', port: 80 }]],
    [['H\nnode\u0085123 me TCP *:80 (LISTEN)'], []],
    [['H\r\nnode 1 me TCP *:80 (LISTEN)\r\nnode 2 me TCP *:81 (LISTEN)\r\n'], [{ pid: 1, command: 'node', port: 80 }, { pid: 2, command: 'node', port: 81 }]],
    [['node 1 me TCP *:80 (LISTEN)'], []],
    [[''], []],
]);

// `pid=`는 숫자가 이어지는 첫 자리, 명령은 `(("`와 닫는 따옴표가 모두 있는 첫 자리
check('parseSsListening', parseSsListening as never, [
    [['State Recv-Q Send-Q Local Peer Process\nLISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=77,fd=19))\nLISTEN 0 128 [::]:80 [::]:* users:(("a b",pid=1,fd=3),("c",pid=2,fd=4))\n'], [{ pid: 77, command: 'node', port: 3000 }, { pid: 1, command: 'a b', port: 80 }]],
    [['H\nLISTEN 0 128 *:80 *:* users:(("x",pid=,fd=1),("y",pid=5))\nLISTEN 0 128 *:81 *:* pid=pid=3\nLISTEN 0 128 *:82 *:* ((""\nLISTEN 0 128 *:83 *:* pid=9 (("x\nLISTEN 0 128 *:84 *:* (("x" pid=8'], [{ pid: 5, command: 'x', port: 80 }, { pid: 3, command: '', port: 81 }, { pid: 9, command: '', port: 83 }, { pid: 8, command: 'x', port: 84 }]],
    [['H\nLISTEN 0 128 *:85 *:*\nLISTEN 0 128 *:abc *:* pid=1\nLISTEN 0 128 *:86:\nLISTEN 0 128 *:87 *:* pid=99999999999999999999'], [{ pid: 100000000000000000000, command: '', port: 87 }]],
    [['H\nLISTEN\u00a00\u00a0128\u00a0*:88\u00a0*:*\u00a0pid=4'], [{ pid: 4, command: '', port: 88 }]],
]);

// `Set`은 NaN을 NaN과 같게, +0과 -0을 같게 본다. 같은 포트는 먼저 나온 것만, 포워더와 제외 pid는 뺀다
check('matchDeclaredPorts', matchDeclaredPorts as never, [
    [[[{ pid: 1, command: 'ssh', port: 80 }, { pid: 2, command: 'node', port: 80 }, { pid: 3, command: 'node', port: 80 }, { pid: 4, command: 'node', port: 81 }, { pid: 5, command: 'node', port: 82 }], [80, 82]], [{ pid: 2, command: 'node', port: 80 }, { pid: 5, command: 'node', port: 82 }]],
    [[[{ pid: 1, command: 'node', port: 80 }, { pid: 2, command: 'node', port: 82 }], [80, 82], [1]], [{ pid: 2, command: 'node', port: 82 }]],
    [[[{ pid: 1, command: 'node', port: NaN }, { pid: 2, command: 'node', port: NaN }], [NaN]], [{ pid: 1, command: 'node', port: NaN }]],
    [[[{ pid: NaN, command: 'node', port: 1 }], [1], [NaN]], []],
    [[[{ pid: 1, command: 'node', port: -0 }, { pid: 2, command: 'node', port: 0 }], [0]], [{ pid: 1, command: 'node', port: -0 }]],
    [[[], [80]], []],
]);

// `.`은 \r·U+2028·U+2029와 맞지 않아 명령 안에 있으면 줄 전체가 맞지 않고, 끝의 \r은 공백이 먹어 명령이 빈 문자열이 된다. CPU는 `parseFloat`(`1.2.3`→1.2, `.`→NaN)
check('parsePsRow', parsePsRow as never, [
    [['\n  12  3.5  400 /usr/bin/node  server.js  \n'], { pid: 12, cpuPercent: 3.5, rssKb: 400, command: '/usr/bin/node  server.js' }],
    [['1 2 3 cmd\rmore'], undefined],
    [['1 2 3 \r'], { pid: 1, cpuPercent: 2, rssKb: 3, command: '' }],
    [['1 2 3 cmd\r'], undefined],
    [['1 2 3 a\u2028b'], undefined],
    [['1 2 3 a\tb'], { pid: 1, cpuPercent: 2, rssKb: 3, command: 'a\tb' }],
    [['1 1.2.3 3 c'], { pid: 1, cpuPercent: 1.2, rssKb: 3, command: 'c' }],
    [['1 . 3 c'], { pid: 1, cpuPercent: NaN, rssKb: 3, command: 'c' }],
    [['1 1e3 3 c'], undefined],
    [['x 2 3 c'], undefined],
    [['1 2 3'], undefined],
    [['1 2 3 '], { pid: 1, cpuPercent: 2, rssKb: 3, command: '' }],
    [['\u00a01\u3000 2\ufeff3\u00a0 c d\u00a0'], { pid: 1, cpuPercent: 2, rssKb: 3, command: 'c d' }],
    [['1 2 3\u0085 c'], undefined],
    [['   \n\n'], undefined],
    [['99999999999999999999 2 3 c'], { pid: 100000000000000000000, cpuPercent: 2, rssKb: 3, command: 'c' }],
    [['\n\n 7 0.0 5 가나\n9 9 9 z'], { pid: 7, cpuPercent: 0, rssKb: 5, command: '가나' }],
]);

// health가 안 되면 안내, logfile은 200·206만 사용 가능
check('classifyActuatorProbe', classifyActuatorProbe as never, [
    [[false, undefined], { connected: false, logfileAvailable: false, guidance: '/actuator/health에 응답이 없습니다. 이 포트의 앱이 Spring Boot Actuator를 쓴다면 management.endpoints.web.exposure.include=health,logfile을 열어 두세요' }],
    [[false, 200], { connected: false, logfileAvailable: false, guidance: '/actuator/health에 응답이 없습니다. 이 포트의 앱이 Spring Boot Actuator를 쓴다면 management.endpoints.web.exposure.include=health,logfile을 열어 두세요' }],
    [[true, 200], { connected: true, logfileAvailable: true }],
    [[true, 206], { connected: true, logfileAvailable: true }],
    [[true, 404], { connected: true, logfileAvailable: false, guidance: 'Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다' }],
    [[true, undefined], { connected: true, logfileAvailable: false, guidance: 'Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다' }],
    [[true, NaN], { connected: true, logfileAvailable: false, guidance: 'Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다' }],
    [[true, 201], { connected: true, logfileAvailable: false, guidance: 'Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다' }],
]);

// 경로는 UTF-16 순서로 정렬해(`～`가 `😀`보다 뒤) SHA-256에 넣고, 같은 경로는 넘긴 순서를 지킨다. 빈 파일과 없는 파일은 다르다
check('snapshotName', snapshotName as never, [
    [[{ project: 'p', service: 'api', volume: 'node_modules', files: [{ path: 'package.json', content: Buffer.from('{}') }, { path: 'pnpm-lock.yaml' }] }], 'b-studio-snapshot-844e225de86dde18c16098fb'],
    [[{ project: 'p', service: 'api', volume: 'node_modules', files: [{ path: 'pnpm-lock.yaml' }, { path: 'package.json', content: Buffer.from('{}') }] }], 'b-studio-snapshot-844e225de86dde18c16098fb'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: '\uff5e', content: Buffer.from('a') }, { path: '😀', content: Buffer.from('b') }] }], 'b-studio-snapshot-31b4c17f26593db4c538be67'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'f', content: Buffer.from('') }] }], 'b-studio-snapshot-6d8dfe02525707263a751950'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'f' }] }], 'b-studio-snapshot-05c5cd76de12cae949c9f0c4'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'same', content: Buffer.from('1') }, { path: 'same', content: Buffer.from('2') }] }], 'b-studio-snapshot-cf52a90642624e93550e2aae'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'same', content: Buffer.from('2') }, { path: 'same', content: Buffer.from('1') }] }], 'b-studio-snapshot-4823b0efeb3323fd5dcd6a10'],
    [[{ project: '가', service: '😀', volume: '', files: [] }], 'b-studio-snapshot-1426f7d22f1f60273fd91c9c'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'big', content: Buffer.alloc(100000, 7) }] }], 'b-studio-snapshot-badc8740577c538dde55444f'],
    [[{ project: 'p', service: 'api', volume: 'v', files: [{ path: 'a\u0000b', content: Buffer.from('x') }, { path: '', content: Buffer.from('y') }] }], 'b-studio-snapshot-398bbe108f77ffc529b03c53'],
]);

// 단순 이음
check('snapshotSlot', snapshotSlot as never, [
    [['p', 'api', 'node_modules'], 'p/api/node_modules'],
    [['', '', ''], '//'],
]);

// 단순 이음
check('composeVolumeName', composeVolumeName as never, [
    [['proj', 'node_modules'], 'proj_node_modules'],
    [['', ''], '_'],
]);

// 시각은 JS `Date.parse`가 읽는다(ISO, RFC 2822, 읽지 못하면 0). 오래된 순서로 `keep`개를 남기고, `keep`은 `slice` 규칙(음수는 끝에서부터, NaN은 0, 소수는 버림)
check('snapshotsToPrune', snapshotsToPrune as never, [
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z\nd 2026-11-05T11:00:00Z\n'], ['c', 'b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc Thu, 05 Nov 2026 12:00:00 GMT\nd x\ne 1970-01-01T00:00:00Z\nf 2026-11-05 10:00:00 +0000 UTC\n', 1], ['f', 'b', 'c', 'd', 'e']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', 0], ['a', 'c', 'b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', -1], ['b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', -2.5], ['c', 'b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', NaN], ['a', 'c', 'b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', 1.9], ['c', 'b']],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', Infinity], []],
    [['a 2026-11-05T10:00:00Z\nb 2025-01-01T00:00:00Z\nc 2026-01-01T00:00:00Z', -Infinity], ['a', 'c', 'b']],
    [['a 1\nb 1\nc 1\nd 1\ne 1', 2], ['c', 'd', 'e']],
    [['\n  \nlone\n\u0085 2026-01-01T00:00:00Z\nv\u3000\u00a02026-01-01T00:00:00Z\nw\ufeff2026-01-01T00:00:00Z extra\n'], ['w']],
    [['x\t2026-11-05T10:00:00Z\r\ny 2026-11-05T10:00:00Z\r\nz 2026-11-05T10:00:00Z\r\n', 0], ['x', 'y', 'z']],
    [[''], []],
]);

// 초는 `toFixed(1)`(1.25→1.3, 0.05→0.1), `elapsedMs`가 없으면 NaN초, 모르는 action은 undefined
check('describeSnapshotEvent', describeSnapshotEvent as never, [
    [[{ service: 's', volume: 'node_modules', snapshot: 'x', action: 'seeded', elapsedMs: 1250 }], 'node_modules 볼륨을 스냅샷에서 채웠습니다 (1.3초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'captured', elapsedMs: 50 }], 'v 볼륨을 다음 기동용 스냅샷으로 저장했습니다 (0.1초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'captured', elapsedMs: 2550 }], 'v 볼륨을 다음 기동용 스냅샷으로 저장했습니다 (2.5초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded', elapsedMs: 99950 }], 'v 볼륨을 스냅샷에서 채웠습니다 (100.0초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded' }], 'v 볼륨을 스냅샷에서 채웠습니다 (NaN초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded', elapsedMs: NaN }], 'v 볼륨을 스냅샷에서 채웠습니다 (NaN초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded', elapsedMs: Infinity }], 'v 볼륨을 스냅샷에서 채웠습니다 (Infinity초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded', elapsedMs: '1500' }], 'v 볼륨을 스냅샷에서 채웠습니다 (1.5초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'seeded', elapsedMs: 1e+25 }], 'v 볼륨을 스냅샷에서 채웠습니다 (1e+22초)'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'missing' }], 'v 스냅샷이 없어 처음부터 설치합니다'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'failed', stage: 'seed', reason: 'boom' }], 'v 스냅샷 복사에 실패해 스냅샷 없이 진행합니다: boom'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'failed', stage: 'capture', reason: 'boom' }], 'v 스냅샷 저장에 실패해 스냅샷 없이 진행합니다: boom'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'failed', stage: 'other' }], 'v 스냅샷 저장에 실패해 스냅샷 없이 진행합니다: undefined'],
    [[{ service: 's', volume: 'v', snapshot: 'x', action: 'nope' }], undefined],
    [[null], THROWS],
]);

// `trimEnd`는 U+3000·BOM도 지우고, 줄 가운데의 \r·U+2028은 `.`이 받지 못해 그 줄이 버려진다. pid는 숫자 순서로 정렬(안정)
check('parseProcessScan', parseProcessScan as never, [
    [['20 500 sleep 100  \n3 40\n  7 1 x\nnoise\n9 8 a\rb\n5 6 \n'], [{ pid: 3, start: '40', command: '' }, { pid: 5, start: '6', command: '' }, { pid: 20, start: '500', command: 'sleep 100' }]],
    [['1 2 a\u2028b\n1 2 c\u3000\n1 3 d\ufeff\n1 4 \u0085e\n1 5 \u00a0f\u00a0'], [{ pid: 1, start: '2', command: 'c' }, { pid: 1, start: '3', command: 'd' }, { pid: 1, start: '4', command: '\u0085e' }, { pid: 1, start: '5', command: 'f' }]],
    [['10 1 x\n2 1 y\n10 2 z\n2 2 w'], [{ pid: 2, start: '1', command: 'y' }, { pid: 2, start: '2', command: 'w' }, { pid: 10, start: '1', command: 'x' }, { pid: 10, start: '2', command: 'z' }]],
    [['007 1 x\n99999999999999999999 1 y\n99999999999999999998 1 z\n3 1 w'], [{ pid: 3, start: '1', command: 'w' }, { pid: 7, start: '1', command: 'x' }, { pid: 100000000000000000000, start: '1', command: 'y' }, { pid: 100000000000000000000, start: '1', command: 'z' }]],
    [['1  2 two spaces\n1 2  extra\n'], [{ pid: 1, start: '2', command: 'extra' }]],
    [['1 2\r\n3 4 x\r\n'], [{ pid: 1, start: '2', command: '' }, { pid: 3, start: '4', command: 'x' }]],
    [[''], []],
]);

// 같은 pid라도 시작 시각이 다르면 모르는 프로세스, 기준선이 없으면 모두 모르는 것
check('foreignProcesses', foreignProcesses as never, [
    [[[{ pid: 1, start: '10', command: 'a' }, { pid: 2, start: '20', command: 'b' }, { pid: 2, start: '21', command: 'c' }], [{ pid: 1, start: '10', command: 'a' }, { pid: 2, start: '20', command: 'b' }]], [{ pid: 2, start: '21', command: 'c' }]],
    [[[{ pid: 1, start: '10', command: 'a' }], undefined], [{ pid: 1, start: '10', command: 'a' }]],
    [[[], [{ pid: 1, start: '10', command: 'a' }]], []],
    [[[{ pid: 1e+21, start: '1', command: 'a' }, { pid: NaN, start: '1', command: 'b' }], [{ pid: 1e+21, start: '1', command: 'x' }, { pid: NaN, start: '1', command: 'y' }]], []],
    [[[{ pid: 1, start: '1:2', command: 'a' }], [{ pid: 1, start: '1', command: 'x' }]], [{ pid: 1, start: '1:2', command: 'a' }]],
]);

// 앞부분이 `{"edge":"egress"`일 때만 읽고, 거부(deny) 줄에 host·at이 문자열일 때만 돌려준다. 다른 형의 port·method·path·reason은 빼거나 빈 문자열
check('parseEgressDenial', parseEgressDenial as never, [
    [['{"edge":"egress","decision":"deny","host":"x.com","port":443,"method":"GET","path":"/a","reason":"no","at":"2026-01-01T00:00:00Z"}'], { host: 'x.com', port: 443, method: 'GET', path: '/a', reason: 'no', at: '2026-01-01T00:00:00.000Z' }],
    [['{"edge":"egress","decision":"deny","host":"x.com","at":"2026-01-01T00:00:00.123456Z","port":"443","method":5,"path":null,"reason":5}'], { host: 'x.com', reason: '', at: '2026-01-01T00:00:00.123Z' }],
    [['{"edge":"egress","decision":"deny","host":"x.com","at":"not a date"}'], { host: 'x.com', reason: '', at: 'Invalid Date' }],
    [['{"edge":"egress","decision":"allow","host":"x","at":"y"}'], undefined],
    [['{"edge":"egress","decision":"deny","host":5,"at":"y"}'], undefined],
    [['{"edge":"egress","decision":"deny","host":"x"}'], undefined],
    [['{"edge":"egress","decision":"deny","host":"x","at":"y"'], undefined],
    [['{"edge": "egress","decision":"deny","host":"x","at":"y"}'], undefined],
    [[' {"edge":"egress","decision":"deny","host":"x","at":"y"}'], undefined],
    [['{"edge":"egress","decision":"deny","host":"x","at":"y"} z'], undefined],
    [['{"edge":"egress","decision":"deny","host":"x","at":"2026-01-01","port":1e999}'], { host: 'x', port: Infinity, reason: '', at: '2026-01-01T00:00:00.000Z' }],
    [['{"edge":"egress","decision":"deny","host":"x","at":"2026-01-01","host":"y"}'], { host: 'y', reason: '', at: '2026-01-01T00:00:00.000Z' }],
]);

// `slice(-max)`: max가 0이거나 NaN이면 전부, 음수면 앞에서부터 자르고, 소수는 0쪽으로 버린다. deny와 error만, 이유가 문자열이 아니면 decision
check('egressAuditExcerpt', egressAuditExcerpt as never, [
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}']], ['h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], 3], ['h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], 0], ['h0: r', 'h1: r', 'h2: r', 'h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], NaN], ['h0: r', 'h1: r', 'h2: r', 'h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], -2], ['h2: r', 'h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], 2.7], ['h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], Infinity], ['h0: r', 'h1: r', 'h2: r', 'h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"deny","host":"h0","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h1","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h2","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h3","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h4","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h5","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h6","reason":"r"}', '{"edge":"egress","decision":"deny","host":"h7","reason":"r"}'], 100], ['h0: r', 'h1: r', 'h2: r', 'h3: r', 'h4: r', 'h5: r', 'h6: r', 'h7: r']],
    [[['{"edge":"egress","decision":"error","host":"a"}', '{"edge":"egress","decision":"allow","host":"b"}', '{"edge":"egress","decision":"deny","host":5}', '{"edge":"egress","decision":"deny","host":"c","reason":7}', 'x', '{"edge":"egress"', '{"edge":"egress","decision":"deny","host":"d","reason":"z"}']], ['a: error', 'c: deny', 'd: z']],
    [[['{"edge":"egress","decision":"error","host":"a"}', '{"edge":"egress","decision":"allow","host":"b"}', '{"edge":"egress","decision":"deny","host":5}', '{"edge":"egress","decision":"deny","host":"c","reason":7}', 'x', '{"edge":"egress"', '{"edge":"egress","decision":"deny","host":"d","reason":"z"}'], 1], ['d: z']],
    [[[]], []],
]);

// 런타임 이름은 UTF-16 순서(`😀` < `～`). 배열이면 인덱스 문자열이 문자열 순서(`0 1 10 11 2`), 객체가 아니거나 JSON이 아니면 빈 배열
check('parseRuntimes', parseRuntimes as never, [
    [['{"runsc":{},"runc":{},"\\uff5e":{},"😀":{},"io.containerd.runc.v2":{},"Runc":{}}'], ['Runc', 'io.containerd.runc.v2', 'runc', 'runsc', '😀', '\uff5e']],
    [['{"b":1,"10":1,"9":1,"2":1,"a":1}'], ['10', '2', '9', 'a', 'b']],
    [['[1,2,3,4,5,6,7,8,9,10,11]'], ['0', '1', '10', '2', '3', '4', '5', '6', '7', '8', '9']],
    [['null'], []],
    [['"x"'], []],
    [['5'], []],
    [['true'], []],
    [['{'], []],
    [[''], []],
    [['  '], []],
    [['{}'], []],
    [['\ufeff{}'], []],
    [['{"a":1,"a":2}'], ['a']],
]);

// 마지막 줄 끝의 `:숫자`. 0·없음은 던지고(메시지에 `JSON.stringify`한 출력), 아주 큰 수는 Infinity
check('parseHostPort', parseHostPort as never, [
    [['0.0.0.0:3000\n[::]:3001\n'], 3001],
    [['x:80\r\nx:81'], 81],
    [['x:007'], 7],
    [['x:0'], THROWS],
    [['x:000'], THROWS],
    [['nothing'], THROWS],
    [[''], THROWS],
    [['x:80:'], THROWS],
    [['x:8a'], THROWS],
    [['x:9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999'], Infinity],
    [['a\u0000b\u001f"\\\u2028é'], THROWS],
    [['x:80\r'], 80],
    [['  x:81  '], 81],
    [['x:80\n\n'], 80],
]);

// `compose ps` 출력은 배열이거나 줄 단위 JSON. 같은 서비스는 나중 값이 이기되 자리는 처음 것, 빈 줄은 건너뛰고(상태 하나만 읽는 쪽은 던진다), JSON이 아니면 던진다
check('parseContainerStates', parseContainerStates as never, [
    [['{"Service":"a","State":"running"}\n\n{"Service":"b","State":"weird"}\n{"Service":"a","State":"exited"}\r\nnull\n5\n{"Service":5,"State":"running"}'], [['a', 'exited']]],
    [['[{"Service":"a","State":"dead"},5,null,{"Service":"b","State":"paused"}]'], [['a', 'dead'], ['b', 'paused']]],
    [['{bad'], THROWS],
    [['{"Service":"a","State":"running"}\n  \n'], [['a', 'running']]],
    [[''], []],
    [['  \n '], []],
    [['[1,]'], THROWS],
    [['{"Service":"b","State":"running"}{"Service":"a","State":"running"}'], THROWS],
    [[' [{"Service":"a","State":"created"}] '], [['a', 'created']]],
    [['\ufeff[]'], []],
]);

// 첫 항목의 State 하나. 줄 단위 출력은 모든 줄을 읽으므로 가운데 빈 줄이 있으면 던진다
check('parseContainerState', parseContainerState as never, [
    [['{"State":"running"}\n{"State":"x"}'], 'running'],
    [['{"State":"running"}\n\n{"State":"x"}'], THROWS],
    [['[]'], 'unknown'],
    [[''], 'unknown'],
    [['[{"State":"weird"}]'], 'unknown'],
    [['[{"State":5}]'], 'unknown'],
    [['[null]'], 'unknown'],
    [['null'], 'unknown'],
    [['{bad'], THROWS],
    [['{"State":"exited"}\r\n'], 'exited'],
    [['[{"State":"dead"}]'], 'dead'],
    [['5'], 'unknown'],
]);

// 첫 공백에서만 나누고(맨 앞 공백은 건너뜀), 같은 경로는 나중 값이 이기되 자리는 처음 것
check('parseSyncOutput', parseSyncOutput as never, [
    [['abc dir/a b.txt\nMISSING x\n bad\nnospace\nabc dir/a b.txt2\nUNREADABLE x'], [['dir/a b.txt', 'abc'], ['x', 'UNREADABLE'], ['dir/a b.txt2', 'abc']]],
    [['h\r\nh x\r\n'], [['x\r', 'h']]],
    [['abc  two  spaces\nabc\ttab y'], [[' two  spaces', 'abc'], ['y', 'abc\ttab']]],
    [['가나 다라\n😀 x'], [['다라', '가나'], ['x', '😀']]],
    [[''], []],
]);

// `\S`·`\s`·`.`는 JS 글자 집합(U+0085는 공백이 아니고 BOM은 공백), 시각은 밀리초까지만, ANSI 제어 코드는 먼저 지운다. 시각이 없는 줄의 `at`은 지금
check('parseLogLine', parseLogLine as never, [
    [['api-1  | 2026-09-10T11:48:35.123456789Z 메시지'], { service: 'api', text: '메시지', at: '2026-09-10T11:48:35.123Z' }],
    [['api-1 | 2026-09-10T11:48:35Z x'], { service: 'api', text: 'x', at: '2026-09-10T11:48:35.000Z' }],
    [['web-2  | 2026-09-10T11:48:35.1Z'], { service: 'web', text: '', at: '2026-09-10T11:48:35.100Z' }],
    [['web-2 |\u00a02026-09-10T11:48:35.12345Z hi'], { service: 'web', text: 'hi', at: '2026-09-10T11:48:35.123Z' }],
    [['a-b-3 | 2026-01-01T00:00:00.000000Z  two spaces'], { service: 'a-b', text: ' two spaces', at: '2026-01-01T00:00:00.000Z' }],
    [['db-1 exited with code 143'], { service: 'db', text: 'exited with code 143', at: 'NOW' }],
    [['db-1 has been recreated'], { service: 'db', text: 'has been recreated', at: 'NOW' }],
    [['DB-1 exited'], { service: 'unknown', text: 'DB-1 exited', at: 'NOW' }],
    [['x-y_z.w-12 \u001b[K started'], { service: 'x-y_z.w', text: 'started', at: 'NOW' }],
    [['\u001b[Kweb-1 exited with code 1'], { service: 'web', text: 'exited with code 1', at: 'NOW' }],
    [['\u001b[31mapi-1  | 2026-09-10T11:48:35.123Z \u001b[0mcolored'], { service: 'api', text: 'colored', at: '2026-09-10T11:48:35.123Z' }],
    [[''], undefined],
    [['   '], undefined],
    [['\ufeff'], undefined],
    [['\u0085'], { service: 'unknown', text: '\u0085', at: 'NOW' }],
    [['plain text'], { service: 'unknown', text: 'plain text', at: 'NOW' }],
    [['api-1 | notatimestamp x'], { service: 'unknown', text: 'api-1 | notatimestamp x', at: 'NOW' }],
    [['api-1  | 2026-09-10T11:48:35.123456789Z a\rb'], { service: 'unknown', text: 'api-1  | 2026-09-10T11:48:35.123456789Z a\rb', at: 'NOW' }],
    [['api-1  | 2026-09-10T11:48:35.123456789Z a\u2028b'], { service: 'unknown', text: 'api-1  | 2026-09-10T11:48:35.123456789Z a\u2028b', at: 'NOW' }],
    [['api-1  |  2026-09-10T11:48:35Z x'], { service: 'unknown', text: 'api-1  |  2026-09-10T11:48:35Z x', at: 'NOW' }],
    [['가-1  | 2026-09-10T11:48:35Z x'], { service: '가', text: 'x', at: '2026-09-10T11:48:35.000Z' }],
    [['a-1 |'], { service: 'unknown', text: 'a-1 |', at: 'NOW' }],
    [['a-1 | | x'], { service: 'unknown', text: 'a-1 | | x', at: 'NOW' }],
    [['a-1 \u0085x'], { service: 'a', text: '\u0085x', at: 'NOW' }],
    [['a-1\u0085x'], { service: 'unknown', text: 'a-1\u0085x', at: 'NOW' }],
    [['\u0085a-1 x'], { service: 'unknown', text: '\u0085a-1 x', at: 'NOW' }],
    [['x-1  | 2026-09-10T11:48:35.999999999+09:00 z'], { service: 'x', text: 'z', at: '2026-09-10T02:48:35.999Z' }],
    [['-1 | 2026-01-01T00:00:00Z'], { service: 'unknown', text: '-1 | 2026-01-01T00:00:00Z', at: 'NOW' }],
    [['a-1  | 2026-01-01T00:00:00Z.123456 x'], { service: 'a', text: 'x', at: 'Invalid Date' }],
    [['a-1  | 2026-99-99T99:99:99Z x'], { service: 'a', text: 'x', at: 'Invalid Date' }],
    [['\u009b1mapi-1 x'], { service: 'api', text: 'x', at: 'NOW' }],
    [['\u001b]8;;http://x\u0007api-1 y'], { service: 'api', text: 'y', at: 'NOW' }],
    [['a-1 x\u001b'], { service: 'a', text: 'x\u001b', at: 'NOW' }],
    [['a-1  | 2026-09-10T11:48:35Z x\r'], { service: 'unknown', text: 'a-1  | 2026-09-10T11:48:35Z x\r', at: 'NOW' }],
    [['a-1  | 2026-09-10T11:48:35Z\u2028x'], { service: 'a', text: 'x', at: '2026-09-10T11:48:35.000Z' }],
]);

// 시간 초과 문구: 파일이 보이지 않았는지, 그대로였는지, 바뀌는 중이었는지, 지워지지 않았는지
describe('SyncObservations', () => {
  it.each([
    { title: '보이지 않음·그대로·바뀌는 중·지워지지 않음을 가른다', records: [['a', 'MISSING'], ['a', undefined], ['b', 'h1'], ['c', 'h1'], ['c', 'h2'], ['d', 'h9']], pending: ['a', 'b', 'c', 'd', 'e'], expected: [['d', 'MISSING']], timeoutMs: 60000, want: '60초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a, b, c, d, e \u2014 a, e: 60초 내내 컨테이너에서 보이지 않았습니다. b: 60초 내내 이전 내용 그대로였습니다. d: 지운 파일이 60초 내내 컨테이너에 남아 있었습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요. c: 반영되는 중이었지만 시간 안에 끝나지 않았습니다(다시 시도하면 될 수 있습니다)' },
    { title: '기록이 없는 파일은 보이지 않은 것이다', records: [], pending: ['x', 'y'], expected: [], timeoutMs: 1500, want: '2초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: x, y \u2014 x, y: 2초 내내 컨테이너에서 보이지 않았습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '같은 값을 두 번 기록해도 하나다', records: [['a', 'h1'], ['a', 'h1'], ['b', 'MISSING'], ['b', 'MISSING']], pending: ['a', 'b'], expected: [['b', 'MISSING']], timeoutMs: 2500, want: '3초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a, b \u2014 a: 3초 내내 이전 내용 그대로였습니다. b: 지운 파일이 3초 내내 컨테이너에 남아 있었습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '해시가 바뀐 뒤 MISSING으로 돌아온 파일은 바뀌는 중이다', records: [['a', 'h1'], ['a', 'MISSING']], pending: ['a'], expected: [], timeoutMs: 500, want: '1초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: 반영되는 중이었지만 시간 안에 끝나지 않았습니다(다시 시도하면 될 수 있습니다)' },
    { title: '초는 Math.round(가운데는 위로)', records: [], pending: ['a'], expected: [], timeoutMs: 2500, want: '3초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: 3초 내내 컨테이너에서 보이지 않았습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '초는 음수에서도 위로', records: [], pending: ['a'], expected: [], timeoutMs: -1500, want: '-1초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: -1초 내내 컨테이너에서 보이지 않았습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '기다릴 파일이 없으면 뒤에 덧붙이지 않는다', records: [['a', 'h1']], pending: [], expected: [], timeoutMs: 1000, want: '1초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: ' },
    { title: '같은 파일이 두 번 pending이면 두 번 센다', records: [['a', 'h1']], pending: ['a', 'a'], expected: [], timeoutMs: 1000, want: '1초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a, a \u2014 a, a: 1초 내내 이전 내용 그대로였습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '시간 값이 NaN·무한대', records: [], pending: ['a'], expected: [], timeoutMs: NaN, want: 'NaN초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: NaN초 내내 컨테이너에서 보이지 않았습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '시간 값이 아주 크다', records: [], pending: ['a'], expected: [], timeoutMs: 1e+25, want: '1e+22초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: 1e+22초 내내 컨테이너에서 보이지 않았습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '기대값이 해시인 파일은 지운 파일이 아니다', records: [['a', 'h1']], pending: ['a'], expected: [['a', 'h2']], timeoutMs: 1000, want: '1초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a \u2014 a: 1초 내내 이전 내용 그대로였습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
    { title: '값이 UNSEEN과 MISSING뿐이면 둘 다 보이지 않은 것이다', records: [['a', 'UNSEEN'], ['a', 'MISSING'], ['b', 'UNSEEN']], pending: ['a', 'b'], expected: [['b', 'MISSING']], timeoutMs: 3000, want: '3초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a, b \u2014 a: 3초 내내 컨테이너에서 보이지 않았습니다. b: 지운 파일이 3초 내내 컨테이너에 남아 있었습니다. 한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요' },
  ] as Array<{ title: string; records: Array<[string, string | undefined]>; pending: string[]; expected: Array<[string, string]>; timeoutMs: number; want: string }>)('$title', ({ records, pending, expected, timeoutMs, want }) => {
    const observations = new SyncObservations();
    for (const [file, value] of records) observations.record(file, value);
    expect(observations.describeTimeout(pending, new Map(expected), timeoutMs)).toBe(want);
  });
});

describe('오류 문구', () => {
  it('호스트 포트를 못 찾으면 출력을 JSON.stringify한 문구로 던진다', () => {
    expect(() => parseHostPort('a\u0000b"\\\n\u2028')).toThrow('공개된 호스트 포트를 찾을 수 없습니다: "a\\u0000b\\"\\\\\\n\u2028"');
  });
});

describe('경로·상태 의존', () => {
  it('상대 경로는 프로세스의 현재 폴더 기준이다', () => {
    expect(matchesProjectRoot('rel/x', `${process.cwd()}/rel`)).toBe(true);
    expect(matchesProjectRoot('rel/x', `${process.cwd()}/other`)).toBe(false);
  });

  it('edge 서비스 이름은 플랫폼이고 managed에 든 것은 managed, 그 밖은 supporting이다', () => {
    const rows = [
      { name: 'e', service: EDGE_SERVICE, state: 'exited', exitCode: 0, oomKilled: false },
      { name: 'm', service: 'managed-one', state: 'exited', exitCode: 0, oomKilled: false },
      { name: 's', service: 'other', state: 'exited', exitCode: 0, oomKilled: false },
    ] as never;
    const roles = Object.fromEntries(mergeUsage(rows, [], new Set(['managed-one', EDGE_SERVICE])).map((usage) => [usage.service, usage.role]));
    expect(roles).toEqual({ [EDGE_SERVICE]: 'platform', 'managed-one': 'managed', other: 'supporting' });
  });
});

describe('의도한 차이', () => {
  const nulKey = '{"Name":"a","\\u0000k":1}';

  it('키가 NUL로 시작하는 JSON은 읽지 않는다(옛 TS는 읽었다 — 경계의 표시 객체와 겹치지 않게 막은 것)', () => {
    expect(() => parseStatsOutput(nulKey)).toThrow();
    expect(() => parseInspectOutput('[' + nulKey + ']')).toThrow();
    expect(() => parseHostContainers('[' + nulKey + ']')).toThrow();
    expect(parseEgressDenial('{"edge":"egress","decision":"deny","host":"x","at":"y","\\u0000k":1}')).toBeUndefined();
    expect(egressAuditExcerpt(['{"edge":"egress","decision":"deny","host":"x","\\u0000k":1}'])).toEqual([]);
    expect(parseRuntimes('{"\\u0000k":{}}')).toEqual([]);
    expect(() => parseContainerStates('{"Service":"a","State":"running","\\u0000k":1}')).toThrow();
  });

  it('중첩이 2000단계를 넘는 JSON은 읽지 않는다(옛 TS는 훨씬 깊어도 읽었다)', () => {
    const deep = '['.repeat(2100) + ']'.repeat(2100);
    expect(() => parseInspectOutput(deep)).toThrow();
    expect(parseRuntimes(deep)).toEqual([]);
    const ok = '['.repeat(1500) + ']'.repeat(1500);
    expect(parseInspectOutput(ok).length).toBe(1);
  });

  it('짝 없는 서로게이트 이스케이프는 U+FFFD로 읽는다(옛 TS는 짝 없는 글자를 그대로 두었다)', () => {
    expect(parseStatsOutput('{"Name":"\\ud800x"}')[0]!.name).toBe('\ufffdx');
    expect(parseStatsOutput('{"Name":"\\ud83d\\ude00"}')[0]!.name).toBe('😀');
  });

  it('값이 undefined인 속성은 없는 속성으로 돌아온다(JSON을 건너는 표현의 차이)', () => {
    expect(Object.keys(parseStatsOutput('{"Name":"a"}')[0]!)).toEqual(['name', 'cpuPercent']);
  });

  it('JSON 오류는 SyntaxError가 아니라 그냥 Error로 던진다(메시지도 다르다)', () => {
    let thrown: unknown;
    try {
      parseStatsOutput('{"Name":');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
  });
});

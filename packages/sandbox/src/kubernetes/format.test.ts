import { describe, expect, it } from 'vitest';
import { isPortForwardBroken, parseKubectlLogLine, parseKubectlVersions, parsePortForwardLine, podReady, podState, podUsage, quantityBytes, quantityCpu } from './format';

describe('kubectl 출력 해석', () => {
  it('접두어가 붙은 로그와 한 Pod의 로그를 읽는다 (실측 형식)', () => {
    expect(parseKubectlLogLine('[pod/web/web] 2026-09-11T04:35:45.419151529Z started-web-gvisor')).toEqual({
      service: 'web',
      text: 'started-web-gvisor',
      at: new Date('2026-09-11T04:35:45.419Z'),
    });
    expect(parseKubectlLogLine('2026-09-11T04:35:45.419151529Z {"edge":"started"}', 'b-studio-edge')).toMatchObject({ service: 'b-studio-edge', text: '{"edge":"started"}' });
    expect(parseKubectlLogLine('   ')).toBeUndefined();
    expect(parseKubectlLogLine('unexpected output')).toMatchObject({ service: 'unknown', text: 'unexpected output' });
  });

  it('kubectl 클라이언트와 클러스터의 minor 버전 차이를 읽는다', () => {
    const json = JSON.stringify({
      clientVersion: { major: '1', minor: '30', gitVersion: 'v1.30.5' },
      kustomizeVersion: 'v5.0.4',
      serverVersion: { major: '1', minor: '36', gitVersion: 'v1.36.1' },
    });
    expect(parseKubectlVersions(json)).toEqual({ client: 'v1.30.5', server: 'v1.36.1', minorSkew: 6 });
    expect(parseKubectlVersions('{"clientVersion":{"minor":"36+"},"serverVersion":{"minor":"35"}}')).toMatchObject({ minorSkew: 1 });
    expect(parseKubectlVersions('{"clientVersion":{"minor":"36"}}')).not.toHaveProperty('minorSkew');
    expect(parseKubectlVersions('not json')).toEqual({});
  });

  it('port-forward가 망가졌다는 에러 줄을 알아본다 (실측 문구)', () => {
    expect(isPortForwardBroken('E0911 14:42:46.175637   58370 portforward.go:351] error creating error stream for port 50878 -> 20000: Timeout occurred')).toBe(true);
    expect(isPortForwardBroken('E0911 13:30:58.085635   73931 portforward.go:413] an error occurred forwarding 18090 -> 8080: error forwarding port 8080 to pod ...')).toBe(true);
    expect(isPortForwardBroken('error: lost connection to pod')).toBe(true);
    expect(isPortForwardBroken('Handling connection for 50878')).toBe(false);
    expect(isPortForwardBroken('Forwarding from 127.0.0.1:50878 -> 20000')).toBe(false);
  });

  it('port-forward가 연 로컬 포트를 읽는다', () => {
    expect(parsePortForwardLine('Forwarding from 127.0.0.1:54321 -> 20000')).toEqual({ local: 54321, remote: 20000 });
    expect(parsePortForwardLine('Forwarding from [::1]:54321 -> 20000')).toBeUndefined();
    expect(parsePortForwardLine('Handling connection for 54321')).toBeUndefined();
  });
});

describe('Pod 상태와 사용량', () => {
  const running = { metadata: { name: 'api', labels: { 'b-studio.service': 'api' } }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount: 0, state: { running: {} } }] } };

  it('컨테이너 상태를 샌드박스 상태로 옮긴다', () => {
    expect(podState(running)).toBe('running');
    expect(podReady(running)).toBe(true);
    expect(podState({ status: { phase: 'Pending' } })).toBe('created');
    expect(podState({ status: { containerStatuses: [{ restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })).toBe('restarting');
    expect(podState({ status: { containerStatuses: [{ state: { terminated: { exitCode: 1 } } }] } })).toBe('exited');
    expect(podState({ metadata: { deletionTimestamp: '2026-09-11T00:00:00Z' }, status: running.status })).toBe('removing');
    expect(podState(undefined)).toBe('unknown');
  });

  it('한도를 바이트와 CPU 개수로 읽고, 직전 종료가 메모리 부족이었는지 알아본다', () => {
    const restarted = {
      metadata: { name: 'api', labels: { 'b-studio.service': 'api' } },
      spec: { containers: [{ resources: { limits: { memory: '1536Mi', cpu: '500m' } } }] },
      status: { containerStatuses: [{ restartCount: 1, state: { running: {} }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] },
    };
    expect(podUsage(restarted)).toEqual({ service: 'api', state: 'running', memoryLimitBytes: 1536 * 2 ** 20, cpuLimit: 0.5, exitCode: 137, oomKilled: true });
    expect(podUsage(running)).toEqual({ service: 'api', state: 'running', oomKilled: false });
  });

  it('Kubernetes 수량 표기를 읽는다', () => {
    expect(quantityBytes('1.5Gi')).toBe(1.5 * 2 ** 30);
    expect(quantityBytes('512M')).toBe(512e6);
    expect(quantityBytes('1048576')).toBe(1048576);
    expect(quantityBytes('lots')).toBeUndefined();
    expect(quantityCpu('2')).toBe(2);
    expect(quantityCpu('250m')).toBe(0.25);
  });
});

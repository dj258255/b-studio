import { describe, expect, it, vi } from 'vitest';
import {
  classifyActuatorProbe,
  isForwarderProcess,
  matchDeclaredPorts,
  parseLsofListening,
  parsePsRow,
  parseSsListening,
  probeActuator,
} from './host-processes';

const LSOF_OUTPUT = [
  'COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'java       1234 beomsu   50u  IPv6 0x1234567890abcdef      0t0  TCP *:8080 (LISTEN)',
  'node       5678 beomsu   22u  IPv4 0xabcdef1234567890      0t0  TCP 127.0.0.1:3000 (LISTEN)',
  'com.docker  999 beomsu   10u  IPv4 0x0000000000000000      0t0  TCP *:5432 (LISTEN)',
  '',
].join('\n');

const SS_OUTPUT = [
  'State    Recv-Q   Send-Q     Local Address:Port      Peer Address:Port   Process',
  'LISTEN   0        128              0.0.0.0:8080            0.0.0.0:*       users:(("java",pid=1234,fd=50))',
  'LISTEN   0        128                 [::]:3000               [::]:*       users:(("node",pid=5678,fd=22))',
  '',
].join('\n');

describe('parseLsofListening', () => {
  it('헤더를 건너뛰고 COMMAND·PID·포트를 읽는다', () => {
    expect(parseLsofListening(LSOF_OUTPUT)).toEqual([
      { pid: 1234, command: 'java', port: 8080 },
      { pid: 5678, command: 'node', port: 3000 },
      { pid: 999, command: 'com.docker', port: 5432 },
    ]);
  });

  it('빈 출력은 빈 배열', () => {
    expect(parseLsofListening('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n')).toEqual([]);
  });
});

describe('parseSsListening', () => {
  it('Local Address:Port와 Process의 pid·커맨드를 읽는다', () => {
    expect(parseSsListening(SS_OUTPUT)).toEqual([
      { pid: 1234, command: 'java', port: 8080 },
      { pid: 5678, command: 'node', port: 3000 },
    ]);
  });
});

describe('isForwarderProcess', () => {
  it.each(['com.docker.backend', 'lima', 'ssh', 'vpnkit'])('%s는 포워더', (command) => {
    expect(isForwarderProcess(command)).toBe(true);
  });
  it.each(['java', 'node', 'python'])('%s는 포워더가 아니다', (command) => {
    expect(isForwarderProcess(command)).toBe(false);
  });
});

describe('matchDeclaredPorts', () => {
  const LISTENING = [
    { pid: 1234, command: 'java', port: 8080 },
    { pid: 5678, command: 'node', port: 3000 },
    { pid: 999, command: 'com.docker.backend', port: 5432 },
  ];

  it('선언된 포트만, 포워더는 제외하고 남긴다', () => {
    expect(matchDeclaredPorts(LISTENING, [8080, 3000, 5432])).toEqual([
      { pid: 1234, command: 'java', port: 8080 },
      { pid: 5678, command: 'node', port: 3000 },
    ]);
  });

  it('선언되지 않은 포트(흔한 개발 포트 포함)는 넘겨짚지 않는다', () => {
    expect(matchDeclaredPorts(LISTENING, [9999])).toEqual([]);
  });

  it('스튜디오 서버 자신의 PID는 선언 포트를 듣고 있어도 뺀다', () => {
    expect(matchDeclaredPorts(LISTENING, [8080, 3000], [5678])).toEqual([{ pid: 1234, command: 'java', port: 8080 }]);
  });

  it('같은 포트가 중복이면 먼저 나온 것만 남긴다', () => {
    const dup = [LISTENING[0]!, { pid: 4321, command: 'java2', port: 8080 }];
    expect(matchDeclaredPorts(dup, [8080])).toEqual([LISTENING[0]]);
  });
});

describe('parsePsRow', () => {
  it('pid·cpu·rss·명령줄을 읽는다(명령줄에 공백이 있어도 통째로)', () => {
    expect(parsePsRow('  1234  2.3 123456 java -jar app.jar --server.port=8080\n')).toEqual({
      pid: 1234,
      cpuPercent: 2.3,
      rssKb: 123456,
      command: 'java -jar app.jar --server.port=8080',
    });
  });

  it('형식이 아니면 undefined', () => {
    expect(parsePsRow('')).toBeUndefined();
    expect(parsePsRow('not a ps row')).toBeUndefined();
  });
});

describe('classifyActuatorProbe', () => {
  it('health가 응답 안 하면 연결 안 됨 + 안내', () => {
    const result = classifyActuatorProbe(false, undefined);
    expect(result.connected).toBe(false);
    expect(result.logfileAvailable).toBe(false);
    expect(result.guidance).toMatch(/health/);
  });

  it('health는 되고 logfile이 200이면 로그 사용 가능', () => {
    expect(classifyActuatorProbe(true, 200)).toEqual({ connected: true, logfileAvailable: true });
  });

  it('health는 되고 logfile이 206(Range 응답)이어도 사용 가능', () => {
    expect(classifyActuatorProbe(true, 206).logfileAvailable).toBe(true);
  });

  it('health는 되지만 logfile이 없으면 설정 안내', () => {
    const result = classifyActuatorProbe(true, 404);
    expect(result.connected).toBe(true);
    expect(result.logfileAvailable).toBe(false);
    expect(result.guidance).toMatch(/logging\.file\.name/);
  });
});

describe('probeActuator', () => {
  it('health 200 + logfile 200이면 로그 일부를 돌려준다', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/actuator/health')) return new Response('{}', { status: 200 });
      return new Response('log line 1\nlog line 2', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeActuator(8080, { fetchImpl });
    expect(result.connected).toBe(true);
    expect(result.logfileAvailable).toBe(true);
    expect(result.logExcerpt).toContain('log line');
  });

  it('health가 실패하면(네트워크 오류) 연결 안 됨으로 본다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeActuator(9999, { fetchImpl });
    expect(result.connected).toBe(false);
  });

  it('127.0.0.1의 포트로만 요청한다', async () => {
    const fetchImpl = vi.fn<(input: string) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
    await probeActuator(8080, { fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).toMatch(/^http:\/\/127\.0\.0\.1:8080\//);
    }
  });
});

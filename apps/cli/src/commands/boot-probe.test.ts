import type { BootNetwork } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { bootProbeJson, describeBootProbe } from './boot-probe';

const network: BootNetwork = [
  { service: 'api', rxBytes: 1_200_000_000, txBytes: 3_400 },
  { service: 'db', rxBytes: 0, txBytes: 0 },
];

describe('boot-probe 출력', () => {
  it('기동 시간과 서비스별 받은 바이트를 한 줄로 낸다', () => {
    expect(describeBootProbe(182_400, network)).toBe('기동 182.4초 · 받음 api 1.12GiB, db 0KiB');
  });

  it('재지 못해 값이 없으면 받음은 없음으로 적는다', () => {
    expect(describeBootProbe(1_000, [])).toBe('기동 1.0초 · 받음 없음');
  });

  it('--json은 ms와 바이트를 가공 없이 담은 한 줄이다', () => {
    const line = bootProbeJson(182_400, network);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ bootMs: 182_400, network });
  });
});

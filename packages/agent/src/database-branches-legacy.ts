import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

/**
 * 옮기기 전(ADR-191 3단계 3af 이전)의 database-branches.ts 판정 원본. 차등 시험·벡터의 기준으로만 쓴다(운영 코드는 부르지 않는다).
 * 함수 본문은 원본 그대로이고, 시험이 줄 목록을 볼 수 있게 `legacyKeptLines`·스트림 입력만 더했다.
 */
const RESTRICT_LINE = /^\\(un)?restrict\s/;

export async function legacyNormalizedDumpHashFromStream(input: Readable): Promise<string> {
  const hash = createHash('sha256');
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (RESTRICT_LINE.test(line)) continue;
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function legacyNormalizedDumpHash(file: string): Promise<string> {
  return legacyNormalizedDumpHashFromStream(createReadStream(file));
}

/** 옛 판정이 남긴 줄 목록(해시에 넣던 줄) */
export async function legacyKeptLines(input: Readable): Promise<string[]> {
  const kept: string[] = [];
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (RESTRICT_LINE.test(line)) continue;
    kept.push(line);
  }
  return kept;
}

export function legacyRestoreDatabaseName(name: string): string {
  const suffix = '__b_studio_restore';
  return `${name.slice(0, 63 - suffix.length)}${suffix}`;
}

/** `<체크포인트>.<이유>.<pid>.<시각>.tmp` */
export function legacyTempPid(name: string): number | undefined {
  const pid = Number(name.split('.').at(-3));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** 옛 sweepStaleTemp가 지울 이름을 고르던 식. `running`은 isRunning의 대역 */
export function legacySweepVictims(names: readonly string[], running: (pid: number | undefined) => boolean): string[] {
  return names.filter((name) => name.endsWith('.tmp') && !running(legacyTempPid(name)));
}

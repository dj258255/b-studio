import { formatBytes, type BootNetwork } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { runSandboxSession } from '../session';

/**
 * 기동 시간과 서비스별 받은 바이트를 사람이 읽는 한 줄로. 예: `기동 182.4초 · 받음 api 1.12GiB, db 0KiB`
 * 단위는 다른 화면(리소스 탭·기동 줄)과 맞춰 2진 접두어(MiB·GiB)를 쓴다
 */
export function describeBootProbe(bootMs: number, network: BootNetwork): string {
  const received = network.length > 0 ? network.map((entry) => `${entry.service} ${formatBytes(entry.rxBytes)}`).join(', ') : '없음';
  return `기동 ${(bootMs / 1_000).toFixed(1)}초 · 받음 ${received}`;
}

/** `--json` 한 줄. 프로그램이 읽도록 ms와 바이트를 가공 없이 담는다 */
export function bootProbeJson(bootMs: number, network: BootNetwork): string {
  return JSON.stringify({ bootMs, network });
}

/**
 * 샌드박스를 띄워 준비될 때까지 기다린 뒤 기동 시간과 서비스별 수신·송신 바이트를 재고 곧바로 내린다.
 * 캐시 없음/있음 기동을 비교하는 `studio boot-probe`의 본문이다(keep 없음). 준비에 실패하면 종료 코드 1과 이유를 낸다.
 */
export function bootProbe(project: LoadedProject, { json }: { json: boolean }): Promise<number> {
  return runSandboxSession(project, { keep: false, followLogs: false, quiet: true }, async ({ bootMs, bootNetwork }) => {
    // --json이면 stdout에 한 줄만 쓴다(진행 안내는 quiet로 막았다)
    console.log(json ? bootProbeJson(bootMs, bootNetwork) : describeBootProbe(bootMs, bootNetwork));
    return 0;
  });
}

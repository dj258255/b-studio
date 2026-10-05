/**
 * 동시 실행(--concurrency N) 전 메모리 확인.
 *
 * 샌드박스 한 벌(api·web·db·edge)의 메모리 한도를 N배로 잡고, Docker VM 전체 메모리에서
 * 이미 도는 컨테이너가 쓰는 만큼을 뺀 남은 양과 비교한다. 계산만 순수 함수로 두고(테스트는 가짜
 * docker 출력으로), 실제 docker 명령 실행은 run.ts에서 한다.
 *
 * 단순화: 한 실행 안에서 레인·통합 세션이 여럿 동시에 뜨는 전략(S1 이상)은 실제로는 "한 실행 슬롯"이
 * 샌드박스를 하나 이상 띄울 수 있지만, 여기서는 지시받은 대로 "동시 실행 하나 = 샌드박스 한 벌"로 어림잡는다.
 * 여유(margin)를 넉넉히 두는 이유이기도 하다.
 */

/** packages/sandbox/src/docker/format.ts가 edge 컨테이너에 거는 기본 메모리 한도(deploy.resources.limits.memory: '128m') */
export const EDGE_MEMORY_MB = 128;
/** Docker 데몬·호스트 OS가 쓰는 여유분. 넉넉히 2G */
export const MEMORY_GUARD_MARGIN_MB = 2048;

/** examples/orders/studio.yaml의 resources 절과 같은 모양(서비스 이름 → 메모리 표기) */
export type ComposeResources = Record<string, { memory?: string }>;

/** studio.yaml의 메모리 표기(`\d+(\.\d+)?[kmg]`, 스키마의 ResourceLimitSchema와 같다)를 MB로 바꾼다 */
export function parseComposeMemoryMb(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([kmg])$/i.exec(value.trim());
  if (!match) throw new Error(`메모리 표기를 알 수 없습니다: ${value} (숫자 뒤에 k, m, g만 씁니다)`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === 'k') return amount / 1024;
  if (unit === 'g') return amount * 1024;
  return amount;
}

/** 동시 실행 하나(샌드박스 한 벌)가 쓰는 메모리(MB). studio.yaml의 resources 합 + edge 오버헤드 */
export function perRunMemoryMb(resources: ComposeResources): number {
  const services = Object.values(resources).reduce((sum, limit) => sum + (limit.memory ? parseComposeMemoryMb(limit.memory) : 0), 0);
  return services + EDGE_MEMORY_MB;
}

/** `docker info --format '{{.MemTotal}}'`의 출력(바이트 문자열)을 MB로 바꾼다 */
export function parseDockerMemTotalMb(raw: string): number {
  const bytes = Number(raw.trim());
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`Docker 전체 메모리를 읽지 못했습니다: ${JSON.stringify(raw)}`);
  return bytes / (1024 * 1024);
}

/** `docker stats --no-stream --format '{{.MemUsage}}'`의 한 줄, 예: "123.4MiB / 1.944GiB". 앞부분(쓴 양)만 MB로 바꾼다 */
export function parseDockerStatsMemUsage(line: string): number {
  const used = line.split('/')[0]?.trim();
  if (!used) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(ki?b|mi?b|gi?b|b)$/i.exec(used);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const mbPerUnit: Record<string, number> = { b: 1 / (1024 * 1024), kb: 1 / 1024, kib: 1 / 1024, mb: 1, mib: 1, gb: 1024, gib: 1024 };
  return amount * (mbPerUnit[unit] ?? 0);
}

/** `docker stats --no-stream --format '{{.MemUsage}}'`의 여러 줄(컨테이너마다 한 줄) 합계를 MB로 돌려준다 */
export function sumDockerStatsMb(output: string): number {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((sum, line) => sum + parseDockerStatsMemUsage(line), 0);
}

export interface MemoryGuardInput {
  /** --concurrency N */
  concurrency: number;
  /** 동시 실행 하나가 쓰는 메모리(MB) */
  perRunMb: number;
  /** Docker VM 전체 메모리(MB) */
  totalMb: number;
  /** 이미 도는 컨테이너가 쓰는 메모리 합(MB) */
  usedMb: number;
  /** 여유분(MB). 기본 MEMORY_GUARD_MARGIN_MB */
  marginMb?: number;
}

export interface MemoryGuardResult {
  ok: boolean;
  neededMb: number;
  availableMb: number;
  marginMb: number;
  /** 지금 남은 메모리로 여유를 지키며 돌릴 수 있는 최대 N(1 미만이면 1로 내림) */
  suggestedConcurrency: number;
}

export function evaluateMemoryGuard(input: MemoryGuardInput): MemoryGuardResult {
  const marginMb = input.marginMb ?? MEMORY_GUARD_MARGIN_MB;
  const neededMb = input.concurrency * input.perRunMb;
  const availableMb = input.totalMb - input.usedMb;
  const suggestedConcurrency = input.perRunMb > 0 ? Math.max(1, Math.floor((availableMb - marginMb) / input.perRunMb)) : input.concurrency;
  return { ok: neededMb + marginMb <= availableMb, neededMb, availableMb, marginMb, suggestedConcurrency };
}

/** 메모리가 부족할 때 보여 줄 한국어 안내. --force로 건너뛸 수 있음을 함께 알린다 */
export function memoryGuardMessage(result: MemoryGuardResult, concurrency: number): string {
  const need = Math.round(result.neededMb);
  const avail = Math.round(Math.max(0, result.availableMb));
  const lines = [
    `동시 실행(--concurrency ${concurrency})에 메모리가 모자랍니다: 필요 약 ${need}MB(여유 ${result.marginMb}MB 포함), 남은 메모리 약 ${avail}MB.`,
    result.suggestedConcurrency < concurrency
      ? `--concurrency ${result.suggestedConcurrency} 이하로 낮추거나, Docker VM 메모리를 늘리세요(예: colima stop && colima start --cpu 8 --memory 16).`
      : `Docker VM 메모리를 늘리세요(예: colima stop && colima start --cpu 8 --memory 16).`,
    '정말 진행하려면 --force를 주세요.',
  ];
  return lines.join('\n');
}

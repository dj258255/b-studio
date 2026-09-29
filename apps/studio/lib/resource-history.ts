import type { ServiceRole, ServiceUsage } from '@b-studio/sandbox';

/** 화면에 보여줄 갈래 이름과 보여줄 순서 */
export const ROLE_LABEL: Record<ServiceRole, string> = {
  managed: '서비스',
  supporting: '부가 서비스',
  platform: '플랫폼',
};

const ROLE_ORDER: readonly ServiceRole[] = ['managed', 'supporting', 'platform'];

export interface ResourceGroup {
  role: ServiceRole;
  label: string;
  services: ServiceUsage[];
}

/**
 * 컨테이너를 갈래(서비스/부가 서비스/플랫폼)로 묶는다. role이 없는 컨테이너는(옛 제공자, 고정 픽스처)
 * 부가 서비스로 둔다. 컨테이너가 하나도 없는 갈래는 화면에서 아예 뺀다
 */
export function groupByRole(services: readonly ServiceUsage[]): ResourceGroup[] {
  const buckets = new Map<ServiceRole, ServiceUsage[]>();
  for (const service of services) {
    const role = service.role ?? 'supporting';
    const bucket = buckets.get(role);
    if (bucket) bucket.push(service);
    else buckets.set(role, [service]);
  }
  return ROLE_ORDER.flatMap((role) => {
    const bucket = buckets.get(role);
    return bucket && bucket.length > 0 ? [{ role, label: ROLE_LABEL[role], services: bucket }] : [];
  });
}

/** 한 번 잰 값 하나. sparkline은 이 값들을 시간 순서로 잇는다 */
export interface ResourceSample {
  at: number;
  cpuPercent?: number;
  memoryBytes?: number;
}

/** 컨테이너(서비스 이름)별 최근 샘플. 새로고침하면 비워지는, 화면에서만 쌓는 기록이다 */
export type ResourceHistory = Record<string, ResourceSample[]>;

export const DEFAULT_HISTORY_SIZE = 30;

/**
 * 방금 잰 사용량을 이력에 이어붙인다.
 *  - 지금 없는 컨테이너(완전히 사라짐)의 이력은 버린다
 *  - maxSamples를 넘는 오래된 샘플은 버린다
 *  - 매번 새 객체를 돌려주므로 React state로 바로 쓸 수 있다
 */
export function appendUsageSample(
  history: ResourceHistory,
  services: readonly Pick<ServiceUsage, 'service' | 'cpuPercent' | 'memoryBytes'>[],
  at: number,
  maxSamples = DEFAULT_HISTORY_SIZE,
): ResourceHistory {
  const next: ResourceHistory = {};
  for (const entry of services) {
    const appended = [...(history[entry.service] ?? []), { at, cpuPercent: entry.cpuPercent, memoryBytes: entry.memoryBytes }];
    next[entry.service] = appended.length > maxSamples ? appended.slice(appended.length - maxSamples) : appended;
  }
  return next;
}

export interface SparklineOptions {
  width?: number;
  height?: number;
  /** 위아래 여백(px). 값이 다 같아도 선이 테두리에 붙지 않게 한다 */
  padding?: number;
}

/**
 * 값을 이은 SVG path(d 속성)를 만든다. undefined인 자리는 비워 두고 선을 끊는다(못 잰 구간을 이어붙여 속이지 않는다).
 * 값이 다 없으면 빈 문자열을 돌려준다(그리지 않는다). 값이 하나뿐이거나 다 같으면 평평한 선/점이 된다
 */
export function sparklinePath(values: readonly (number | undefined)[], { width = 64, height = 20, padding = 2 }: SparklineOptions = {}): string {
  const defined = values.flatMap((value, index) => (value === undefined || Number.isNaN(value) ? [] : [{ index, value }]));
  if (defined.length === 0) return '';

  const max = Math.max(...defined.map((point) => point.value));
  const min = Math.min(...defined.map((point) => point.value));
  const span = max - min || 1;
  const usableHeight = height - padding * 2;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const toXY = ({ index, value }: { index: number; value: number }) => {
    const x = stepX * index;
    const y = padding + usableHeight - ((value - min) / span) * usableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  // 이어진 구간마다 따로 M...L...를 만들어, undefined가 낀 자리에서 선이 끊어지게 한다
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  for (const point of defined) {
    if (current.length > 0 && point.index !== current[current.length - 1]!.index + 1) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);

  // 점 하나뿐인 구간은 M만으로는 안 그려지므로 같은 점으로 L을 더해 보이는 점으로 만든다(선 끝을 둥글게 해서 쓴다)
  return segments
    .map((segment) => (segment.length === 1 ? `M${toXY(segment[0]!)} L${toXY(segment[0]!)}` : `M${segment.map(toXY).join(' L')}`))
    .join(' ');
}

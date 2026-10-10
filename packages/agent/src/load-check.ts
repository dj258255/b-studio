import type { LoadExpect, WorkflowLoadCheck } from '@b-studio/spec';
import type { LoadRequest, LoadResult } from '@b-studio/sandbox';

/** 부하 확인 한 번의 판정. note는 통과·실패와 상관없이 남기는 요약, problems가 비어야 통과다 */
export interface LoadJudgement {
  note: string;
  problems: string[];
  /** 통과했을 때 사람에게 보여 줄 근거. 판정에 쓴 값만 적는다 */
  evidence: string[];
}

const LATENCY_KEYS = [
  ['p50Ms', 'p50'],
  ['p95Ms', 'p95'],
  ['p99Ms', 'p99'],
  ['maxMs', 'max'],
] as const;

/** studio.yaml의 선언을 러너에 넘길 요청으로 바꾼다. requests를 생략하면 연결마다 한 건이다 */
export function loadRequestFor(check: WorkflowLoadCheck): LoadRequest {
  return {
    service: check.service,
    method: check.method,
    path: check.path,
    ...(check.headers ? { headers: check.headers } : {}),
    ...(check.body !== undefined ? { body: check.body } : {}),
    concurrent: check.concurrent,
    requests: check.requests ?? check.concurrent,
    warmup: check.warmup,
    ...(check.expect.latencyOf ? { latencyOf: check.expect.latencyOf } : {}),
  };
}

const ms = (value: number): string => `${value}ms`;
const tally = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, amount]) => `${key}:${amount}`)
    .join(', ');
const total = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, amount) => sum + amount, 0);

/** 응답 시간 기준을 사람이 읽는 한 줄로. 예: "p95 200ms 이하, 409 응답만" */
export function describeLoadExpect(expect: LoadExpect): string {
  const limits = LATENCY_KEYS.flatMap(([key, label]) => (expect[key] !== undefined ? [`${label} ${ms(expect[key])} 이하`] : []));
  return [...limits, ...(expect.latencyOf ? [`${expect.latencyOf.join('·')} 응답만`] : [])].join(', ');
}

/**
 * 러너가 잰 값으로 통과 여부를 정한다. 원인을 추정하지 않고 숫자만 남긴다.
 * 응답을 받지 못한 요청이 하나라도 있으면 실패다 — 느리거나 끊긴 요청이 표본에서 빠진 채 응답 시간만 보고 통과하지 않게 한다.
 * 응답 시간을 잴 응답이 없어도 실패다(기준을 확인하지 못한 것을 통과로 세지 않는다).
 * 서버 오류(5xx)도 allStatusIn에 적지 않았으면 실패다
 */
export function judgeLoad(check: WorkflowLoadCheck, result: LoadResult): LoadJudgement {
  const { expect } = check;
  const { latency } = result;
  const scope = expect.latencyOf ? `${expect.latencyOf.join('·')} 응답 ` : '';
  const sample = expect.latencyOf ? `${expect.latencyOf.join('·')} 응답` : '응답';
  const failed = total(result.errors);
  const statusDetail = tally(result.statuses) || '없음';
  const seconds = result.elapsedMs / 1000;
  const rate = seconds > 0 ? Math.round(result.completed / seconds) : 0;
  // 1초가 안 되는 측정을 "0.0초"로 적지 않는다
  const took = seconds >= 1 ? `${seconds.toFixed(1)}초` : `${Math.round(result.elapsedMs)}ms`;

  const latencyLine =
    latency.count > 0
      ? `응답 시간(${scope}${latency.count}건) p50 ${ms(latency.p50!)} · p95 ${ms(latency.p95!)} · p99 ${ms(latency.p99!)} · 최대 ${ms(latency.max!)}`
      : `응답 시간을 잴 ${sample} 없음`;
  const parts = [
    `동시 ${result.concurrent} · ${result.requests}건 중 응답 ${result.completed}건 (${took}, 초당 ${rate}건)`,
    `상태 ${statusDetail}`,
    latencyLine,
    `연결 p95 ${result.connect.p95 !== undefined ? ms(result.connect.p95) : '-'} · 러너 밀림 p99 ${ms(result.loopDelay.p99)}`,
  ];
  if (result.warmup.requests > 0) parts.push(`준비 요청 ${result.warmup.requests}건${result.warmup.errors > 0 ? ` (실패 ${result.warmup.errors}건)` : ''}`);

  const problems: string[] = [];
  if (failed > 0) problems.push(`응답을 받지 못한 요청 ${failed}건 (${tally(result.errors)})`);

  const successCount = Object.entries(result.statuses).reduce((sum, [status, amount]) => (status.startsWith('2') ? sum + amount : sum), 0);
  if (expect.successCount?.exactly !== undefined && successCount !== expect.successCount.exactly) {
    problems.push(`성공 ${successCount}/${result.requests} (기대: 정확히 ${expect.successCount.exactly})`);
  }
  if (expect.successCount?.atMost !== undefined && successCount > expect.successCount.atMost) {
    problems.push(`성공 ${successCount}/${result.requests} (기대: 최대 ${expect.successCount.atMost})`);
  }
  if (expect.allStatusIn) {
    const allowed = new Set(expect.allStatusIn.map(String));
    const outside = Object.keys(result.statuses).filter((status) => !allowed.has(status));
    if (outside.length > 0) problems.push(`기대 밖 상태 코드: ${outside.sort().join(', ')} (기대: ${expect.allStatusIn.join(', ')})`);
  } else {
    // 상태 코드 기대를 적지 않았어도 서버 오류는 통과로 세지 않는다. 빨리 실패하는 서비스가 응답 시간 기준을 통과하는 일을 막는다
    const serverErrors = Object.fromEntries(Object.entries(result.statuses).filter(([status]) => status.startsWith('5')));
    if (total(serverErrors) > 0) problems.push(`서버 오류 응답 ${total(serverErrors)}건 (${tally(serverErrors)}). 의도한 응답이면 expect.allStatusIn에 적으세요`);
  }

  const exceeded: number[] = [];
  if (latency.count === 0) {
    problems.push(`응답 시간을 잴 ${sample}이 없습니다 (기준: ${describeLoadExpect(expect)})`);
  } else {
    for (const [key, label] of LATENCY_KEYS) {
      const limit = expect[key];
      const actual = latency[label];
      if (limit === undefined || actual === undefined) continue;
      if (actual > limit) {
        problems.push(`${scope}${label} ${ms(actual)} (기준: ${ms(limit)} 이하)`);
        exceeded.push(limit);
      }
    }
  }
  // 러너는 응답을 늦게 받아 적을 수는 있어도 일찍 적지는 못한다. 그래서 통과에는 영향이 없고, 기준을 넘겼을 때만 러너의 밀림이 섞였을 수 있다고 알린다
  if (exceeded.length > 0 && result.loopDelay.p99 >= Math.max(5, Math.min(...exceeded) * 0.1)) {
    problems.push(`러너 자신이 p99 ${ms(result.loopDelay.p99)} 밀렸습니다. 이 값이 응답 시간에 섞였을 수 있습니다 — concurrent나 requests를 줄여 다시 재 보세요`);
  }

  const limits = LATENCY_KEYS.flatMap(([key, label]) =>
    expect[key] !== undefined && latency[label] !== undefined ? [`${scope}${label} ${ms(latency[label])} (기준 ${ms(expect[key])} 이하, ${latency.count}건)`] : [],
  );
  const evidence = [
    `샌드박스 네트워크 안에서 ${check.method} ${check.path} · 동시 ${result.concurrent} · ${result.requests}건 (${took})`,
    ...limits,
    `상태 ${statusDetail} · 응답을 받지 못한 요청 0건`,
    `러너 밀림 p99 ${ms(result.loopDelay.p99)} · 연결 p95 ${result.connect.p95 !== undefined ? ms(result.connect.p95) : '-'}`,
  ];
  return { note: parts.join(' · '), problems, evidence };
}

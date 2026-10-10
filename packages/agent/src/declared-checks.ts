import type { WorkflowSpec } from '@b-studio/spec';

/** 게이트의 리뷰 단계에 남기는 "확인 선언이 바뀌었다" 기록의 이름 */
export const DECLARED_CHECKS_CHECK = 'declared-checks';

/**
 * 게이트가 무엇을 확인할지 정하는 선언. 사용자가 그 요청에서 허용했을 때만 실행 중에 바뀐 값을 받아들인다(ADR-164).
 * 허용 도구·금지 명령·보호 경로·승인 대상·배포 조건 같은 실행 정책은 여기에 없다 — 그것들은 언제나 실행을 시작할 때의 값이다
 */
const DECLARED_FIELDS = ['required', 'tests', 'pageChecks', 'concurrencyChecks', 'loadChecks', 'autoPageChecks'] as const;

export interface DeclaredCheckChange {
  added: string[];
  removed: string[];
  changed: string[];
}

/** 선언 하나하나에 사람이 읽는 이름을 붙인다. 같은 화면을 두 번 확인하면 둘째부터 번호를 붙여 구별한다 */
function entries(workflow: WorkflowSpec | undefined): Map<string, string> {
  const found = new Map<string, string>();
  const put = (label: string, value: unknown) => {
    let key = label;
    for (let count = 2; found.has(key); count++) key = `${label} #${count}`;
    found.set(key, JSON.stringify(value));
  };
  for (const test of workflow?.tests ?? []) put(`테스트 ${test.name}`, test);
  for (const page of workflow?.pageChecks ?? []) put(`화면 ${page.service} ${page.path}`, page);
  for (const check of workflow?.concurrencyChecks ?? []) put(`동시 요청 ${check.name}`, check);
  for (const check of workflow?.loadChecks ?? []) put(`부하 ${check.name}`, check);
  // sample 값(sampleParams·sampleIdFrom)은 허용 없이도 실행 중에 받아들이는 값이라(ADR-159) 선언의 변경으로 세지 않는다
  if (workflow?.autoPageChecks) {
    const { sampleParams: _sampleParams, sampleIdFrom: _sampleIdFrom, ...rest } = workflow.autoPageChecks;
    put('바뀐 페이지 자동 확인', rest);
  }
  if (workflow?.required) put('필수 단계', workflow.required);
  return found;
}

/** 실행을 시작할 때의 선언과 지금 파일의 선언을 견준다. 실행 정책의 차이는 보지 않는다 */
export function diffDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): DeclaredCheckChange {
  const before = entries(started);
  const after = entries(latest);
  return {
    added: [...after.keys()].filter((key) => !before.has(key)),
    removed: [...before.keys()].filter((key) => !after.has(key)),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
  };
}

export function hasDeclaredCheckChange(change: DeclaredCheckChange): boolean {
  return change.added.length + change.removed.length + change.changed.length > 0;
}

/** 예: "추가: 부하 orders-p95 · 삭제: 테스트 unit · 변경: 화면 web /cart" */
export function describeDeclaredCheckChange(change: DeclaredCheckChange): string {
  const part = (label: string, names: readonly string[]) => (names.length > 0 ? [`${label}: ${names.join(', ')}`] : []);
  return [...part('추가', change.added), ...part('삭제', change.removed), ...part('변경', change.changed)].join(' · ');
}

/** 실행 정책은 시작할 때의 것을 그대로 두고, 확인 선언만 지금 파일의 것으로 바꾼 workflow */
export function withDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): WorkflowSpec | undefined {
  const merged: Record<string, unknown> = { ...started };
  for (const field of DECLARED_FIELDS) {
    if (latest?.[field] === undefined) delete merged[field];
    else merged[field] = latest[field];
  }
  return Object.keys(merged).length > 0 ? (merged as WorkflowSpec) : undefined;
}

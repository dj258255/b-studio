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

/** 약해졌는지 보는 실행 정책 목록과 사람이 읽는 이름. 시작할 때 있던 항목이 빠지면 약해진 것이다 */
const POLICY_LISTS: ReadonlyArray<{ field: 'protectedPaths' | 'evaluationAssets' | 'deniedCommands' | 'requireApprovalFor' | 'releaseRequires'; label: string }> = [
  { field: 'protectedPaths', label: '보호 경로' },
  { field: 'evaluationAssets', label: '평가 자산' },
  { field: 'deniedCommands', label: '금지 명령' },
  { field: 'requireApprovalFor', label: '승인 대상 도구' },
  { field: 'releaseRequires', label: '배포 조건 단계' },
];

/**
 * 실행을 시작할 때보다 지금 선언이 약해진 항목을 사람이 읽는 목록으로 돌려준다(#767). 확인 선언은 삭제·변경만 보고,
 * 실행 정책은 시작할 때 있던 값이 빠진 것을 본다. maxTurns는 보호가 아니므로 보지 않는다.
 */
export function weakenedDeclarations(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): string[] {
  const weakened: string[] = [];
  const change = diffDeclaredChecks(started, latest);
  for (const name of change.removed) weakened.push(`삭제: ${name}`);
  for (const name of change.changed) weakened.push(`변경: ${name}`);
  for (const { field, label } of POLICY_LISTS) {
    const after: readonly string[] = latest?.[field] ?? [];
    for (const item of started?.[field] ?? []) {
      if (!after.includes(item)) weakened.push(`삭제: ${label} ${item}`);
    }
  }
  // 시작할 때 목록이 없었으면(모든 도구 허용) 지금 목록을 더 봐도 약해진 것이 아니다
  if (started?.allowedTools) {
    if (!latest?.allowedTools) weakened.push('삭제: 허용 도구(모든 도구 허용)');
    else for (const tool of latest.allowedTools) if (!started.allowedTools.includes(tool)) weakened.push(`추가: 허용 도구 ${tool}`);
  }
  if (started?.maxChangedFiles !== undefined) {
    if (latest?.maxChangedFiles === undefined) weakened.push('삭제: 변경 파일 수 상한');
    else if (latest.maxChangedFiles > started.maxChangedFiles) weakened.push(`변경: 변경 파일 수 상한 ${started.maxChangedFiles} → ${latest.maxChangedFiles}`);
  }
  return weakened;
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

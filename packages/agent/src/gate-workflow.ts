import { decodeNative, native } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { decodeLoneSurrogates } from './lone-surrogates';
import { requirementRecordIdsForGate } from './requirement-integrity';
import type { RegularFileRead } from './workspace';
import type { WorkflowCheck } from './workflow';

/**
 * 게이트가 끝에 다시 읽는 두 파일(2단계 (b)).
 * 파일 읽기와 판정은 Rust(`crates/bstudio-io/src/gate_workflow.rs`)가 하고, 게이트 인스턴스 상태(바뀐 파일·스냅샷·redact)는 TS가 들고 있다.
 * 옛 TS는 `gate-workflow-legacy.ts`로 남겨 차등 시험만 그것을 import한다.
 */

export type LatestWorkflowResult = { workflow: LoadedProject['spec']['workflow'] } | { error: string };

/**
 * 지금 디스크의 studio.yaml에서 workflow를 읽는다. 읽을 까닭이 없으면(이번 실행에서 바뀌지 않았고 허용도 없으면) undefined.
 * 설정 파일이 일반 파일인지 먼저 보고, 아니면 `(이유)`/`(파일 없음)`을 실패로 돌려준다. 형식 오류는 `: ...`로 알린다.
 */
export async function latestWorkflow(root: string, redact: (text: string) => string): Promise<LatestWorkflowResult | undefined> {
  let result: { kind: 'ok'; workflow?: unknown } | { kind: 'missing' } | { kind: 'irregular'; reason: string } | { kind: 'specError'; message: string; issues: string[] };
  try {
    result = decodeNative(await native.gateLatestWorkflow(root));
  } catch {
    // 옛 코드는 SpecError가 아닌 오류의 글자를 싣지 않고 ''로 실패시켰다(모르면 통과가 아니다)
    return { error: '' };
  }
  if (result.kind === 'irregular') return { error: `(${result.reason})` };
  if (result.kind === 'missing') return { error: '(파일 없음)' };
  if (result.kind === 'specError') {
    // SpecError.message는 이미 issues를 "  - ..." 꼴로 붙인 글자다(옛 latestWorkflow가 그 message와 issues를 다시 이어 붙였다)
    const message = result.issues.length > 0 ? `${result.message}\n${result.issues.map((issue) => `  - ${issue}`).join('\n')}` : result.message;
    return { error: `: ${redact([message, ...result.issues].join(' / '))}` };
  }
  return { workflow: result.workflow as LoadedProject['spec']['workflow'] };
}

/**
 * 요구사항 문서의 검증 기록(사람 확인·재확인 판정 필드)이 이번 실행에서 바뀌었는지 본다(ADR-157).
 * 실행 시작 때의 스냅샷(TS 상태)과 지금 파일을 Rust가 견주고, 다르면 요구사항 기록 판정을 돌린다.
 * 문서 자리에 링크·FIFO·거대한 파일이면 "문서가 없다"로 넘기지 않고 실패다.
 */
export async function requirementRecordChecks(root: string, before: RegularFileRead): Promise<WorkflowCheck[]> {
  const beforeText = before.kind === 'text' ? before.content : undefined;
  const checks = decodeNative<WorkflowCheck[]>(
    await native.gateRequirementRecordChecks(root, beforeText, async (request) => {
      const parsed = JSON.parse(request) as { before?: string; after?: string };
      return JSON.stringify(requirementRecordIdsForGate(parsed.before ?? undefined, parsed.after ?? undefined));
    }),
  );
  return checks.map((check) => (check.detail === undefined ? check : { ...check, detail: decodeLoneSurrogates(check.detail) }));
}

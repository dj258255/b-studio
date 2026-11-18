import { loadProject, SpecError, SPEC_FILE, type LoadedProject } from '@b-studio/spec';
import { MANUAL_VERIFICATION_CHECK, reviewRequirementRecords } from './requirement-integrity';
import { REQUIREMENTS_FILE } from './requirements';
import { readProjectFileSync, type RegularFileRead, type Workspace } from './workspace';
import type { WorkflowCheck } from './workflow';

/**
 * D2 (b) 이전 `packages/agent/src/gate.ts`의 `#latestWorkflow`·`#requirementRecordChecks`를 그대로 옮긴 것(차등 시험 기준값).
 * 시험만 import한다. 지금 구현은 `crates/bstudio-io/src/gate_workflow.rs`가 한다.
 */

export type LegacyLatestWorkflow = { workflow: LoadedProject['spec']['workflow'] } | { error: string };

export async function legacyLatestWorkflow(
  root: string,
  always: boolean,
  changedFiles: () => readonly string[],
  redact: (text: string) => string,
): Promise<LegacyLatestWorkflow | undefined> {
  if (!always && !changedFiles().includes(SPEC_FILE)) return undefined;
  const file = readProjectFileSync(root, SPEC_FILE);
  if (file.kind !== 'text') return { error: `(${file.kind === 'irregular' ? file.reason : '파일 없음'})` };
  try {
    return { workflow: (await loadProject(root)).spec.workflow };
  } catch (error) {
    // 형식 오류의 항목만 알려 준다. 그 밖의 오류 문구는 어디서 온 내용인지 알 수 없어 싣지 않는다
    return { error: error instanceof SpecError ? `: ${redact([error.message, ...error.issues].join(' / '))}` : '' };
  }
}

export async function legacyRequirementRecordChecks(root: string, workspace: Pick<Workspace, 'root' | 'snapshotRead'>, before?: RegularFileRead): Promise<WorkflowCheck[]> {
  const snapshot = before ?? workspace.snapshotRead(REQUIREMENTS_FILE);
  const after = readProjectFileSync(root, REQUIREMENTS_FILE);
  // 문서 자리에 링크·FIFO·거대한 파일이 놓였으면 견줄 수 없다. "문서가 없다"로 넘기면 링크 너머의 내용이 나중에 읽혀
  // 검증됨을 만들 수 있으므로 통과시키지 않는다
  if (after.kind === 'irregular') {
    return [
      {
        stage: 'review',
        name: MANUAL_VERIFICATION_CHECK,
        ok: false,
        attempts: 1,
        detail: `${REQUIREMENTS_FILE}을(를) 읽을 수 없어 검증 기록을 견줄 수 없습니다: ${after.reason}. 일반 파일로 되돌리세요`,
      },
    ];
  }
  const beforeText = snapshot.kind === 'text' ? snapshot.content : undefined;
  const afterText = after.kind === 'text' ? after.content : undefined;
  if (beforeText === afterText) return [];
  return reviewRequirementRecords(beforeText, afterText);
}

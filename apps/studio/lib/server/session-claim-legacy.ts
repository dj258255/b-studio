import type { SessionStatus } from '../studio-events';

/**
 * 옛 세션의 바쁨 판정(ADR-207 이전). 새 코드(`session-claim.ts`, Rust `bstudio-session`의 `claim`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`가 `snapshot.running`·`session.run`·`session.exporting`을 읽고 정하던 판정을 그대로 옮겼다(부수 효과만 뺐다).
 * 누가 점유했는지는 없다: 세 값만 있다.
 */
export interface LegacyBusy {
  status: SessionStatus;
  /** 옛 `snapshot.running` */
  running: boolean;
  /** 옛 `session.exporting` */
  exporting: boolean;
  /** 옛 `session.run`. `aborted`는 `run.cancel.signal.aborted` */
  run?: { id: string; aborted: boolean; steering: boolean; terminal: boolean };
}

/** 거절은 `409:글`, 통과는 `ok` */
export type Verdict = string;

const reject = (status: number, message: string): Verdict => `${status}:${message}`;
const OK: Verdict = 'ok';

/** 옛 `sendMessage`의 앞 세 검사 */
export function legacyRequestVerdict(facts: LegacyBusy): Verdict {
  if (facts.status !== 'ready' && facts.status !== 'idle') return reject(409, '샌드박스가 준비된 뒤에 요청할 수 있습니다');
  if (facts.running) return reject(409, '이전 요청을 처리하는 중입니다');
  if (facts.exporting) return reject(409, '원격 저장소에 올리는 중입니다');
  return OK;
}

/** 옛 `cancelRun`. 통과는 `started`(중단 신호를 올림) 또는 `already`(이미 취소 중, 조용히 돌아옴) */
export function legacyCancelVerdict(facts: LegacyBusy, runId: string): Verdict {
  const run = facts.run;
  if (!run || run.id !== runId) return reject(409, '취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다');
  if (run.aborted) return 'already';
  return 'started';
}

/** 옛 `steerRun`의 실행 확인(데모 모드·빈 지시·큐 없음은 TS가 그대로 한다) */
export function legacySteerVerdict(facts: LegacyBusy): Verdict {
  if (!facts.run) return reject(409, '실행 중이 아닙니다. 새 요청으로 보내세요');
  return OK;
}

export type LegacyTask = 'restore' | 'restore_backup' | 'sync_remote' | 'reverify';

const TASK_READY: Record<LegacyTask, string> = {
  restore: '샌드박스가 준비된 뒤에 되돌릴 수 있습니다',
  restore_backup: '샌드박스가 준비된 뒤에 되살릴 수 있습니다',
  sync_remote: '샌드박스가 준비된 뒤에 가져올 수 있습니다',
  reverify: '샌드박스가 준비된 뒤에 다시 검증할 수 있습니다',
};

/** 옛 보조 작업 시작의 상태·바쁨 검사(순서: 상태 → 바쁨). 저장소·체크포인트 같은 TS 검사는 그 사이에 있다 */
export function legacyTaskVerdict(facts: LegacyBusy, task: LegacyTask): Verdict {
  if (facts.status !== 'ready') return reject(409, TASK_READY[task]);
  if (task === 'reverify') {
    if (facts.run || facts.running || facts.exporting) return reject(409, '다른 작업을 처리하는 중입니다. 끝난 뒤 다시 검증하세요');
    return OK;
  }
  if (facts.running || facts.exporting) return reject(409, '다른 작업을 처리하는 중입니다');
  return OK;
}

/** 옛 `autoCatchUpBase`: 바쁘면 건너뛴다(`skip`), 아니면 한다(`go`). 상태와 올리는 중은 보지 않았다 */
export function legacyCatchUpVerdict(facts: LegacyBusy): 'skip' | 'go' {
  return facts.running ? 'skip' : 'go';
}

export type LegacyBusyOp = 'set_model' | 'save_requirements' | 'manual_verify' | 'manual_clear' | 'write_requirements_doc';

const BUSY_OP: Record<LegacyBusyOp, string> = {
  set_model: '요청을 처리하는 동안에는 모델을 바꿀 수 없습니다',
  save_requirements: '요청을 처리하는 동안에는 요구사항을 저장할 수 없습니다. 끝난 뒤에 저장해 주세요',
  manual_verify: '요청을 처리하는 동안에는 사람 확인을 남길 수 없습니다. 끝난 뒤에 눌러 주세요',
  manual_clear: '요청을 처리하는 동안에는 사람 확인을 취소할 수 없습니다. 끝난 뒤에 눌러 주세요',
  write_requirements_doc: '요청을 처리하는 동안에는 요구사항 문서를 저장할 수 없습니다. 끝난 뒤에 저장해 주세요',
};

/** `running`을 보고 거절하던 곳(상태 검사는 TS가 앞에서 했다) */
export function legacyBusyOpVerdict(facts: LegacyBusy, op: LegacyBusyOp): Verdict {
  return facts.running ? reject(409, BUSY_OP[op]) : OK;
}

/** 옛 `exportSession`의 앞 두 검사 */
export function legacyExportVerdict(facts: LegacyBusy): Verdict {
  if (facts.running) return reject(409, '작업이 끝난 뒤에 올릴 수 있습니다');
  if (facts.exporting) return reject(409, '이미 올리는 중입니다');
  return OK;
}

/** 옛 `deleteSession`의 판정(Rust `delete_check`의 상태 검사). 점유는 보지 않았다 */
export function legacyDeleteVerdict(facts: LegacyBusy): Verdict {
  if (facts.status !== 'stopped' && facts.status !== 'idle') return reject(409, '실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요');
  return OK;
}

/** 옛 `terminalBusy`. 통과는 `ok`, 거절은 글 */
export function legacyTerminalVerdict(facts: LegacyBusy): Verdict {
  if (facts.exporting) return reject(409, '[b-studio] 원격 저장소에 올리는 중입니다. 끝난 뒤 다시 보내세요.');
  if (facts.run || facts.running) return reject(409, '[b-studio] 앞선 요청을 처리하는 중입니다(대화 창에서 보낸 요청이거나 검증 결과를 저장하는 중). 끝난 뒤 다시 보내세요.');
  return OK;
}

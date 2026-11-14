/**
 * 게이트 check의 상태 기계를 Rust로 옮기기 전(ADR-195 4f A5b-1) `gate.ts`의 `VerificationGate.#check`·`#failure`·`#strayServices`를 그대로 둔 것이다.
 * 차등 시험(`gate-check-differential.test.ts`)이 같은 시나리오를 이 옛 구현과 지금 구현에 넣어 이벤트·결과·게이트 상태를 견준다. 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다(4g에서 함께 지운다).
 *
 * 하위 단계(도구 밖 변경 동기화·선언 정하기·기록 검사·선언한 검사 실행·다시 견줌·리뷰·바뀐 파일 목록)는 옛 코드에서도 게이트 객체의 private 메서드였고 이번에 옮기지 않은 것이라,
 * 게이트가 꺼내 주는 `GateHost`(`GATE_HOST`)로 부른다. 옛 코드가 `this.…`로 읽고 쓰던 필드는 `host.state`다. 순서와 분기는 옛 코드의 한 줄도 바꾸지 않았다.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { SPEC_FILE, type WorkflowStage } from '@b-studio/spec';
import { GATE_HOST, type GateHost } from './gate-check';
import { formatFailedChecks, type GateOutcome, type VerificationGate } from './gate';
import { MANUAL_VERIFICATION_CHECK } from './requirement-integrity';
import { formatVerificationReport, verifyChanges } from './verify';
import type { WorkflowCheck } from './workflow';
import { rejectedChangeFeedback } from './change-tracker';

/** 옛 `check()`: 결과를 `lastOutcome`에 남긴다 */
export async function legacyCheck(gate: VerificationGate): Promise<GateOutcome> {
  const host = (gate as unknown as Record<symbol, () => GateHost>)[GATE_HOST]!();
  gate.lastOutcome = undefined;
  const outcome = await legacyCheckInner(host);
  gate.lastOutcome = outcome.kind;
  return outcome;
}

async function legacyStrayServices(host: GateHost): Promise<{ services: string[]; note?: WorkflowCheck }> {
  const { sandbox, signal } = host;
  if (!sandbox.strayProcesses) return { services: [] };
  const note = (detail: string): WorkflowCheck => ({ stage: 'review', name: 'background-processes', ok: true, attempts: 1, detail });
  let reports: Awaited<ReturnType<NonNullable<typeof sandbox.strayProcesses>>>;
  try {
    reports = await sandbox.strayProcesses({ signal });
  } catch (error) {
    signal?.throwIfAborted();
    const all = host.state.project.managed.map(([name]) => name);
    return { services: all, note: note(`서비스 안의 백그라운드 프로세스를 확인하지 못해 서비스를 모두 다시 띄웠습니다: ${error instanceof Error ? error.message : String(error)}`) };
  }
  if (reports.length === 0) return { services: [] };
  const lines = reports.map((report) =>
    report.error !== undefined
      ? `${report.service}: ${report.error}`
      : `${report.service}: ${report.processes.slice(0, 3).map((process) => process.command || `pid ${process.pid}`).join(', ')}${report.processes.length > 3 ? ` 외 ${report.processes.length - 3}개` : ''}`,
  );
  return {
    services: reports.map((report) => report.service),
    note: note(`검사 전에 서비스 안에 남은 백그라운드 프로세스가 있어 그 서비스를 다시 띄웠습니다(서비스 안 명령으로 오래 도는 프로세스를 남기지 마세요) — ${lines.join(' / ')}`),
  };
}

async function legacyCheckInner(host: GateHost): Promise<GateOutcome> {
  const { state, signal, onEvent } = host;
  const stage = (name: WorkflowStage): void => onEvent({ type: 'stage', stage: name, source: 'platform' });
  const rejectedOutside = await host.outsideSync();
  const declaredChecks = await host.reviewDeclaredChecks();
  const project = state.project;
  const recordChecks = [
    ...(await host.requirementRecordChecks()),
    ...(await host.evaluationAssetChecks()),
    ...declaredChecks,
    ...(rejectedOutside.length > 0
      ? [{ stage: 'review' as const, name: 'outside-tool-changes', ok: false, attempts: 1, detail: rejectedChangeFeedback(rejectedOutside) }]
      : []),
  ];
  const recheck = host.recheck;
  if (!recheck && host.changedFiles().length === 0) {
    if (recordChecks.every((check) => check.ok)) return { kind: 'pass' };
    state.checks = recordChecks;
    for (const check of recordChecks) onEvent({ type: 'workflow_check', check });
    return legacyFailure(host, '', recordChecks.filter((check) => !check.ok));
  }

  const files = recheck ? [SPEC_FILE] : host.filesToVerify();
  stage('run');
  onEvent({ type: 'verify_start', files });
  host.markVerifiedVersion();
  const strays = await legacyStrayServices(host);
  if (strays.note) recordChecks.push(strays.note);
  const verify = () => verifyChanges(host.verifyOptions(files, strays.services));
  let report = await verify();
  if (!report.ok && report.platformFailure) {
    signal?.throwIfAborted();
    await sleep(host.platformRetryDelayMs, undefined, { signal });
    report = await verify();
  }
  signal?.throwIfAborted();
  stage('contract_check');
  state.report = report;
  state.failedServices = new Set(report.restarted.filter((check) => !check.ready).map((check) => check.service));
  state.passedStages = new Set();
  state.checks = [...recordChecks];

  const text = formatVerificationReport(report, { allowBreaking: host.allowBreaking });
  onEvent({ type: 'verify_result', report, text, ...(report.ok ? { moreChecks: true } : {}) });
  const gateDone = (ok: boolean): void => {
    if (report.ok) onEvent({ type: 'gate_done', ok });
  };
  if (report.addedAddons?.length) {
    onEvent({
      type: 'warning',
      message: `compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): ${report.addedAddons.join(', ')}`,
    });
  }

  if (!report.ok && report.platformFailure) {
    state.platformFailure = report.platformFailure;
    return { kind: 'exhausted', summary: `b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아닙니다 — ${report.platformFailure}` };
  }
  state.platformFailure = undefined;

  if (report.ok) {
    state.passedStages.add('run');
    state.passedStages.add('contract_check');
    if (host.light) {
      state.skippedStages = host.missingStages(state.passedStages);
      for (const check of recordChecks) onEvent({ type: 'workflow_check', check });
    } else {
      const checks = await host.runDeclaredChecks();
      signal?.throwIfAborted();
      await host.recheckEvaluationAssets(recordChecks);
      await host.recheckOutsideChanges(recordChecks);
      if (state.loadPlatformFailure) {
        state.checks = [...checks, ...recordChecks];
        for (const check of state.checks) onEvent({ type: 'workflow_check', check });
        state.platformFailure = state.loadPlatformFailure;
        gateDone(false);
        return { kind: 'exhausted', summary: `b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아닙니다 — ${state.loadPlatformFailure}` };
      }
      stage('review');
      checks.push(...host.reviewChecks(), ...recordChecks);
      state.checks = checks;
      for (const check of checks) onEvent({ type: 'workflow_check', check });
      for (const name of ['browser_check', 'test', 'concurrency_check', 'load_check', 'review'] as const) {
        const ofStage = checks.filter((check) => check.stage === name);
        if (ofStage.length > 0 && ofStage.every((check) => check.ok)) state.passedStages.add(name);
      }
    }
  }

  const failedChecks = state.checks.filter((check) => !check.ok);
  if (report.ok && failedChecks.length === 0) {
    if (host.light) {
      state.verified = true;
      gateDone(true);
      return { kind: 'pass' };
    }
    const missing = host.missingStages(state.passedStages);
    if (missing.length > 0) {
      gateDone(false);
      return { kind: 'exhausted', summary: `워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: ${missing.join(', ')}` };
    }
    state.verified = true;
    gateDone(true);
    return { kind: 'pass' };
  }

  gateDone(false);
  return legacyFailure(host, text, failedChecks, report.ok);
}

function legacyFailure(host: GateHost, reportText: string, failedChecks: readonly WorkflowCheck[], reportOk = false): GateOutcome {
  const { state } = host;
  state.attempts += 1;
  if (state.attempts >= state.maxAttempts) {
    const record = failedChecks.find((check) => check.name === MANUAL_VERIFICATION_CHECK);
    const reason = record?.detail ? ` — ${record.detail.split('\n')[0]}` : '';
    const declared = state.unadoptedChange ? ` — 확인의 선언을 바꾸려던 것이면 '확인 선언 변경 허용'을 켜고 다시 요청하세요(이번 실행에서 바뀐 선언: ${state.unadoptedChange})` : '';
    return { kind: 'exhausted', summary: `검증 게이트를 ${state.attempts}번 통과하지 못했습니다${reason}${declared}` };
  }
  const failed = formatFailedChecks(failedChecks).trimStart();
  const body = !reportText ? failed : reportOk ? `${failed}\n\n[참고] 서비스 재시작·계약 확인은 통과했습니다.\n${reportText}` : `${reportText}${formatFailedChecks(failedChecks)}`;
  const declared = state.unadoptedChange
    ? `\n\n[참고] 이번 실행에서 ${SPEC_FILE}의 확인 선언을 바꿨지만(${state.unadoptedChange}) 이 검증은 실행을 시작할 때의 선언으로 돌았습니다. 선언은 사용자가 허용한 요청에서만 그 실행의 검증에 쓰입니다. 선언을 바꾸는 것이 사용자의 요청이면 같은 수정을 되풀이하지 말고, 되묻기 도구(ask_user)로 사용자에게 "'확인 선언 변경 허용'을 켜고 답해 달라"고 알리세요.`
    : '';
  return {
    kind: 'retry',
    feedback: `[b-studio 검증 게이트] 변경 사항이 검증을 통과하지 못했습니다. 아래 결과를 보고 고친 뒤 턴을 끝내세요.\n\n${body}${declared}`,
  };
}

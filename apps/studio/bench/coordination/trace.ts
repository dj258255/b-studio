/**
 * 세션 이벤트 기록에서 레인 하나가 "얼마나 탐색했고 무엇이 실패했는지"를 뽑는다(순수 함수).
 *
 * "공유가 실패는 줄이고 탐색은 줄이지 않는가"를 나중에 재려면 E1 기준선부터 같은 값을 남겨야 한다.
 * 운영 코드를 바꾸지 않고 세션 이벤트 기록만으로 계산한다. 실패 서명은 **검증기가 낸 실패만** 쓴다 —
 * 모델 텍스트는 실패의 근거가 아니다(모델은 실패를 다르게 서술할 뿐이다).
 */
import type { VerificationReport } from '@b-studio/agent';
import type { StudioEvent } from '../../lib/studio-events';

export interface FailureSignature {
  /** 게이트 단계(run, contract_check, browser_check, test, review) */
  stage: string;
  service?: string;
  /** 정규화한 오류 첫 줄 */
  message: string;
  files?: string[];
}

export interface LaneTrace {
  sessionId: string;
  /** 도구 이름별 호출 수 */
  toolCalls: Record<string, number>;
  /** read_file 입력 path, 정규화·중복 제거·정렬 */
  filesRead: string[];
  /** list_files 입력 path(없으면 '.') */
  dirsListed: string[];
  /** 발생 순서대로, 중복 포함 */
  failureSignatures: FailureSignature[];
  /** 같은 서명이 두 번째 이상 나온 횟수 합 */
  repeatedFailures: number;
}

/** 같은 원인의 실패를 하나로 묶는 키 */
export function signatureKey(signature: FailureSignature): string {
  return [signature.stage, signature.service ?? '', signature.message, (signature.files ?? []).join(',')].join('|');
}

export function traceFromEvents(sessionId: string, events: StudioEvent[]): LaneTrace {
  // 도구 이름이 '__proto__'·'constructor'여도 안전하도록 Map으로 센다
  const toolCalls = new Map<string, number>();
  const filesRead = new Set<string>();
  const dirsListed = new Set<string>();
  const failureSignatures: FailureSignature[] = [];

  for (const event of events) {
    if (event.type !== 'agent') continue;
    const agent = event.event;

    if (agent.type === 'tool_call') {
      toolCalls.set(agent.name, (toolCalls.get(agent.name) ?? 0) + 1);
      const path = inputPath(agent.input);
      if (agent.name === 'read_file' && path !== undefined) filesRead.add(normalizePath(path));
      if (agent.name === 'list_files') dirsListed.add(path === undefined ? '.' : normalizePath(path));
      continue;
    }
    if (agent.type === 'verify_result') {
      failureSignatures.push(...signaturesFromReport(agent.report));
      continue;
    }
    if (agent.type === 'workflow_check' && !agent.check.ok) {
      failureSignatures.push({ stage: agent.check.stage, message: normalizeMessage(agent.check.detail ?? agent.check.name) });
    }
  }

  const counts = new Map<string, number>();
  for (const signature of failureSignatures) {
    const key = signatureKey(signature);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeatedFailures = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  return {
    sessionId,
    toolCalls: Object.fromEntries(toolCalls),
    filesRead: [...filesRead].sort(),
    dirsListed: [...dirsListed].sort(),
    failureSignatures,
    repeatedFailures,
  };
}

/** 검증기가 통과하지 못한 항목만 서명으로 만든다: 준비 못 한 서비스, 어긋난 계약, 반영 확인 실패, 시크릿 검출 */
function signaturesFromReport(report: VerificationReport): FailureSignature[] {
  const signatures: FailureSignature[] = [];
  for (const check of report.restarted) {
    if (check.ready) continue;
    signatures.push({
      stage: 'run',
      service: check.service,
      message: normalizeMessage(check.error ?? check.logTail?.[0] ?? '서비스를 준비하지 못했습니다'),
    });
  }
  for (const check of report.contracts) {
    const breaking = check.changes.filter((change) => change.breaking);
    // 오류도 없고 호환을 깨는 변경도 없으면 통과한 계약 확인이다
    if (!check.error && breaking.length === 0) continue;
    const message = check.error ?? breaking.map((change) => `${change.kind} ${change.target}${change.detail ? `: ${change.detail}` : ''}`).join('; ');
    signatures.push({ stage: 'contract_check', service: check.service, message: normalizeMessage(message) });
  }
  // 샌드박스에 바뀐 파일이 반영되지 않으면 게이트는 여기서 멈춘다
  if ('error' in report.sync) signatures.push({ stage: 'sync', message: normalizeMessage(report.sync.error) });
  for (const leak of report.secretLeaks) {
    // 시크릿 값은 넣지 않는다. 파일 경로와 시크릿 이름만 남긴다(verify.ts의 SecretLeak.secrets는 값이 아니라 이름이다)
    signatures.push({ stage: 'secret_leak', message: normalizeMessage(`${leak.file}: ${leak.secrets.join(', ')}`), files: [leak.file] });
  }
  return signatures;
}

/**
 * 실패 메시지 정규화: 첫 줄만, 앞뒤 공백 제거, 16진 해시 → H, 숫자열 → N, 200자로 자른다.
 * 같은 원인의 실패가 줄 번호·시각·해시 때문에 다른 서명이 되지 않게 하기 위해서다.
 * 해시는 단어 경계로 찾아 'feedback' 같은 낱말을 잘못 줄이지 않는다.
 */
export function normalizeMessage(text: string): string {
  return text
    .split('\n', 1)[0]!
    .trim()
    .replace(/\b[0-9a-f]{7,}\b/gi, 'H')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

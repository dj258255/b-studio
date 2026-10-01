/**
 * 요구사항(docs/requirements.md) → GitHub 이슈 발행·동기화(ADR-092).
 *
 * 한 방향(파일 → 이슈)이다: `docs/requirements.md`가 언제나 원본이고, 이슈는 그 내용을 보여 주는 거울이다.
 * 추적 이슈 하나("요구사항: <프로젝트>")와 must·should 요구사항마다 하위 이슈 하나를 만든다(task-plans.ts의
 * `publishPlanIssues`가 작업 계획에 쓰는 "추적 이슈 + 하위 이슈" 패턴을 그대로 재사용했다). could·docs는
 * 추적 이슈의 체크리스트 항목으로만 남는다(하위 이슈를 만들지 않는다).
 *
 * 이 파일은 순수 함수만 담는다(파일 IO·네트워크 없음) — studio의 `apps/studio/lib/server/requirement-issues.ts`가
 * `packages/agent/src/repository.ts`의 이슈 API 호출과 세션 작업 복사본 읽기/쓰기를 맡고, 여기 함수들은
 * 입력(요구사항·원격 이슈 스냅샷)을 받아 "무엇을 할지"(발행 계획)와 "본문에 무엇을 쓸지"만 계산한다.
 *
 * `requirements.ts`의 `Requirement`가 이미 `rev`·`hash`·`ears`·`scenarios`·`nfr`·`trace` 필드를 갖고 있다(ADR-090).
 * 이 모듈은 그 타입을 그대로 쓰지 않고 구조적으로 호환되는 별도 타입(`RequirementForIssues`)을 선언해 두는데,
 * 이유는 결합을 낮추기 위해서다(이슈 발행은 요구사항 추적과 독립적으로 테스트·재사용하고 싶다) — 필드 이름·모양은
 * `Requirement`와 반드시 같아야 한다(예전에 `ears`를 string, `nfr`을 string[]로 잘못 선언해 두었던 적이 있다 —
 * `Requirement`는 `ears: {pattern, statement}`, `nfr: {metric, threshold, condition, method}`다. 모양이 어긋나면
 * 이슈 본문에 EARS·시나리오·NFR이 전부 빠진 채로 발행된다, 버그 리포트 참고).
 */
import { createHash } from 'node:crypto';
import type { Ears, Nfr, RequirementKind, RequirementPriority, RequirementStatus, Scenario } from './requirements';

// ---------------------------------------------------------------------------
// 타입: `Requirement`(requirements.ts)와 같은 모양이되, 결합을 낮추려고 구조적으로만 호환시킨다
// ---------------------------------------------------------------------------

/** 요구사항 ↔ 이슈·다른 요구사항의 관계. requirements.ts의 Trace와 이름을 맞췄다 */
export interface RequirementTrace {
  issue?: number;
  dependsOn?: readonly string[];
  /** 옛 항목을 가리키는 요구사항 id 하나(재추출로 쪼개질 때). requirements.ts의 Trace와 모양을 맞춘다(배열이 아니다) */
  supersedes?: string;
}

/** 마지막으로 이 요구사항을 이슈로 발행했을 때의 기록. requirements.ts의 JSON 블록에 관대하게 얹는 필드다 */
export interface RequirementPublishedRecord {
  issue: number;
  /** requirementContentHash가 그때 계산한 값(우리가 이슈에 쓴 내용의 해시 — "우리가 저장한 해시") */
  hash: string;
  /** ISO 8601 */
  at: string;
}

/**
 * 이 모듈이 다루는 요구사항의 최소 모양. `Requirement`(requirements.ts)와 필드 이름·모양을 반드시 맞춘다.
 * 이 모듈은 그 필드들이 없어도(undefined) 안전하게 동작한다(EARS·시나리오·NFR이 없으면 그 절을 아예 쓰지 않는다).
 */
export interface RequirementForIssues {
  id: string;
  title: string;
  kind: string;
  priority: string;
  acceptance: readonly string[];
  rev?: number;
  hash?: string;
  ears?: Ears;
  scenarios?: readonly Scenario[];
  nfr?: Nfr;
  trace?: RequirementTrace;
  published?: RequirementPublishedRecord;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 안정적인 짧은 내용 해시(충돌 감지·변경 감지용이지 보안용이 아니다 — sha256 앞 12자로 충분하다) */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// 관리형 영역: 이슈 본문 안에서 b-studio가 쓰고 읽는 부분(<!-- b-studio:req … --> ~ <!-- /b-studio:req -->)
// ---------------------------------------------------------------------------

export const REQUIREMENT_LABEL = 'b-studio:req';

const MANAGED_REGION_HEADER = /<!--\s*b-studio:req\s+id=(\S+)\s+rev=(\d+)\s+hash=(\S+?)\s*-->/;
const MANAGED_REGION_FOOTER = /<!--\s*\/b-studio:req\s*-->/;

/**
 * 요구사항을 이슈 본문에 쓸 관리형 영역의 "내용" 부분(헤더·꼬리 마커 없이). EARS·시나리오·NFR·인수 조건·원본 안내를 담는다.
 * EARS·시나리오·NFR 절은 실제로 값이 있을 때만 쓴다(없으면 절 자체를 뺀다 — "(정의되지 않음)"·"(없음)" 같은 자리표시자를
 * 남기면 docs/requirements.md에 분명히 있는 내용도 이슈만 보고는 빠진 것처럼 보인다, 버그 리포트 참고). 한 줄
 * 표기(`- EARS(pattern): …`, `- NFR: 지표 … · …`)는 docs/requirements.md의 몸통 줄과 같은 모양으로 맞춰
 * draftManagedRequirement가 모델 호출 없이 그대로 되읽을 수 있게 한다.
 */
export function buildRegionContent(requirement: RequirementForIssues): string {
  const acceptance = requirement.acceptance.map((item) => `- ${item}`).join('\n');
  const sections: string[] = [`- 종류: ${requirement.kind} · 우선순위: ${requirement.priority}`];
  if (requirement.ears) {
    sections.push('', '### EARS', `- EARS(${requirement.ears.pattern}): ${requirement.ears.statement}`);
  }
  if (requirement.scenarios && requirement.scenarios.length > 0) {
    sections.push(
      '',
      '### 시나리오',
      '| id | Given | When | Then |',
      '| --- | --- | --- | --- |',
      ...requirement.scenarios.map((s) => `| ${s.id} | ${s.given} | ${s.when} | ${s.then} |`),
    );
  }
  if (requirement.nfr) {
    sections.push(
      '',
      '### 비기능 요구사항',
      `- NFR: 지표 ${requirement.nfr.metric} · 임계값 ${requirement.nfr.threshold} · 조건 ${requirement.nfr.condition} · 측정 ${requirement.nfr.method}`,
    );
  }
  sections.push('', '### 인수 조건', acceptance);
  sections.push(
    '',
    '---',
    `이 내용은 \`docs/requirements.md\`(${requirement.id})에서 자동으로 만들어졌습니다. **파일이 원본입니다** — 이 본문을 직접 고치지 말고 파일을 고친 뒤 다시 발행하세요. 발행 도구가 내용이 달라진 것을 감지하면 덮어쓰지 않고 충돌로 표시합니다.`,
  );
  return sections.join('\n');
}

/** buildRegionContent가 만드는 내용만으로 계산한 해시. 이 값이 발행 계획(create/update/conflict)의 판단 기준이다 */
export function requirementContentHash(requirement: RequirementForIssues): string {
  return contentHash(buildRegionContent(requirement));
}

/** 요구사항을 하위 이슈 본문 전체(관리형 영역 하나로 이뤄진다)로 렌더링한다 */
export function buildManagedRegion(requirement: RequirementForIssues, rev: number): string {
  const content = buildRegionContent(requirement);
  const hash = contentHash(content);
  return [`<!-- b-studio:req id=${requirement.id} rev=${rev} hash=${hash} -->`, '', content, '', '<!-- /b-studio:req -->'].join('\n');
}

export interface ParsedManagedRegion {
  id: string;
  rev: number;
  hash: string;
  content: string;
}

/** 이슈 본문에서 관리형 영역을 다시 읽는다. 마커가 없거나 짝이 안 맞으면 undefined */
export function parseManagedRegion(body: string): ParsedManagedRegion | undefined {
  const header = MANAGED_REGION_HEADER.exec(body);
  if (!header) return undefined;
  const footer = MANAGED_REGION_FOOTER.exec(body.slice(header.index + header[0].length));
  if (!footer) return undefined;
  const contentStart = header.index + header[0].length;
  const contentEnd = contentStart + footer.index;
  return { id: header[1]!, rev: Number(header[2]), hash: header[3]!, content: body.slice(contentStart, contentEnd).trim() };
}

// ---------------------------------------------------------------------------
// 제목·라벨
// ---------------------------------------------------------------------------

export function subIssueTitle(requirement: Pick<RequirementForIssues, 'id' | 'title'>): string {
  return `[${requirement.id}] ${requirement.title}`;
}

/** subIssueTitle이 붙인 "[R4] " 접두어에서 요구사항 id를 뽑는다. 저장소 탭 이슈 목록이 R-id 칩을 보여줄 때 쓴다 */
export function requirementIdFromIssueTitle(title: string): string | undefined {
  return /^\[(R[1-9][0-9]*)\]/.exec(title.trim())?.[1];
}

export function trackingIssueTitle(projectNameOrSpecTitle: string): string {
  return `요구사항: ${projectNameOrSpecTitle}`;
}

/**
 * 이미 발행한 추적 이슈를 저장소에서 찾는다. 발행 기록(docs/requirements.issues.json)은 세션 작업 복사본에만 있어
 * 다른 세션(예: 작업 분해 통합 세션)에서 다시 발행하면 기록이 없다 — 그때 새 추적 이슈를 또 만들지 않도록
 * `b-studio:req` 라벨과 정확한 제목으로 찾는다. 열린 것을 먼저, 그중 가장 먼저 만든(번호가 작은) 것을 고른다
 */
export function findTrackingIssue(
  issues: ReadonlyArray<{ number: number; title: string; labels: readonly string[]; state: 'open' | 'closed'; url?: string }>,
  projectName: string,
): { issue: number; url?: string } | undefined {
  const title = trackingIssueTitle(projectName);
  const candidates = issues
    .filter((issue) => issue.labels.includes(REQUIREMENT_LABEL) && typeof issue.title === 'string' && issue.title.trim() === title)
    .sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === 'open' ? -1 : 1));
  const found = candidates[0];
  return found ? { issue: found.number, ...(found.url ? { url: found.url } : {}) } : undefined;
}

/** 라벨 집합: b-studio:req, kind:<종류>, priority:<우선순위>, status:<상태>(그대로 한글). 없으면 저장소에 만든다(라벨 생성은 허용된 동작이다) */
export function requirementLabelSet(requirement: Pick<RequirementForIssues, 'kind' | 'priority'>, status: RequirementStatus): string[] {
  return [REQUIREMENT_LABEL, `kind:${requirement.kind}`, `priority:${requirement.priority}`, `status:${status}`];
}

// ---------------------------------------------------------------------------
// 하위 이슈 본문 · 추적 이슈 본문(표)
// ---------------------------------------------------------------------------

export function buildSubIssueBody(requirement: RequirementForIssues, rev: number): string {
  return buildManagedRegion(requirement, rev);
}

export interface TrackingRow {
  requirement: Pick<RequirementForIssues, 'id' | 'title' | 'kind' | 'priority'>;
  status: RequirementStatus;
  issue?: number;
  checklistOnly: boolean;
}

/** 추적 이슈 본문: 요구사항마다 표 한 줄(종류·우선순위·상태·하위 이슈 링크) + could·docs만 담는 체크리스트 절 */
export function buildTrackingIssueBody(projectName: string, rows: readonly TrackingRow[]): string {
  const tableRows = rows
    .filter((row) => !row.checklistOnly)
    .map((row) => `| ${row.requirement.id} | ${row.requirement.title} | ${row.requirement.kind} | ${row.requirement.priority} | ${row.status} | ${row.issue !== undefined ? `#${row.issue}` : '-'} |`);
  const checklist = rows
    .filter((row) => row.checklistOnly)
    .map((row) => `- [${row.status === '검증됨' ? 'x' : ' '}] ${row.requirement.id}. ${row.requirement.title}`);
  return [
    `\`${projectName}\`의 \`docs/requirements.md\`에서 자동으로 만든 요구사항 추적 이슈입니다. **파일이 원본입니다** — 상태는 발행 도구가 주기적으로 갱신합니다.`,
    '',
    '| id | 제목 | 종류 | 우선순위 | 상태 | 하위 이슈 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...tableRows,
    ...(checklist.length > 0 ? ['', '### 체크리스트 전용(could·docs — 하위 이슈를 만들지 않습니다)', ...checklist] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 발행 계획: create / update / unchanged / conflict / reverify / closed_but_requirement_exists
// ---------------------------------------------------------------------------

export type RequirementPlanAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'reverify' | 'closed_but_requirement_exists';

/** 원격 이슈 하나의 스냅샷(발행 계획 계산에 필요한 최소 정보). 실제 조회는 studio의 orchestrator가 한다 */
export interface RemoteIssueSnapshot {
  number: number;
  state: 'open' | 'closed';
  body: string;
}

export interface RequirementPlanInput {
  requirement: RequirementForIssues;
  status: RequirementStatus;
}

export interface RequirementPlanEntry {
  id: string;
  action: RequirementPlanAction;
  issue?: number;
  /** 지금 요구사항 내용으로 계산한 해시(이번에 발행하면 이 값을 published.hash로 저장한다) */
  localHash: string;
  /** 원격 이슈 본문의 관리형 영역에서 다시 계산한 해시(이슈가 없거나 관리형 영역이 없으면 없다) */
  remoteHash?: string;
  /** could 우선순위이거나 docs 종류 — 하위 이슈를 만들지 않고 추적 이슈의 체크리스트에만 넣는다 */
  checklistOnly: boolean;
  /** 미리보기 화면이 그대로 보여줄 한 줄 설명 */
  note: string;
}

/** trace.issue가 있으면 그 번호로, 없으면 관리형 영역의 id 마커로 찾는다(재발행의 멱등성 — 기록을 잃어도 이슈로 다시 찾는다) */
export function findExistingRemoteIssue(requirement: RequirementForIssues, remoteIssues: readonly RemoteIssueSnapshot[]): RemoteIssueSnapshot | undefined {
  if (requirement.trace?.issue !== undefined) return remoteIssues.find((issue) => issue.number === requirement.trace!.issue);
  return remoteIssues.find((issue) => parseManagedRegion(issue.body)?.id === requirement.id);
}

/**
 * 발행 계획을 계산한다(순수 함수 — 네트워크 호출 없음). 충돌 판정은 "지금 로컬 내용"이 아니라
 * "우리가 마지막으로 발행했을 때 쓴 해시"(requirement.published.hash)를 기준으로 삼는다:
 * 원격 이슈의 관리형 영역을 다시 해시했을 때 그 값과 다르면, 로컬이 바뀌었든 아니든 누군가 GitHub에서
 * 직접 고친 것이다(사람이 눈에 보이는 본문을 고쳐도 헤더의 hash= 속성은 손으로 안 고치므로, 헤더를 믿지 않고
 * 내용을 다시 해시해 비교한다).
 */
export function planRequirementPublish(inputs: readonly RequirementPlanInput[], remoteIssues: readonly RemoteIssueSnapshot[]): RequirementPlanEntry[] {
  return inputs.map(({ requirement, status }) => {
    const localHash = requirementContentHash(requirement);
    const checklistOnly = requirement.priority === 'could' || requirement.kind === 'docs';
    const existing = findExistingRemoteIssue(requirement, remoteIssues);

    if (!existing) {
      return {
        id: requirement.id,
        action: 'create',
        localHash,
        checklistOnly,
        note: checklistOnly ? '체크리스트 항목으로만 추적 이슈에 남습니다(하위 이슈를 만들지 않습니다)' : '하위 이슈를 새로 만듭니다',
      };
    }

    const remoteRegion = parseManagedRegion(existing.body);
    const remoteHash = remoteRegion ? contentHash(remoteRegion.content) : undefined;
    const lastPublishedHash = requirement.published?.hash;

    if (remoteHash !== undefined && lastPublishedHash !== undefined && remoteHash !== lastPublishedHash) {
      return {
        id: requirement.id,
        action: 'conflict',
        issue: existing.number,
        localHash,
        remoteHash,
        checklistOnly,
        note: `이슈 #${existing.number}의 내용이 GitHub에서 직접 바뀌었습니다 — 가져오기·덮어쓰기·무시 중 골라 주세요`,
      };
    }

    if (localHash === lastPublishedHash) {
      if (existing.state === 'closed' && status !== '검증됨') {
        return {
          id: requirement.id,
          action: 'closed_but_requirement_exists',
          issue: existing.number,
          localHash,
          remoteHash,
          checklistOnly,
          note: `이슈 #${existing.number}는 닫혀 있지만 이 요구사항은 아직 검증되지 않았습니다`,
        };
      }
      return { id: requirement.id, action: 'unchanged', issue: existing.number, localHash, remoteHash, checklistOnly, note: '바뀐 내용이 없습니다' };
    }

    if (existing.state === 'closed') {
      return {
        id: requirement.id,
        action: 'reverify',
        issue: existing.number,
        localHash,
        remoteHash,
        checklistOnly,
        note: `내용이 바뀌어 이슈 #${existing.number}를 다시 열고 "재확인 필요"로 표시합니다`,
      };
    }
    return { id: requirement.id, action: 'update', issue: existing.number, localHash, remoteHash, checklistOnly, note: `이슈 #${existing.number} 본문을 갱신합니다` };
  });
}

export interface RequirementPlanSummary {
  total: number;
  /** 하위 이슈를 실제로 새로 만드는 항목 수(체크리스트 전용은 빼고 센다 — could·docs는 하위 이슈를 만들지 않는다) */
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  reverify: number;
  closedButRequirementExists: number;
  /**
   * could 우선순위·docs 종류라 하위 이슈 없이 추적 이슈 체크리스트로만 남는 항목 수. 이 항목은 원격에 짝지을
   * 하위 이슈가 애초에 없어 매번 action이 'create'로 계산되지만(findExistingRemoteIssue가 찾을 대상이 없다),
   * 실제로는 아무것도 새로 만들지 않으므로 `create`에 넣지 않고 따로 센다(버그 리포트 — "새로 만들기"로 잘못 보였다)
   */
  checklistOnly: number;
}

export function summarizeRequirementPlan(entries: readonly RequirementPlanEntry[]): RequirementPlanSummary {
  return {
    total: entries.length,
    create: entries.filter((entry) => entry.action === 'create' && !entry.checklistOnly).length,
    update: entries.filter((entry) => entry.action === 'update').length,
    unchanged: entries.filter((entry) => entry.action === 'unchanged').length,
    conflict: entries.filter((entry) => entry.action === 'conflict').length,
    reverify: entries.filter((entry) => entry.action === 'reverify').length,
    closedButRequirementExists: entries.filter((entry) => entry.action === 'closed_but_requirement_exists').length,
    checklistOnly: entries.filter((entry) => entry.checklistOnly).length,
  };
}

// ---------------------------------------------------------------------------
// 충돌 해결: 가져오기 / 덮어쓰기 / 무시
// ---------------------------------------------------------------------------

export type ConflictResolution = 'import' | 'overwrite' | 'ignore';

// ---------------------------------------------------------------------------
// 상태 반영: 하위 이슈에 고정할 댓글 하나(편집만 하고 새로 남기지 않는다)
// ---------------------------------------------------------------------------

export interface RequirementEvidenceRow {
  scenario: string;
  test?: string;
  result: string;
  commit?: string;
  gate?: string;
}

const STATUS_COMMENT_HEADER = (id: string) => `<!-- b-studio:req-status id=${id} -->`;
const STATUS_COMMENT_FOOTER = '<!-- /b-studio:req-status -->';

/** 하위 이슈에 고정할 상태 댓글 본문(표: 시나리오 | 테스트 | 결과 | 커밋 | 게이트). 매번 이 댓글을 통째로 다시 만들어 편집한다 */
export function buildStatusComment(requirementId: string, status: RequirementStatus, rows: readonly RequirementEvidenceRow[]): string {
  const body =
    rows.length > 0
      ? rows.map((row) => `| ${row.scenario} | ${row.test ?? '-'} | ${row.result} | ${row.commit ?? '-'} | ${row.gate ?? '-'} |`)
      : ['| (근거 없음) | - | - | - | - |'];
  return [
    STATUS_COMMENT_HEADER(requirementId),
    `**상태: ${status}**`,
    '',
    '| 시나리오 | 테스트 | 결과 | 커밋 | 게이트 |',
    '| --- | --- | --- | --- | --- |',
    ...body,
    '',
    '이 댓글은 b-studio가 자동으로 갱신합니다(새 댓글을 남기지 않고 이 댓글만 고칩니다). 직접 고치지 마세요.',
    STATUS_COMMENT_FOOTER,
  ].join('\n');
}

/** 이 댓글이 우리의 고정 상태 댓글인지(requirementId를 주면 그 요구사항 것인지까지) */
export function isStatusComment(body: string, requirementId?: string): boolean {
  const pattern = requirementId ? new RegExp(`<!--\\s*b-studio:req-status\\s+id=${escapeRegExp(requirementId)}\\s*-->`) : /<!--\s*b-studio:req-status\s+id=\S+\s*-->/;
  return pattern.test(body);
}

/** 댓글 목록에서 이 요구사항의 고정 상태 댓글을 찾는다(없으면 새로 만든다 — studio orchestrator가 처리) */
export function findPinnedStatusComment<T extends { body: string }>(comments: readonly T[], requirementId: string): T | undefined {
  return comments.find((comment) => isStatusComment(comment.body, requirementId));
}

// ---------------------------------------------------------------------------
// PR 본문 조립: Closes #n(검증됨 + 이슈 있음) / Implements: Rn@revN
// ---------------------------------------------------------------------------

export interface ImplementedRequirementRef {
  id: string;
  rev?: number;
  issue?: number;
  status: RequirementStatus;
}

export function implementsTrailer(ref: Pick<ImplementedRequirementRef, 'id' | 'rev'>): string {
  return ref.rev !== undefined ? `Implements: ${ref.id}@rev${ref.rev}` : `Implements: ${ref.id}`;
}

/** 세션 커밋 제목("요청: [R4] …" 등)에서 "[R4]" 형태로 언급된 요구사항 id를 순서대로, 중복 없이 뽑는다 */
export function extractRequirementMentions(texts: readonly string[]): string[] {
  const found: string[] = [];
  const pattern = /\[(R[1-9][0-9]*)\]/g;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const id = match[1]!;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

/**
 * PR 본문에 덧붙일 절을 만든다: 검증됨 + 이슈가 있는 요구사항만 `Closes #n`(병합되면 자동으로 닫는다),
 * 구현한 요구사항 전부 `Implements: Rn`(또는 `Rn@revN`). `Closes #n`은 기본 브랜치로 여는 PR에서만 동작한다는
 * 안내를 함께 붙인다(GitLab 스타일 MR closes 문구와 달리 GitHub는 이 규칙이 있다).
 */
export function buildRequirementsAddendum(refs: readonly ImplementedRequirementRef[]): string {
  if (refs.length === 0) return '';
  const closes = refs.filter((ref) => ref.issue !== undefined && ref.status === '검증됨').map((ref) => `Closes #${ref.issue}`);
  const implementsLines = refs.map((ref) => implementsTrailer(ref));
  const note = closes.length > 0 ? '\n\n(`Closes #n`은 이 PR이 기본 브랜치로 열릴 때만 이슈를 자동으로 닫습니다.)' : '';
  return `\n\n${[...closes, ...implementsLines].join('\n')}${note}`;
}

/** AI 리뷰 라운드 프롬프트에 덧붙일 압축 목록: 이 PR이 구현한 요구사항의 제목·시나리오 */
export function buildReviewRequirementsContext(entries: readonly Pick<RequirementForIssues, 'id' | 'title' | 'scenarios'>[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const scenarios = (entry.scenarios ?? []).map((scenario) => `Given ${scenario.given} When ${scenario.when} Then ${scenario.then}`).join(' / ');
    return `- ${entry.id}. ${entry.title}${scenarios ? ` — ${scenarios}` : ''}`;
  });
  return `[이 PR이 구현하는 요구사항]\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// 이슈 폼 생성기·파서: .github/ISSUE_TEMPLATE/requirement.yml (자동으로 저장소에 커밋하지 않는다 — 사용자가 검토 후 추가)
// ---------------------------------------------------------------------------

/** 사용자가 직접 `.github/ISSUE_TEMPLATE/requirement.yml`로 저장해 쓸 수 있는 GitHub 이슈 폼 내용 */
export function buildRequirementIssueFormYaml(): string {
  return [
    'name: 요구사항',
    'description: docs/requirements.md에 없는 요구사항을 제안합니다(b-studio가 나중에 가져올 수 있습니다)',
    'title: "[R?] "',
    'labels: ["b-studio:req"]',
    'body:',
    '  - type: input',
    '    id: title',
    '    attributes:',
    '      label: 제목',
    '    validations:',
    '      required: true',
    '  - type: dropdown',
    '    id: kind',
    '    attributes:',
    '      label: 종류',
    '      options:',
    '        - api',
    '        - ui',
    '        - data',
    '        - nonfunctional',
    '        - docs',
    '    validations:',
    '      required: true',
    '  - type: dropdown',
    '    id: priority',
    '    attributes:',
    '      label: 우선순위',
    '      options:',
    '        - must',
    '        - should',
    '        - could',
    '    validations:',
    '      required: true',
    '  - type: textarea',
    '    id: acceptance',
    '    attributes:',
    '      label: 인수 조건',
    '      description: 한 줄에 하나씩 적어 주세요',
    '    validations:',
    '      required: true',
    '',
  ].join('\n');
}

export interface RequirementIssueDraft {
  title: string;
  kind: string;
  priority: string;
  acceptance: string[];
  /** 구조화된 값을 하나라도 못 찾아 기본값으로 대신했다 — 화면이 "검토해 주세요"로 안내한다 */
  guessed: boolean;
}

/** GitHub 이슈 폼이 렌더링한 "### 레이블\n값" 구획 하나를 찾는다(값이 없으면 "_No response_") */
function extractFormField(body: string, label: string): string | undefined {
  const pattern = new RegExp(`###\\s*${escapeRegExp(label)}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`);
  const value = pattern.exec(body)?.[1]?.trim();
  return value && value !== '_No response_' ? value : undefined;
}

function acceptanceLines(raw: string | undefined, fallback: string): string[] {
  const lines = (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [fallback];
}

/** 이슈 폼(requirement.yml)으로 만든 이슈 본문을 요구사항 초안으로 파싱한다. 폼 구획을 하나도 못 찾으면 undefined */
export function parseRequirementIssueForm(title: string, body: string): RequirementIssueDraft | undefined {
  const formTitle = extractFormField(body, '제목') ?? extractFormField(body, 'Title');
  const kind = extractFormField(body, '종류') ?? extractFormField(body, 'Kind');
  const priority = extractFormField(body, '우선순위') ?? extractFormField(body, 'Priority');
  const acceptanceRaw = extractFormField(body, '인수 조건') ?? extractFormField(body, 'Acceptance Criteria');
  if (!formTitle && !kind && !priority && !acceptanceRaw) return undefined;
  return {
    title: formTitle ?? bareTitle(title),
    kind: kind ?? 'api',
    priority: priority ?? 'must',
    acceptance: acceptanceLines(acceptanceRaw, formTitle ?? title),
    guessed: !kind || !priority || !acceptanceRaw,
  };
}

/** subIssueTitle이 붙인 "[R4] " 접두어나, 이슈 폼 제목 기본값("[R?] ")을 뗀다 */
function bareTitle(title: string): string {
  return title.replace(/^\[R(?:[1-9][0-9]*|\?)\]\s*/, '').trim() || title;
}

const REGION_KIND_PRIORITY = /^-\s*종류:\s*(\S+)\s*·\s*우선순위:\s*(\S+)\s*$/m;
const REGION_ACCEPTANCE = /###\s*인수\s*조건\s*\n([\s\S]*?)(?=\n###|\n---|$)/;

/**
 * 이슈 하나(제목+본문)를 요구사항 초안으로 가져온다. 순서대로 시도한다:
 *  1) 우리가 이미 발행한 이슈(관리형 영역이 있다) — 종류·우선순위·인수 조건을 그대로 되읽는다(정확한 왕복)
 *  2) `requirement.yml` 이슈 폼으로 만든 이슈 — 폼 구획을 읽는다
 *  3) 평문 이슈 — 글머리 기호를 인수 조건으로 보고, 종류·우선순위는 기본값(api·must)으로 두고 "검토해 주세요"로 표시한다
 */
export function draftRequirementFromIssue(title: string, body: string): RequirementIssueDraft {
  const managed = parseManagedRegion(body);
  if (managed) {
    const kindPriority = REGION_KIND_PRIORITY.exec(managed.content);
    const acceptance = acceptanceLines(REGION_ACCEPTANCE.exec(managed.content)?.[1], bareTitle(title));
    return { title: bareTitle(title), kind: kindPriority?.[1] ?? 'api', priority: kindPriority?.[2] ?? 'must', acceptance, guessed: !kindPriority };
  }
  const form = parseRequirementIssueForm(title, body);
  if (form) return form;
  const bullets = body
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  return { title, kind: 'api', priority: 'must', acceptance: bullets.length > 0 ? bullets : [body.trim().slice(0, 500) || title], guessed: true };
}

// ---------------------------------------------------------------------------
// 저장소 이슈에서 그대로 가져오기(ADR-092 보강): b-studio가 발행한 관리형 영역은 모델을 부르지 않고 그대로 되읽는다
// ---------------------------------------------------------------------------

/**
 * 관리형 영역에서 되읽은 완전한 요구사항 초안. `draftRequirementFromIssue`(평문·이슈 폼까지 받아주는 느슨한 초안)와
 * 달리 이 함수는 관리형 영역이 있을 때만 값을 돌려주고(없으면 undefined — 호출하는 쪽이 모델 추출로 넘어간다),
 * id·rev·EARS·시나리오·NFR까지 전부 되읽어 docs/requirements.md에 그대로 저장할 수 있는 모양으로 만든다.
 */
export interface ManagedRequirementDraft {
  id: string;
  rev: number;
  title: string;
  kind: string;
  priority: string;
  acceptance: string[];
  ears?: Ears;
  scenarios?: Scenario[];
  nfr?: Nfr;
}

const REGION_EARS = /^-\s*EARS\((ubiquitous|event|state|unwanted|optional)\):\s*(.+?)\s*$/m;
const REGION_NFR = /^-\s*NFR:\s*지표\s+(.+?)\s*·\s*임계값\s+(.+?)\s*·\s*조건\s+(.+?)\s*·\s*측정\s+(.+?)\s*$/m;
const REGION_SCENARIO_ROW = /^\|\s*(R[1-9][0-9]*\.[1-9][0-9]*)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/gm;

/**
 * 이슈 하나(제목+본문)가 b-studio의 관리형 영역을 담고 있으면 모델 호출 없이 완전한 요구사항으로 되읽는다.
 * 관리형 영역이 없으면(사람이 손으로 만든 이슈 등) undefined — 호출하는 쪽이 기존 모델 추출로 넘어간다.
 */
export function draftManagedRequirement(title: string, body: string): ManagedRequirementDraft | undefined {
  const managed = parseManagedRegion(body);
  if (!managed) return undefined;
  const kindPriority = REGION_KIND_PRIORITY.exec(managed.content);
  const acceptance = acceptanceLines(REGION_ACCEPTANCE.exec(managed.content)?.[1], bareTitle(title));
  const earsMatch = REGION_EARS.exec(managed.content);
  const nfrMatch = REGION_NFR.exec(managed.content);
  const scenarios = [...managed.content.matchAll(REGION_SCENARIO_ROW)].map((row) => ({ id: row[1]!, given: row[2]!, when: row[3]!, then: row[4]! }));
  return {
    id: managed.id,
    rev: managed.rev,
    title: bareTitle(title),
    kind: kindPriority?.[1] ?? 'api',
    priority: kindPriority?.[2] ?? 'must',
    acceptance,
    ...(earsMatch ? { ears: { pattern: earsMatch[1] as Ears['pattern'], statement: earsMatch[2]! } } : {}),
    ...(scenarios.length > 0 ? { scenarios } : {}),
    ...(nfrMatch ? { nfr: { metric: nfrMatch[1]!, threshold: nfrMatch[2]!, condition: nfrMatch[3]!, method: nfrMatch[4]! } } : {}),
  };
}

const TRACKING_ROW_ISSUE_LINK = /^\|\s*R[1-9][0-9]*\s*\|.*\|\s*#(\d+)\s*\|\s*$/gm;

/**
 * 추적 이슈 본문(표: id·제목·종류·우선순위·상태·하위 이슈, `buildTrackingIssueBody` 참고)에서 하위 이슈 번호를
 * 순서대로, 중복 없이 뽑는다. GitHub의 sub_issues API 대신 이 표의 `#N` 링크를 쓰면 GitHub·Gitea 둘 다에서
 * 똑같이 동작한다(Gitea는 하위 이슈 API가 없다).
 */
export function extractTrackingSubIssueNumbers(body: string): number[] {
  const numbers: number[] = [];
  for (const match of body.matchAll(TRACKING_ROW_ISSUE_LINK)) {
    const n = Number(match[1]);
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

/** `draftManagedRequirement`가 돌려준 초안을 docs/requirements.md에 저장할 수 있는 `RequirementForIssues`(=Requirement 호환) 모양으로 바꾼다 */
export function managedRequirementToRequirement(draft: ManagedRequirementDraft): RequirementForIssues & { id: string; rev: number; kind: RequirementKind; priority: RequirementPriority } {
  return {
    id: draft.id,
    rev: draft.rev,
    title: draft.title,
    kind: draft.kind as RequirementKind,
    priority: draft.priority as RequirementPriority,
    acceptance: draft.acceptance,
    ...(draft.ears ? { ears: draft.ears } : {}),
    ...(draft.scenarios ? { scenarios: draft.scenarios } : {}),
    ...(draft.nfr ? { nfr: draft.nfr } : {}),
  };
}

// ---------------------------------------------------------------------------
// 안전장치: 이 기능이 부를 수 있는 API 경로 화이트리스트(이슈·하위 이슈·댓글·라벨만 — 협업자·권한·설정·웹훅·브랜치 보호는 절대 안 된다)
// ---------------------------------------------------------------------------

/** GitHub·Gitea REST API에서 이슈·하위 이슈·댓글·라벨에 해당하는 경로만 허용한다(owner/repo 뒤부터) */
export const ALLOWED_REQUIREMENT_ENDPOINTS: readonly RegExp[] = [
  /^\/repos\/[^/]+\/[^/]+\/issues$/,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
  /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/sub_issues$/,
  /^\/repos\/[^/]+\/[^/]+\/labels$/,
];

export class RequirementEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementEndpointError';
  }
}

/** repository.ts의 이슈·라벨·댓글 호출이 실제로 fetch하기 직전에 부른다. 화이트리스트 밖이면 네트워크를 타지 않고 던진다 */
export function assertAllowedRequirementEndpoint(pathname: string): void {
  if (!ALLOWED_REQUIREMENT_ENDPOINTS.some((pattern) => pattern.test(pathname))) {
    throw new RequirementEndpointError(`요구사항 발행기가 허용되지 않은 API 경로를 부르려 했습니다(협업자·권한·설정·웹훅 등은 절대 부르지 않습니다): ${pathname}`);
  }
}

/**
 * 명세 → 요구사항 → 검증 추적(ADR-079).
 *
 * Kiro(requirements.md/design.md/tasks.md, 작업 상태)와 GitHub Spec Kit(/specify → /clarify(질문 5개 이하) → /tasks,
 * "코드가 아니라 스펙을 고친다"는 카카오페이 실천)를 참고하되, 두 도구 모두 요구사항과 "무엇이 증명하는가"를 잇지 않는다.
 * 이 모듈은 그 이음매다: 과제 명세를 인수 조건이 있는 요구사항으로 나누고(추출), 사람이 읽고 고칠 수 있는 파일로
 * 남기고(직렬화·역직렬화), 체크포인트·테스트·게이트 결과에서 "이 요구사항이 됐다는 증거"를 모아 상태를 매긴다(추적).
 *
 * PR 리뷰(pr-review.ts)·작업 계획(task-plan.ts)과 같은 "도구 없이 한 번만 묻는다"(ModelAsk) 방식을 재사용한다 —
 * 추출 모델에게 파일 읽기·명령 실행 도구를 주지 않고 명세 글만 준다. 모델을 부를 수 없는 백엔드에서는 호출하는 쪽
 * (studio의 sessions.ts)이 결정론적 대체 파서(extractRequirementsHeuristically)로 넘어간다.
 *
 * 이 파일의 함수는 모두 순수 함수다(파일 IO·네트워크 없음) — studio의 sessions.ts가 파일 읽기/쓰기·세션 상태 조회를 맡고,
 * 여기 함수들은 입력을 받아 값을 돌려주기만 한다(테스트하기 쉽게, 그리고 studio 밖에서도 재사용할 수 있게).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { summarizeJsonContent, summarizeLargeJsonFile } from './json-summary';
import type { AgentUsage } from './loop';
import { parsePlannerReply, type ModelAsk } from './task-plan';
import { discoverTestsInFile, flattenDiscoveredFile } from './test-discovery';
import { Workspace, WorkspaceError } from './workspace';

export const REQUIREMENT_KINDS = ['api', 'ui', 'data', 'nonfunctional', 'docs'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_PRIORITIES = ['must', 'should', 'could'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

/** 한 문서에 담을 수 있는 요구사항 수 상한. 명세 하나 분량을 넘어서면 추출이 잘못됐다고 본다 */
export const MAX_REQUIREMENTS = 60;
/** Spec Kit의 /clarify처럼 "물어볼 가치가 있는 모호함"만 최대 5개 */
export const MAX_CLARIFYING_QUESTIONS = 5;
/** "## 가정" 절에 담을 수 있는 가정 수 상한 */
export const MAX_ASSUMPTIONS = 10;
/** "범위 밖" 노트로 뺄 수 있는 항목 수 상한(요구사항으로 만들지 않는 부정형 문장) */
export const MAX_OUT_OF_SCOPE = 20;

/** 요구사항 id는 영구적이다 — 절대 다시 매기거나 재사용하지 않는다(ADR-090). 시나리오 id(R4.1)는 SCENARIO_ID를 따로 쓴다 */
const REQUIREMENT_ID = /^R[1-9][0-9]*$/;
const SCENARIO_ID = /^R[1-9][0-9]*\.[1-9][0-9]*$/;

/**
 * 증거·트레일러에서 요구사항/시나리오 id를 토큰 하나로 뽑는다. "R1"이 "R10"의 일부로 걸리지 않게 항상 단어 경계로 감싼다
 * (alistairmavin.com/ears의 패턴 이름과 무관하게, Doorstop/sphinx-needs류 도구의 "id는 독립 토큰" 관례를 그대로 따른다).
 */
export const REQUIREMENT_MENTION_PATTERN = /\bR\d+(?:\.\d+)?\b/g;

export const EARS_PATTERNS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional'] as const;
export type EarsPattern = (typeof EARS_PATTERNS)[number];

/** EARS(Easy Approach to Requirements Syntax, alistairmavin.com/ears) 한 문장. "…해야 한다"로 끝나는 단수 서술 하나만 담는다 */
export const EarsSchema = z.object({
  pattern: z.enum(EARS_PATTERNS),
  statement: z.string().min(1).max(500),
});
export type Ears = z.infer<typeof EarsSchema>;

/** Gherkin 스타일 Given-When-Then 시나리오 하나. id는 소속 요구사항 id로 시작한다(R4의 시나리오는 R4.1, R4.2…) */
export const ScenarioSchema = z.object({
  id: z.string().regex(SCENARIO_ID, 'R4.1 형태의 시나리오 id여야 합니다'),
  given: z.string().min(1).max(500),
  when: z.string().min(1).max(500),
  then: z.string().min(1).max(500),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * 시나리오 id의 앞부분을 요구사항 id에 맞춘다(`R6.2` → `R7.2`). 재추출 병합이 모델이 붙인 id(R6)를 기존 id(R7)로
 * 바꿀 때 시나리오 id는 그대로 남아, 저장 검증(시나리오 id는 요구사항 id로 시작)에 걸리거나 추적 매트릭스가 테스트를
 * 엉뚱한 요구사항에 붙였다. 뒤 번호는 유지하고, 겹치면 다음 빈 번호를 쓴다
 */
export function alignScenarioIds<T extends { id: string; scenarios?: ReadonlyArray<{ id: string }> }>(requirement: T): T {
  if (!requirement.scenarios || requirement.scenarios.length === 0) return requirement;
  const prefix = `${requirement.id}.`;
  if (requirement.scenarios.every((scenario) => scenario.id.startsWith(prefix))) return requirement;
  const used = new Set<number>();
  const scenarios = requirement.scenarios.map((scenario) => {
    const suffix = Number(/\.(\d+)$/.exec(scenario.id)?.[1] ?? NaN);
    let number = Number.isInteger(suffix) && suffix > 0 && !used.has(suffix) ? suffix : 1;
    while (used.has(number)) number += 1;
    used.add(number);
    return { ...scenario, id: `${requirement.id}.${number}` };
  });
  return { ...requirement, scenarios };
}

/** 비기능 요구사항(kind: nonfunctional)의 측정 가능한 기준. QVscribe류 요구사항 스멜 검사가 요구하는 "수치화된 임계값"을 강제한다 */
export const NfrSchema = z.object({
  metric: z.string().min(1).max(200),
  threshold: z.string().min(1).max(200),
  condition: z.string().min(1).max(300),
  method: z.string().min(1).max(300),
});
export type Nfr = z.infer<typeof NfrSchema>;

/**
 * 추적 정보. `issue`·`rev`·`hash`는 저장소 이슈 발행을 맡은 다른 모듈(requirement-issues.ts)이 그대로 읽으므로
 * 이름을 바꾸지 않는다. `supersedes`는 재추출로 요구사항이 쪼개질 때 새 항목이 옛 항목을 가리키는 자리다.
 */
export const TraceSchema = z.object({
  issue: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().regex(REQUIREMENT_ID)).max(20).optional(),
  supersedes: z.string().regex(REQUIREMENT_ID).optional(),
});
export type Trace = z.infer<typeof TraceSchema>;

/**
 * 사람이 "직접 확인함"으로 남긴 검증 기록(ADR-103). 테스트·게이트처럼 자동으로 돌지 않는 요구사항(문서, UI를
 * 디자인과 맞춰 보는 것, could 우선순위 항목 등)도 사람이 직접 보고 확인했다는 사실을 증거로 남길 수 있게 한다.
 * docs/requirements.md 몸통에 "- 확인: 범수 · 2026-10-01 · 체크포인트 c57d72f · 메모 …"로 그대로 보인다(저장소에
 * 같이 남아 커밋·PR에 실린다). computeRequirementStatus는 자동 증거(게이트·테스트 탭 실행)가 실패면 이 기록이
 * 있어도 절대 뒤집지 않는다. 내용이 개정되면(revisedAt 갱신) 다른 증거와 같은 규칙으로 "재확인 필요"에 들어간다.
 */
export const ManualVerificationSchema = z.object({
  /** 확인한 사람(세션을 연 사용자 이름) */
  by: z.string().min(1).max(100),
  /** 확인한 날짜(YYYY-MM-DD). 시각까지는 담지 않는다 — 몸통 줄이 사람이 읽기 좋아야 한다 */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD 형태여야 합니다'),
  /** 확인한 시점의 체크포인트(짧은 sha) */
  sha: z.string().min(4).max(40),
  /** "무엇을 어떻게 확인했나" — 빈 메모는 받지 않는다(그냥 누른 버튼과 구분한다) */
  note: z.string().min(1).max(500),
});
export type ManualVerification = z.infer<typeof ManualVerificationSchema>;

export const RequirementSchema = z
  .object({
    id: z.string().regex(REQUIREMENT_ID, 'R1, R2… 형태의 id여야 합니다'),
    title: z.string().min(1).max(200),
    kind: z.enum(REQUIREMENT_KINDS),
    /** 테스트 가능한 인수 조건. "~하면 ~한다" 같은 확인 가능한 문장이어야 한다(제목을 되풀이하는 문장은 안 된다) */
    acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
    priority: z.enum(REQUIREMENT_PRIORITIES),
    /** 개정 번호. 1부터 시작하고, 내용(ears+scenarios+nfr+title)의 해시가 바뀌면 오른다 */
    rev: z.number().int().min(1).optional(),
    ears: EarsSchema.optional(),
    /** 최대 20개 — 한 요구사항이 이보다 많은 시나리오를 필요로 하면 요구사항을 쪼개야 한다는 신호로 본다 */
    scenarios: z.array(ScenarioSchema).max(20).optional(),
    /** kind가 nonfunctional이면 있어야 lintRequirement가 "Ready"로 본다 — 옛 문서와 호환하려고 스키마에서는 선택이다 */
    nfr: NfrSchema.optional(),
    trace: TraceSchema.optional(),
    /** ears+scenarios+nfr+title의 안정적 해시(computeRequirementHash). 저장할 때마다 다시 계산해 이전 값과 다르면 개정이 오른다 */
    hash: z.string().optional(),
    /** 마지막으로 개정이 오른 시각(ISO 8601). 그 뒤에 생긴 증거만 "재확인됨"으로 인정한다(computeRequirementStatus) */
    revisedAt: z.string().optional(),
    /** 사람이 "직접 확인함"으로 남긴 기록(ADR-103). "확인 취소"를 누르면 지운다 */
    manualVerification: ManualVerificationSchema.optional(),
  })
  .refine((value) => (value.scenarios ?? []).every((scenario) => scenario.id.startsWith(`${value.id}.`)), {
    message: '시나리오 id는 소속 요구사항 id로 시작해야 합니다(예: R4의 시나리오는 R4.1)',
  });
export type Requirement = z.infer<typeof RequirementSchema>;

/** "## 가정" 절의 항목 하나. 데이터 규모·동시성/트래픽(명세가 실마리를 줄 때만)·페이지네이션/인덱스 같은 성능 관련 제약 — 서버 사양은 다루지 않는다 */
export const AssumptionSchema = z.string().min(1).max(300);

/** 요구사항으로 만들지 않고 "범위 밖" 노트로 빼는 부정형 문장(예: "결제 연동은 포함하지 않는다") */
export const OutOfScopeItemSchema = z.string().min(1).max(300);

/** "## 사람이 할 일" 절에 담을 수 있는 항목 수 상한 */
export const MAX_MANUAL_STEPS = 20;
export const ManualStepItemSchema = z.string().min(1).max(300);

/**
 * 명세가 요구사항처럼 적어도 실제로는 코드·문서 밖에서 사람이 손으로 해야 하는 절차(저장소 권한·협업자·공개 범위
 * 변경, 이메일·메시지로 제출, 계정 생성 등)를 결정론적으로 거른다(ADR-090). 모델이 프롬프트 규칙을 놓쳐도
 * 에이전트가 GitHub 저장소 권한을 바꾸는 작업을 "요구사항"으로 착각해 시도하지 않도록 이 가드가 항상 한 번 더 본다.
 *
 * 아래는 그 자체로 "사람이 할 일"인 표현이다. 앱 기능 이름으로 거의 쓰이지 않는다(GitHub 용어 collaborator, 제출 절차).
 */
const MANUAL_STEP_STANDALONE: readonly RegExp[] = [
  /\bcollaborators?\b/i,
  /branch\s*protection/i,
  /deploy\s*key/i,
  /메일(?:로)?\s*제출|이메일(?:로)?\s*제출|email\s*(?:로)?\s*제출/i,
  /제출\s*(?:방법|절차)/i,
];
/**
 * 앱 기능으로도 흔한 표현(결제 webhook, 사용자 권한 변경, 팀원 초대, 게시글 공개 범위 등). 저장소·계정 맥락과
 * 함께 나올 때만 "사람이 할 일"로 본다 — 맥락 없이 걸면 정상 요구사항이 에이전트 작업 목록에서 빠진다
 */
const MANUAL_STEP_IN_REPO_CONTEXT: readonly RegExp[] = [
  /협업자|공동\s*작업자/,
  /\binvite(?:s|d)?\b|초대/i,
  /\bvisibility\b|공개\s*범위|\bprivate\b|\bpublic\b|비공개|공개로/i,
  /권한|\bpermission/i,
  /\bwebhook\b|웹훅/i,
  /\bsecrets?\b|시크릿/i,
];
const REPO_CONTEXT = /저장소|레포|\brepo(?:sitory)?\b|github|깃허브|gitlab|organization|조직\s*설정|계정\s*설정/i;

/** 텍스트가 "사람이 할 일"(에이전트가 절대 하면 안 되는 절차)로 보이는지 */
export function isManualStepText(text: string): boolean {
  if (MANUAL_STEP_STANDALONE.some((pattern) => pattern.test(text))) return true;
  return REPO_CONTEXT.test(text) && MANUAL_STEP_IN_REPO_CONTEXT.some((pattern) => pattern.test(text));
}

/**
 * 요구사항 목록에서 "사람이 할 일"로 보이는 항목을 걷어내 manualSteps로 옮긴다. 모델이 직접 낸 manualSteps에
 * 이어 붙이므로, 모델이 이미 올바르게 분류했어도(중복 없이) 결정론적 가드가 한 번 더 확인하는 이중 안전망이 된다.
 */
export function partitionManualSteps(requirements: readonly Requirement[], manualSteps: readonly string[] = []): { requirements: Requirement[]; manualSteps: string[] } {
  const kept: Requirement[] = [];
  const moved: string[] = [...manualSteps];
  for (const requirement of requirements) {
    const text = [requirement.title, ...requirement.acceptance].join(' ');
    if (isManualStepText(text)) {
      const detail = requirement.acceptance.length > 0 ? `${requirement.title} — ${requirement.acceptance.join('; ')}` : requirement.title;
      moved.push(detail);
    } else {
      kept.push(requirement);
    }
  }
  return { requirements: kept, manualSteps: moved };
}

export const ExtractionReplySchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1).max(MAX_REQUIREMENTS),
    questions: z.array(z.string().min(1).max(300)).max(MAX_CLARIFYING_QUESTIONS),
    outOfScope: z.array(OutOfScopeItemSchema).max(MAX_OUT_OF_SCOPE).default([]),
    assumptions: z.array(AssumptionSchema).max(MAX_ASSUMPTIONS).default([]),
    /** 코드·문서 밖에서 사람이 손으로 할 절차(저장소 권한·협업자 추가, 이메일 제출 등) — 에이전트는 절대 하지 않는다 */
    manualSteps: z.array(ManualStepItemSchema).max(MAX_MANUAL_STEPS).default([]),
  })
  .refine((value) => new Set(value.requirements.map((requirement) => requirement.id)).size === value.requirements.length, {
    message: '요구사항 id가 중복됩니다',
  });
export type ExtractionReply = z.infer<typeof ExtractionReplySchema>;

export class RequirementsError extends Error {
  /** 추출 호출이 실패해도 그때까지 쓴 토큰과 시간은 남긴다(계획·리뷰 호출과 같은 규칙) */
  usage?: AgentUsage;
  durationMs?: number;
  constructor(message: string) {
    super(message);
    this.name = 'RequirementsError';
  }
}

/** 추출 모델에게 주는 고정 시스템 프롬프트. pr-review.ts와 같은 문체(영어 지시, JSON만 받는다) */
export function buildExtractionSystemPrompt(): string {
  return `You turn a full-stack product spec into a requirements list with concrete, testable acceptance criteria, EARS-style statements, and Given-When-Then scenarios, in the style of GitHub Spec Kit's /specify step and the EARS notation (alistairmavin.com/ears).
You see ONLY the spec text below (it may include a "[참조 파일 요약]" section — compact summaries of files the spec references, such as seed data — and a previous round's answered questions appended at the end) — you have no tools to read the actual project code.
Reply with ONLY a JSON object, no prose before or after:
{"requirements":[{"id":"R1","title":"short title","kind":"api"|"ui"|"data"|"nonfunctional"|"docs","acceptance":["testable criterion", "..."],"priority":"must"|"should"|"could","ears":{"pattern":"ubiquitous"|"event"|"state"|"unwanted"|"optional","statement":"단수 EARS 문장"},"scenarios":[{"id":"R1.1","given":"...","when":"...","then":"..."}],"nfr":{"metric":"...","threshold":"...","condition":"...","method":"..."}}],"questions":["short clarifying question", "..."],"outOfScope":["explicitly excluded item", "..."],"assumptions":["short assumption", "..."],"manualSteps":["procedure a human must do outside the code, verbatim from the spec", "..."]}
Rules:
- manualSteps: put here any step that changes repository/account permissions or settings, NOT code or docs — adding a collaborator, changing repo visibility(private/public), inviting someone, setting branch protection/webhooks/deploy keys/secrets, creating accounts, or submitting/notifying by email or message. These are things a HUMAN does outside this tool, never the coding agent — do NOT turn them into a requirement (even as "could"/optional), no matter how the spec phrases them (e.g. "제출 방법: … collaborator로 추가 … 메일로 제출"). At most ${MAX_MANUAL_STEPS} items, short and verbatim-ish from the spec.
- id: "R1","R2",... in the order requirements appear in the spec. No gaps, no repeats. Keep the SAME id for the SAME requirement across re-extractions when its meaning hasn't materially changed — saved status and evidence are keyed by id, so churn here throws that away.
- title: one short line. Group closely related sub-items under one requirement (e.g. all CRUD endpoints of one resource, or one screen's loading/empty/error/success states) instead of splitting them one-by-one.
- acceptance: 1 or more concrete, testable statements a reviewer could check off without guessing — use the actual inputs/outputs the spec gives (request/response fields, status codes), and for UI list every state the spec implies (loading/empty/error, not just the happy path). Never just restate the title.
- ears: exactly ONE EARS-notation sentence per requirement, ending in "…해야 한다" — and only ONE such clause (never two "해야 한다" joined with "그리고"/","). Pick the pattern that matches: ubiquitous("시스템은 항상 …해야 한다"), event("…하면 시스템은 …해야 한다"), state("…인 동안 시스템은 …해야 한다"), unwanted("…라면 시스템은 …해야 한다" — 이상 상태·오류 처리), optional("…하는 경우 시스템은 …해야 한다" — 있으면 좋은 기능). Never restate the title; use the concrete trigger/condition from the spec.
- scenarios: 1 or more Given-When-Then scenarios, id "{requirement id}.1", "{requirement id}.2", … Use CONCRETE values (실제 필드명·상태 코드·seed 데이터 수치 — "[참조 파일 요약]"이 있으면 그 값을 쓴다), never placeholders like "적절한 값".
- nfr: REQUIRED when kind is "nonfunctional" — metric(측정 지표)·threshold(수치 임계값)·condition(측정 조건 — 동시 사용자 수·부하 등)·method(측정 방법)를 모두 구체적으로 채운다(예: {"metric":"응답 시간","threshold":"300ms 이하","condition":"p95, 동시 요청 50건","method":"k6 부하 테스트"}). Omit "nfr" for other kinds.
- Never use vague/weak words anywhere (in title/acceptance/ears/scenarios/nfr) — 빠르게, 적절히, 사용자 친화적, 등, 기타, 가능하면, 적당히, fast, user-friendly, etc., appropriate, as needed, TBD, quickly 같은 말 대신 항상 구체적인 수치·조건을 쓴다. 정말 정할 수 없으면 그 항목을 "questions"에 "[NEEDS CLARIFICATION] …" 형태로 올려라(요구사항 문장에 모호한 말을 남기지 마라).
- kind: api(서버 엔드포인트·비즈니스 로직), ui(화면·컴포넌트), data(스키마·마이그레이션), nonfunctional(성능·보안·가용성 등 비기능 요구), docs(문서화). Pick the closest one.
- priority: must(빠지면 완성으로 보지 않는다), should(있어야 완성도 있다), could(있으면 좋다, 보너스). Default to "must" unless the spec explicitly marks an item optional/bonus/nice-to-have.
- Never turn a negative statement ("X is not included", "X 미포함", "X는 하지 않는다") into its own requirement — put it in "outOfScope" instead (a short note, not an acceptance criterion). At most ${MAX_OUT_OF_SCOPE} items.
- questions: at most ${MAX_CLARIFYING_QUESTIONS} short clarifying questions about real ambiguities that would change requirements or acceptance criteria (Spec Kit's /clarify and [NEEDS CLARIFICATION] style — do not ask about things the spec already answers). If nothing is ambiguous, reply with an empty array.
- assumptions: at most ${MAX_ASSUMPTIONS} short, concrete assumptions this extraction relied on — data volume (derive it from any "[참조 파일 요약]" you were given, e.g. "seed 데이터 기준 게시글 42건"), expected concurrency/traffic ONLY if the spec itself hints at it, and performance-relevant constraints the spec implies (pagination, indexing). Never assume or ask about server hardware specs. Leave empty if nothing applies.
- Write title/acceptance/ears/scenarios/nfr/questions/outOfScope/assumptions/manualSteps text in Korean. Keep id/kind/priority/pattern values in English exactly as listed above.`;
}

/**
 * 추출 모델에게 주는 사용자 메시지. 스펙 원문 그대로 넘기고(질문 답변이 있으면 스펙 끝에 이미 덧붙여 온다 — "스펙을 고치고 다시 뽑기"),
 * 명세가 참조하는 파일들의 압축 요약이 있으면 뒤에 붙인다(데이터 규모를 지어내지 않고 실제 값으로 가정을 쓰게 한다, ~6,000자 상한은 호출하는 쪽이 이미 잘라 준다)
 */
export function buildExtractionUserPrompt(specText: string, referencedFilesContext?: string): string {
  const context = referencedFilesContext?.trim();
  return `Product spec:\n\n${specText.trim()}${context ? `\n\n[참조 파일 요약]\n${context}` : ''}`;
}

/** 모델 응답에서 JSON을 꺼내 검증한다. 형식이 틀리면 RequirementsError */
/**
 * 엄격한 검사 전에, 모델 답에서 기계적으로 고칠 수 있는 어긋남을 고친다. 3~6분 걸린 답 전체가 사소한 형식 하나로
 * 버려지던 문제(시나리오 id가 요구사항 id와 다름, 질문이 상한보다 많음 등)를 막는다. 뜻을 바꾸는 수정은 하지 않는다:
 * 시나리오 id 앞부분 맞추기(alignScenarioIds), 상한을 넘는 목록 자르기만 한다
 */
export function repairExtractionReply(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const reply = { ...(raw as Record<string, unknown>) };
  // 최상위 목록도 null이면 빈 목록으로 본다(기본값이 있는 항목들)
  for (const key of ['questions', 'outOfScope', 'assumptions', 'manualSteps']) {
    if (reply[key] === null) reply[key] = [];
  }
  const cap = (key: string, max: number) => {
    if (Array.isArray(reply[key]) && (reply[key] as unknown[]).length > max) reply[key] = (reply[key] as unknown[]).slice(0, max);
  };
  cap('requirements', MAX_REQUIREMENTS);
  cap('questions', MAX_CLARIFYING_QUESTIONS);
  cap('outOfScope', MAX_OUT_OF_SCOPE);
  cap('assumptions', MAX_ASSUMPTIONS);
  cap('manualSteps', MAX_MANUAL_STEPS);
  if (Array.isArray(reply.requirements)) {
    reply.requirements = (reply.requirements as unknown[]).map((requirement) => {
      if (!requirement || typeof requirement !== 'object') return requirement;
      const candidate = { ...(requirement as Record<string, unknown>) };
      // 모델은 해당 사항이 없는 선택 항목을 빼지 않고 null로 채우곤 한다("nfr": null). 스키마는 "없음"만 받으므로 지운다
      for (const key of ['ears', 'scenarios', 'nfr', 'trace', 'rev', 'hash', 'revisedAt']) {
        if (candidate[key] === null) delete candidate[key];
      }
      // 문자열 안에 JSON 예시({"items": …})가 이스케이프 없이 들어가면 jsonrepair가 그 부분을 배열 원소(객체)로 떼어 낸다.
      // 인수 조건 목록에 문자열이 아닌 원소가 섞이면, 떨어진 조각을 원래 문장 하나로 다시 붙인다
      if (Array.isArray(candidate.acceptance) && candidate.acceptance.some((item) => typeof item !== 'string')) {
        candidate.acceptance = [candidate.acceptance.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')];
      }
      if (Array.isArray(candidate.scenarios)) {
        if (candidate.scenarios.length > 20) candidate.scenarios = candidate.scenarios.slice(0, 20);
        const scenarios = candidate.scenarios as unknown[];
        const wellFormed = scenarios.every((scenario) => scenario && typeof scenario === 'object' && typeof (scenario as { id?: unknown }).id === 'string');
        if (typeof candidate.id === 'string' && wellFormed) {
          return alignScenarioIds(candidate as { id: string; scenarios: Array<{ id: string }> });
        }
      }
      return candidate;
    });
  }
  return reply;
}

export function parseExtractionReply(text: string): ExtractionReply {
  let raw: unknown;
  try {
    raw = parsePlannerReply(text);
  } catch (error) {
    throw new RequirementsError(error instanceof Error ? error.message : String(error));
  }
  const parsed = ExtractionReplySchema.safeParse(repairExtractionReply(raw));
  if (!parsed.success) {
    throw new RequirementsError(`추출 응답 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  // 모델이 저장소 권한 변경·이메일 제출 같은 "사람이 할 일"을 요구사항으로 잘못 분류했어도 결정론적 가드가 한 번 더 걷어낸다
  const { requirements, manualSteps } = partitionManualSteps(parsed.data.requirements, parsed.data.manualSteps);
  return { ...parsed.data, requirements, manualSteps };
}

/**
 * 추출 모델을 도구 없이 한 번 불러 요구사항·질문을 받는다. 부르는 방법은 바깥에서 준다(ModelAsk) —
 * claude-code 모드는 도구 없는 로컬 CLI 한 번 호출, api 모드는 ModelClient 어댑터(계획·리뷰 호출과 같은 경계).
 */
export async function requestRequirementsExtraction(
  ask: ModelAsk,
  specText: string,
  signal?: AbortSignal,
  referencedFilesContext?: string,
): Promise<ExtractionReply & { usage: AgentUsage; durationMs: number }> {
  const started = performance.now();
  const system = buildExtractionSystemPrompt();
  const user = buildExtractionUserPrompt(specText, referencedFilesContext);
  const first = await ask({ system, user }, signal);
  try {
    return { ...parseExtractionReply(first.text), usage: first.usage, durationMs: Math.round(performance.now() - started) };
  } catch (firstError) {
    if (!(firstError instanceof RequirementsError) || signal?.aborted) throw firstError;
    // 몇 분 걸린 답을 형식 하나로 버리지 않도록, 어디가 틀렸는지 알려 주고 딱 한 번 다시 묻는다(그래도 틀리면 오류)
    const retry = await ask({ system, user: `${user}\n\n${buildExtractionRetryNote(firstError.message)}` }, signal);
    const usage = addUsage(first.usage, retry.usage);
    const durationMs = Math.round(performance.now() - started);
    try {
      return { ...parseExtractionReply(retry.text), usage, durationMs };
    } catch (error) {
      if (error instanceof RequirementsError) {
        error.usage = usage;
        error.durationMs = durationMs;
      }
      throw error;
    }
  }
}

/** 두 번 부른 호출의 사용량을 합친다(다시 물은 비용도 기록에 남긴다) */
function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** 다시 물을 때 덧붙이는 안내. 첫 답이 왜 거절됐는지와, 깨지기 쉬운 지점(문자열 안 큰따옴표)을 짚는다 */
export function buildExtractionRetryNote(reason: string): string {
  return [
    `[이전 답을 쓸 수 없었습니다] ${reason.slice(0, 600)}`,
    '같은 형식의 JSON 객체 하나만 다시 출력하세요. 문자열 안의 큰따옴표는 반드시 \\" 로 이스케이프하거나 작은따옴표·백틱으로 바꾸고, 해당 사항이 없는 선택 항목(ears·scenarios·nfr)은 null 대신 아예 빼세요.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 결정론적 대체 파서 — 추출 모델을 부를 수 없는 백엔드(예: 데모 세션)에서 쓴다.
// 제목(헤딩)·글머리 기호·번호 매긴 줄로 요구사항을 나눈다. 질문은 만들지 못한다(모호함을 판단할 모델이 없다).
// ---------------------------------------------------------------------------

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const NUMBERED_LINE = /^\s*(\d+)[.)]\s+(.+?)\s*$/;
const BULLET_LINE = /^\s*[-*]\s+(.+?)\s*$/;

const KIND_KEYWORDS: ReadonlyArray<[RequirementKind, RegExp]> = [
  ['data', /\b(db|database|schema|migration)\b|데이터베이스|스키마|마이그레이션|테이블/i],
  ['nonfunctional', /performance|security|scalab|availability|latency|성능|보안|가용성|확장성|동시성|응답\s*시간|부하/i],
  ['ui', /\b(ui|component|page|layout|screen)\b|화면|버튼|컴포넌트|페이지|레이아웃/i],
  ['api', /\b(api|endpoint|rest|http)\b|엔드포인트|응답|요청/i],
  ['docs', /문서|readme|docs?\b/i],
];

function guessKind(text: string): RequirementKind {
  for (const [kind, pattern] of KIND_KEYWORDS) {
    if (pattern.test(text)) return kind;
  }
  return 'api';
}

function guessPriority(text: string): RequirementPriority {
  if (/선택\s*사항|보너스|bonus|optional|nice[- ]to[- ]have/i.test(text)) return 'could';
  if (/권장|should|추천/i.test(text)) return 'should';
  return 'must';
}

interface DraftRequirement {
  title: string;
  acceptance: string[];
}

/**
 * 명세 글을 헤딩·번호·글머리 기호 구조로 요구사항 초안으로 나눈다.
 * 헤딩(또는 번호 매긴 줄)을 요구사항 제목으로 보고, 바로 아래 글머리 기호 줄들을 인수 조건으로 모은다.
 * 헤딩 구조가 전혀 없으면(밋밋한 글) 최상위 글머리 기호·번호 줄 하나하나를 요구사항으로 본다.
 */
function draftFromSpec(specText: string): DraftRequirement[] {
  const lines = specText.split(/\r?\n/);
  const drafts: DraftRequirement[] = [];
  let current: DraftRequirement | undefined;

  const flush = () => {
    if (current && current.title.trim()) drafts.push(current);
    current = undefined;
  };

  for (const rawLine of lines) {
    const heading = HEADING_LINE.exec(rawLine);
    if (heading) {
      flush();
      current = { title: heading[2]!, acceptance: [] };
      continue;
    }
    const numbered = NUMBERED_LINE.exec(rawLine);
    if (numbered && !/^\s/.test(rawLine)) {
      flush();
      current = { title: numbered[2]!, acceptance: [] };
      continue;
    }
    const bullet = BULLET_LINE.exec(rawLine);
    if (bullet) {
      if (current) current.acceptance.push(bullet[1]!);
      continue;
    }
    // 들여쓴 번호 줄(하위 항목)은 새 요구사항이 아니라 지금 요구사항의 인수 조건으로 본다
    if (/^\s+\S/.test(rawLine) && current) {
      const indentedNumbered = NUMBERED_LINE.exec(rawLine.trim());
      if (indentedNumbered) current.acceptance.push(indentedNumbered[2]!);
    }
  }
  flush();

  // 헤딩·번호 구조가 하나도 없었으면(모든 줄이 글머리 기호 없는 평문) 문단을 통째로 하나의 요구사항으로 본다
  if (drafts.length === 0) {
    const paragraphs = specText
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    return paragraphs.slice(0, MAX_REQUIREMENTS).map((paragraph) => ({ title: paragraph.split('\n')[0]!.slice(0, 200), acceptance: [paragraph] }));
  }
  return drafts;
}

/**
 * 추출 모델 없이 명세 글을 요구사항으로 바꾼다. 순수 함수 — 헤딩/번호/글머리 기호 구조만 보고 판단하므로
 * 모델보다 거칠지만(질문도 만들지 못한다), 백엔드가 도구 없는 단발 호출을 지원하지 않을 때의 안전망이다.
 */
export function extractRequirementsHeuristically(specText: string): Requirement[] {
  const drafts = draftFromSpec(specText).slice(0, MAX_REQUIREMENTS);
  return drafts.map((draft, index) => {
    const title = draft.title.trim().slice(0, 200) || `요구사항 ${index + 1}`;
    const acceptance = draft.acceptance.length > 0 ? draft.acceptance.map((line) => line.slice(0, 500)) : [`${title}대로 동작한다`];
    const combined = `${title} ${acceptance.join(' ')}`;
    return {
      id: `R${index + 1}`,
      title,
      kind: guessKind(combined),
      acceptance,
      priority: guessPriority(combined),
    };
  });
}

// ---------------------------------------------------------------------------
// 참조 파일: 명세가 가리키는 경로(seed/seed.json, docs/api.md, openapi.yaml, schema.sql 등)를 찾아
// 존재 여부·크기·미리보기를 붙인다(sessions.ts가 실제 파일을 읽어 이 모양으로 만든다 — 여기 함수는 순수하다).
// ---------------------------------------------------------------------------

/** 경로처럼 보이는 낱말(디렉터리/파일.확장자 또는 파일.확장자)을 명세 글에서 찾는다. URL의 일부(도메인/경로)는 건너뛴다 */
const PATH_LIKE_REFERENCE = /\b(?:[\w.-]+\/)*[\w-]+\.(?:json|ya?ml|sql|md|csv|txt|env|proto|graphql)\b/gi;

export function extractPathReferences(specText: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const match of specText.matchAll(PATH_LIKE_REFERENCE)) {
    const index = match.index ?? 0;
    const before = specText.slice(Math.max(0, index - 10), index);
    if (before.includes('://')) continue; // https://example.com/page.json 같은 URL의 경로 부분은 참조 파일이 아니다
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push(raw);
  }
  return results;
}

export interface ReferencedFile {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  /** JSON이면 최상위 키·배열 길이 요약("posts 42개, comments 2,076개"), 그 밖은 앞 몇 줄 */
  preview?: string;
}

function firstLinesPreview(content: string, maxLines = 5, maxChars = 300): string {
  const joined = content
    .split(/\r?\n/)
    .slice(0, maxLines)
    .join('\n')
    .trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

/** JSON 파일의 최상위 모양을 요약한다(실제 요약은 json-summary.ts가 한다). JSON이 아니면 앞 몇 줄로 대신한다 */
export function summarizeJsonPreview(content: string): string {
  return summarizeJsonContent(content) ?? firstLinesPreview(content);
}

/** 존재하는 참조 파일 하나의 미리보기를 만든다(내용·크기는 호출하는 쪽이 읽어서 준다 — 이 함수는 파일 IO를 하지 않는다) */
export function buildReferencedFilePreview(path: string, content: string, sizeBytes: number): ReferencedFile {
  return { path, exists: true, sizeBytes, preview: /\.json$/i.test(path) ? summarizeJsonPreview(content) : firstLinesPreview(content) };
}

/** 추출 모델에게 알려줄 게 없는 참조 파일(없음)을 만든다 */
export function missingReferencedFile(path: string): ReferencedFile {
  return { path, exists: false };
}

/** "이 요구사항이 참조한 파일이 작업 복사본에 없다"는 모호함을 질문 목록에 자연스럽게 올린다 */
export function buildMissingReferenceQuestion(path: string): string {
  return `참조한 파일 ${path}이(가) 작업 복사본에 없습니다. 어디서 가져와야 하나요, 아니면 새로 만들어야 하나요?`;
}

/** 참조 파일 미리보기는 요약이면 충분하다 — 아주 큰 파일(시드 데이터 등)도 존재·크기만 보고하고 앞부분만 읽어 요약한다 */
const REFERENCE_FILE_TOO_BIG = /너무 큽니다 \((\d+) bytes\)/;

/**
 * 명세 글이 경로처럼 언급한 파일(`extractPathReferences`)을 주어진 루트(세션 작업 복사본)에서 찾는다.
 * `Workspace`를 그대로 써서 프로젝트 밖 경로·.env 같은 비밀 파일은 다른 도구와 똑같이 막는다. 없으면 missing,
 * 있으면 크기·미리보기를 담는다(너무 큰 파일은 크기만 보고하고 미리보기는 만들지 않는다).
 */
export async function resolveReferencedFiles(root: string, specText: string): Promise<ReferencedFile[]> {
  const workspace = new Workspace(root);
  const files: ReferencedFile[] = [];
  for (const path of extractPathReferences(specText)) {
    try {
      const content = await workspace.read(path);
      files.push(buildReferencedFilePreview(path, content, Buffer.byteLength(content, 'utf8')));
    } catch (error) {
      const tooBig = error instanceof WorkspaceError ? REFERENCE_FILE_TOO_BIG.exec(error.message) : null;
      if (tooBig) {
        const sizeBytes = Number(tooBig[1]);
        // 256KB 상한에 걸려도 JSON이면 구조만(최상위 키·배열 길이·첫 항목 필드) 요약해 보려 한다(json-summary.ts)
        const summary = await summarizeLargeJsonFile(root, path, sizeBytes);
        files.push({ path, exists: true, sizeBytes, preview: summary ?? '(파일이 커서 미리보기를 만들지 못했습니다)' });
        continue;
      }
      files.push(missingReferencedFile(path));
    }
  }
  return files;
}

/** 참조 파일 상한(전체 글자 수 기준). "seed/seed.json" 같은 큰 시드 파일을 통째로 넣지 않고 요약만 잘라 넣는다 */
export const REFERENCED_FILES_CONTEXT_MAX_CHARS = 6_000;

/** 참조 파일 목록을 추출 모델 문맥에 붙일 압축 텍스트로 만든다. 상한을 넘으면 앞에서부터 채우고 자른다 */
export function buildReferencedFilesContext(files: readonly ReferencedFile[], maxChars: number = REFERENCED_FILES_CONTEXT_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const file of files) {
    const line = file.exists ? `- ${file.path} (${file.sizeBytes ?? 0} bytes): ${file.preview ?? ''}` : `- ${file.path}: 파일 없음`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 모호한 점에 추천 값 채우기: 업계 관례에 근거한 답·근거·출처를 한 번 더 묻는다(ModelAsk 재사용).
// claude-code 백엔드는 이 호출에 한해 WebSearch/WebFetch만 여는 선택적 경로가 있다(claude-code-ask.ts의 webTools) —
// 그 경로가 없는 api 백엔드나 도구가 없을 때는 모델 지식만으로 답하고, 호출하는 쪽(studio)이 "출처 확인 필요"로 표시한다.
// ---------------------------------------------------------------------------

export const RecommendationSourceSchema = z.object({
  url: z.string().min(1).max(500),
  title: z.string().min(1).max(200).optional(),
});

export const RecommendationSchema = z.object({
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(500),
  rationale: z.string().min(1).max(300),
  sources: z.array(RecommendationSourceSchema).max(2).default([]),
  /** 'spec'이면 명세(또는 참조 파일)가 이미 답을 정해 준 경우, 'practice'면 명세가 열어 둔 부분이라 업계 관례로 채운 경우 */
  basis: z.enum(['spec', 'practice']).catch('practice'),
  /** basis가 'spec'일 때만 있다 — 명세 원문에서 그대로 가져온 근거 문장(서버가 specText에 실제로 있는지 검증한다) */
  specQuote: z.string().min(1).max(500).optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RecommendationReplySchema = z.object({
  recommendations: z.array(RecommendationSchema).min(1).max(MAX_CLARIFYING_QUESTIONS),
});
export type RecommendationReply = z.infer<typeof RecommendationReplySchema>;

/** 추천 답에 실제 웹 검색이 쓰였는지에 따라 화면이 보여줄 라벨을 정한다(model이면 "출처 확인 필요") */
export function labelRecommendationSource(webSearchAvailable: boolean): 'web' | 'model' {
  return webSearchAvailable ? 'web' : 'model';
}

export function buildRecommendationSystemPrompt(webSearchAvailable: boolean): string {
  return `You recommend concrete answers to open questions about a product spec.
${webSearchAvailable ? 'You have WebSearch/WebFetch — use them to find real, current sources for questions the spec leaves open.' : 'You have no tools — answer from what you already know for questions the spec leaves open.'}
Reply with ONLY a JSON object, no prose before or after:
{"recommendations":[{"question":"<one of the given questions, verbatim>","answer":"recommended value/decision","rationale":"one-line reason","basis":"spec"|"practice","specQuote":"verbatim sentence from the spec — only when basis is spec","sources":[{"url":"https://...","title":"optional short title"}]}]}
Rules:
- Cover every question given, in the same order, "question" matching the input verbatim.
- SPEC FIRST: if the spec text (or a "[참조 파일 요약]"/"[프로젝트 스택]" section given below) already answers, constrains, or implies the answer, your "answer" MUST follow it exactly — NEVER recommend anything that contradicts a rule the spec states (a field/response shape it shows verbatim, a data format, a database engine or framework already in "[프로젝트 스택]"). Set "basis":"spec" and "specQuote" to the exact sentence (a verbatim substring you can point to) that governs it.
- Only use "basis":"practice" (industry-practice default, no specQuote) for what the spec genuinely leaves open.
- If "[프로젝트 스택]" names a database/framework/language, your recommendation must match it (e.g. never suggest MySQL-only syntax when the stack says PostgreSQL, never suggest a different field name than one the spec's example already shows).
- answer: a concrete, usable default a competent engineer would pick absent more context (not "it depends").
- rationale: one short line, in Korean.
- sources: ${webSearchAvailable ? 'up to 2 real links you found via web search just now (prefer official docs/specs over blog posts) — only for "basis":"practice" items, since "basis":"spec" already has its source (specQuote)' : 'leave empty — without a tool call you cannot verify a link, so do not invent one'}.
- Write answer/rationale in Korean. Keep JSON keys and basis values in English exactly as listed above.`;
}

export function buildRecommendationUserPrompt(questions: readonly string[], specText: string, stackSummary?: string): string {
  const list = questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
  const stackLine = stackSummary?.trim() ? `\n\n[프로젝트 스택]\n${stackSummary.trim()}` : '';
  return `Product spec:\n\n${specText.trim()}${stackLine}\n\nOpen questions:\n${list}`;
}

function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** specQuote가 실제로 specText 안에 있는 문장인지(공백 정규화 후 부분 문자열로) 확인한다 — 지어낸 인용을 막는다 */
export function verifySpecQuote(specQuote: string, specText: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(specQuote);
  if (!normalizedQuote) return false;
  return normalizeForQuoteMatch(specText).includes(normalizedQuote);
}

/**
 * basis가 'spec'인데 specQuote가 없거나 specText에 실제로 없으면(모델이 지어낸 인용) 'practice'로 강등하고
 * specQuote를 지운다 — "명세에 있음" 배지는 검증된 인용에만 붙어야 한다.
 */
function enforceSpecQuoteEvidence(recommendations: readonly Recommendation[], specText: string): Recommendation[] {
  return recommendations.map((recommendation) => {
    if (recommendation.basis !== 'spec') return recommendation;
    if (recommendation.specQuote && verifySpecQuote(recommendation.specQuote, specText)) return recommendation;
    const { specQuote: _drop, ...rest } = recommendation;
    return { ...rest, basis: 'practice' as const };
  });
}

/**
 * 추천 응답을 파싱한다. specText를 주면(운영 경로는 항상 준다) "명세에 있음" 인용을 검증해 지어낸 인용을 걸러낸다
 * (enforceSpecQuoteEvidence) — specText를 생략하면(과거 호출 호환) 검증 없이 파싱만 한다.
 */
export function parseRecommendationReply(text: string, specText?: string): RecommendationReply {
  let raw: unknown;
  try {
    raw = parsePlannerReply(text);
  } catch (error) {
    throw new RequirementsError(error instanceof Error ? error.message : String(error));
  }
  const parsed = RecommendationReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequirementsError(`추천 응답 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  if (specText === undefined) return parsed.data;
  return { recommendations: enforceSpecQuoteEvidence(parsed.data.recommendations, specText) };
}

/** 추천 모델을 도구 없이(또는 claude-code 한정 웹 도구만 열고) 한 번 불러 질문마다 추천 답·근거·출처를 받는다 */
export async function requestQuestionRecommendations(
  ask: ModelAsk,
  questions: readonly string[],
  specText: string,
  webSearchAvailable: boolean,
  signal?: AbortSignal,
  stackSummary?: string,
): Promise<RecommendationReply & { usage: AgentUsage; durationMs: number }> {
  const started = performance.now();
  const answer = await ask({ system: buildRecommendationSystemPrompt(webSearchAvailable), user: buildRecommendationUserPrompt(questions, specText, stackSummary) }, signal);
  const durationMs = Math.round(performance.now() - started);
  const { text, usage } = answer;
  try {
    return { ...parseRecommendationReply(text, specText), usage, durationMs };
  } catch (error) {
    if (error instanceof RequirementsError) {
      error.usage = usage;
      error.durationMs = durationMs;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 사람이 읽는 마크다운 저장/불러오기(docs/requirements.md)
// ---------------------------------------------------------------------------

/** 세션 작업 복사본에 쓰는 자리. 체크포인트 diff·PR·다음 세션에 그대로 남는다(=제출물의 일부) */
export const REQUIREMENTS_FILE = 'docs/requirements.md';

/**
 * "재확인 필요"는 검증됨보다 낮은 확신으로 다룬다(requirementConfidence) — 내용이 바뀐 뒤 아직 새 증거로
 * 다시 확인되지 않은 상태다(Doorstop/sphinx-needs류 도구의 "suspect" 링크와 같은 개념).
 */
export type RequirementStatus = '미착수' | '작업 중' | '검증됨' | '재확인 필요' | '실패';
export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ['미착수', '작업 중', '검증됨', '재확인 필요', '실패'];

export const JSON_BLOCK = /<!--\s*b-studio-requirements\s*([\s\S]*?)-->/;

function requirementHeading(requirement: Requirement): string {
  return `## ${requirement.id}. ${requirement.title}`;
}

const KIND_PRIORITY_LINE = /^-\s*종류:\s*(\S+)\s*·\s*우선순위:\s*(\S+)(?:\s*·\s*개정:\s*(\d+))?\s*$/;
const EARS_LINE = /^-\s*EARS\((ubiquitous|event|state|unwanted|optional)\):\s*(.+?)\s*$/;
const SCENARIOS_HEADER = /^-\s*시나리오:\s*$/;
const SCENARIO_ITEM = /^\s+-\s+(R[1-9][0-9]*\.[1-9][0-9]*):\s*\(Given\)\s*(.+?)\s*\(When\)\s*(.+?)\s*\(Then\)\s*(.+?)\s*$/;
const ACCEPTANCE_HEADER = /^-\s*인수\s*조건:\s*$/;
const ACCEPTANCE_ITEM = /^\s+-\s+(.+?)\s*$/;
const NFR_LINE = /^-\s*NFR:\s*지표\s+(.+?)\s*·\s*임계값\s+(.+?)\s*·\s*조건\s+(.+?)\s*·\s*측정\s+(.+?)\s*$/;
const TRACE_LINE = /^-\s*추적:\s*(.+?)\s*$/;
/** "- 확인: 범수 · 2026-10-01 · 체크포인트 c57d72f · 메모 무엇을 어떻게 확인했나" */
export const MANUAL_VERIFICATION_LINE = /^-\s*확인:\s*(.+?)\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*체크포인트\s+(\S+)\s*·\s*메모\s+(.+?)\s*$/;
export const REQUIREMENT_HEADING = /^##\s+(R[1-9][0-9]*)\.\s*(.+?)\s*$/;
const ASSUMPTIONS_HEADING = /^##\s*가정\s*$/;
const ASSUMPTION_ITEM = /^-\s+(.+?)\s*$/;
/**
 * "사람이 할 일" 절 헤딩. 괄호 안의 문구("에이전트 금지" 등)는 자유다 — 헤딩 첫 낱말만 확인한다.
 * 한글 글자는 JS 정규식의 \w(아스키 전용)에 들지 않아 \b가 한글-한글 경계에서는 전혀 서지 않으므로(둘 다
 * "단어 아님"이라 경계가 생기지 않는다) 끝에 \b를 붙이지 않는다 — "일" 뒤에 공백이 오든 괄호가 오든 그대로 맞는다.
 */
const MANUAL_STEPS_HEADING = /^##\s*사람이\s*할\s*일/;

/** "- 추적: 이슈 #12 · 의존 R2, R3 · 대체 R1" 같은 줄의 본문(맨 앞 "- 추적: " 제거분)을 Trace로 되돌린다. 알아볼 조각이 없으면 undefined */
function parseTraceLine(content: string): Trace | undefined {
  const trace: Trace = {};
  const issueMatch = /이슈\s*#(\d+)/.exec(content);
  if (issueMatch) trace.issue = Number(issueMatch[1]);
  const dependsMatch = /의존\s+([R0-9.,\s]+?)(?=\s*·|$)/.exec(content);
  if (dependsMatch) {
    const ids = dependsMatch[1]!
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (ids.length > 0) trace.dependsOn = ids;
  }
  const supersedesMatch = /대체\s+(R[1-9][0-9]*)/.exec(content);
  if (supersedesMatch) trace.supersedes = supersedesMatch[1];
  return Object.keys(trace).length > 0 ? trace : undefined;
}

/** "## 가정" 절 바로 아래의 글머리 기호 줄만 모은다. 다음 "##" 헤딩을 만나면 멈춘다(사람이 절을 통째로 지웠으면 빈 배열) */
function extractAssumptionsSection(lines: readonly string[]): string[] {
  const assumptions: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (ASSUMPTIONS_HEADING.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^##\s+/.test(line)) {
      collecting = false;
      continue;
    }
    const item = ASSUMPTION_ITEM.exec(line);
    if (item) assumptions.push(item[1]!);
  }
  return assumptions;
}

/**
 * "## 사람이 할 일" 절 바로 아래의 글머리 기호 줄만 모은다(같은 모양, extractAssumptionsSection과 동형).
 * 이 절은 요구사항이 아니다 — parseRequirementsMarkdown의 본문 요구사항 파싱과는 완전히 별개로 읽는다.
 */
function extractManualStepsSection(lines: readonly string[]): string[] {
  const steps: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (MANUAL_STEPS_HEADING.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^##\s+/.test(line)) {
      collecting = false;
      continue;
    }
    const item = ASSUMPTION_ITEM.exec(line);
    if (item) steps.push(item[1]!);
  }
  return steps;
}

/** 요구사항 하나의 몸통 줄(헤딩·상태 줄 제외)을 만든다. rev·ears·scenarios·nfr·trace는 있을 때만 줄을 더한다(옛 문서와 같은 모양을 유지한다) */
function requirementBodyLines(requirement: Requirement): string {
  const acceptance = requirement.acceptance.map((item) => `  - ${item}`).join('\n');
  const revPart = requirement.rev !== undefined ? ` · 개정: ${requirement.rev}` : '';
  const lines = [`- 종류: ${requirement.kind} · 우선순위: ${requirement.priority}${revPart}`];
  if (requirement.ears) lines.push(`- EARS(${requirement.ears.pattern}): ${requirement.ears.statement}`);
  if (requirement.scenarios && requirement.scenarios.length > 0) {
    lines.push('- 시나리오:');
    for (const scenario of requirement.scenarios) {
      lines.push(`  - ${scenario.id}: (Given) ${scenario.given} (When) ${scenario.when} (Then) ${scenario.then}`);
    }
  }
  lines.push(`- 인수 조건:\n${acceptance}`);
  if (requirement.nfr) {
    lines.push(`- NFR: 지표 ${requirement.nfr.metric} · 임계값 ${requirement.nfr.threshold} · 조건 ${requirement.nfr.condition} · 측정 ${requirement.nfr.method}`);
  }
  if (requirement.trace) {
    const bits: string[] = [];
    if (requirement.trace.issue !== undefined) bits.push(`이슈 #${requirement.trace.issue}`);
    if (requirement.trace.dependsOn && requirement.trace.dependsOn.length > 0) bits.push(`의존 ${requirement.trace.dependsOn.join(', ')}`);
    if (requirement.trace.supersedes) bits.push(`대체 ${requirement.trace.supersedes}`);
    if (bits.length > 0) lines.push(`- 추적: ${bits.join(' · ')}`);
  }
  if (requirement.manualVerification) {
    const { by, at, sha, note } = requirement.manualVerification;
    lines.push(`- 확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}`);
  }
  return lines.join('\n');
}

/**
 * 요구사항 목록을 사람이 읽는 마크다운으로 바꾼다: 요구사항마다 헤딩·종류/우선순위/개정·(있으면) EARS·시나리오·인수
 * 조건·(있으면) NFR·추적·상태 줄을 두고, assumptions가 있으면 "## 가정" 절을, manualSteps가 있으면 "## 사람이 할 일
 * (에이전트 금지)" 절(저장소 권한·협업자 추가, 이메일 제출 같은 절차 — 요구사항이 아니다)을 이어 붙이고, 끝에 안정적으로
 * 다시 읽을 수 있는 HTML 주석 JSON 블록(requirements·assumptions·manualSteps, hash·revisedAt까지 포함한 전체 필드)을 붙인다.
 * statusById에 없는 요구사항은 "미착수"로 쓴다(상태는 저장 시점의 스냅샷일 뿐이고, 다시 읽을 때는 증거로 새로 계산한다).
 */
export function serializeRequirementsMarkdown(
  requirements: readonly Requirement[],
  statusById: Readonly<Record<string, RequirementStatus>> = {},
  assumptions: readonly string[] = [],
  manualSteps: readonly string[] = [],
): string {
  const blocks = requirements.map((requirement) => {
    const status = statusById[requirement.id] ?? '미착수';
    return `${requirementHeading(requirement)}\n${requirementBodyLines(requirement)}\n- 상태: ${status}`;
  });
  const assumptionsBlock = assumptions.length > 0 ? `\n\n## 가정\n${assumptions.map((item) => `- ${item}`).join('\n')}` : '';
  const manualStepsBlock =
    manualSteps.length > 0 ? `\n\n## 사람이 할 일 (에이전트 금지)\n${manualSteps.map((item) => `- ${item}`).join('\n')}` : '';
  const json = JSON.stringify(
    {
      requirements: requirements.map(({ id, title, kind, priority, acceptance, rev, ears, scenarios, nfr, trace, hash, revisedAt, manualVerification }) => ({
        id,
        title,
        kind,
        priority,
        acceptance,
        ...(rev !== undefined ? { rev } : {}),
        ...(ears ? { ears } : {}),
        ...(scenarios ? { scenarios } : {}),
        ...(nfr ? { nfr } : {}),
        ...(trace ? { trace } : {}),
        ...(hash !== undefined ? { hash } : {}),
        ...(revisedAt !== undefined ? { revisedAt } : {}),
        ...(manualVerification ? { manualVerification } : {}),
      })),
      assumptions,
      manualSteps,
    },
    null,
    2,
  );
  return `# 요구사항\n\n${blocks.join('\n\n')}${assumptionsBlock}${manualStepsBlock}\n\n<!-- b-studio-requirements\n${json}\n-->\n`;
}

const LEGACY_JSON_BLOCK = z.array(RequirementSchema);
const JSON_BLOCK_SHAPE = z.object({
  requirements: z.array(RequirementSchema),
  assumptions: z.array(AssumptionSchema).optional(),
  manualSteps: z.array(ManualStepItemSchema).optional(),
});

/**
 * 몸통에서 읽지 못하는(또는 몸통에 아예 줄이 없는 옛 문서의) 기술 메타데이터 — hash·revisedAt은 몸통에 절대 쓰지 않으므로
 * 항상 JSON 블록에서만 채운다. rev·ears·scenarios·nfr·trace는 몸통 값을 우선하고(사람이 손으로 고쳤을 수 있다),
 * 몸통에 그 줄이 아예 없을 때만 JSON 블록 값으로 메운다.
 */
function mergeExtendedFieldsFromJsonBlock(requirements: readonly Requirement[], raw: string): Requirement[] {
  const jsonMatch = JSON_BLOCK.exec(raw);
  if (!jsonMatch) return [...requirements];
  let byId = new Map<string, Requirement>();
  try {
    const shaped = JSON_BLOCK_SHAPE.safeParse(JSON.parse(jsonMatch[1]!));
    if (shaped.success) byId = new Map(shaped.data.requirements.map((requirement) => [requirement.id, requirement]));
  } catch {
    return [...requirements];
  }
  return requirements.map((requirement) => {
    const stored = byId.get(requirement.id);
    if (!stored) return requirement;
    return {
      ...requirement,
      rev: requirement.rev ?? stored.rev,
      ears: requirement.ears ?? stored.ears,
      scenarios: requirement.scenarios ?? stored.scenarios,
      nfr: requirement.nfr ?? stored.nfr,
      trace: requirement.trace ?? stored.trace,
      hash: stored.hash,
      revisedAt: stored.revisedAt,
      manualVerification: requirement.manualVerification ?? stored.manualVerification,
    };
  });
}

/**
 * docs/requirements.md를 다시 읽는다. 사람이 헤딩·제목·인수 조건·EARS·시나리오·NFR·추적을 손으로 고쳐도(구조 표지 —
 * "## R1.", "종류: … · 우선순위: …", "인수 조건:" 등 — 는 그대로 둔 채) 그 값을 그대로 반영한다(사람 편집을 우선한다).
 * hash·revisedAt은 몸통에 없는 값이라 항상 끝의 JSON 블록에서 채운다(mergeExtendedFieldsFromJsonBlock). "## 가정" 절도
 * 같은 자리에서 읽되, 절이 통째로 지워졌으면 가정 없음으로 본다. 구조가 깨져 요구사항을 하나도 못 읽으면 끝의 JSON 블록
 * (마지막으로 저장한 값, 새 형식 {requirements, assumptions}·이 기능 전에 저장된 옛 형식 배열 둘 다 읽는다)으로 되돌아간다.
 * 둘 다 실패하면 빈 배열을 돌려준다 — 호출하는 쪽이 "명세를 다시 뽑아 주세요"로 안내한다.
 */
export function parseRequirementsMarkdown(raw: string): { requirements: Requirement[]; assumptions: string[]; manualSteps: string[] } {
  const withoutJsonBlock = raw.replace(JSON_BLOCK, '');
  const lines = withoutJsonBlock.split(/\r?\n/);
  const drafts: Array<{
    id: string;
    title: string;
    kind?: string;
    priority?: string;
    acceptance: string[];
    rev?: number;
    ears?: Ears;
    scenarios?: Scenario[];
    nfr?: Nfr;
    trace?: Trace;
    manualVerification?: ManualVerification;
  }> = [];
  let current: (typeof drafts)[number] | undefined;
  let collectingAcceptance = false;
  let collectingScenarios = false;

  for (const line of lines) {
    const heading = REQUIREMENT_HEADING.exec(line);
    if (heading) {
      if (current) drafts.push(current);
      current = { id: heading[1]!, title: heading[2]!, acceptance: [] };
      collectingAcceptance = false;
      collectingScenarios = false;
      continue;
    }
    if (!current) continue;

    const kindLine = KIND_PRIORITY_LINE.exec(line);
    if (kindLine) {
      current.kind = kindLine[1];
      current.priority = kindLine[2];
      if (kindLine[3]) current.rev = Number(kindLine[3]);
      collectingAcceptance = false;
      collectingScenarios = false;
      continue;
    }

    const earsLine = EARS_LINE.exec(line);
    if (earsLine) {
      current.ears = { pattern: earsLine[1] as EarsPattern, statement: earsLine[2]! };
      collectingAcceptance = false;
      collectingScenarios = false;
      continue;
    }

    if (SCENARIOS_HEADER.test(line)) {
      collectingScenarios = true;
      collectingAcceptance = false;
      continue;
    }
    if (collectingScenarios) {
      const item = SCENARIO_ITEM.exec(line);
      if (item) {
        current.scenarios ??= [];
        current.scenarios.push({ id: item[1]!, given: item[2]!, when: item[3]!, then: item[4]! });
        continue;
      }
      collectingScenarios = false;
      // 시나리오 절 바로 다음 줄(보통 "인수 조건:")도 이어서 검사해야 하므로 여기서 멈추지 않고 아래로 흐른다
    }

    if (ACCEPTANCE_HEADER.test(line)) {
      collectingAcceptance = true;
      continue;
    }
    if (collectingAcceptance) {
      const item = ACCEPTANCE_ITEM.exec(line);
      if (item) {
        current.acceptance.push(item[1]!);
        continue;
      }
      collectingAcceptance = false;
      // 인수 조건 절 바로 다음 줄(NFR·추적)도 이어서 검사해야 하므로 여기서 멈추지 않고 아래로 흐른다
    }

    const nfrLine = NFR_LINE.exec(line);
    if (nfrLine) {
      current.nfr = { metric: nfrLine[1]!, threshold: nfrLine[2]!, condition: nfrLine[3]!, method: nfrLine[4]! };
      continue;
    }

    const traceLine = TRACE_LINE.exec(line);
    if (traceLine) {
      const trace = parseTraceLine(traceLine[1]!);
      if (trace) current.trace = trace;
      continue;
    }

    const manualVerificationLine = MANUAL_VERIFICATION_LINE.exec(line);
    if (manualVerificationLine) {
      current.manualVerification = { by: manualVerificationLine[1]!, at: manualVerificationLine[2]!, sha: manualVerificationLine[3]!, note: manualVerificationLine[4]! };
    }
  }
  if (current) drafts.push(current);

  const parsedFromMarkdown = drafts.map((draft) => RequirementSchema.safeParse(draft));
  if (drafts.length > 0 && parsedFromMarkdown.every((result) => result.success)) {
    const requirements = mergeExtendedFieldsFromJsonBlock(
      parsedFromMarkdown.map((result) => (result as z.ZodSafeParseSuccess<Requirement>).data),
      raw,
    );
    return { requirements, assumptions: extractAssumptionsSection(lines), manualSteps: extractManualStepsSection(lines) };
  }

  const jsonMatch = JSON_BLOCK.exec(raw);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[1]!);
      const shaped = JSON_BLOCK_SHAPE.safeParse(json);
      if (shaped.success) return { requirements: shaped.data.requirements, assumptions: shaped.data.assumptions ?? [], manualSteps: shaped.data.manualSteps ?? [] };
      const legacy = LEGACY_JSON_BLOCK.safeParse(json);
      if (legacy.success) return { requirements: legacy.data, assumptions: [], manualSteps: [] };
    } catch {
      // 주석 블록도 사람이 손으로 깨뜨렸을 수 있다 — 아래에서 빈 배열로 마무리한다
    }
  }
  return { requirements: [], assumptions: [], manualSteps: [] };
}

// ---------------------------------------------------------------------------
// 추적: 체크포인트·테스트·게이트 결과에서 증거를 모아 상태를 매긴다
// ---------------------------------------------------------------------------

export interface CheckpointRef {
  sha: string;
  shortSha: string;
  /** 커밋 메시지 전체(제목+본문). "요청: [R3] …" 형태로 id가 들어가거나, "Implements: R3@rev2" 트레일러가 들어간다 */
  message: string;
  /** 커밋 시각(ISO 8601, git `%cI`). 있으면 "개정 후 새 증거인지"(재확인 필요 해제) 판정에 쓴다 */
  createdAt?: string;
}

export interface TestMatch {
  file: string;
  name: string;
}

export interface GateCheckResult {
  name: string;
  ok: boolean;
}

/**
 * "테스트" 탭(ADR-084)이 지금 체크포인트(HEAD)에서 돌린 결과 중 이 요구사항 id가 붙은 테스트 행을 모은 증거 하나
 * (studio의 sessions.ts가 체크포인트 SHA가 같고 커밋하지 않은 변경이 없을 때만 만든다 — 그 밖의 실행은 "증거 없음"으로 본다).
 * 게이트가 test 단계를 돌리지 않은 세션도(사람이 테스트 탭에서 직접 "전체 실행"을 눌렀을 뿐이라도) 이 증거로
 * 검증됨/실패를 매길 수 있다.
 */
export interface TestRunEvidence {
  /** 실행 시각(ISO 8601). "근거 보기"가 사람이 읽는 시각으로 보여준다 */
  at: string;
  sha: string;
  shortSha: string;
  /** 이 요구사항 id가 붙은 테스트 중 통과한 수 */
  passed: number;
  /** 이 요구사항 id가 붙은 테스트 중 실패한 수. 하나라도 있으면 "실패"로 매긴다 */
  failed: number;
}

/**
 * 문서(docs/requirements.md가 아니라 README.md·docs/**\/*.md 같은 프로젝트 문서) 안에서 요구사항의 인수 조건을
 * 찾은 결과(ADR-103). kind: 'docs' 요구사항은 테스트·게이트가 돌지 않으므로, README 제목·문단에서 인수 조건이
 * 말하는 내용을 찾았는지로 대신 증거를 삼는다. apps/studio/lib/submission-checklist.ts의 matchAcceptanceAgainstDocs가
 * 만든다(README 항목 탐지를 그 모듈과 공유한다) — 이 모듈(packages/agent)은 파일을 읽지 않는 순수 함수만 두므로
 * 매칭 결과를 데이터로만 받는다.
 */
export interface DocEvidence {
  /** 매칭을 시도한 인수 조건 줄 */
  matched: string[];
  /** 문서에서 찾지 못한 인수 조건 줄("근거 보기"가 "빠진 조건"으로 보여준다) */
  missing: string[];
  /** matched.length === matched.length + missing.length && 그 합이 0보다 클 때 */
  satisfied: boolean;
  /** "README.md(설계 결정, 상태 설계)" 같은 한 줄 출처 요약. 하나도 못 찾았으면 없다 */
  sourceSummary?: string;
}

export interface RequirementEvidence {
  checkpoints: CheckpointRef[];
  tests: TestMatch[];
  gateChecks: GateCheckResult[];
  /** 테스트 탭 실행 증거(있으면). 게이트 확인(gateChecks)이 있으면 그쪽을 우선한다(기존 규칙 그대로) */
  testRun?: TestRunEvidence;
  /** kind: 'docs' 요구사항의 문서 매칭 증거(있으면) */
  docEvidence?: DocEvidence;
  /**
   * 요구사항에 시나리오가 있는데 아직 자동 근거(테스트·게이트)로 확인되지 않은 시나리오 id(`findUnverifiedScenarioIds`).
   * 비어 있지 않으면 테스트·게이트 근거만으로는 "검증됨"이 되지 않고 "작업 중"에 머문다(ADR-155, ADR-147 결정 2를 대체).
   * 문서 확인·사람 확인은 이 목록이 남아 있어도 검증됨을 만든다(그때 출처는 문서·사람 확인으로 표시한다).
   * 시나리오가 없거나 전부 확인됐으면 없다(빈 배열을 넣지 않는다).
   */
  missingScenarios?: string[];
  /**
   * 요구사항 id가 붙은 테스트 중 지금 체크포인트의 게이트 실행에 결과가 하나도 없는 것(다그푸딩 마찰 152,
   * `findUnexecutedTests`). 상태(computeRequirementStatus)는 바꾸지 않고 근거로만 보여준다 — "검증됨"이라도
   * 이 목록이 있으면 그 테스트는 이번 판정에 실제로 기여하지 않았다는 뜻이다. 없으면 없다(빈 배열을 넣지 않는다).
   */
  unexecutedTests?: UnexecutedTestInfo[];
}

/** 요구사항 id가 붙었지만 지금 체크포인트에서 돈 게이트 실행 결과에 나타나지 않은 테스트 하나(다그푸딩 마찰 152) */
export interface UnexecutedTestInfo {
  file: string;
  name: string;
  /**
   * test-discovery.ts가 정적으로 찾은 실행 환경 조건부 표시(JUnit `@Tag`·`@Testcontainers`·`@EnabledIf…` 류,
   * pytest 커스텀 마커)를 "·"로 이어 붙인 추정 사유. 어디까지나 추정이다 — 실제로 그래서 안 돈 것인지 b-studio는
   * 확인하지 않는다. 아무 표시도 못 찾았으면 없다
   */
  reason?: string;
}

/**
 * "R1~R32"·"R1-R32"·"R1–R32"(en dash)처럼 두 id를 구두점으로 이은 범위 표기. `requirementRangeLabel`(studio의
 * sessions.ts)가 "여러 요구사항을 한 번에 저장했다"는 커밋 메시지 범위 라벨로 바로 이 모양을 쓴다 — 그 라벨의
 * 양 끝 id(R1·R32)는 "그 id를 직접 작업했다"는 자유 언급이 아니라 "저장한 전체 범위가 이만큼"이라는 집계일
 * 뿐이라, findMentionedIds가 걸러야 한다(다그푸딩 마찰 136: 손대지 않은 R1이 이 라벨 하나로 "작업 중"이 됐다)
 */
const RANGE_MENTION_PATTERN = /\bR\d+(?:\.\d+)?\s*[-–—~]\s*R\d+(?:\.\d+)?\b/g;

/**
 * 텍스트에서 `\bR\d+(\.\d+)?\b` 토큰(요구사항 id·시나리오 id)을 모두 뽑는다. "R1"이 "R10"의 일부로 걸리지 않는다.
 * "R1~R32" 같은 범위 표기 안의 양 끝 id는 개별 언급으로 보지 않고 뺀다(RANGE_MENTION_PATTERN, 마찰 136) —
 * "R1 그리고 R32 확인"처럼 범위 구두점 없이 따로 나오는 언급은 그대로 각각 센다
 */
export function findMentionedIds(text: string): string[] {
  const ranges = [...text.matchAll(RANGE_MENTION_PATTERN)].map((match) => {
    const start = match.index ?? 0;
    return [start, start + match[0].length] as const;
  });
  const insideRange = (index: number) => ranges.some(([start, end]) => index >= start && index < end);
  const mentions: string[] = [];
  for (const match of text.matchAll(REQUIREMENT_MENTION_PATTERN)) {
    if (insideRange(match.index ?? 0)) continue;
    mentions.push(match[0]);
  }
  return mentions;
}

/**
 * id가 텍스트 안에서 독립된 토큰으로 나타나는지("R31"의 일부로 걸리지 않는다). id가 요구사항 id(R3)면 그 요구사항의
 * 시나리오 언급(R3.1)도 포함한다 — 시나리오는 소속 요구사항의 일부이므로 시나리오를 가리키면 상위 요구사항도 가리킨 것이다.
 */
export function mentionsRequirementId(text: string, id: string): boolean {
  return findMentionedIds(text).some((mention) => mention === id || mention.startsWith(`${id}.`));
}

/** 커밋 메시지·PR 본문의 "Implements: R4" / "Implements: R4.1@rev2" 트레일러를 찾는다(자유 언급보다 우선하는 명시적 증거) */
export interface ImplementsTrailer {
  id: string;
  rev?: number;
}
const IMPLEMENTS_TRAILER_PATTERN = /\bImplements:\s*(R\d+(?:\.\d+)?)(?:@rev(\d+))?/gi;
export function extractImplementsTrailers(text: string): ImplementsTrailer[] {
  const results: ImplementsTrailer[] = [];
  for (const match of text.matchAll(IMPLEMENTS_TRAILER_PATTERN)) {
    results.push({ id: match[1]!.toUpperCase(), ...(match[2] ? { rev: Number(match[2]) } : {}) });
  }
  return results;
}

function implementsTrailerMentions(text: string, id: string): boolean {
  return extractImplementsTrailers(text).some((trailer) => trailer.id === id || trailer.id.startsWith(`${id}.`));
}

/**
 * id를 가리키는 체크포인트를 찾는다. 명시적 "Implements:" 트레일러가 있는 체크포인트가 하나라도 있으면 그것만 증거로
 * 삼고(사람이 의도적으로 남긴 기록이 더 믿을 만하다), 없으면 자유 언급(커밋 제목·본문에 id가 나타나는 것)으로 대신한다.
 */
export function findCheckpointMentions(checkpoints: readonly CheckpointRef[], id: string): CheckpointRef[] {
  const viaTrailer = checkpoints.filter((checkpoint) => implementsTrailerMentions(checkpoint.message, id));
  if (viaTrailer.length > 0) return viaTrailer;
  return checkpoints.filter((checkpoint) => mentionsRequirementId(checkpoint.message, id));
}

export function findGateCheckMentions(gateChecks: readonly GateCheckResult[], id: string): GateCheckResult[] {
  return gateChecks.filter((check) => mentionsRequirementId(check.name, id));
}

/** 식별자가 코드 식별자(테스트 메서드 이름 등) 안에 붙어 나오는지. R3 뒤에 바로 숫자가 이어지면(R31 등) 다른 id로 본다 */
function identifierMentionsId(identifier: string, id: string): boolean {
  const index = identifier.toLowerCase().indexOf(id.toLowerCase());
  if (index === -1) return false;
  const after = identifier[index + id.length];
  return after === undefined || !/[0-9]/.test(after);
}

const TEST_FILE_PATTERN = /(\.(test|spec)\.[cm]?[jt]sx?$)|(Tests?\.java$)/i;

export interface ScannedFile {
  path: string;
  content: string;
}

export function isLikelyTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

const TEST_CALL_PATTERN = /\b(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
const TEST_DISPLAY_NAME_PATTERN = /@DisplayName\s*\(\s*"((?:\\.|[^"])*)"/g;

/** 파일 하나에서 it/test 호출 문자열과 @DisplayName 문자열을 모두 뽑는다(중복 없이). 요구사항 id·시나리오 id 스캔이 공유하는 1차 추출 */
function collectDeclaredTestNames(file: ScannedFile): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      names.push(trimmed);
    }
  };
  for (const match of file.content.matchAll(TEST_CALL_PATTERN)) add(match[2]!);
  for (const match of file.content.matchAll(TEST_DISPLAY_NAME_PATTERN)) add(match[1]!);
  return names;
}

/**
 * 테스트 이름마다 그 테스트를 감싼 묶음(describe·클래스) 제목에 단 id를 모은다. 묶음 제목에 단 id는 그 안의 모든
 * 테스트의 id다(test-discovery.ts의 extractRequirementIdsWithSuites와 같은 규칙) — 실행 근거 쪽과 어긋나면
 * "발견은 되는데 주인 없는 테스트"처럼 보인다. 발견기가 못 읽는 모양이면 빈 맵이다(그 파일은 테스트 자신의 id만 본다).
 * 같은 이름의 테스트가 다른 묶음에 있으면 id를 합친다
 */
function collectSuiteIdsByTestName(file: ScannedFile): Map<string, string[]> {
  const byName = new Map<string, Set<string>>();
  const discovered = discoverTestsInFile(file.path, file.content);
  if (!discovered) return new Map();
  for (const row of flattenDiscoveredFile(discovered)) {
    if (row.suitePath.length === 0) continue;
    const ids = byName.get(row.displayName.trim()) ?? new Set<string>();
    for (const title of row.suitePath) for (const id of findMentionedIds(title)) ids.add(id);
    byName.set(row.displayName.trim(), ids);
  }
  return new Map([...byName].map(([name, ids]) => [name, [...ids]]));
}

/** 테스트 이름 하나가 가리키는 id 전부: 자기 이름에 단 것 + 감싼 묶음 제목에 단 것(중복 없이) */
function mentionedIdsOfTest(name: string, suiteIds: ReadonlyMap<string, string[]>): string[] {
  return [...new Set([...findMentionedIds(name), ...(suiteIds.get(name) ?? [])])];
}

/**
 * 작업 복사본의 테스트 파일에서 id를 언급하는 테스트 이름을 찾는다.
 * Jest/Vitest/Playwright의 it('R3 …')·test('R3 …')와 JUnit의 @DisplayName("R3 …")·메서드 이름(testR3Login 등)을 본다.
 */
export function scanTestFilesForRequirementId(files: readonly ScannedFile[], id: string): TestMatch[] {
  const matches: TestMatch[] = [];
  for (const file of files) {
    if (!isLikelyTestFile(file.path)) continue;
    const seen = new Set<string>();
    const add = (name: string) => {
      if (!seen.has(name)) {
        seen.add(name);
        matches.push({ file: file.path, name });
      }
    };

    const suiteIds = collectSuiteIdsByTestName(file);
    for (const name of collectDeclaredTestNames(file)) {
      if (mentionedIdsOfTest(name, suiteIds).some((mention) => mention === id || mention.startsWith(`${id}.`))) add(name);
    }

    const methodPattern = /\b(?:void|public|private|protected)\s+[\w<>[\],\s]*?\b(\w*[Rr]\d+\w*)\s*\(/g;
    for (const match of file.content.matchAll(methodPattern)) {
      if (identifierMentionsId(match[1]!, id)) add(match[1]!);
    }
  }
  return matches;
}

/** 작업 복사본의 테스트 파일에서 시나리오 id(R4.1 등)를 정확히 언급하는 테스트 이름을 찾는다(추적 매트릭스의 시나리오 행이 쓴다) */
export function scanTestFilesForScenarioId(files: readonly ScannedFile[], scenarioId: string): TestMatch[] {
  const matches: TestMatch[] = [];
  for (const file of files) {
    if (!isLikelyTestFile(file.path)) continue;
    const suiteIds = collectSuiteIdsByTestName(file);
    for (const name of collectDeclaredTestNames(file)) {
      if (mentionedIdsOfTest(name, suiteIds).includes(scenarioId)) matches.push({ file: file.path, name });
    }
  }
  return matches;
}

/** 어떤 요구사항·시나리오 id도 언급하지 않은 테스트("주인 없는 테스트")를 찾는다. 추적 매트릭스의 역방향 목록이 쓴다 */
export function scanTestFilesForOrphans(files: readonly ScannedFile[]): TestMatch[] {
  const matches: TestMatch[] = [];
  for (const file of files) {
    if (!isLikelyTestFile(file.path)) continue;
    const suiteIds = collectSuiteIdsByTestName(file);
    for (const name of collectDeclaredTestNames(file)) {
      if (mentionedIdsOfTest(name, suiteIds).length === 0) matches.push({ file: file.path, name });
    }
  }
  return matches;
}

/**
 * 요구사항의 안정적 내용 해시(ADR-090). title·ears·scenarios·nfr만 본다 — 이 넷이 "무엇을 어떻게 검증하는가"를
 * 정하는 실질 내용이고, acceptance·priority·trace·id는 해시에 넣지 않는다(우선순위를 바꿨다고 재확인이 필요한 건
 * 아니고, acceptance는 scenarios가 있으면 그로부터 파생되는 표시용 값이라 이중으로 세지 않는다).
 */
export function computeRequirementHash(requirement: Pick<Requirement, 'title' | 'ears' | 'scenarios' | 'nfr'>): string {
  const stable = JSON.stringify({
    title: requirement.title,
    ears: requirement.ears ?? null,
    scenarios: requirement.scenarios ?? null,
    nfr: requirement.nfr ?? null,
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * 지금 내용의 해시가 기록된(저장된) 해시와 다른지("의심" 판정, Doorstop/sphinx-needs류 도구의 suspect 링크와 같은 개념).
 * 기록된 해시가 아예 없으면(이 기능 이전 문서를 막 읽어 들인 시점) 비교할 기준이 없으므로 드리프트 아님으로 본다.
 */
export function requirementContentDrifted(requirement: Requirement): boolean {
  if (!requirement.hash) return false;
  return computeRequirementHash(requirement) !== requirement.hash;
}

/**
 * 저장(apply) 시점에 부른다: 내용이 드리프트됐으면 개정을 올리고 새 해시·시각을 적는다. 기록된 해시가 없으면
 * (처음 저장하거나 이 기능 이전 문서) 개정 1로 채우기만 하고 "바뀌었다"고 보지 않는다 — 비교할 이전 값이 없기 때문이다.
 * 이때 revisedAt도 손대지 않는다(건드리면 방금 저장한 요구사항이 전부 "재확인 필요"로 보인다 — 비교 기준이 없는
 * 첫 저장은 바뀐 게 아니라 그냥 "지금 상태를 처음 기록"하는 것이기 때문이다. computeRequirementStatus 참고).
 */
export function reviseRequirementIfChanged(requirement: Requirement, now: string = new Date().toISOString()): Requirement {
  const hash = computeRequirementHash(requirement);
  if (requirement.hash === undefined) return { ...requirement, rev: requirement.rev ?? 1, hash };
  if (requirement.hash === hash) return requirement;
  return { ...requirement, rev: (requirement.rev ?? 1) + 1, hash, revisedAt: now };
}

/**
 * 다음 요구사항이 이전 요구사항과 id로 이어진다면(사람이 직접 고친 경우 등, 재추출 병합과 달리 id는 그대로다)
 * 이전의 개정 관련 필드(rev·hash·revisedAt)를 먼저 물려받는다 — 클라이언트가 그 필드를 안 보내도(대개 그렇다)
 * 서버가 신뢰할 수 있는 기준점을 잃지 않는다. 다음 쪽이 이미 값을 갖고 있으면(재추출 병합 등) 그 값을 존중한다.
 */
export function carryForwardRequirementRevision(next: Requirement, previous: Requirement | undefined): Requirement {
  if (!previous) return next;
  return {
    ...next,
    rev: next.rev ?? previous.rev,
    hash: next.hash ?? previous.hash,
    revisedAt: next.revisedAt ?? previous.revisedAt,
    // 요구사항 화면의 편집·재추출 저장은 그 요구사항을 건드리지 않았으면 manualVerification을 안 보낸다(클라이언트가
    // 모르는 필드다) — "확인 취소"를 누른 게 아니라면 저장할 때마다 사람 확인이 조용히 사라지면 안 된다
    manualVerification: next.manualVerification ?? previous.manualVerification,
  };
}

/**
 * 이 id로 docs/requirements.md에 저장된 적이 한 번도 없으면(previouslySaved가 없다), 들어온 요구사항이 들고
 * 있는 rev·hash·revisedAt은 "이 파일의 이전 상태"가 아니다 — 다른 세션에서 이어받은 추출 결과 사이드카(통합
 * 세션이 레인 세션의 draft를 물려받는 경우 등)나 재추출 미리보기가 붙여 둔 값일 수 있다. 그걸 진짜 이전 저장값으로
 * 오인해 carryForwardRequirementRevision·reviseRequirementIfChanged에 넘기면, 파일 입장에서는 분명 첫 저장(개정
 * 1이어야 한다)인데도 개정이 오르고 revisedAt이 찍혀 그 전에 쌓인 체크포인트·테스트 증거가 전부 "재확인 필요"로
 * 둔갑한다("첫 저장은 개정이 아니다", 버그 리포트). 저장된 적이 있으면(previouslySaved 있음) 손대지 않는다 — 그
 * 경우의 rev·hash·revisedAt 판단은 carryForwardRequirementRevision·reviseRequirementIfChanged가 그대로 맡는다.
 */
export function discardRevisionIfNeverSaved(requirement: Requirement, previouslySaved: Requirement | undefined): Requirement {
  if (previouslySaved) return requirement;
  const { rev: _rev, hash: _hash, revisedAt: _revisedAt, ...rest } = requirement;
  return rest;
}

/**
 * 상태 규칙(ADR-079, 재확인 필요는 ADR-090, 문서 확인·사람 확인은 ADR-103): 내용이 지금 드리프트돼 있으면(아직
 * 저장 전) 곧바로 재확인 필요. 드리프트는 없지만(저장돼 반영됨) 최근에 개정이 올랐다면, 그 시각 뒤에 생긴
 * 체크포인트·게이트 확인·테스트 탭 실행·사람 확인이 하나라도 있어야 "재확인됨"으로 보고 평소 규칙으로 넘어간다
 * — 없으면 재확인 필요에 머문다. 문서 확인(docEvidence)은 항상 "지금 저장소 상태"를 다시 본 결과라 시점을
 * 비교할 필요가 없다(저절로 신선하다). 평소 규칙: 미착수 → 작업 중(체크포인트가 참조하거나 테스트가 있다, 또는
 * 문서 매칭이 일부라도 됐다) → 검증됨(id가 붙은 게이트 확인이 모두 통과, 없으면 테스트 탭 실행이 통과, 없으면
 * 문서의 인수 조건을 모두 찾았거나 사람이 직접 확인했다) / 실패(게이트가 하나라도 실패, 또는 테스트 탭 실행에
 * 실패가 있다). 게이트 확인·테스트 탭 실행 증거가 있으면 그것이 늘 우선한다(기존 규칙 그대로) — 실패했다면
 * 문서 확인·사람 확인이 있어도 절대 뒤집지 않는다("사람 확인이 실패한 테스트를 이기지 않는다").
 * 시나리오가 있는 요구사항은 자동 근거(게이트·테스트 탭 실행)만으로 검증됨이 되려면 시나리오가 전부 확인돼야 한다
 * (evidence.missingScenarios가 비어 있어야 한다, ADR-155). 남은 시나리오가 있으면 통과한 자동 근거는 "작업 중"까지만
 * 올리고, 실패는 그대로 우선한다. 시나리오 자신의 평가에는 missingScenarios가 없으므로 이 조건이 재귀로 걸리지 않는다.
 */
export function computeRequirementStatus(evidence: RequirementEvidence, requirement?: Requirement): RequirementStatus {
  if (requirement && requirementContentDrifted(requirement)) return '재확인 필요';
  if (requirement?.revisedAt) {
    const revisedAt = requirement.revisedAt;
    const freshCheckpoint = evidence.checkpoints.some((checkpoint) => checkpoint.createdAt !== undefined && checkpoint.createdAt > revisedAt);
    const freshTestRun = evidence.testRun !== undefined && evidence.testRun.at > revisedAt;
    const freshManualVerification = requirement.manualVerification !== undefined && requirement.manualVerification.at > revisedAt;
    const freshDocEvidence = evidence.docEvidence?.satisfied === true;
    const hasFreshEvidence = freshCheckpoint || evidence.gateChecks.length > 0 || freshTestRun || freshManualVerification || freshDocEvidence;
    if (!hasFreshEvidence) return '재확인 필요';
  }
  // 시나리오가 있는 요구사항은 시나리오가 전부 자동 근거(테스트·게이트)로 확인돼야 그 근거만으로 검증됨이 된다(ADR-155).
  // 하나라도 남았으면(missingScenarios) 자동 근거는 "작업 중"까지만 올리고, 실패는 그대로 우선한다
  const scenariosPending = (evidence.missingScenarios?.length ?? 0) > 0;
  if (evidence.gateChecks.length > 0) {
    if (!evidence.gateChecks.every((check) => check.ok)) return '실패';
    if (!scenariosPending) return '검증됨';
  }
  if (evidence.testRun) {
    if (evidence.testRun.failed > 0) return '실패';
    if (evidence.testRun.passed > 0 && !scenariosPending) return '검증됨';
  }
  if (evidence.docEvidence?.satisfied) return '검증됨';
  if (requirement?.manualVerification) return '검증됨';
  const hasPassingRun = (evidence.testRun?.passed ?? 0) > 0;
  if (evidence.checkpoints.length > 0 || evidence.tests.length > 0 || evidence.gateChecks.length > 0 || hasPassingRun || (evidence.docEvidence?.matched.length ?? 0) > 0) return '작업 중';
  return '미착수';
}

/**
 * "검증됨"을 만든 증거의 종류. "근거 보기"·"올리기 전 점검" 메시지가 자동(게이트·테스트 탭)·문서 확인·사람 확인을
 * 구분해 보여준다(ADR-103) — computeRequirementStatus와 같은 우선순위(자동 > 문서 확인 > 사람 확인)를 따른다.
 * 검증됨이 아니면 'none'이다.
 */
export function requirementVerificationSource(evidence: RequirementEvidence, requirement?: Requirement): 'test' | 'docs' | 'manual' | 'none' {
  if (computeRequirementStatus(evidence, requirement) !== '검증됨') return 'none';
  // 자동 근거가 시나리오를 다 덮지 못했으면(missingScenarios) 검증됨은 문서·사람 확인이 만든 것이다(ADR-155) — 일부만
  // 덮은 테스트를 출처로 내세우면 과대평가다. 둘 다 있으면 기존 우선순위(문서 확인 > 사람 확인)를 따른다
  if (!automaticEvidenceIncomplete(evidence)) {
    if (evidence.gateChecks.length > 0) return 'test';
    if (evidence.testRun && evidence.testRun.passed > 0 && evidence.testRun.failed === 0) return 'test';
  }
  if (evidence.docEvidence?.satisfied) return 'docs';
  if (requirement?.manualVerification) return 'manual';
  return 'test';
}

/** 시나리오 중 자동 근거(테스트·게이트)로 확인되지 않은 것이 남았는지 */
function automaticEvidenceIncomplete(evidence: RequirementEvidence): boolean {
  return (evidence.missingScenarios?.length ?? 0) > 0;
}

/** 추적 매트릭스가 "검증 출처" 배지로 쓰는 값. requirementVerificationSource의 'test'를 "테스트 탭 실행"과 "게이트"로
 * 더 가른다(매트릭스엔 테스트·게이트 열이 따로 있어 목록보다 자세히 보여줄 수 있다). status는 다시 구하지 않고
 * 그대로 받는다(이미 구해 둔 값과 어긋날 일이 없게 — 매트릭스 행의 상태와 배지가 서로 다른 계산을 거치지 않는다) */
export type MatrixVerificationBadge = '테스트 탭' | '게이트' | '문서 확인' | '사람 확인' | 'none';
export function matrixVerificationBadge(status: RequirementStatus, evidence: RequirementEvidence, requirement?: Requirement): MatrixVerificationBadge {
  if (status !== '검증됨') return 'none';
  if (!automaticEvidenceIncomplete(evidence)) {
    if (evidence.gateChecks.length > 0) return '게이트';
    if (evidence.testRun && evidence.testRun.passed > 0 && evidence.testRun.failed === 0) return '테스트 탭';
  }
  if (evidence.docEvidence?.satisfied) return '문서 확인';
  if (requirement?.manualVerification) return '사람 확인';
  return '테스트 탭';
}

/** Devin 스타일 확신 표시. 검증됨=🟢, 작업 중·재확인 필요=🟡(둘 다 "더 봐야 한다"), 그 밖(미착수·실패)=🔴 */
export function requirementConfidence(status: RequirementStatus): '🟢' | '🟡' | '🔴' {
  if (status === '검증됨') return '🟢';
  if (status === '작업 중' || status === '재확인 필요') return '🟡';
  return '🔴';
}

export interface RequirementCoverage {
  total: number;
  verified: number;
  mustTotal: number;
  mustVerified: number;
  /** "12개 중 9개 검증됨" */
  text: string;
  /** must인데 검증되지 않은 게 있을 때만 있다. 화면이 강조 표시에 쓴다 */
  mustGapText?: string;
  /** 상태가 "재확인 필요"인 요구사항 수(개정 후 아직 새 증거가 없는 것) */
  needsRecheck: number;
  /** needsRecheck가 있을 때만 있다. 화면이 강조 표시에 쓴다 */
  needsRecheckText?: string;
}

export function summarizeCoverage(requirements: readonly Requirement[], statusById: Readonly<Record<string, RequirementStatus>>): RequirementCoverage {
  const total = requirements.length;
  const verified = requirements.filter((requirement) => statusById[requirement.id] === '검증됨').length;
  const mustRequirements = requirements.filter((requirement) => requirement.priority === 'must');
  const mustTotal = mustRequirements.length;
  const mustVerified = mustRequirements.filter((requirement) => statusById[requirement.id] === '검증됨').length;
  const mustGap = mustTotal - mustVerified;
  const needsRecheck = requirements.filter((requirement) => statusById[requirement.id] === '재확인 필요').length;
  return {
    total,
    verified,
    mustTotal,
    mustVerified,
    text: `${total}개 중 ${verified}개 검증됨`,
    ...(mustGap > 0 ? { mustGapText: `필수(must) 요구사항 ${mustGap}개 미검증` } : {}),
    needsRecheck,
    ...(needsRecheck > 0 ? { needsRecheckText: `${needsRecheck}개 재확인 필요` } : {}),
  };
}

// ---------------------------------------------------------------------------
// 에이전트 인지(ADR-077 project-guide.ts가 붙이는 절): 요구사항 요약
// ---------------------------------------------------------------------------

/** project-guide.ts가 docs/requirements.md 요약에 쓰는 글자 수 상한 */
export const REQUIREMENTS_GUIDE_MAX_CHARS = 1_500;

/**
 * 요구사항 목록을 모델이 매 실행마다 참고할 수 있는 짧은 목록으로 줄인다: id·제목·우선순위만, must/should만(could는 뺀다).
 * 상한을 넘으면 앞에서부터 채우고 "…외 N개 생략"으로 마무리한다 — project-guide.ts의 AGENTS.md 자르기와 같은 태도다.
 */
export function summarizeRequirementsForGuide(requirements: readonly Requirement[], maxChars: number = REQUIREMENTS_GUIDE_MAX_CHARS): string {
  const relevant = requirements.filter((requirement) => requirement.priority === 'must' || requirement.priority === 'should');
  if (relevant.length === 0) return '';
  const header = `[요구사항 목록(${REQUIREMENTS_FILE}) — id. 제목 (우선순위)]`;
  const lines: string[] = [];
  let used = header.length;
  for (let index = 0; index < relevant.length; index++) {
    const requirement = relevant[index]!;
    const line = `${requirement.id}. ${requirement.title} (${requirement.priority})`;
    if (used + 1 + line.length > maxChars) {
      const omitted = `…외 ${relevant.length - index}개 생략`;
      if (used + 1 + omitted.length <= maxChars) lines.push(omitted);
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return `${header}\n${lines.join('\n')}`;
}

/** project-guide.ts가 "사람이 할 일" 안내에 쓰는 글자 수 상한 */
export const MANUAL_STEPS_GUIDE_MAX_CHARS = 800;

/**
 * "## 사람이 할 일" 목록을 모델이 매 실행마다 참고할 금지 안내로 줄인다. 이 목록은 요구사항이 아니므로
 * summarizeRequirementsForGuide와 별개로 만든다 — 에이전트가 저장소 권한·협업자·공개 범위를 바꾸거나 이메일로
 * 제출하는 절차를 요구사항으로 착각해 시도하지 않도록, 매 실행마다 "절대 하지 마라"는 문장으로 못박는다.
 */
export function summarizeManualStepsForGuide(manualSteps: readonly string[], maxChars: number = MANUAL_STEPS_GUIDE_MAX_CHARS): string {
  if (manualSteps.length === 0) return '';
  const header = '[사람이 할 일 — 에이전트는 이 항목을 절대 하지 않는다(저장소 권한·협업자·공개 범위 변경, 이메일 제출 등)]';
  const lines: string[] = [];
  let used = header.length;
  for (let index = 0; index < manualSteps.length; index++) {
    const line = `- ${manualSteps[index]}`;
    if (used + 1 + line.length > maxChars) {
      const omitted = `…외 ${manualSteps.length - index}개 생략`;
      if (used + 1 + omitted.length <= maxChars) lines.push(omitted);
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return `${header}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// 대화 입력창 채우기(chat-draft-context.tsx가 채우고, 절대 자동으로 보내지 않는다)
// ---------------------------------------------------------------------------

/** 시나리오가 있으면 "테스트 이름에 R4.1, R4.2를 넣어", 없으면 "테스트 이름에 R4를" — 요구사항·시나리오 추적이 둘 다 되게 안내한다 */
function testNamingGuidance(requirement: Requirement): string {
  const scenarioIds = (requirement.scenarios ?? []).map((scenario) => scenario.id);
  const ids = scenarioIds.length > 0 ? scenarioIds.join(', ') : requirement.id;
  return `테스트 이름에 ${ids}을(를) 넣어 시나리오·인수 조건을 검증하는 테스트를 함께 작성해 주세요.`;
}

/** 커밋·PR 본문에 남길 트레일러 안내. 자유 언급보다 우선하는 증거이므로 항상 안내한다(findCheckpointMentions) */
function implementsTrailerGuidance(requirement: Requirement): string {
  return `커밋·PR 본문에 "Implements: ${requirement.id}@rev${requirement.rev ?? 1}"을 남겨 주세요.`;
}

/** "이 요구사항 작업" 버튼이 채우는 글 */
export function buildRequirementWorkPrefill(requirement: Requirement): string {
  const acceptance = requirement.acceptance.map((item) => `- ${item}`).join('\n');
  const earsLine = requirement.ears ? `\n\nEARS: ${requirement.ears.statement}` : '';
  return `[${requirement.id}] ${requirement.title}${earsLine}\n\n인수 조건:\n${acceptance}\n\n${testNamingGuidance(requirement)} ${implementsTrailerGuidance(requirement)}`;
}

/** "전체 계획 세우기" 버튼이 채우는 글. must 요구사항을 순서대로 나열한다(레인을 나눌지는 에이전트가 스스로 정한다) */
export function buildAllMustHavesPrefill(requirements: readonly Requirement[]): string {
  const mustHaves = requirements.filter((requirement) => requirement.priority === 'must');
  const list = mustHaves.map((requirement) => `- [${requirement.id}] ${requirement.title}`).join('\n');
  return `다음 필수(must) 요구사항을 모두 구현해 주세요. 서로 독립적인 부분이 있으면 레인을 나눠 계획을 세워도 됩니다. 요구사항마다 테스트 이름에 해당 id(시나리오가 있으면 R1.1처럼 시나리오 id, 없으면 R1)를 넣어 검증하는 테스트를 함께 작성하고, 커밋·PR 본문에 "Implements: R1@rev1" 같은 트레일러를 남겨 주세요.\n\n${list}`;
}

// ---------------------------------------------------------------------------
// 요구사항 스멜 린트(ADR-090): QVscribe류 도구가 잡는 "약한 표현"과 구조적 흠을 결정론적으로 찾는다.
// 모델 호출 없이 문자열만 본다 — 추출 모델이 프롬프트 규칙을 놓쳐도 화면에서 바로 잡아낼 안전망이다.
// ---------------------------------------------------------------------------

/** 한국어 약한 표현(QVscribe의 "weak words" 개념을 국문 관용구로 옮겼다) */
export const WEAK_WORDS_KO: readonly string[] = ['빠르게', '적절히', '적당히', '사용자 친화적', '가능하면', '기타', '신속히', '효율적으로', '즉시', '충분히'];
/** 영어 약한 표현 */
export const WEAK_WORDS_EN: readonly string[] = ['fast', 'user-friendly', 'appropriate', 'as needed', 'tbd', 'quickly', 'efficient', 'asap', 'soon', 'etc'];
/** "등"은 한 글자라 단어 경계 정규식으로 오탐이 많다(등록·등급 등) — 조사가 바로 붙는 "…등" 꼴만 따로 본다 */
export const WEAK_WORD_ETC_KO = /[가-힣0-9]\s*등(?:[,.\s]|$)/;

/** doc-lint.ts가 같은 단어 경계 규칙으로 약한 표현을 찾을 때 재사용한다(중복 정의하지 않는다) */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RequirementLintWarning {
  /** 기계가 구분하는 코드(테스트·화면이 분기에 쓴다) */
  code: 'weak-word' | 'no-scenario' | 'nfr-missing' | 'multiple-must-statements' | 'not-ears-shaped';
  /** 사람이 읽는 한 줄 설명 */
  message: string;
  /** true면 requirementIsReady를 막는다(반드시 고쳐야 할 흠), false면 권고만 한다 */
  mustFix: boolean;
}

/** 요구사항 하나에 들어있는 모든 텍스트(제목·EARS·시나리오·인수 조건)를 한 덩어리로 모은다 */
function collectRequirementText(requirement: Requirement): string {
  const scenarioText = (requirement.scenarios ?? []).flatMap((scenario) => [scenario.given, scenario.when, scenario.then]);
  return [requirement.title, requirement.ears?.statement, ...requirement.acceptance, ...scenarioText].filter(Boolean).join(' ');
}

/**
 * 요구사항 하나를 결정론적으로 점검한다: 약한 표현(한국어·영어), 시나리오 없음, nonfunctional인데 NFR 없음,
 * 한 EARS 문장에 "해야 한다"가 여럿(요구사항이 사실 여러 개), EARS 문장이 "…해야 한다" 형태가 아님(권고만).
 */
export function lintRequirement(requirement: Requirement): RequirementLintWarning[] {
  const warnings: RequirementLintWarning[] = [];
  const text = collectRequirementText(requirement);
  const lowerText = text.toLowerCase();

  for (const word of WEAK_WORDS_KO) {
    const pattern = new RegExp(`(^|[^가-힣A-Za-z0-9])${escapeRegExp(word)}($|[^가-힣A-Za-z0-9])`);
    if (pattern.test(text)) warnings.push({ code: 'weak-word', message: `약한 표현 "${word}"이(가) 있습니다 — 수치·구체적 조건으로 바꿔 주세요`, mustFix: true });
  }
  if (WEAK_WORD_ETC_KO.test(text)) warnings.push({ code: 'weak-word', message: '약한 표현 "등"이(가) 있습니다 — 목록을 모두 적어 주세요', mustFix: true });
  for (const word of WEAK_WORDS_EN) {
    const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(word)}($|[^a-z0-9-])`);
    if (pattern.test(lowerText)) warnings.push({ code: 'weak-word', message: `약한 표현 "${word}"이(가) 있습니다 — 수치·구체적 조건으로 바꿔 주세요`, mustFix: true });
  }

  if (!requirement.scenarios || requirement.scenarios.length === 0) {
    warnings.push({ code: 'no-scenario', message: '시나리오(Given-When-Then)가 없습니다', mustFix: true });
  }

  if (requirement.kind === 'nonfunctional' && !requirement.nfr) {
    warnings.push({ code: 'nfr-missing', message: '비기능 요구사항인데 측정 가능한 지표·임계값(NFR)이 없습니다', mustFix: true });
  }

  if (requirement.ears) {
    const mustCount = (requirement.ears.statement.match(/해야\s*한다/g) ?? []).length;
    if (mustCount > 1) {
      warnings.push({ code: 'multiple-must-statements', message: '한 EARS 문장에 "해야 한다"가 여러 번 있습니다 — 요구사항 하나에 한 문장만 쓰세요(요구사항을 쪼개야 할 수 있습니다)', mustFix: true });
    } else if (mustCount === 0) {
      warnings.push({ code: 'not-ears-shaped', message: 'EARS 문장이 "…해야 한다" 형태가 아닙니다', mustFix: false });
    }
  }

  return warnings;
}

/** must-fix 경고가 하나도 없으면 Ready. 권고성 경고(mustFix: false)는 Ready를 막지 않는다 */
export function requirementIsReady(requirement: Requirement): boolean {
  return lintRequirement(requirement).every((warning) => !warning.mustFix);
}

/** 문서 전체의 "Ready" 배지: 필수(must) 요구사항이 모두 Ready일 때만 켠다(선택·권장 요구사항의 흠은 배지를 막지 않는다) */
export function requirementsReadyBadge(requirements: readonly Requirement[]): boolean {
  const mustHaves = requirements.filter((requirement) => requirement.priority === 'must');
  return mustHaves.length > 0 && mustHaves.every((requirement) => requirementIsReady(requirement));
}

// ---------------------------------------------------------------------------
// 재추출 병합(ADR-090): 모델이 다시 뽑은 요구사항(id는 항상 R1..Rn부터 새로 매겨져 온다)을 제목·EARS 문장·종류
// 유사도로 기존 저장된 요구사항과 짝지어 id를 지킨다. 같은 입력을 두 번 돌리면 id가 하나도 바뀌지 않아야 한다.
// ---------------------------------------------------------------------------

/** 문자열을 소문자·공백 정규화한 뒤 2-그램(문자 바이그램) 집합으로 바꾼다. 한국어(교착어라 단어 경계가 약하다)에도 잘 먹힌다 */
function charBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index++) grams.add(normalized.slice(index, index + 2));
  return grams;
}

/** 두 문자열의 유사도(자카드 계수, 0~1)를 2-그램 집합으로 어림한다 */
export function textSimilarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function requirementSimilarityText(requirement: Requirement): string {
  return `${requirement.title} ${requirement.ears?.statement ?? requirement.acceptance.join(' ')}`;
}

/** 제목 비교용 정규화: 백틱·문장부호·공백 차이로 같은 제목이 달라 보이지 않게 한다 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[`'"“”‘’()[\]{}·,.:;!?—–\-+/]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 제목에 든 API 시그니처(메서드 + 경로). 예: "GET /api/posts/{postId} — 상세" → "GET /api/posts/{postId}" */
export function apiSignature(title: string): string | undefined {
  const match = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s—–,(]+)/i.exec(title);
  return match ? `${match[1]!.toUpperCase()} ${match[2]!.replace(/\/+$/, '')}` : undefined;
}

/**
 * 요구사항 둘의 유사도(0~1). 같은 kind면 가산점을 준다(제목이 비슷해도 api/ui처럼 종류가 다르면 다른 요구사항일 확률이 높다).
 * 제목끼리의 유사도와 "제목+EARS(없으면 인수 조건)" 전체의 유사도 중 큰 값을 쓴다 — 한쪽에만 EARS가 있으면 긴 본문끼리
 * 비교돼 같은 요구사항도 점수가 낮게 나왔다(재추출이 기존 18개 중 6개만 짝지은 실사용 사례). 같은 API 시그니처
 * (메서드+경로)를 가진 두 요구사항은 같은 것으로 본다
 */
export function requirementSimilarity(a: Requirement, b: Requirement): number {
  const signatureA = apiSignature(a.title);
  const signatureB = apiSignature(b.title);
  if (signatureA && signatureA === signatureB) return 1;
  // 둘 다 API 시그니처가 있는데 다르면(GET /api/posts ↔ GET /api/posts/{postId}) 제목이 비슷해도 다른 요구사항이다
  if (signatureA && signatureB) return 0;
  const titleScore = textSimilarity(normalizeTitle(a.title), normalizeTitle(b.title));
  const textScore = textSimilarity(requirementSimilarityText(a), requirementSimilarityText(b));
  const kindBonus = a.kind === b.kind ? 0.15 : 0;
  return Math.min(1, Math.max(titleScore, textScore) * 0.85 + kindBonus);
}

/** 이 유사도 이상이면 "같은 요구사항"으로 짝짓는다(재추출 병합) */
export const MERGE_MATCH_THRESHOLD = 0.35;
/** 이 유사도 이상이면(하지만 주 짝짓기 문턱보다는 낮으면) "분할 힌트"로 본다(trace.supersedes를 자동으로 채운다) */
export const MERGE_SPLIT_HINT_THRESHOLD = 0.15;

export type RequirementDiffStatus = 'added' | 'changed' | 'unchanged' | 'removed';

export interface RequirementDiffEntry {
  status: RequirementDiffStatus;
  id: string;
  /** added/changed/unchanged일 때의 최종 값(병합 결과 merged에 실제로 들어가는 값과 같다) */
  requirement: Requirement;
  /** changed/removed일 때만 있다 — 이전에 저장돼 있던 값 */
  previous?: Requirement;
}

export interface RequirementMergeResult {
  /** 저장할 최종 목록. id 오름차순으로 정렬돼 있다 */
  merged: Requirement[];
  /** 화면이 "추가/변경(개정 상승)/삭제→대체" 미리보기로 보여줄 목록(merged와 같은 순서가 아니다 — added→changed→unchanged→removed 순) */
  diff: RequirementDiffEntry[];
}

function requirementIdNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * 재추출로 새로 받은 요구사항(incoming, 모델이 늘 R1..Rn으로 새로 매겨 준다)을 기존 저장분(existing)과
 * 제목/EARS 문장 유사도 + kind로 짝짓고, 짝지어진 것은 existing의 id를 그대로 물려받는다(개정은
 * reviseRequirementIfChanged가 매긴다). 짝을 못 찾은 incoming은 새 id(기존 최대 번호+1부터, 절대 재사용하지
 * 않는다)로 추가되고, 짝을 못 찾은 existing은 목록에 그대로 남되(id를 지우지 않는다) "removed"로 표시된다 —
 * "추가된" 항목 중 방금 제거된 항목과 어느 정도 비슷한 것이 있으면(분할 힌트 문턱) 쪼개졌다고 보고
 * trace.supersedes를 자동으로 채운다. 같은 입력을 두 번 주면 모든 짝이 유사도 1로 잡혀 id가 하나도 바뀌지 않는다.
 */
export function mergeReextractedRequirements(incoming: readonly Requirement[], existing: readonly Requirement[]): RequirementMergeResult {
  const now = new Date().toISOString();
  const pairs: Array<{ incomingIndex: number; existingIndex: number; score: number }> = [];
  incoming.forEach((candidate, incomingIndex) => {
    existing.forEach((stored, existingIndex) => {
      const score = requirementSimilarity(candidate, stored);
      if (score >= MERGE_MATCH_THRESHOLD) pairs.push({ incomingIndex, existingIndex, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const matchedIncoming = new Map<number, number>();
  const usedExisting = new Set<number>();
  for (const pair of pairs) {
    if (matchedIncoming.has(pair.incomingIndex) || usedExisting.has(pair.existingIndex)) continue;
    matchedIncoming.set(pair.incomingIndex, pair.existingIndex);
    usedExisting.add(pair.existingIndex);
  }

  let nextIdNumber = 1 + existing.reduce((max, requirement) => Math.max(max, requirementIdNumber(requirement.id)), 0);
  const added: RequirementDiffEntry[] = [];
  const changed: RequirementDiffEntry[] = [];
  const unchanged: RequirementDiffEntry[] = [];
  const merged: Requirement[] = [];

  incoming.forEach((candidate, incomingIndex) => {
    const existingIndex = matchedIncoming.get(incomingIndex);
    if (existingIndex === undefined) {
      const withId: Requirement = alignScenarioIds({ ...candidate, id: `R${nextIdNumber++}` });
      const revised = reviseRequirementIfChanged(withId, now);
      merged.push(revised);
      added.push({ status: 'added', id: revised.id, requirement: revised });
      return;
    }
    const prior = existing[existingIndex]!;
    const withId = carryForwardRequirementRevision(alignScenarioIds({ ...candidate, id: prior.id }), prior);
    const revised = reviseRequirementIfChanged(withId, now);
    merged.push(revised);
    if (revised.hash === prior.hash) {
      unchanged.push({ status: 'unchanged', id: revised.id, requirement: revised });
    } else {
      changed.push({ status: 'changed', id: revised.id, requirement: revised, previous: prior });
    }
  });

  const removed: RequirementDiffEntry[] = [];
  existing.forEach((stored, existingIndex) => {
    if (usedExisting.has(existingIndex)) return;
    merged.push(stored);
    removed.push({ status: 'removed', id: stored.id, requirement: stored, previous: stored });
  });

  // 분할 힌트: 방금 추가된 항목이 방금 제거된 항목과 어느 정도 닮았고(주 문턱에는 못 미쳤지만) 같은 kind면, 그 제거된
  // 항목이 쪼개져 이 항목이 됐다고 보고 trace.supersedes를 채운다(한 제거 항목이 여러 추가 항목으로 쪼개질 수 있다)
  for (const entry of added) {
    let best: { id: string; score: number } | undefined;
    for (const removedEntry of removed) {
      if (removedEntry.requirement.kind !== entry.requirement.kind) continue;
      const score = requirementSimilarity(entry.requirement, removedEntry.requirement);
      if (score >= MERGE_SPLIT_HINT_THRESHOLD && (!best || score > best.score)) best = { id: removedEntry.id, score };
    }
    if (best) {
      const withSupersedes: Requirement = { ...entry.requirement, trace: { ...entry.requirement.trace, supersedes: best.id } };
      entry.requirement = withSupersedes;
      const index = merged.findIndex((requirement) => requirement.id === entry.id);
      if (index !== -1) merged[index] = withSupersedes;
    }
  }

  merged.sort((a, b) => requirementIdNumber(a.id) - requirementIdNumber(b.id));
  return { merged, diff: [...added, ...changed, ...unchanged, ...removed] };
}

// ---------------------------------------------------------------------------
// 추적 매트릭스(ADR-090): 요구사항·시나리오 행마다 개정·우선순위·이슈·커밋·테스트·게이트·상태를 한 줄로 모으고,
// 역방향 목록(주인 없는 테스트, 테스트 없는 필수 요구사항)을 함께 만든다. "요구사항" 탭의 추적 매트릭스 하위 화면이 쓴다.
// ---------------------------------------------------------------------------

/** 매트릭스 테스트 열의 테스트 하나. 지금 체크포인트(HEAD)의 테스트 탭 실행에 이 테스트가 있었으면 그 결과까지 붙인다
 * (실행 자체가 없었거나 이 테스트가 그 실행에 없었으면 result가 없다 — 화면이 "안 돌림"으로 보여준다) */
export interface MatrixTestMatch extends TestMatch {
  result?: 'pass' | 'fail' | 'not-run';
}

/** 지금 체크포인트에서 돈 테스트 탭 실행 결과를 테스트 하나하나 단위로, 그 테스트 이름에 붙은 요구사항·시나리오 id별로
 * 펼친 목록(studio의 buildMatrixTestRunRows가 만든다). RequirementEvidence.testRun(목록이 쓰는 집계된 통과·실패 수)과는
 * 결이 달라(매트릭스는 테스트 하나하나를 보여줘야 한다) 따로 둔다 — 한 테스트가 여러 id를 언급하면 id마다 한 행씩 있다 */
export interface MatrixTestRunRow {
  id: string;
  file: string;
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'not-run';
  at: string;
  sha: string;
  shortSha: string;
  /** studio가 test-discovery.ts의 envConditionalReasons를 이어 붙인 추정 사유(없으면 없다). findUnexecutedTests가 읽는다 */
  reason?: string;
}

/** studio가 이미 계산한 요구사항 하나의 평가("명세" 탭의 목록이 보여주는 것과 완전히 같은 값). 매트릭스의 요구사항 행이
 * 이 값을 받으면 상태를 다시 계산하지 않고 그대로 쓴다 — 추적 매트릭스가 테스트 탭 실행·문서 확인·사람 확인을 모른 채
 * 체크포인트·테스트 파일 이름·게이트만으로 다시 계산해 목록과 다른 상태를 보여주던 문제를 원천적으로 막는다 */
export interface RequirementEvaluation {
  status: RequirementStatus;
  evidence: RequirementEvidence;
  verifiedBy: 'test' | 'docs' | 'manual' | 'none';
}

export interface MatrixRow {
  kind: 'requirement' | 'scenario';
  id: string;
  /** kind가 scenario일 때만 있다(소속 요구사항 id) */
  parentId?: string;
  title: string;
  rev: number;
  priority: RequirementPriority;
  issue?: number;
  checkpoints: CheckpointRef[];
  tests: MatrixTestMatch[];
  gateChecks: GateCheckResult[];
  status: RequirementStatus;
  /** "검증됨"을 만든 증거(테스트 탭/게이트/문서 확인/사람 확인). 검증됨이 아니면 'none' */
  verifiedBy: MatrixVerificationBadge;
}

export interface TraceabilityMatrix {
  rows: MatrixRow[];
  /** 어느 요구사항·시나리오 id도 언급하지 않은 테스트("주인 없는 테스트") */
  orphanTests: TestMatch[];
  /** 테스트가 하나도 없고(시나리오 테스트 포함) 아직 검증됨도 아닌 필수(must) 요구사항 — 손봐야 할 진짜 공백 */
  mustHavesWithoutTests: Requirement[];
  /** 테스트는 없지만 문서 확인·사람 확인으로 이미 검증됨인 필수 요구사항 — 공백이 아니라 "다른 방식으로 검증됐다"는
   * 안내로 따로 보여준다(테스트가 없다고 "테스트 없는 필수 요구사항"에 섞이면 이미 끝난 일을 또 손보라는 뜻처럼 보인다) */
  mustHavesVerifiedWithoutTests: Requirement[];
}

export interface BuildTraceabilityMatrixInput {
  requirements: readonly Requirement[];
  checkpoints: readonly CheckpointRef[];
  testFiles: readonly ScannedFile[];
  gateChecks: readonly GateCheckResult[];
  /** 요구사항 id별로 이미 평가된 상태·증거(studio의 evaluateRequirementWithContext가 "명세" 탭 목록과 똑같이 만든
   * 값). 있으면 요구사항 행은 이 값을 그대로 쓴다(따로 계산하지 않는다 — 목록과 어긋날 수가 없다). 없으면(이 모듈의
   * 단위 테스트처럼 studio 컨텍스트 없이 부르는 경우) 체크포인트·테스트 파일 이름·게이트만으로 예전처럼 계산한다 */
  evaluationByRequirementId?: Readonly<Record<string, RequirementEvaluation>>;
  /** 지금 체크포인트에서 돈 테스트 탭 실행 결과를 테스트 단위로 펼친 목록(있으면 테스트 열에 통과·실패·안 돌림을 붙인다) */
  testRunRows?: readonly MatrixTestRunRow[];
}

/** 매트릭스 테스트 열 — 파일을 스캔해 찾은 테스트에, 지금 체크포인트에서 돈 테스트 탭 실행 결과가 있으면 이름으로 맞춰
 * 붙인다. 실행에만 있고 스캔에는 안 걸린 테스트(테스트 탭의 발견 파서가 이 모듈의 가벼운 정규식과 다르게 파싱한 경우
 * 등)도 빠뜸없이 보여준다. skip은 "안 돌림"으로 합쳐 보여준다(매트릭스는 통과·실패·안 돌림 세 가지만 구분한다) */
function mergeTestMatchesWithRunRows(scanned: readonly TestMatch[], runRows: readonly MatrixTestRunRow[], id: string): MatrixTestMatch[] {
  const toResult = (status: MatrixTestRunRow['status']): 'pass' | 'fail' | 'not-run' => (status === 'skip' ? 'not-run' : status);
  const matchedRuns = runRows.filter((row) => row.id === id);
  const resultByName = new Map(matchedRuns.map((row) => [row.name, toResult(row.status)]));
  const merged = new Map<string, MatrixTestMatch>();
  for (const test of scanned) {
    const result = resultByName.get(test.name);
    merged.set(test.name, result !== undefined ? { ...test, result } : { ...test });
  }
  for (const row of matchedRuns) {
    if (merged.has(row.name)) continue;
    merged.set(row.name, { file: row.file, name: row.name, result: toResult(row.status) });
  }
  return [...merged.values()];
}

/** 시나리오 하나의 증거를 만든다. 체크포인트·테스트·게이트는 시나리오 id로만 좁히고(요구사항 전체 증거를 섞지 않는다),
 * 요구사항 전체에만 있는 두 증거는 부모에서 정해진 규칙대로 물려받는다: ① 테스트 탭 실행(testRun)은 이 시나리오 id가
 * 붙은 테스트만 따로 모아 다시 센다 — 요구사항 전체 집계를 그대로 쓰면 "다른 시나리오의 테스트가 통과했다"는 이유로
 * 이 시나리오까지 검증됨으로 보일 수 있다. ② 문서 확인(docEvidence)은 애초에 시나리오 단위로 매칭하지 않으므로(인수
 * 조건은 요구사항 전체의 것이다), 부모가 "전부 만족"일 때만 그대로 물려준다 — 일부만 맞은 상태를 물려주면 이 시나리오
 * 자신의 증거가 하나도 없어도 "작업 중"으로 보여 과대평가된다. 사람 확인(manualVerification)·내용 드리프트는 부모
 * 요구사항 객체 자체를 보고 판정하므로(computeRequirementStatus가 requirementForStatus로 받는다) 따로 다루지 않는다
 * — 이 규칙 덕에 시나리오 행의 상태는 "요구사항 목록과 같은 함수로, 증거만 시나리오로 좁혀" 계산된다 */
export function buildScenarioEvidence(params: {
  scenarioId: string;
  checkpoints: readonly CheckpointRef[];
  testFiles: readonly ScannedFile[];
  gateChecks: readonly GateCheckResult[];
  testRunRows: readonly MatrixTestRunRow[];
  parentEvidence?: RequirementEvidence;
}): RequirementEvidence {
  const matchedRuns = params.testRunRows.filter((row) => row.id === params.scenarioId);
  const passed = matchedRuns.filter((row) => row.status === 'pass').length;
  const failed = matchedRuns.filter((row) => row.status === 'fail').length;
  const testRun: TestRunEvidence | undefined =
    passed + failed > 0
      ? {
          at: matchedRuns.reduce((latest, row) => (row.at > latest ? row.at : latest), matchedRuns[0]!.at),
          sha: matchedRuns[0]!.sha,
          shortSha: matchedRuns[0]!.shortSha,
          passed,
          failed,
        }
      : undefined;
  const docEvidence = params.parentEvidence?.docEvidence?.satisfied ? params.parentEvidence.docEvidence : undefined;
  return {
    checkpoints: findCheckpointMentions(params.checkpoints, params.scenarioId),
    tests: scanTestFilesForScenarioId(params.testFiles, params.scenarioId),
    gateChecks: findGateCheckMentions(params.gateChecks, params.scenarioId),
    ...(testRun ? { testRun } : {}),
    ...(docEvidence ? { docEvidence } : {}),
  };
}

/**
 * 요구사항에 시나리오가 있는데, 그 시나리오 id로는 아직 `computeRequirementStatus`가 "검증됨"을 주지 않는 시나리오
 * id만 모은다(다그푸딩 마찰 140). 추적 매트릭스(`buildTraceabilityMatrix`)가 시나리오 행마다 계산하는 것과 같은
 * `buildScenarioEvidence`+`computeRequirementStatus`를 그대로 재사용한다 — 두 곳이 "시나리오가 검증됐다"를
 * 다른 기준으로 매기면 요구사항 카드와 매트릭스가 서로 다른 답을 보여주게 된다.
 * ADR-155: 이 목록은 이제 요구사항 상태에도 쓰인다 — 비어 있지 않으면 테스트·게이트 근거만으로는 검증됨이 아니다.
 * 그래서 "자동 근거로 확인됐는가"만 본다: 사람 확인(요구사항 전체에 대한 것)과 문서 확인은 시나리오 상태를 전부
 * 검증됨으로 만들어 버리므로 시나리오 평가에서 뺀다. 시나리오 평가의 증거에는 missingScenarios가 없어
 * computeRequirementStatus의 새 조건이 재귀로 걸리지 않는다(시나리오에는 하위 시나리오가 없다).
 */
export function findUnverifiedScenarioIds(
  requirement: Requirement,
  checkpoints: readonly CheckpointRef[],
  testFiles: readonly ScannedFile[],
  gateChecks: readonly GateCheckResult[],
  testRunRows: readonly MatrixTestRunRow[],
  parentEvidence: RequirementEvidence,
): string[] {
  const scenarios = requirement.scenarios ?? [];
  if (scenarios.length === 0) return [];
  // "자동 근거(테스트·게이트)로 확인되지 않은 시나리오"를 모은다(ADR-155). 사람 확인·문서 확인은 시나리오마다 따로
  // 하는 확인이 아니라 요구사항 전체에 대한 것이라 시나리오 상태를 전부 검증됨으로 만들어 버리므로, 여기서는 둘 다 뺀다 —
  // 그래야 "테스트가 일부만 덮고 나머지는 사람이 확인했다"를 요구사항 상태·출처(verifiedBy)가 구분해 보여줄 수 있다.
  // 시나리오 평가에는 missingScenarios가 없으니 computeRequirementStatus의 새 조건이 재귀로 걸리지 않는다
  const { manualVerification: _manual, ...automaticRequirement } = requirement;
  const { docEvidence: _doc, ...automaticParent } = parentEvidence;
  return scenarios
    .filter((scenario) => {
      const scenarioEvidence = buildScenarioEvidence({ scenarioId: scenario.id, checkpoints, testFiles, gateChecks, testRunRows, parentEvidence: automaticParent });
      return computeRequirementStatus(scenarioEvidence, automaticRequirement) !== '검증됨';
    })
    .map((scenario) => scenario.id);
}

/**
 * 요구사항 id가 붙은 테스트 중 지금 체크포인트에서 돈 게이트 실행 결과에 하나도 나타나지 않는 것을 찾는다
 * (다그푸딩 마찰 152, BE-commerce R12의 `LiveOrderConcurrencyTest`처럼 `@Tag("integration")`로 기본 test
 * 태스크에서 빠지는 테스트가 발견은 되는데 실행 기록은 전혀 없는 경우).
 * testRunRows는 studio의 `buildMatrixTestRunRows`가 이미 "그 서비스가 지금 체크포인트에서 실제로 돈 실행만"
 * 골라 둔 것(testRunMatchesHead) — 서비스 자체가 안 돌았으면 애초에 이 목록에 들어오지 않는다. 그래서 여기서
 * status가 'not-run'이라는 건 "서비스는 돌았는데 이 테스트만 보고서에 없다"는 뜻이지, "아무것도 안 돌았다"는
 * 뜻이 아니다. 상태는 바꾸지 않는다(`computeRequirementStatus`를 다시 부르지 않는다) — 보여주기만 한다.
 */
export function findUnexecutedTests(requirementId: string, testRunRows: readonly MatrixTestRunRow[]): UnexecutedTestInfo[] {
  const seen = new Set<string>();
  const result: UnexecutedTestInfo[] = [];
  for (const row of testRunRows) {
    if (row.id !== requirementId || row.status !== 'not-run') continue;
    const key = `${row.file}\u0000${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ file: row.file, name: row.name, ...(row.reason ? { reason: row.reason } : {}) });
  }
  return result;
}

/** 증거·상태가 다 정해진 행 하나를 MatrixRow 모양으로 마무리한다(요구사항 행·시나리오 행이 공통으로 쓴다) */
function finalizeMatrixRow(params: {
  kind: 'requirement' | 'scenario';
  id: string;
  parentId?: string;
  title: string;
  rev: number;
  priority: RequirementPriority;
  issue?: number;
  evidence: RequirementEvidence;
  status: RequirementStatus;
  requirementForStatus: Requirement;
  testRunRows: readonly MatrixTestRunRow[];
}): MatrixRow {
  return {
    kind: params.kind,
    id: params.id,
    ...(params.parentId ? { parentId: params.parentId } : {}),
    title: params.title,
    rev: params.rev,
    priority: params.priority,
    ...(params.issue !== undefined ? { issue: params.issue } : {}),
    checkpoints: params.evidence.checkpoints,
    tests: mergeTestMatchesWithRunRows(params.evidence.tests, params.testRunRows, params.id),
    gateChecks: params.evidence.gateChecks,
    status: params.status,
    verifiedBy: matrixVerificationBadge(params.status, params.evidence, params.requirementForStatus),
  };
}

/** studio 평가(evaluationByRequirementId) 없이 부를 때의 요구사항 증거 — 목록과 같은 규칙으로 missingScenarios도 채운다 */
function fallbackEvidence(requirement: Requirement, input: BuildTraceabilityMatrixInput, testRunRows: readonly MatrixTestRunRow[]): RequirementEvidence {
  const base: RequirementEvidence = {
    checkpoints: findCheckpointMentions(input.checkpoints, requirement.id),
    tests: scanTestFilesForRequirementId(input.testFiles, requirement.id),
    gateChecks: findGateCheckMentions(input.gateChecks, requirement.id),
  };
  const missingScenarios = findUnverifiedScenarioIds(requirement, input.checkpoints, input.testFiles, input.gateChecks, testRunRows, base);
  return missingScenarios.length > 0 ? { ...base, missingScenarios } : base;
}

/** 요구사항·시나리오마다 추적 행을 만들고, 주인 없는 테스트·테스트 없는 필수 요구사항을 모은다. 요구사항 행의
 * 증거·상태는 evaluationByRequirementId가 있으면 그대로 쓰고(목록과 똑같다), 없으면 체크포인트·테스트·게이트만으로
 * 계산한다(studio 컨텍스트 없이 부르는 이 모듈의 단위 테스트가 이 경로를 쓴다) */
export function buildTraceabilityMatrix(input: BuildTraceabilityMatrixInput): TraceabilityMatrix {
  const rows: MatrixRow[] = [];
  const mustHavesWithoutTests: Requirement[] = [];
  const mustHavesVerifiedWithoutTests: Requirement[] = [];
  const testRunRows = input.testRunRows ?? [];

  for (const requirement of input.requirements) {
    const evaluation = input.evaluationByRequirementId?.[requirement.id];
    const evidence: RequirementEvidence = evaluation ? evaluation.evidence : fallbackEvidence(requirement, input, testRunRows);
    const status = evaluation ? evaluation.status : computeRequirementStatus(evidence, requirement);
    rows.push(
      finalizeMatrixRow({
        kind: 'requirement',
        id: requirement.id,
        title: requirement.title,
        rev: requirement.rev ?? 1,
        priority: requirement.priority,
        issue: requirement.trace?.issue,
        evidence,
        status,
        requirementForStatus: requirement,
        testRunRows,
      }),
    );

    let scenarioTestCount = 0;
    for (const scenario of requirement.scenarios ?? []) {
      const scenarioEvidence = buildScenarioEvidence({
        scenarioId: scenario.id,
        checkpoints: input.checkpoints,
        testFiles: input.testFiles,
        gateChecks: input.gateChecks,
        testRunRows,
        parentEvidence: evidence,
      });
      scenarioTestCount += scenarioEvidence.tests.length;
      rows.push(
        finalizeMatrixRow({
          kind: 'scenario',
          id: scenario.id,
          parentId: requirement.id,
          title: `(Given) ${scenario.given} (When) ${scenario.when} (Then) ${scenario.then}`,
          rev: requirement.rev ?? 1,
          priority: requirement.priority,
          issue: requirement.trace?.issue,
          evidence: scenarioEvidence,
          status: computeRequirementStatus(scenarioEvidence, requirement),
          requirementForStatus: requirement,
          testRunRows,
        }),
      );
    }

    if (requirement.priority === 'must' && evidence.tests.length === 0 && scenarioTestCount === 0) {
      if (status === '검증됨') mustHavesVerifiedWithoutTests.push(requirement);
      else mustHavesWithoutTests.push(requirement);
    }
  }

  return { rows, orphanTests: scanTestFilesForOrphans(input.testFiles), mustHavesWithoutTests, mustHavesVerifiedWithoutTests };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const MATRIX_TEST_RESULT_LABEL: Record<'pass' | 'fail' | 'not-run', string> = { pass: '통과', fail: '실패', 'not-run': '안 돌림' };

/** 추적 매트릭스를 CSV(쉼표 구분, CRLF 줄바꿈)로 만든다. "CSV로 내보내기" 버튼이 그대로 내려받게 한다 */
export function buildMatrixCsv(matrix: TraceabilityMatrix): string {
  const header = ['종류', 'id', '상위 id', '제목', '개정', '우선순위', '이슈', '커밋', '테스트', '게이트', '검증 출처', '상태'];
  const rows = matrix.rows.map((row) => [
    row.kind === 'requirement' ? '요구사항' : '시나리오',
    row.id,
    row.parentId ?? '',
    row.title,
    String(row.rev),
    row.priority,
    row.issue !== undefined ? `#${row.issue}` : '',
    row.checkpoints.map((checkpoint) => checkpoint.shortSha).join(' '),
    row.tests.map((test) => (test.result ? `${test.name}(${MATRIX_TEST_RESULT_LABEL[test.result]})` : test.name)).join(' | '),
    row.gateChecks.map((check) => `${check.name}:${check.ok ? '통과' : '실패'}`).join(' | '),
    row.verifiedBy === 'none' ? '' : row.verifiedBy,
    row.status,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

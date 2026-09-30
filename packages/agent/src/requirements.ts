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
import { z } from 'zod';
import type { AgentUsage } from './loop';
import { parsePlannerReply, type ModelAsk } from './task-plan';

export const REQUIREMENT_KINDS = ['api', 'ui', 'data', 'nonfunctional', 'docs'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_PRIORITIES = ['must', 'should', 'could'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

/** 한 문서에 담을 수 있는 요구사항 수 상한. 과제 명세 하나 분량을 넘어서면 추출이 잘못됐다고 본다 */
export const MAX_REQUIREMENTS = 60;
/** Spec Kit의 /clarify처럼 "물어볼 가치가 있는 모호함"만 최대 5개 */
export const MAX_CLARIFYING_QUESTIONS = 5;

const REQUIREMENT_ID = /^R[1-9][0-9]*$/;

export const RequirementSchema = z.object({
  id: z.string().regex(REQUIREMENT_ID, 'R1, R2… 형태의 id여야 합니다'),
  title: z.string().min(1).max(200),
  kind: z.enum(REQUIREMENT_KINDS),
  /** 테스트 가능한 인수 조건. "~하면 ~한다" 같은 확인 가능한 문장이어야 한다(제목을 되풀이하는 문장은 안 된다) */
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
  priority: z.enum(REQUIREMENT_PRIORITIES),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const ExtractionReplySchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1).max(MAX_REQUIREMENTS),
    questions: z.array(z.string().min(1).max(300)).max(MAX_CLARIFYING_QUESTIONS),
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
  return `You turn a full-stack coding-assignment spec into a requirements list with testable acceptance criteria, in the style of GitHub Spec Kit's /specify step.
You see ONLY the spec text below — you have no tools to read the actual project code.
Reply with ONLY a JSON object, no prose before or after:
{"requirements":[{"id":"R1","title":"short title","kind":"api"|"ui"|"data"|"nonfunctional"|"docs","acceptance":["testable criterion", "..."],"priority":"must"|"should"|"could"}],"questions":["short clarifying question", "..."]}
Rules:
- id: "R1","R2",... in the order requirements appear in the spec. No gaps, no repeats.
- title: one short line.
- acceptance: 1 or more testable statements a reviewer could check off (not a restatement of the title). Write them so a test name or manual check could reference them directly.
- kind: api(서버 엔드포인트·비즈니스 로직), ui(화면·컴포넌트), data(스키마·마이그레이션), nonfunctional(성능·보안·가용성 등 비기능 요구), docs(문서화). Pick the closest one.
- priority: must(없으면 과제 제출이 안 됨), should(있어야 완성도 있음), could(있으면 좋음, 보너스). Default to "must" unless the spec explicitly marks an item optional/bonus/nice-to-have.
- questions: at most ${MAX_CLARIFYING_QUESTIONS} short clarifying questions about real ambiguities that would change requirements or acceptance criteria (Spec Kit's /clarify style — do not ask about things the spec already answers). If nothing is ambiguous, reply with an empty array.
- Write title/acceptance/questions text in Korean. Keep id/kind/priority values in English exactly as listed above.`;
}

/** 추출 모델에게 주는 사용자 메시지. 스펙 원문 그대로 넘긴다(질문 답변이 있으면 스펙 끝에 이미 덧붙여 온다 — "스펙을 고치고 다시 뽑기") */
export function buildExtractionUserPrompt(specText: string): string {
  return `Assignment spec:\n\n${specText.trim()}`;
}

/** 모델 응답에서 JSON을 꺼내 검증한다. 형식이 틀리면 RequirementsError */
export function parseExtractionReply(text: string): ExtractionReply {
  let raw: unknown;
  try {
    raw = parsePlannerReply(text);
  } catch (error) {
    throw new RequirementsError(error instanceof Error ? error.message : String(error));
  }
  const parsed = ExtractionReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequirementsError(`추출 응답 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}

/**
 * 추출 모델을 도구 없이 한 번 불러 요구사항·질문을 받는다. 부르는 방법은 바깥에서 준다(ModelAsk) —
 * claude-code 모드는 도구 없는 로컬 CLI 한 번 호출, api 모드는 ModelClient 어댑터(계획·리뷰 호출과 같은 경계).
 */
export async function requestRequirementsExtraction(ask: ModelAsk, specText: string, signal?: AbortSignal): Promise<ExtractionReply & { usage: AgentUsage; durationMs: number }> {
  const started = performance.now();
  const answer = await ask({ system: buildExtractionSystemPrompt(), user: buildExtractionUserPrompt(specText) }, signal);
  const durationMs = Math.round(performance.now() - started);
  const { text, usage } = answer;
  try {
    return { ...parseExtractionReply(text), usage, durationMs };
  } catch (error) {
    if (error instanceof RequirementsError) {
      error.usage = usage;
      error.durationMs = durationMs;
    }
    throw error;
  }
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
// 사람이 읽는 마크다운 저장/불러오기(docs/requirements.md)
// ---------------------------------------------------------------------------

/** 세션 작업 복사본에 쓰는 자리. 체크포인트 diff·PR·다음 세션에 그대로 남는다(=제출물의 일부) */
export const REQUIREMENTS_FILE = 'docs/requirements.md';

export type RequirementStatus = '미착수' | '작업 중' | '검증됨' | '실패';
export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ['미착수', '작업 중', '검증됨', '실패'];

const JSON_BLOCK = /<!--\s*b-studio-requirements\s*([\s\S]*?)-->/;

function requirementHeading(requirement: Requirement): string {
  return `## ${requirement.id}. ${requirement.title}`;
}

const KIND_PRIORITY_LINE = /^-\s*종류:\s*(\S+)\s*·\s*우선순위:\s*(\S+)\s*$/;
const ACCEPTANCE_HEADER = /^-\s*인수\s*조건:\s*$/;
const ACCEPTANCE_ITEM = /^\s+-\s+(.+?)\s*$/;
const REQUIREMENT_HEADING = /^##\s+(R[1-9][0-9]*)\.\s*(.+?)\s*$/;

/**
 * 요구사항 목록을 사람이 읽는 마크다운으로 바꾼다: 요구사항마다 헤딩·종류/우선순위·인수 조건·상태 줄을 두고,
 * 끝에 안정적으로 다시 읽을 수 있는 HTML 주석 JSON 블록(id·kind·priority·acceptance)을 붙인다.
 * statusById에 없는 요구사항은 "미착수"로 쓴다(상태는 저장 시점의 스냅샷일 뿐이고, 다시 읽을 때는 증거로 새로 계산한다).
 */
export function serializeRequirementsMarkdown(requirements: readonly Requirement[], statusById: Readonly<Record<string, RequirementStatus>> = {}): string {
  const blocks = requirements.map((requirement) => {
    const acceptance = requirement.acceptance.map((item) => `  - ${item}`).join('\n');
    const status = statusById[requirement.id] ?? '미착수';
    return `${requirementHeading(requirement)}\n- 종류: ${requirement.kind} · 우선순위: ${requirement.priority}\n- 인수 조건:\n${acceptance}\n- 상태: ${status}`;
  });
  const json = JSON.stringify(
    requirements.map(({ id, title, kind, priority, acceptance }) => ({ id, title, kind, priority, acceptance })),
    null,
    2,
  );
  return `# 요구사항\n\n${blocks.join('\n\n')}\n\n<!-- b-studio-requirements\n${json}\n-->\n`;
}

/**
 * docs/requirements.md를 다시 읽는다. 사람이 헤딩·제목·인수 조건을 손으로 고쳐도(구조 표지 — "## R1.", "종류: … · 우선순위: …",
 * "인수 조건:" — 는 그대로 둔 채) 그 값을 그대로 반영한다(사람 편집을 우선한다). 구조가 깨져 하나도 못 읽으면
 * 끝의 JSON 블록(마지막으로 저장한 값)으로 되돌아간다. 둘 다 실패하면 빈 배열을 돌려준다 — 호출하는 쪽이 "명세를 다시 뽑아 주세요"로 안내한다.
 */
export function parseRequirementsMarkdown(raw: string): { requirements: Requirement[] } {
  const withoutJsonBlock = raw.replace(JSON_BLOCK, '');
  const lines = withoutJsonBlock.split(/\r?\n/);
  const drafts: Array<{ id: string; title: string; kind?: string; priority?: string; acceptance: string[] }> = [];
  let current: (typeof drafts)[number] | undefined;
  let collectingAcceptance = false;

  for (const line of lines) {
    const heading = REQUIREMENT_HEADING.exec(line);
    if (heading) {
      if (current) drafts.push(current);
      current = { id: heading[1]!, title: heading[2]!, acceptance: [] };
      collectingAcceptance = false;
      continue;
    }
    if (!current) continue;
    const kindLine = KIND_PRIORITY_LINE.exec(line);
    if (kindLine) {
      current.kind = kindLine[1];
      current.priority = kindLine[2];
      collectingAcceptance = false;
      continue;
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
    }
  }
  if (current) drafts.push(current);

  const parsedFromMarkdown = drafts.map((draft) => RequirementSchema.safeParse(draft));
  if (drafts.length > 0 && parsedFromMarkdown.every((result) => result.success)) {
    return { requirements: parsedFromMarkdown.map((result) => (result as z.ZodSafeParseSuccess<Requirement>).data) };
  }

  const jsonMatch = JSON_BLOCK.exec(raw);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[1]!);
      const parsed = z.array(RequirementSchema).safeParse(json);
      if (parsed.success) return { requirements: parsed.data };
    } catch {
      // 주석 블록도 사람이 손으로 깨뜨렸을 수 있다 — 아래에서 빈 배열로 마무리한다
    }
  }
  return { requirements: [] };
}

// ---------------------------------------------------------------------------
// 추적: 체크포인트·테스트·게이트 결과에서 증거를 모아 상태를 매긴다
// ---------------------------------------------------------------------------

export interface CheckpointRef {
  sha: string;
  shortSha: string;
  /** 커밋 메시지 전체(제목+본문). "요청: [R3] …" 형태로 id가 들어간다 */
  message: string;
}

export interface TestMatch {
  file: string;
  name: string;
}

export interface GateCheckResult {
  name: string;
  ok: boolean;
}

export interface RequirementEvidence {
  checkpoints: CheckpointRef[];
  tests: TestMatch[];
  gateChecks: GateCheckResult[];
}

/** id가 텍스트 안에서 "R3"나 "[R3]"처럼 독립된 토큰으로 나타나는지(예: "R31"의 일부로 우연히 걸리지 않게) */
export function mentionsRequirementId(text: string, id: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`);
  return pattern.test(text);
}

export function findCheckpointMentions(checkpoints: readonly CheckpointRef[], id: string): CheckpointRef[] {
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
      const trimmed = name.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        matches.push({ file: file.path, name: trimmed });
      }
    };

    const callPattern = /\b(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
    for (const match of file.content.matchAll(callPattern)) {
      if (mentionsRequirementId(match[2]!, id)) add(match[2]!);
    }

    const displayNamePattern = /@DisplayName\s*\(\s*"((?:\\.|[^"])*)"/g;
    for (const match of file.content.matchAll(displayNamePattern)) {
      if (mentionsRequirementId(match[1]!, id)) add(match[1]!);
    }

    const methodPattern = /\b(?:void|public|private|protected)\s+[\w<>[\],\s]*?\b(\w*[Rr]\d+\w*)\s*\(/g;
    for (const match of file.content.matchAll(methodPattern)) {
      if (identifierMentionsId(match[1]!, id)) add(match[1]!);
    }
  }
  return matches;
}

/**
 * 상태 규칙(ADR-079): 미착수 → 작업 중(체크포인트가 참조하거나 테스트가 있다) → 검증됨(id가 붙은 게이트 확인이
 * 최근 체크포인트에서 통과) / 실패(id가 붙은 게이트 확인 중 하나라도 실패). 게이트 확인 증거가 있으면 그것이 우선한다 —
 * 체크포인트만 참조하고 실제로 통과했는지 모르는 상태(작업 중)보다 실제 결과(검증됨/실패)를 더 믿을 수 있는 증거로 본다.
 */
export function computeRequirementStatus(evidence: RequirementEvidence): RequirementStatus {
  if (evidence.gateChecks.length > 0) {
    return evidence.gateChecks.every((check) => check.ok) ? '검증됨' : '실패';
  }
  if (evidence.checkpoints.length > 0 || evidence.tests.length > 0) return '작업 중';
  return '미착수';
}

/** Devin 스타일 확신 표시. 검증됨=🟢, 작업 중=🟡, 그 밖(미착수·실패)=🔴 — 실패는 증거가 오히려 반대라 붉은 점이 맞다 */
export function requirementConfidence(status: RequirementStatus): '🟢' | '🟡' | '🔴' {
  if (status === '검증됨') return '🟢';
  if (status === '작업 중') return '🟡';
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
}

export function summarizeCoverage(requirements: readonly Requirement[], statusById: Readonly<Record<string, RequirementStatus>>): RequirementCoverage {
  const total = requirements.length;
  const verified = requirements.filter((requirement) => statusById[requirement.id] === '검증됨').length;
  const mustRequirements = requirements.filter((requirement) => requirement.priority === 'must');
  const mustTotal = mustRequirements.length;
  const mustVerified = mustRequirements.filter((requirement) => statusById[requirement.id] === '검증됨').length;
  const mustGap = mustTotal - mustVerified;
  return {
    total,
    verified,
    mustTotal,
    mustVerified,
    text: `${total}개 중 ${verified}개 검증됨`,
    ...(mustGap > 0 ? { mustGapText: `필수(must) 요구사항 ${mustGap}개 미검증` } : {}),
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

// ---------------------------------------------------------------------------
// 대화 입력창 채우기(chat-draft-context.tsx가 채우고, 절대 자동으로 보내지 않는다)
// ---------------------------------------------------------------------------

/** "이 요구사항 작업" 버튼이 채우는 글 */
export function buildRequirementWorkPrefill(requirement: Requirement): string {
  const acceptance = requirement.acceptance.map((item) => `- ${item}`).join('\n');
  return `[${requirement.id}] ${requirement.title}\n\n인수 조건:\n${acceptance}\n\n테스트 이름에 ${requirement.id}을(를) 넣어 인수 조건을 검증하는 테스트를 함께 작성해 주세요.`;
}

/** "전체 계획 세우기" 버튼이 채우는 글. must 요구사항을 순서대로 나열한다(레인을 나눌지는 에이전트가 스스로 정한다) */
export function buildAllMustHavesPrefill(requirements: readonly Requirement[]): string {
  const mustHaves = requirements.filter((requirement) => requirement.priority === 'must');
  const list = mustHaves.map((requirement) => `- [${requirement.id}] ${requirement.title}`).join('\n');
  return `다음 필수(must) 요구사항을 모두 구현해 주세요. 서로 독립적인 부분이 있으면 레인을 나눠 계획을 세워도 됩니다. 요구사항마다 테스트 이름에 해당 id(R1 등)를 넣어 인수 조건을 검증하는 테스트를 함께 작성해 주세요.\n\n${list}`;
}

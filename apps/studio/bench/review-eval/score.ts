/**
 * 리뷰 응답 채점기(결정론). 모델은 쓰지 않는다.
 *
 * 규칙
 *  - 응답은 제품과 같은 `parsePrReviewReply`로 읽는다. 읽지 못하면(JSON이 아님·스키마 불일치·응답 없음) 그 항목은 "응답 못 읽음"이다.
 *    못 읽은 항목은 기대 지적을 놓친 것으로 세고(재현율 분모에 남는다), 결함 없는 diff에서도 "오탐 없음"으로 세지 않는다
 *  - 맞음: 지적의 파일이 기대 지적의 파일과 같고(`a/`·`b/` 접두, `./`, 역슬래시, 겹친 `/`만 같게 본다) 지적의 줄이 기대 줄 범위(양 끝 포함) 안이다.
 *    줄이 없는 지적은 맞음으로 세지 않는다. 심각도·제목·종류 태그는 맞음 판정에 쓰지 않는다
 *  - 기대 지적 하나를 여러 지적이 가리켜도 한 번만 맞는다. 어떤 기대 지적에도 맞지 않는 지적은 결함 있는 diff에서 "범위 밖"이다
 *  - 결함 없는 diff(기대 지적이 없음)의 지적은 전부 오탐이다
 *  - notInDiff: 지적의 파일·줄이 리뷰한 diff에 없는 수. 제품이 쓰는 위치 대조(review-finding-check.ts, #1440)를 그대로 쓴다. 확인 못 함은 세지 않는다
 */
import { checkFindingLocations, parsePrReviewReply, type PrReviewFinding } from '@b-studio/agent';
import { DEFECT_TAGS, EVAL_LANGUAGES, type DefectTag, type EvalCase, type EvalLanguage, type ExpectedFinding } from './types';

export interface ExpectedResult extends ExpectedFinding {
  hit: boolean;
}

export interface CaseResult {
  id: string;
  language: EvalLanguage;
  clean: boolean;
  /** 응답을 읽었는가. false면 이 항목은 맞춘 것도 오탐 없음도 아니다 */
  readable: boolean;
  parseError?: string;
  findings: number;
  expected: ExpectedResult[];
  /** 결함 없는 diff에서 나온 지적 수 */
  falsePositives: number;
  /** 결함이 있는 diff에서 기대 지적 어디에도 맞지 않은 지적 수 */
  outOfScope: number;
  /** 지적의 파일·줄이 리뷰한 diff에 없는 수(#1440의 위치 대조) */
  notInDiff: number;
}

/** 경로를 비교용으로만 고른다. 대소문자는 구분한다(파일 시스템에 기대지 않는다) */
export function normalizeEvalPath(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length > 1 && (parts[0] === 'a' || parts[0] === 'b')) parts.shift();
  return parts.join('/');
}

function covers(expected: ExpectedFinding, finding: PrReviewFinding): boolean {
  return finding.line !== undefined && normalizeEvalPath(finding.file) === normalizeEvalPath(expected.file) && finding.line >= expected.startLine && finding.line <= expected.endLine;
}

export function scoreCase(c: EvalCase, reply: string | undefined): CaseResult {
  const base = { id: c.id, language: c.language, clean: c.expected.length === 0 };
  const missed: ExpectedResult[] = c.expected.map((e) => ({ ...e, hit: false }));
  let findings: PrReviewFinding[];
  try {
    if (reply === undefined) throw new Error('응답이 없습니다');
    findings = parsePrReviewReply(reply);
  } catch (error) {
    return { ...base, readable: false, parseError: error instanceof Error ? error.message : String(error), findings: 0, expected: missed, falsePositives: 0, outOfScope: 0, notInDiff: 0 };
  }
  let outOfScope = 0;
  for (const finding of findings) {
    const matched = missed.filter((e) => covers(e, finding));
    for (const e of matched) e.hit = true;
    if (matched.length === 0 && !base.clean) outOfScope += 1;
  }
  const checks = checkFindingLocations(findings, { diff: c.diff, truncated: false, omittedFiles: [] });
  return {
    ...base,
    readable: true,
    findings: findings.length,
    expected: missed,
    falsePositives: base.clean ? findings.length : 0,
    outOfScope,
    notInDiff: checks.filter((check) => check.status === 'not_in_diff').length,
  };
}

export interface Totals {
  items: number;
  unreadable: number;
  expected: number;
  hits: number;
  /** 맞은 기대 지적 / 전체 기대 지적. 못 읽은 항목도 분모에 든다. 기대 지적이 없으면 null */
  recall: number | null;
  falsePositives: number;
  cleanItems: number;
  /** 결함 없는 diff 중 응답을 읽었고 지적이 0개인 항목 수 */
  cleanPassed: number;
  outOfScope: number;
  notInDiff: number;
  byTag: Partial<Record<DefectTag, { expected: number; hits: number; recall: number }>>;
  byLanguage: Partial<Record<EvalLanguage, { expected: number; hits: number; recall: number | null }>>;
}

export function summarize(results: readonly CaseResult[]): Totals {
  const all = results.flatMap((r) => r.expected.map((e) => ({ ...e, language: r.language })));
  const hits = all.filter((e) => e.hit).length;
  const byTag: Totals['byTag'] = {};
  for (const tag of DEFECT_TAGS) {
    const own = all.filter((e) => e.tag === tag);
    if (own.length > 0) byTag[tag] = { expected: own.length, hits: own.filter((e) => e.hit).length, recall: own.filter((e) => e.hit).length / own.length };
  }
  const byLanguage: Totals['byLanguage'] = {};
  for (const language of EVAL_LANGUAGES) {
    if (!results.some((r) => r.language === language)) continue;
    const own = all.filter((e) => e.language === language);
    const ownHits = own.filter((e) => e.hit).length;
    byLanguage[language] = { expected: own.length, hits: ownHits, recall: own.length === 0 ? null : ownHits / own.length };
  }
  const sum = (pick: (r: CaseResult) => number) => results.reduce((n, r) => n + pick(r), 0);
  const clean = results.filter((r) => r.clean);
  return {
    items: results.length,
    unreadable: results.filter((r) => !r.readable).length,
    expected: all.length,
    hits,
    recall: all.length === 0 ? null : hits / all.length,
    falsePositives: sum((r) => r.falsePositives),
    cleanItems: clean.length,
    cleanPassed: clean.filter((r) => r.readable && r.findings === 0).length,
    outOfScope: sum((r) => r.outOfScope),
    notInDiff: sum((r) => r.notInDiff),
    byTag,
    byLanguage,
  };
}

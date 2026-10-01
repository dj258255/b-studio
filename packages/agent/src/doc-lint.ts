/**
 * 문서·PR 본문의 "모호한 표현" 린트(ADR-098). 범수 님이 쓴 평가 기준(측정 가능한 말을 쓴다 — "성능이
 * 좋아졌다/빨라졌다/안정적이다" 대신 수치·단위를, "latency"·"throughput"처럼 헷갈리는 말은 정확한 용어로)을
 * 문서 탭·PR 올리기 미리보기에서 결정론적으로(모델 호출 없이) 잡아내는 안전망이다.
 *
 * requirements.ts의 lintRequirement가 쓰는 약한 표현 목록(WEAK_WORDS_KO/EN·WEAK_WORD_ETC_KO·escapeRegExp)을
 * 그대로 가져와 쓴다 — 요구사항 문장만이 아니라 문서·PR 본문 같은 자유 텍스트에도 같은 "약한 표현" 기준을
 * 적용해야 두 린트가 서로 다른 말을 다른 기준으로 잡는 혼란이 없다.
 *
 * 이 파일은 줄 번호가 있는 자유 텍스트(마크다운 문서, PR 본문)를 대상으로 한다 — requirements.ts의
 * lintRequirement는 구조화된 Requirement 한 건을 대상으로 한다는 점이 다르다(그래서 따로 둔다).
 */
import { escapeRegExp, WEAK_WORD_ETC_KO, WEAK_WORDS_EN, WEAK_WORDS_KO } from './requirements';

export interface DocLintFinding {
  /** 1부터 시작하는 줄 번호 */
  line: number;
  code: 'weak-word' | 'vague-performance' | 'confusable-term';
  message: string;
}

/** 줄마다 약한 표현(requirements.ts와 같은 한국어·영어 목록)을 찾는다. 단어 경계 규칙도 lintRequirement와 같다 */
function findWeakWords(line: string): Array<{ code: 'weak-word'; message: string }> {
  const findings: Array<{ code: 'weak-word'; message: string }> = [];
  for (const word of WEAK_WORDS_KO) {
    const pattern = new RegExp(`(^|[^가-힣A-Za-z0-9])${escapeRegExp(word)}($|[^가-힣A-Za-z0-9])`);
    if (pattern.test(line)) findings.push({ code: 'weak-word', message: `약한 표현 "${word}"이(가) 있습니다 — 수치·구체적 조건으로 바꿔 주세요` });
  }
  if (WEAK_WORD_ETC_KO.test(line)) findings.push({ code: 'weak-word', message: '약한 표현 "등"이(가) 있습니다 — 목록을 모두 적어 주세요' });
  const lowerLine = line.toLowerCase();
  for (const word of WEAK_WORDS_EN) {
    const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(word)}($|[^a-z0-9-])`);
    if (pattern.test(lowerLine)) findings.push({ code: 'weak-word', message: `약한 표현 "${word}"이(가) 있습니다 — 수치·구체적 조건으로 바꿔 주세요` });
  }
  return findings;
}

/**
 * 측정값 없는 성능·안정성 주장. "성능 개선"·"빨라졌다"·"안정적이다"·"부하가 크다"처럼 방향만 말하고 수치가
 * 없는 문장을 잡는다. 같은 줄에 숫자+단위(ms, %, p95, rps, tps, qps, MB, GB, 초, 배, 건)가 있으면 이미 측정값을
 * 댄 것으로 보고 넘어간다("p95 850ms로 개선" 같은 문장은 걸리지 않는다).
 */
const VAGUE_PERFORMANCE_PATTERNS: readonly RegExp[] = [
  /성능\s*(이|을|을이|가)?\s*(개선|향상|좋아|나아)/,
  /(빨라|느려)(졌|지)/,
  /반응\s*(이|속도)?\s*(빠르|느리)/,
  /안정적/,
  /부하(가|를)?\s*(크|높|많)/,
  /(처리량|속도|지연)(이|을|가)?\s*(높|낮|많|적)/,
];
const MEASUREMENT_EVIDENCE = /\d+\s*(ms|밀리초|%|percent|초|배|건|회|[kmg]?b\b|rps|tps|qps|p\d\d|req\/s)/i;

function findVaguePerformance(line: string): Array<{ code: 'vague-performance'; message: string }> {
  if (MEASUREMENT_EVIDENCE.test(line)) return [];
  const findings: Array<{ code: 'vague-performance'; message: string }> = [];
  for (const pattern of VAGUE_PERFORMANCE_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      findings.push({ code: 'vague-performance', message: `"${match[0]}"는 수치·단위(ms, %, p95, rps, MB 등) 없이 방향만 말합니다 — 무엇을 어떻게 재서 얼마나 달라졌는지 적어 주세요` });
    }
  }
  return findings;
}

/** 헷갈리기 쉬운 용어 쌍. 느슨한 상위어(속도·동시·많이 접속)가 둘 중 어느 뜻인지 밝히지 않고 쓰이면 힌트를 보여 준다 */
const CONFUSABLE_TERM_HINTS: ReadonlyArray<{ loose: RegExp; hint: string }> = [
  // \b는 한글-한글 경계에서는 서지 않는다(둘 다 "단어 아님"이라 경계가 생기지 않는다) — requirements.ts의 WEAK_WORD_ETC_KO와 같은 이유로 \b를 쓰지 않는다
  { loose: /속도|빠르기/, hint: 'latency(지연)와 throughput(처리량) 중 무엇인지 적어 주세요' },
  { loose: /동시\s*(에|로)?\s*(여러|많이)|많이\s*접속/, hint: 'concurrency(동시성)와 parallelism(병렬성) 중 무엇인지 적어 주세요' },
  { loose: /빈번히|자주/, hint: 'frequency(빈도)와 throughput(처리량) 중 무엇인지, 단위 시간당 몇 건인지 적어 주세요' },
];
/** 정확한 용어를 이미 썼으면(괄호 설명 포함) 다시 지적하지 않는다 */
const PRECISE_TERMS = /latency|throughput|concurrency|parallelism|지연\s*\(|처리량\s*\(|동시성\s*\(|병렬성\s*\(/i;

function findConfusableTerms(line: string): Array<{ code: 'confusable-term'; message: string }> {
  if (PRECISE_TERMS.test(line)) return [];
  const findings: Array<{ code: 'confusable-term'; message: string }> = [];
  for (const { loose, hint } of CONFUSABLE_TERM_HINTS) {
    const match = loose.exec(line);
    if (match) findings.push({ code: 'confusable-term', message: `"${match[0]}"는 뜻이 여러 가지로 읽힙니다 — ${hint}` });
  }
  return findings;
}

/**
 * 자유 텍스트(문서·PR 본문)를 줄 단위로 린트한다: 약한 표현, 수치 없는 성능·안정성 주장, 헷갈리는 용어 쌍.
 * 모두 결정론적 문자열 검사라 모델을 부르지 않는다. 화면은 이 결과를 막지 않고(non-blocking) 보여 주기만 한다.
 */
export function lintText(text: string): DocLintFinding[] {
  const findings: DocLintFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const finding of findWeakWords(line)) findings.push({ line: lineNumber, ...finding });
    for (const finding of findVaguePerformance(line)) findings.push({ line: lineNumber, ...finding });
    for (const finding of findConfusableTerms(line)) findings.push({ line: lineNumber, ...finding });
  });
  return findings;
}

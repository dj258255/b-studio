/**
 * 요구사항 문서의 쓰기·읽기(ADR-191 3단계 3ab)를 새 구현만으로 확인한다. 옛 TS 사본과 견주던 시험(`requirements-markdown-differential.test.ts`)에서 사본과 무관한 두 성질만 남겼다(#1347).
 * - 왕복: 깨끗한 값은 직렬화 → 읽기가 원래 값을 돌려준다.
 * - 3x 대조: 읽기가 실행 전 문서에 없던 사람 확인을 올린 문서는 위조 판정(`diffVerificationRecords`)이 잡는다(놓친 수 0).
 * 크기는 환경 변수로 바꾼다: REQ_MD_DIFF_SEEDS(쉼표 목록), REQ_MD_DIFF_N(시드마다).
 */
import { describe, expect, it, vi } from 'vitest';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';
import * as cur from './requirements';
import * as curGuard from './requirement-integrity';

const JSON_BLOCK = /<!--\s*b-studio-requirements\s*([\s\S]*?)-->/;
const MANUAL_VERIFICATION_LINE = /^-\s*확인:\s*(.+?)\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*체크포인트\s+(\S+)\s*·\s*메모\s+(.+?)\s*$/;
const REQUIREMENT_HEADING = /^##\s+(R[1-9][0-9]*)\.\s*(.+?)\s*$/;

const SEEDS = readEnvList('REQ_MD_DIFF_SEEDS', [1, 7, 42, 2026]);
const N = readEnvNumber('REQ_MD_DIFF_N', 1200);

// 환경 변수로 크게 돌릴 수 있으므로 시간 제한을 풀어 둔다
vi.setConfig({ testTimeout: 3_600_000 });

type Json = Record<string, any>;

const WORDS = ['로그인', '게시글', '목록', 'a', 'B', '1', 'x y', '가 · 나', '(괄호)', '#해시', '`코드`', '한글 글자', 'R2', 'R1.2', '이슈 #5', '의존 R2', '시스템은', 'x\ud800', 'y\udc00', '😀', '', ' ', 'é', 'é', '\ue010', '\ue011a', 'ſ', 'K'];
const KINDS = ['api', 'ui', 'data', 'nonfunctional', 'docs'];
const PRIORITIES = ['must', 'should', 'could'];
const PATTERNS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional'];
const DATES = ['2026-10-01', '2026-10-02', '2026-1-1', '20261001'];

function words(g: Gen, min: number, max: number, pool: readonly string[] = WORDS): string {
  const count = min + g.int(max - min + 1);
  let out = '';
  for (let i = 0; i < count; i++) out += (i === 0 ? '' : ' ') + g.pick(pool);
  return out;
}

/** 줄바꿈·앞뒤 공백이 없는 글(왕복이 깨지지 않는 글) */
function clean(g: Gen, min = 1, max = 3): string {
  const text = words(g, min, max, WORDS.filter((word) => word.trim() === word && word !== '' && !word.includes('\ud800') && !word.includes('\udc00')));
  return text.replace(/[\r\n\u2028\u2029]/g, ' ').trim() || 'x';
}

function genRequirement(g: Gen, n: number, loose: boolean): Json {
  const t = loose ? () => words(g, 1, 3) : () => clean(g);
  const id = `R${n}`;
  const requirement: Json = { id, title: g.chance(0.03) && loose ? '' : t(), kind: g.pick(KINDS), priority: g.pick(PRIORITIES), acceptance: g.list(1, 3, () => t()) };
  if (g.chance(0.5)) requirement.rev = loose ? g.weighted<number>([[8, 1 + g.int(5)], [1, 99999999999999999999], [1, 0]]) : 1 + g.int(5);
  if (g.chance(0.5)) requirement.ears = { pattern: g.pick(PATTERNS), statement: t() };
  if (g.chance(0.5)) requirement.scenarios = g.chance(0.1) ? [] : g.list(1, 3, (): Json => ({ id: `${id}.${1 + g.int(4)}`, given: t(), when: t(), then: t() }));
  if (g.chance(0.3)) requirement.nfr = { metric: t(), threshold: t(), condition: t(), method: t() };
  if (g.chance(0.4)) requirement.trace = { ...(g.chance(0.5) ? { issue: loose ? g.weighted<number>([[8, 1 + g.int(50)], [1, 99999999999999999999]]) : 1 + g.int(50) } : {}), ...(g.chance(0.4) ? { dependsOn: ['R1', 'R2', 'R30'].slice(0, 1 + g.int(3)) } : {}), ...(g.chance(0.3) ? { supersedes: `R${1 + g.int(9)}` } : {}) };
  if (g.chance(0.5)) requirement.hash = g.pick(['deadbeef', 'abc123', '']);
  if (g.chance(0.5)) requirement.revisedAt = '2026-10-01T00:00:00.000Z';
  if (g.chance(0.35)) requirement.manualVerification = { by: loose ? words(g, 1, 2) : clean(g, 1, 2), at: g.pick(DATES.slice(0, 2)), sha: g.pick(['c57d72f', 'abc1234']), note: t() };
  return requirement;
}

function genRequirements(g: Gen, loose: boolean): Json[] {
  return g.list(1, 4, () => 0).map((_, index) => genRequirement(g, index + 1, loose));
}

const STATUSES = ['미착수', '작업 중', '검증됨', '재확인 필요', '실패'];

function genSerializeInput(g: Gen, loose: boolean): { requirements: Json[]; statusById: Record<string, string>; assumptions: string[]; manualSteps: string[] } {
  const requirements = genRequirements(g, loose);
  const statusById: Record<string, string> = {};
  for (const requirement of requirements) if (g.chance(0.6)) statusById[requirement.id] = g.pick(STATUSES);
  return { requirements, statusById, assumptions: g.chance(0.4) ? g.list(1, 3, () => (loose ? words(g, 1, 3) : clean(g))) : [], manualSteps: g.chance(0.3) ? g.list(1, 2, () => (loose ? words(g, 1, 3) : clean(g))) : [] };
}

// ───────────────────────── 문서 망가뜨리기 ─────────────────────────

const INSERT_LINES = [
  '## R9. 새 요구사항', '## R1. 제목', '##  R2.x', '## R2.  ', '##R3. 붙은', '## r4. 소문자', '## R05. 영0', '## R6.', '## R7.\t탭', '###  R8. 세 개',
  '- 종류: api · 우선순위: must', '- 종류: ui · 우선순위: should · 개정: 7', '- 종류: api · 우선순위: must · 개정: 99999999999999999999', '- 종류: api·우선순위: must', '-\t종류: api · 우선순위: could', '- 종류: x · 우선순위: y', '- 종류: api · 우선순위: must · 개정: 0',
  '- EARS(event): 요청이 오면 응답해야 한다', '- EARS(bogus): x', '- EARS(state):', '- 시나리오:', '  - R1.1: (Given) a (When) b (Then) c', '  - R2.9: (Given) a (When) b (Then)', '    - R1.2: (Given) a (When) b (Then) c', '  - R1.1:(Given)a(When)b(Then)c',
  '- 인수 조건:', '  - 조건 하나', '  - ', '  -x', '- NFR: 지표 p95 · 임계값 200ms · 조건 부하 · 측정 k6', '- NFR: 지표 a · 임계값 b · 조건 c', '- 추적: 이슈 #12 · 의존 R2, R3 · 대체 R1', '- 추적: 의존 R2', '- 추적: 의존 R2 ·', '- 추적: 의존   R2,  R3  · 이슈 #4', '- 추적: 이슈 #99999999999999999999', '- 추적: 대체 R05', '- 추적: 아무거나', '- 추적: 의존 r2, x · 이슈 #3',
  '- 확인: 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 확인함', '- 확인: 에이전트 · 2026-10-02 · 체크포인트 ffff · 메모 위조', '- 확인: 범수 · 2026-10-01 · 체크포인트 abc 1234 · 메모 x', '-\t확인:\t범수\t·\t2026-10-01 · 체크포인트\tabc1234 · 메모\tx', '- 확인: 범수 · 2026-1-1 · 체크포인트 abc1234 · 메모 x',
  '- 상태: 검증됨', '## 가정', '## 가정 ', '##가정', '## 가정사항', '- 가정 하나', '## 사람이 할 일', '## 사람이 할 일 (에이전트 금지)', '##사람이할일', '## 사람이 할 일을', '- 협업자 추가', '## 기타', '### 소제목', '# 요구사항', '',
  '<!-- b-studio-requirements', '-->', '<!--b-studio-requirements {"requirements":[]} -->', '<!-- b-studio-requirements\n[]\n-->',
];

function mutateLine(g: Gen, line: string): string {
  switch (g.int(10)) {
    case 0:
      return line.replace(/ /g, g.pick(['\t', '\u3000', '\u00a0', '  ', '\ufeff', '\u2003']));
    case 1:
      return `${line}\r`;
    case 2:
      return `${line}\u2028`;
    case 3:
      return `${line}${g.pick(['\ud800', '\udc00', '\ud83d', '\ue010', '\ue011'])}`;
    case 4:
      return ` ${line}`;
    case 5:
      return `${line} `;
    case 6:
      return line.replace('·', g.pick(['•', '・', '-', '·\u2028']));
    case 7:
      return line.slice(0, g.int(line.length + 1));
    case 8:
      return line.replace(/\d/, (digit) => String((Number(digit) + 1) % 10));
    default:
      return line.replace(/R(\d)/, 'R0$1');
  }
}

function mutateDoc(g: Gen, text: string): string {
  let lines = text.split('\n');
  const edits = 1 + g.int(4);
  for (let i = 0; i < edits; i++) {
    if (lines.length === 0) lines = [''];
    const at = g.int(lines.length);
    switch (g.int(9)) {
      case 0:
        lines.splice(at, 1);
        break;
      case 1:
        lines.splice(at, 0, lines[at]!);
        break;
      case 2: {
        const to = g.int(lines.length);
        const [moved] = lines.splice(at, 1);
        lines.splice(to, 0, moved!);
        break;
      }
      case 3:
      case 4:
        lines.splice(at, 0, g.pick(INSERT_LINES));
        break;
      case 5:
        lines[at] = mutateLine(g, lines[at]!);
        break;
      case 6:
        lines = lines.slice(0, at + 1);
        break;
      case 7:
        lines[at] = lines[at]!.replace(g.pick(['"', '{', '}', '[', ']', ',', ':', 'requirements', '-->', '<!--']), g.pick(['', '"x"', ',', '\\ud800', '\\u00', ' ']));
        break;
      default:
        lines.splice(at, 0, ...lines.slice(0, 3));
        break;
    }
  }
  return lines.join(g.chance(0.1) ? '\r\n' : '\n');
}

function makeDocument(g: Gen): string {
  const input = genSerializeInput(g, g.chance(0.2));
  let text = cur.serializeRequirementsMarkdown(input.requirements as never, input.statusById as never, input.assumptions, input.manualSteps);
  if (g.chance(0.85)) text = mutateDoc(g, text);
  if (g.chance(0.2)) text = mutateDoc(g, text);
  return text;
}

// ───────────────────────── 집계 ─────────────────────────


interface ParseResult {
  requirements: Json[];
  assumptions: string[];
  manualSteps: string[];
}


function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
}


describe('요구사항 문서 읽기·쓰기', () => {
  it('왕복: 깨끗한 값은 직렬화 → 읽기가 원래 값을 돌려준다', () => {
    let cleanTotal = 0;
    let cleanBroken = 0;
    const examples: string[] = [];
    const expectedOf = (input: ReturnType<typeof genSerializeInput>) => ({ requirements: input.requirements, assumptions: input.assumptions, manualSteps: input.manualSteps });
    for (const seed of SEEDS) {
      const g = new Gen(seed + 11);
      for (let i = 0; i < N; i++) {
        const clean = genSerializeInput(g, false);
        cleanTotal += 1;
        const text = cur.serializeRequirementsMarkdown(clean.requirements as never, clean.statusById as never, clean.assumptions, clean.manualSteps);
        const back = cur.parseRequirementsMarkdown(text);
        // 쓰지 않는 필드(없는 값)는 JSON을 거치며 사라지므로 JSON 글자로 견준다
        if (canonical(back) !== canonical(expectedOf(clean))) {
          cleanBroken += 1;
          if (examples.length < 3) examples.push(`${JSON.stringify(clean)}\n=> ${JSON.stringify(back)}`);
        }
      }
    }
    expect(examples).toEqual([]);
    expect(cleanBroken).toBe(0);
    expect(cleanTotal).toBeGreaterThan(0);
  });


  it('3x 대조: 읽기가 실행 전 문서에 없던 사람 확인을 올린 문서는 위조 판정이 잡는다(놓친 수 0)', () => {
    // 실행 전 문서에 있던 기록 글(요구사항 id·값)은 이미 믿은 것이다(깨진 문서라 읽기가 무시했다가, 다른 줄을 고쳐 읽히게 된 것은 위조가 아니다).
    // 읽기가 지금 문서에서 요구사항 X에 올린 확인이 실행 전 문서의 (X, 같은 값) 기록으로 뒷받침되지 않으면 새로 올린 것이다.
    // 기준 구현(옛 정규식으로 줄을 읽는다): 읽기가 확인을 올리는 요구사항 id(직전 요구사항 헤딩, 첫 헤딩 앞의 줄은 버린다)와 값, JSON 블록 항목의 id와 값
    const recordsOf = (doc: string) => {
      const known = new Set<string>();
      let reader: string | undefined;
      for (const line of doc.replace(JSON_BLOCK, '').split(/\r?\n/)) {
        const heading = REQUIREMENT_HEADING.exec(line);
        if (heading) reader = heading[1];
        const m = MANUAL_VERIFICATION_LINE.exec(line);
        if (m && reader !== undefined) known.add(`${reader}\u0000${m[1]} · ${m[2]} · 체크포인트 ${m[3]} · 메모 ${m[4]}`);
      }
      const block = JSON_BLOCK.exec(doc);
      if (block) {
        try {
          const json = JSON.parse(block[1]!) as unknown;
          const list = Array.isArray(json) ? json : (json as { requirements?: unknown }).requirements;
          for (const item of Array.isArray(list) ? list : []) {
            const entry = item as { id?: unknown; manualVerification?: Record<string, unknown> | null };
            if (typeof entry?.id === 'string' && entry.manualVerification && typeof entry.manualVerification === 'object') {
              const v = entry.manualVerification;
              known.add(`${entry.id}\u0000${String(v.by ?? '')} · ${String(v.at ?? '')} · 체크포인트 ${String(v.sha ?? '')} · 메모 ${String(v.note ?? '')}`);
            }
          }
        } catch {
          // 읽지 못하는 블록에는 기록이 없다
        }
      }
      return known;
    };
    const canonicalRecord = (v: Json) => `${v.by} · ${v.at} · 체크포인트 ${v.sha} · 메모 ${v.note}`;
    let pairs = 0;
    let opened = 0;
    let newMissed = 0;
    let newCaught = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed + 23);
      for (let i = 0; i < N; i++) {
        const before = makeDocument(g);
        const after = g.chance(0.85) ? mutateDoc(g, before) : makeDocument(g);
        pairs += 1;
        const raisedBy = (parse: (doc: string) => ParseResult) => {
          const known = recordsOf(before);
          return parse(after).requirements.some((r) => r.manualVerification && !known.has(`${r.id}\u0000${canonicalRecord(r.manualVerification)}`));
        };
        if (!raisedBy(cur.parseRequirementsMarkdown)) continue;
        opened += 1;
        if (!curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(before, after))) newMissed += 1;
        else newCaught += 1;
      }
    }
    expect(opened).toBeGreaterThan(pairs / 100);
    expect(newMissed).toBe(0);
  });
});

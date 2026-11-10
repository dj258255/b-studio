/**
 * 요구사항 문서의 읽기·쓰기(ADR-191 3단계 3ab)를 옮기기 전의 TS(`requirements-legacy.ts`의 `parseRequirementsMarkdown`·`serializeRequirementsMarkdown`, 3j 때 복사한 뒤 마크다운 구간은 고치지 않았다)와
 * 지금의 Rust 껍데기에 같은 무작위 문서·요구사항을 넣어 견준다. 결과는 `JSON.stringify` 글자(키 순서 포함)로 견주고, 짝 없는 서로게이트도 글자 그대로 같아야 한다(`wellFormed`로 맞추지 않는다).
 *
 * - 읽기: 직렬화한 문서를 줄 단위로 망가뜨려(줄 지우기·복제·이동·공백 종류 바꾸기·`\r`·U+2028·짝 없는 서로게이트·절 끼워 넣기·JSON 블록 깨기·블록 둘) 넣는다.
 * - 쓰기: 모양이 다양한 요구사항(옛 문서처럼 일부 필드 없음, 거대한 수, 짝 없는 서로게이트, 줄바꿈이 든 글)을 직렬화해 글자를 견준다.
 * - 왕복: 직렬화 → 읽기가 원래 값을 돌려주는지. 옛 TS와 새 구현이 같은 입력에서 깨져야 한다(같은 규칙을 옮겼으므로). 깨지는 입력의 종류를 센다.
 * - 3x 대조: 읽기가 사람 확인을 새로 올린 문서(실행 전 문서에는 없던 값)는 3x의 `diffVerificationRecords`가 위조로 잡아야 한다. 옛 TS(옛 읽기 + 옛 3x)와 새 구현의 놓친 수를 각각 센다.
 * - 판정이 열린 쪽(사람 확인·hash·revisedAt·개정·시나리오 id가 더 생김)으로 뒤집힌 수가 0이어야 한다.
 * 크기는 환경 변수로 바꾼다: REQ_MD_DIFF_SEEDS(쉼표 목록), REQ_MD_DIFF_N(시드마다).
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';
import * as old from './requirements-legacy';
import * as cur from './requirements';
import * as oldGuard from './requirement-integrity-legacy';
import * as curGuard from './requirement-integrity';

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
  let text = old.serializeRequirementsMarkdown(input.requirements as never, input.statusById as never, input.assumptions, input.manualSteps);
  if (g.chance(0.85)) text = mutateDoc(g, text);
  if (g.chance(0.2)) text = mutateDoc(g, text);
  return text;
}

// ───────────────────────── 집계 ─────────────────────────

function run(fn: () => unknown): { ok: true; json: string } | { ok: false; error: string } {
  try {
    return { ok: true, json: JSON.stringify(fn()) ?? 'undefined' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const same = (a: ReturnType<typeof run>, b: ReturnType<typeof run>) => (a.ok && b.ok ? a.json === b.json : !a.ok && !b.ok);

interface ParseResult {
  requirements: Json[];
  assumptions: string[];
  manualSteps: string[];
}

function category(parsed: ParseResult, doc: string): string {
  if (parsed.requirements.length === 0) return '빈 결과';
  // 블록을 뺀 문서가 요구사항을 읽으면 몸통에서 읽은 것이고, 못 읽는데 결과가 있으면 JSON 블록으로 되돌아간 것이다
  const bodyOnly = old.parseRequirementsMarkdown(doc.replace(/<!--\s*b-studio-requirements[\s\S]*?-->/, ''));
  return bodyOnly.requirements.length > 0 ? '몸통에서 읽음' : 'JSON 블록으로 되돌아감';
}

/** 키 순서를 맞춘 JSON 글자(왕복은 키 순서가 아니라 값을 견준다) */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
}

/** 사람 확인·hash·revisedAt·개정·시나리오 id: 새 쪽에 더 생긴 것(열린 쪽)과 줄어든 것(닫는 쪽)의 수 */
function fieldFlips(a: ParseResult, b: ParseResult): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  const count = (left: unknown, right: unknown) => {
    const [l, r] = [JSON.stringify(left) ?? null, JSON.stringify(right) ?? null];
    if (l === r) return;
    if (left === undefined && right !== undefined) open += 1;
    else if (left !== undefined && right === undefined) closed += 1;
    else open += 1; // 값이 달라졌으면 어느 쪽인지 모른다: 열린 쪽으로 세어 0이 아니면 사람이 읽는다
  };
  for (let i = 0; i < Math.max(a.requirements.length, b.requirements.length); i++) {
    const [x, y] = [a.requirements[i], b.requirements[i]];
    if (!x || !y) {
      open += x ? 0 : 1;
      closed += x ? 1 : 0;
      continue;
    }
    for (const key of ['manualVerification', 'hash', 'revisedAt', 'rev']) count(x[key], y[key]);
    count(
      (x.scenarios ?? []).map((s: Json) => s.id),
      (y.scenarios ?? []).map((s: Json) => s.id),
    );
  }
  return { open, closed };
}

describe('요구사항 문서 읽기·쓰기 차등 시험', () => {
  it('읽기: 망가진 문서도 옛 TS와 같은 값을 읽고, 열린 쪽으로 뒤집지 않는다', () => {
    const dist = new Map<string, number>();
    let total = 0;
    let different = 0;
    let open = 0;
    let closed = 0;
    const examples: string[] = [];
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      for (let i = 0; i < N; i++) {
        const doc = makeDocument(g);
        total += 1;
        const a = run(() => old.parseRequirementsMarkdown(doc));
        const b = run(() => cur.parseRequirementsMarkdown(doc));
        if (a.ok) dist.set(category(JSON.parse(a.json), doc), (dist.get(category(JSON.parse(a.json), doc)) ?? 0) + 1);
        else dist.set('옛 TS 던짐', (dist.get('옛 TS 던짐') ?? 0) + 1);
        if (!same(a, b)) {
          different += 1;
          if (examples.length < 3) examples.push(`${JSON.stringify(doc)}\n옛 ${a.ok ? a.json : a.error}\n새 ${b.ok ? b.json : b.error}`);
          if (a.ok && b.ok) {
            const flips = fieldFlips(JSON.parse(a.json), JSON.parse(b.json));
            open += flips.open;
            closed += flips.closed;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[3ab 읽기] ${total}건, 다름 ${different}, 열린 쪽 ${open}, 닫는 쪽 ${closed}, 분포 ${JSON.stringify(Object.fromEntries(dist))}`);
    expect(examples).toEqual([]);
    expect(different).toBe(0);
    expect(open).toBe(0);
    expect(dist.get('몸통에서 읽음') ?? 0).toBeGreaterThan(total / 4);
    expect(dist.get('JSON 블록으로 되돌아감') ?? 0).toBeGreaterThan(total / 100);
    expect(dist.get('빈 결과') ?? 0).toBeGreaterThan(total / 100);
  });

  it('쓰기: 같은 입력에 같은 글자를 쓴다(짝 없는 서로게이트·거대한 수·빠진 필드 포함)', () => {
    let total = 0;
    let different = 0;
    let bothThrew = 0;
    const examples: string[] = [];
    for (const seed of SEEDS) {
      const g = new Gen(seed + 5);
      for (let i = 0; i < N; i++) {
        const input = genSerializeInput(g, true);
        // 옛 문서처럼 필드가 빠진 요구사항
        if (g.chance(0.15)) delete input.requirements[0]!.kind;
        if (g.chance(0.1)) input.requirements[0]!.acceptance = g.pick([[], ['']]);
        if (g.chance(0.1)) input.requirements[0]!.trace = { dependsOn: [], supersedes: '' };
        if (g.chance(0.1)) input.requirements[0]!.ears = {};
        if (g.chance(0.05)) input.requirements[0]!.acceptance = undefined; // 둘 다 던진다
        total += 1;
        const a = run(() => old.serializeRequirementsMarkdown(input.requirements as never, input.statusById as never, input.assumptions, input.manualSteps));
        const b = run(() => cur.serializeRequirementsMarkdown(input.requirements as never, input.statusById as never, input.assumptions, input.manualSteps));
        if (!a.ok && !b.ok) bothThrew += 1;
        if (!same(a, b)) {
          different += 1;
          if (examples.length < 3) examples.push(`${JSON.stringify(input)}\n옛 ${a.ok ? a.json : a.error}\n새 ${b.ok ? b.json : b.error}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[3ab 쓰기] ${total}건, 다름 ${different}, 둘 다 던짐 ${bothThrew}`);
    expect(examples).toEqual([]);
    expect(different).toBe(0);
    expect(bothThrew).toBeGreaterThan(0);
  });

  it('왕복: 깨끗한 값은 직렬화 → 읽기가 원래 값을 돌려주고, 깨지는 입력은 옛 TS와 같다', () => {
    let cleanTotal = 0;
    let cleanBroken = 0;
    let looseTotal = 0;
    let oldBroken = 0;
    let newBroken = 0;
    let differentBehavior = 0;
    const brokenKinds = new Map<string, number>();
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

        const loose = genSerializeInput(g, true);
        looseTotal += 1;
        const oldText = old.serializeRequirementsMarkdown(loose.requirements as never, loose.statusById as never, loose.assumptions, loose.manualSteps);
        const oldBack = run(() => old.parseRequirementsMarkdown(oldText));
        const newBack = run(() => cur.parseRequirementsMarkdown(oldText));
        const expected = canonical(expectedOf(loose));
        const oldOk = oldBack.ok && canonical(JSON.parse(oldBack.json)) === expected;
        const newOk = newBack.ok && canonical(JSON.parse(newBack.json)) === expected;
        if (!oldOk) oldBroken += 1;
        if (!newOk) newBroken += 1;
        if (oldOk !== newOk || !same(oldBack, newBack)) differentBehavior += 1;
        if (!oldOk) {
          const kind = loose.requirements.some((r) => [r.title, ...r.acceptance].some((t: string) => t !== t.trim()))
            ? '앞뒤 공백이 든 글(몸통은 다듬어 읽고 몸통이 이긴다)'
            : loose.requirements.some((r) => [r.title, ...r.acceptance].some((t: string) => t === ''))
              ? '빈 글(헤딩·항목이 사라진다)'
              : '그 밖(짝 없는 서로게이트·특수 글자)';
          brokenKinds.set(kind, (brokenKinds.get(kind) ?? 0) + 1);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[3ab 왕복] 깨끗한 값 ${cleanTotal}건 중 깨짐 ${cleanBroken}; 느슨한 값 ${looseTotal}건 중 옛 TS 깨짐 ${oldBroken}, 새 깨짐 ${newBroken}, 동작 다름 ${differentBehavior}; 깨짐 종류 ${JSON.stringify(Object.fromEntries(brokenKinds))}`);
    expect(examples).toEqual([]);
    expect(cleanBroken).toBe(0);
    expect(differentBehavior).toBe(0);
    expect(oldBroken).toBeGreaterThan(0);
  });

  it('3x 대조: 읽기가 실행 전 문서에 없던 사람 확인을 올린 문서는 위조 판정이 잡는다(옛 TS와 새 구현이 놓친 수)', () => {
    // 실행 전 문서에 있던 기록 글(요구사항 id·값)은 이미 믿은 것이다(깨진 문서라 읽기가 무시했다가, 다른 줄을 고쳐 읽히게 된 것은 위조가 아니다).
    // 읽기가 지금 문서에서 요구사항 X에 올린 확인이 실행 전 문서의 (X, 같은 값) 기록으로 뒷받침되지 않으면 새로 올린 것이다.
    // 기준 구현(옛 정규식으로 줄을 읽는다): 읽기가 확인을 올리는 요구사항 id(직전 요구사항 헤딩, 첫 헤딩 앞의 줄은 버린다)와 값, JSON 블록 항목의 id와 값
    const recordsOf = (_guard: unknown, doc: string) => {
      const known = new Set<string>();
      let reader: string | undefined;
      for (const line of doc.replace(old.JSON_BLOCK, '').split(/\r?\n/)) {
        const heading = old.REQUIREMENT_HEADING.exec(line);
        if (heading) reader = heading[1];
        const m = old.MANUAL_VERIFICATION_LINE.exec(line);
        if (m && reader !== undefined) known.add(`${reader}\u0000${m[1]} · ${m[2]} · 체크포인트 ${m[3]} · 메모 ${m[4]}`);
      }
      const block = old.JSON_BLOCK.exec(doc);
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
    let oldMissed = 0;
    let newMissed = 0;
    let newCaught = 0;
    const examples: string[] = [];
    for (const seed of SEEDS) {
      const g = new Gen(seed + 23);
      for (let i = 0; i < N; i++) {
        const before = makeDocument(g);
        const after = g.chance(0.85) ? mutateDoc(g, before) : makeDocument(g);
        pairs += 1;
        const raisedBy = (parse: (doc: string) => ParseResult, guard: typeof curGuard) => {
          const known = recordsOf(guard, before);
          return parse(after).requirements.some((r) => r.manualVerification && !known.has(`${r.id}\u0000${canonicalRecord(r.manualVerification)}`));
        };
        if (!raisedBy(old.parseRequirementsMarkdown as never, oldGuard as never)) continue;
        opened += 1;
        if (!oldGuard.hasVerificationTamper(oldGuard.diffVerificationRecords(before, after))) {
          oldMissed += 1;
          if (process.env.REQ_MD_MISSED) appendFileSync(process.env.REQ_MD_MISSED, `${JSON.stringify({ before, after })}\n`);
          if (examples.length < 3) examples.push(`before=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
        }
        if (!curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(before, after))) newMissed += 1;
        else newCaught += 1;
        // 새 읽기도 같은 쪽으로 읽는다(차등 시험이 같음을 보이지만 여기서도 센다)
        expect(raisedBy(cur.parseRequirementsMarkdown, curGuard)).toBe(true);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[3ab 3x 대조] ${pairs}쌍 중 읽기가 실행 전에 없던 확인을 올린 ${opened}쌍: 옛 TS가 놓침 ${oldMissed}, 새 구현이 놓침 ${newMissed}, 새 구현이 잡음 ${newCaught}`);
    if (examples.length > 0) console.log(examples.join('\n---\n'));
    expect(opened).toBeGreaterThan(pairs / 100);
    expect(newMissed).toBe(0);
    // 옛 TS가 놓친 수(`oldMissed`)는 트러블슈팅 177의 결함이다. 새 구현은 0이어야 하고, 옛 TS의 수는 입력에 따라 0일 수 있다
  });
});

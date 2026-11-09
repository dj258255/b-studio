/**
 * 요구사항 순수 코어와 doc-lint를 Rust로 옮기면서(ADR-191 3단계 3j) 옛 TS 구현을 `requirements-legacy.ts`에 그대로 복사해 두고, 같은 무작위 입력(시드 고정)을
 * 옛 TS와 새 껍데기(Rust)에 넣어 결과를 `JSON.stringify` 글자(키 순서 포함)로 견준다. 한쪽 규칙을 바꾸면 이 시험이 먼저 실패한다.
 *
 * - 입력은 정규식이 걸리는 조각(id 꼴, 약한 표현, 경로, 헤딩·번호·글머리, 공백 종류, 짝 없는 서로게이트)을 이어 붙여 만든다.
 * - 짝 없는 서로게이트는 Rust 쪽에서 U+FFFD가 되므로(의도한 차이) 양쪽 결과를 `wellFormed`로 맞춘 뒤 견준다.
 * - 옛 TS가 던졌는데 Rust가 값을 낸 경우(`legacyOnlyThrew`)는 0이어야 하고, 잘 짜인 입력에서 Rust만 던지는 경우(`rustOnlyThrew`)도 0이어야 한다.
 *   모양이 어긋난 입력(손상 입력)은 Rust만 던질 수 있다(의도한 차이: 옛 TS는 조용히 읽던 모양을 던진다). 그 수를 센다.
 * - 판정이 통과·충족 쪽으로 뒤집힌 수(`flips`)가 0이어야 한다. 함수마다 "통과 쪽"의 방향을 아래 `flip`에 적었다.
 * - 환경 변수 `REQUIREMENTS_DIFF_RUNS`(함수당 입력 수), `REQUIREMENTS_DIFF_SEEDS`(쉼표로 이은 시드)로 크게 돌릴 수 있다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lintText } from './doc-lint';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, wellFormed } from './differential-kit';
import * as old from './requirements-legacy';
import * as cur from './requirements';

const SEEDS = readEnvList('REQUIREMENTS_DIFF_SEEDS', [20261110, 20261111]);
const RUNS = readEnvNumber('REQUIREMENTS_DIFF_RUNS', 1500);
const NOW = '2026-11-10T00:00:00.000Z';

// 환경 변수로 크게 돌릴 수 있으므로 시간 제한을 풀어 둔다
vi.setConfig({ testTimeout: 3_600_000 });

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

// ───────────────────────── 입력 조각 ─────────────────────────

const FRAGS = [
  'R1', 'R12', 'R1.2', 'R10.3', 'R0', 'R01', 'R1.', 'xR3', 'R4a', '~', '-', '–', '—', ' ', '  ', '\n', '\r\n', '\r', '\t', '\u00a0', '\u3000', '\u2028', '\ufeff', '\u0085',
  'Implements: R1', 'implements:R2.1@rev3', 'Implements:   R4@rev', 'Implements: R5@REV7', 'Implements: r6', 'Implements:R7@rev0', 'Implements: R8@rev99999999999999999999',
  '성능이 좋아졌다', '성능을 개선', '성능을이 향상', '빨라졌다', '느려지고', '안정적', '속도', '빠르기', 'latency', 'throughput', '자주', '빈번히', '동시에 많이', '동시 여러', '많이 접속', '부하가 크다', '부하를 높', '처리량이 높다', '지연 낮', '반응 속도가 빠르다', '반응이 느리',
  '지연(latency)', '처리량 (rps)', '동시성(concurrency)', 'LATENCY',
  '빠르게', '적절히', '적당히', '가능하면', '사용자 친화적', '기타', '신속히', '효율적으로', '즉시', '충분히', '빠르게가', '그빠르게', '가즉시',
  'fast', 'FAST', 'faster', 'user-friendly', 'as needed', 'TBD', 'tbd1', 'etc', 'etc.', 'quickly', 'soon-ish', 'asap', 'efficient', 'appropriate',
  '등', '목록 등,', '3개 등', 'A등.', '등록', '등급', '가 등 ', '하 등',
  'p95 850ms', '10MB', '5초', '3배', '100건', '2회', 'rps', '50 rps', '9 req/s', '12%', '%', '3 ms', '7밀리초', '4 percent', '88 Gb', '6 KB', '1 bx', 'p99', 'p9', '70tps', '5 qps',
  '# 제목', '## 헤딩', '### x', '####### 일곱', '#', '# ', '#  ', '1. 번호', '2) 둘', '  3. 들여쓴', '- 글머리', '* 별표', '  - 들여쓴 글머리', '-', '- ', '1.', '1. ',
  'seed/seed.json', 'docs/api.md', 'openapi.yaml', 'schema.sql', 'a.csv', 'https://x.com/p.json', 'http://h/a/b.yml', 'README.md', '.env', 'x.ENV', 'a..json', 'dir/sub/f.txt', 'x.proto', 'q.graphql', 'ab.JSON', 'file.json5', '한글/파일.md', '://', 'a://b.sql',
  'collaborator', 'Collaborators', 'branch protection', 'branchprotection', 'deploy key', 'deploykey', '메일로 제출', '이메일 제출', 'email 로 제출', 'email제출', '제출 방법', '제출 절차', '제출방법',
  '저장소', '레포', 'repo', 'repository', 'GitHub', '깃허브', 'gitlab', 'organization', '조직 설정', '계정 설정', '조직설정',
  '협업자', '공동 작업자', '초대', 'invite', 'invites', 'invited', 'inviter', 'visibility', '공개 범위', '공개범위', 'private', 'public', '비공개', '공개로', '권한', 'permission', 'permissions', 'webhook', '웹훅', 'secret', 'secrets', '시크릿',
  'ſecret', 'K', '\u212a', 'github-x', 'xgithub',
  'GET /api/posts', 'POST /api/posts/{id} — 상세', 'delete /x/', 'PATCH /a, b', 'get   /api/p(1)', 'GET /', 'GET //', 'PUT /a–b', 'xGET /a', 'GETS /a',
  'HTTP', 'api', 'endpoint', 'rest', '화면', '버튼', 'ui', 'page', 'db', 'database', 'migration', '스키마', '테이블', '성능', 'performance', 'scalability', '보안', '응답 시간', '응답시간', '부하', '문서', 'readme', 'docs', 'doc', '요청', '응답',
  '선택 사항', '선택사항', '보너스', 'bonus', 'optional', 'nice-to-have', 'nice to have', '권장', 'should', 'SHOULD', '추천',
  '해야 한다', '해야한다', '해야  한다', '해야\n한다', '시스템은', '한글', 'English', 'ABC', '😀', '\ud800', '\udc00', 'a', 'b', '1', '2', '.', '_', '/', '(', ')', '`', '"', ',',
];

function words(g: Gen, min: number, max: number, pool: readonly string[] = FRAGS, sep: readonly string[] = [' ', ' ', '', '\n', ', ']): string {
  const count = min + g.int(max - min + 1);
  let out = '';
  for (let i = 0; i < count; i++) out += (i === 0 ? '' : g.pick(sep)) + g.pick(pool);
  return out;
}

const TITLE_WORDS = [
  '로그인', '회원가입', '게시글', '목록', '조회', '상세', '수정', '삭제', '댓글', '검색', '정렬', '페이지네이션', '성능', '응답 시간', 'p95', '300ms', '화면', '버튼',
  'GET /api/posts', 'POST /api/posts', 'GET /api/posts/{postId}', 'GET /api/posts/', 'DELETE /api/posts/{postId} — 삭제', 'login', 'list', 'detail', 'User', 'API', '`code`', '(괄호)', 'a/b', '—', '–', '"인용"', '“따옴표”',
];

function title(g: Gen): string {
  return words(g, 1, 4, TITLE_WORDS, [' ']);
}

const KINDS = ['api', 'ui', 'data', 'nonfunctional', 'docs'] as const;
const PRIORITIES = ['must', 'should', 'could'] as const;
const PATTERNS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional'] as const;
const DATES = ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.001Z', '2026-11-10T00:00:00.000Z', '2026-11-10', '2025-12-31T23:59:59.999Z'];
const STATUSES = ['미착수', '작업 중', '검증됨', '재확인 필요', '실패', '모르는 상태'];

type Json = Record<string, unknown>;

function genScenarios(g: Gen, id: string): Json[] | undefined {
  if (g.chance(0.3)) return g.chance(0.15) ? [] : undefined;
  return g.list(1, 4, () => {
    const n = 1 + g.int(5);
    const sid = g.weighted<string>([
      [6, `${id}.${n}`],
      [2, `R${1 + g.int(30)}.${n}`],
      [1, `${id}.`],
      [1, 'x'],
      [1, `${id}.0`],
      [1, `${id}.007`],
      [1, `${id}.${n}.${1 + g.int(3)}`],
      [1, `${id}.99999999999999`],
    ]);
    return { id: sid, given: words(g, 1, 3), when: words(g, 1, 3), then: words(g, 1, 3) };
  });
}

/**
 * 요구사항 하나. 기본은 짝 없는 서로게이트가 없는 글만 쓴다 — 내용 해시를 쓰는 판정(상태·개정·병합)은 짝 없는 서로게이트가 든 글에서
 * 옛 TS와 해시가 다르다(의도한 차이: 옛 TS는 `JSON.stringify`가 쓴 `\\udXXX` 이스케이프를, Rust는 U+FFFD를 해시한다).
 * `loose`면 그런 글도 섞는다(해시를 쓰지 않는 린트·유사도·글 만들기 시험).
 */
function genRequirement(g: Gen, idNumber?: number, loose = false): Json {
  const requirement = genRequirementRaw(g, idNumber);
  return loose ? requirement : (wellFormed(requirement) as Json);
}

function genRequirementRaw(g: Gen, idNumber?: number): Json {
  const id = `R${idNumber ?? 1 + g.int(30)}`;
  const requirement: Json = { id, title: g.chance(0.04) ? '' : title(g), kind: g.pick(KINDS), priority: g.pick(PRIORITIES), acceptance: g.list(1, 3, () => words(g, 1, 5)) };
  if (g.chance(0.5)) requirement.rev = 1 + g.int(5);
  if (g.chance(0.5)) requirement.ears = { pattern: g.pick(PATTERNS), statement: g.chance(0.6) ? `${words(g, 1, 3)} 해야 한다` : words(g, 1, 4) };
  const scenarios = genScenarios(g, id);
  if (scenarios) requirement.scenarios = scenarios;
  if (requirement.kind === 'nonfunctional' ? g.chance(0.6) : g.chance(0.1)) requirement.nfr = { metric: words(g, 1, 2), threshold: words(g, 1, 2), condition: words(g, 1, 2), method: words(g, 1, 2) };
  if (g.chance(0.4)) requirement.trace = { ...(g.chance(0.5) ? { issue: 1 + g.int(50) } : {}), ...(g.chance(0.4) ? { dependsOn: ['R1', 'R2'].slice(0, 1 + g.int(2)) } : {}), ...(g.chance(0.3) ? { supersedes: `R${1 + g.int(9)}` } : {}) };
  const hash = g.weighted<string | undefined>([[3, undefined], [5, old.computeRequirementHash(wellFormed(requirement) as never)], [2, 'deadbeef00000000'], [1, '']]);
  if (hash !== undefined) requirement.hash = hash;
  if (g.chance(0.5)) requirement.revisedAt = g.pick(DATES);
  if (g.chance(0.35)) requirement.manualVerification = { by: '범수', at: g.pick(DATES).slice(0, 10), sha: 'c57d72f', note: words(g, 1, 3) };
  return requirement;
}

function genEvidence(g: Gen, ids: string[] = ['R1']): Json {
  if (g.chance(0.2)) return { checkpoints: [], tests: [], gateChecks: [] };
  const evidence: Json = {
    checkpoints: g.list(0, 3, () => ({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: `${words(g, 0, 4)} ${g.pick(ids)}`, ...(g.chance(0.7) ? { createdAt: g.pick(DATES) } : {}) })),
    tests: g.list(0, 2, () => ({ file: 'a.test.ts', name: words(g, 1, 3) })),
    gateChecks: g.chance(0.5) ? g.list(1, 3, () => ({ name: words(g, 1, 3), ok: g.chance(0.7) })) : [],
  };
  if (g.chance(0.45)) evidence.testRun = { at: g.pick(DATES), sha: 'a'.repeat(40), shortSha: 'aaaaaaa', passed: g.pick([0, 0, 1, 3]), failed: g.pick([0, 0, 0, 1, 2]) };
  if (g.chance(0.4)) {
    const matched = g.list(0, 2, () => words(g, 1, 2));
    const missing = g.list(0, 2, () => words(g, 1, 2));
    evidence.docEvidence = { matched, missing, satisfied: g.chance(0.5), ...(g.chance(0.5) ? { sourceSummary: 'README.md' } : {}) };
  }
  if (g.chance(0.35)) evidence.missingScenarios = g.list(0, 2, () => `R1.${1 + g.int(4)}`);
  if (g.chance(0.2)) evidence.unexecutedTests = [{ file: 'a.test.ts', name: 'x' }];
  return evidence;
}

function genRunRows(g: Gen, ids: string[]): Json[] {
  return g.list(0, 6, () => ({
    id: g.pick(ids),
    file: g.pick(['a.test.ts', 'b.test.ts', 'c/D.java']),
    name: g.pick(['t1', 't2', 't3', words(g, 1, 2)]),
    status: g.pick(['pass', 'fail', 'skip', 'not-run', 'not-run']),
    at: g.pick(DATES),
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    ...(g.chance(0.5) ? { reason: g.pick(['@Tag(integration)', '', '@Testcontainers']) } : {}),
  }));
}

// ───────────────────────── 집계 ─────────────────────────

interface Stat {
  total: number;
  same: number;
  bothThrew: number;
  rustOnlyThrew: number;
  legacyOnlyThrew: number;
  mismatches: string[];
  empty: number;
  filled: number;
  truthy: number;
  falsy: number;
  flips: number;
}

const STATS = new Map<string, Stat>();

function stat(name: string): Stat {
  let s = STATS.get(name);
  if (!s) {
    s = { total: 0, same: 0, bothThrew: 0, rustOnlyThrew: 0, legacyOnlyThrew: 0, mismatches: [], empty: 0, filled: 0, truthy: 0, falsy: 0, flips: 0 };
    STATS.set(name, s);
  }
  return s;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

interface CompareOptions {
  /** 옛 값과 새 값을 받아 "통과·충족 쪽으로 뒤집혔는지" */
  flip?: (legacy: unknown, current: unknown) => boolean;
  /** 손상 입력: 새 쪽만 던져도 된다(던진 수는 센다) */
  malformed?: boolean;
}

function compare(name: string, describeInput: () => string, legacy: () => unknown, current: () => unknown, options: CompareOptions = {}): void {
  const s = stat(name);
  s.total++;
  const a = outcome(legacy);
  const b = outcome(current);
  if (a.threw || b.threw) {
    if (a.threw && b.threw) s.bothThrew++;
    else if (a.threw) s.legacyOnlyThrew++;
    else s.rustOnlyThrew++;
    if (!options.malformed && (a.threw !== b.threw)) s.mismatches.push(`던짐이 다르다(${a.threw ? '옛 TS만' : 'Rust만'}) ${describeInput().slice(0, 300)}`);
    return;
  }
  const expected = JSON.stringify(wellFormed(a.value));
  const actual = JSON.stringify(wellFormed(b.value));
  const sameNumber = typeof a.value !== 'number' || Object.is(a.value, b.value);
  if (expected === actual && sameNumber) {
    s.same++;
    if (isEmptyValue(a.value)) s.empty++;
    else s.filled++;
    if (a.value === true) s.truthy++;
    if (a.value === false) s.falsy++;
  } else if (process.env.REQUIREMENTS_DIFF_DUMP && s.mismatches.length === 0) {
    s.mismatches.push('덤프');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(process.env.REQUIREMENTS_DIFF_DUMP, JSON.stringify({ name, input: describeInput(), expected, actual }, null, 1));
  } else if (s.mismatches.length < 5) {
    s.mismatches.push(`${describeInput().slice(0, 300)}\n  옛: ${expected?.slice(0, 300)}\n  새: ${actual?.slice(0, 300)}`);
  } else {
    s.mismatches.push('(생략)');
  }
  if (options.flip?.(a.value, b.value)) s.flips++;
}

const json = (value: unknown) => JSON.stringify(value);

/** 같은 입력에 옛 함수·새 함수를 부른다. 입력은 만들 때 한 번만 쓰고 서로 건드리지 않는다 */
function runWith(seed: number, body: (g: Gen) => void): void {
  const g = new Gen(seed);
  for (let i = 0; i < RUNS; i++) body(g);
}

// ───────────────────────── 시험 ─────────────────────────

describe('요구사항 순수 코어: 옛 TS와 글자까지 같다', () => {
  for (const seed of SEEDS) {
    it(`언급 id·트레일러·체크포인트·게이트·테스트 파일 이름 (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const id = g.pick(['R1', 'R12', 'R1.2', 'R10', 'R5', 'R', 'R1.']);
        const text = g.chance(0.5) ? `${words(g, 0, 5)}${g.pick([' ', '', '(', ':'])}${id}${g.pick([' ', '', '.', '3', '.1', ')'])}${words(g, 0, 3)}` : words(g, 0, 10);
        compare('findMentionedIds', () => json(text), () => old.findMentionedIds(text), () => cur.findMentionedIds(text));
        compare('mentionsRequirementId', () => json([text, id]), () => old.mentionsRequirementId(text, id), () => cur.mentionsRequirementId(text, id));
        compare('extractImplementsTrailers', () => json(text), () => old.extractImplementsTrailers(text), () => cur.extractImplementsTrailers(text));
        const checkpoints = g.list(0, 4, () => ({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: `${words(g, 0, 4)} ${g.pick([id, id, 'x', `Implements: ${id}`, `${id}.1`])} ${words(g, 0, 2)}` }));
        compare('findCheckpointMentions', () => json([checkpoints, id]), () => old.findCheckpointMentions(checkpoints, id), () => cur.findCheckpointMentions(checkpoints, id));
        const checks = g.list(0, 4, () => ({ name: `${words(g, 0, 3)} ${g.pick([id, 'x', `${id}.2`])}`, ok: g.chance(0.5) }));
        compare('findGateCheckMentions', () => json([checks, id]), () => old.findGateCheckMentions(checks, id), () => cur.findGateCheckMentions(checks, id));
        const path = words(g, 1, 4, ['a', 'b', '.test', '.spec', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', 'Test', 'Tests', '.java', '.TEST', '.Spec', '.TSX', '/', 'x', '\n', 'ſ', 'test.ts', '.', 'Tes', 't', 's', '\u212a'], ['', '', '']);
        compare('isLikelyTestFile', () => json(path), () => old.isLikelyTestFile(path), () => cur.isLikelyTestFile(path));
      });
    });

    it(`시나리오 id 맞추기·내용 해시·개정 (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const requirement = genRequirement(g);
        compare('alignScenarioIds', () => json(requirement), () => old.alignScenarioIds(requirement as never), () => cur.alignScenarioIds(requirement as never));
        compare('computeRequirementHash', () => json(requirement), () => old.computeRequirementHash(requirement as never), () => cur.computeRequirementHash(requirement as never));
        compare('requirementContentDrifted', () => json(requirement), () => old.requirementContentDrifted(requirement as never), () => cur.requirementContentDrifted(requirement as never), {
          flip: (legacy, current) => legacy === true && current === false,
        });
        const now = g.pick(DATES);
        compare('reviseRequirementIfChanged', () => json([requirement, now]), () => old.reviseRequirementIfChanged(requirement as never, now), () => cur.reviseRequirementIfChanged(requirement as never, now));
        const previous = g.chance(0.8) ? genRequirement(g) : undefined;
        compare('carryForwardRequirementRevision', () => json([requirement, previous]), () => old.carryForwardRequirementRevision(requirement as never, previous as never), () => cur.carryForwardRequirementRevision(requirement as never, previous as never));
        compare('discardRevisionIfNeverSaved', () => json([requirement, previous]), () => old.discardRevisionIfNeverSaved(requirement as never, previous as never), () => cur.discardRevisionIfNeverSaved(requirement as never, previous as never));
      });
    });

    it(`상태·검증 출처·배지·확신·집계 (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const evidence = genEvidence(g);
        const requirement = g.chance(0.85) ? genRequirement(g, 1) : undefined;
        compare('computeRequirementStatus', () => json([evidence, requirement]), () => old.computeRequirementStatus(evidence as never, requirement as never), () => cur.computeRequirementStatus(evidence as never, requirement as never), {
          flip: (legacy, current) => legacy !== '검증됨' && current === '검증됨',
        });
        compare('requirementVerificationSource', () => json([evidence, requirement]), () => old.requirementVerificationSource(evidence as never, requirement as never), () => cur.requirementVerificationSource(evidence as never, requirement as never), {
          flip: (legacy, current) => legacy === 'none' && current !== 'none',
        });
        const status = g.pick(STATUSES);
        compare('matrixVerificationBadge', () => json([status, evidence, requirement]), () => old.matrixVerificationBadge(status as never, evidence as never, requirement as never), () => cur.matrixVerificationBadge(status as never, evidence as never, requirement as never), {
          flip: (legacy, current) => legacy === 'none' && current !== 'none',
        });
        compare('requirementConfidence', () => json(status), () => old.requirementConfidence(status as never), () => cur.requirementConfidence(status as never));
        const requirements = g.list(0, 6, () => genRequirement(g, 1 + g.int(8)));
        const statusById = Object.fromEntries(requirements.filter(() => g.chance(0.8)).map((r) => [r.id as string, g.pick(STATUSES)]));
        compare('summarizeCoverage', () => json([requirements, statusById]), () => old.summarizeCoverage(requirements as never, statusById as never), () => cur.summarizeCoverage(requirements as never, statusById as never));
      });
    });

    it(`린트·사람이 할 일 거르기 (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const requirement = genRequirement(g, undefined, true);
        // 약한 표현과 헷갈리는 조각을 문장에 섞는다
        if (g.chance(0.6)) (requirement.acceptance as string[]).push(words(g, 1, 6));
        if (g.chance(0.4)) requirement.title = `${requirement.title as string} ${words(g, 1, 3)}`;
        const mustFix = (value: unknown) => (Array.isArray(value) ? value.filter((w: { mustFix: boolean }) => w.mustFix).length : 0);
        compare('lintRequirement', () => json(requirement), () => old.lintRequirement(requirement as never), () => cur.lintRequirement(requirement as never), {
          flip: (legacy, current) => mustFix(current) < mustFix(legacy),
        });
        compare('requirementIsReady', () => json(requirement), () => old.requirementIsReady(requirement as never), () => cur.requirementIsReady(requirement as never), { flip: (legacy, current) => legacy === false && current === true });
        const requirements = g.list(0, 4, () => genRequirement(g, undefined, true));
        compare('requirementsReadyBadge', () => json(requirements), () => old.requirementsReadyBadge(requirements as never), () => cur.requirementsReadyBadge(requirements as never), { flip: (legacy, current) => legacy === false && current === true });
        const text = words(g, 0, 6);
        compare('isManualStepText', () => json(text), () => old.isManualStepText(text), () => cur.isManualStepText(text), { flip: (legacy, current) => legacy === true && current === false });
        const manualSteps = g.chance(0.4) ? g.list(0, 2, () => words(g, 1, 3)) : undefined;
        const withManual = requirements.map((r) => ({ ...r, title: g.chance(0.5) ? words(g, 1, 4) : r.title, acceptance: g.chance(0.5) ? g.list(0, 3, () => words(g, 1, 4)) : r.acceptance }));
        compare('partitionManualSteps', () => json([withManual, manualSteps]), () => old.partitionManualSteps(withManual as never, manualSteps), () => cur.partitionManualSteps(withManual as never, manualSteps), {
          flip: (legacy, current) => ((legacy as { requirements: unknown[] }).requirements.length < (current as { requirements: unknown[] }).requirements.length),
        });
        const doc = words(g, 0, 12, FRAGS, ['\n', ' ', '\r\n', '\n']);
        compare('lintText', () => json(doc), () => old.lintText(doc), () => lintText(doc));
      });
    });

    it(`재추출 병합·유사도 (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const a = words(g, 0, 6, TITLE_WORDS, [' ', '  ']);
        const b = words(g, 0, 6, TITLE_WORDS, [' ', '  ']);
        compare('textSimilarity', () => json([a, b]), () => old.textSimilarity(a, b), () => cur.textSimilarity(a, b));
        compare('apiSignature', () => json(a), () => old.apiSignature(a), () => cur.apiSignature(a));
        const requirementA = genRequirement(g, 1);
        const requirementB = g.chance(0.5) ? { ...requirementA, id: 'R2', title: `${requirementA.title as string}${g.pick(['', ' 수정', ' 상세'])}` } : genRequirement(g, 2);
        compare('requirementSimilarity', () => json([requirementA, requirementB]), () => old.requirementSimilarity(requirementA as never, requirementB as never), () => cur.requirementSimilarity(requirementA as never, requirementB as never));
        const existing = g.list(0, 6, (() => { let n = 0; return () => genRequirement(g, ++n * (g.chance(0.1) ? 2 : 1) + g.int(2)); })());
        const incoming: Json[] = wellFormed([
          ...existing.filter(() => g.chance(0.65)).map((r) => ({ ...r, title: g.chance(0.5) ? r.title : `${r.title as string} ${g.pick(['v2', '추가', ''])}`, ...(g.chance(0.3) ? { ears: { pattern: 'event', statement: words(g, 1, 3) } } : {}) })),
          ...g.list(0, 3, () => genRequirement(g)),
        ].map((r, index) => {
          const id = `R${index + 1}`;
          const scenarios = Array.isArray((r as Json).scenarios) ? ((r as Json).scenarios as Json[]).map((s, k) => ({ ...s, id: g.chance(0.8) ? `${id}.${k + 1}` : s.id })) : (r as Json).scenarios;
          return { ...r, id, ...(scenarios ? { scenarios } : {}) };
        }));
        compare('mergeReextractedRequirements', () => json([incoming, existing]), () => old.mergeReextractedRequirements(incoming as never, existing as never), () => cur.mergeReextractedRequirements(incoming as never, existing as never));
      });
    });

    it(`명세 글 나누기·참조 파일·프롬프트·안내 요약 (시드 ${seed})`, () => {
      const LINES = ['# 제목', '## 헤딩 둘', '#### 넷', '####### 일곱', '1. 번호 줄', '2) 둘째', '  3. 들여쓴 번호', '- 글머리', '* 별표 글머리', '  - 들여쓴 글머리', '  글자만 들여씀', '', '', '평문 문단', '#', '# ', '-', '1.', '\t- 탭', '\u3000- 전각', '- 😀' + 'a'.repeat(198) + '😀'];
      runWith(seed, (g) => {
        const lines = g.list(0, g.chance(0.05) ? 90 : 18, () => (g.chance(0.5) ? g.pick(LINES) : words(g, 1, 3, [...LINES, ...FRAGS], [' ', ''])));
        const spec = lines.join(g.pick(['\n', '\r\n', '\n\n', '\n', '\r']));
        compare('extractRequirementsHeuristically', () => json(spec), () => old.extractRequirementsHeuristically(spec), () => cur.extractRequirementsHeuristically(spec));
        const paragraphs = words(g, 0, 20, [...FRAGS, '\n\n', '\n\n\n', '😀'.repeat(100), 'x'.repeat(199) + '😀'], ['', ' ']);
        compare('extractRequirementsHeuristically(문단)', () => json(paragraphs), () => old.extractRequirementsHeuristically(paragraphs), () => cur.extractRequirementsHeuristically(paragraphs));
        compare('extractPathReferences', () => json(spec), () => old.extractPathReferences(spec), () => cur.extractPathReferences(spec));
        const refs = words(g, 0, 10, ['http://', 'https://', 'seed/seed.json', 'a.md', 'x/y/z.yaml', ' ', '😀', '/', '(', 'file:///etc/a.txt', ':', 'ab', '\n']);
        compare('extractPathReferences(URL)', () => json(refs), () => old.extractPathReferences(refs), () => cur.extractPathReferences(refs));
        const path = words(g, 1, 3, FRAGS, ['']);
        compare('buildMissingReferenceQuestion', () => json(path), () => old.buildMissingReferenceQuestion(path), () => cur.buildMissingReferenceQuestion(path));
        const files = g.list(0, 6, () => (g.chance(0.7) ? { path: words(g, 1, 2), exists: true, ...(g.chance(0.8) ? { sizeBytes: g.pick([0, 12, 1234, 5.5]) } : {}), ...(g.chance(0.8) ? { preview: words(g, 0, 6) } : {}) } : { path: words(g, 1, 2), exists: false }));
        const maxChars = g.pick([0, 1, 10, 30, 60, 100, 300, 6000]);
        compare('buildReferencedFilesContext', () => json([files, maxChars]), () => old.buildReferencedFilesContext(files as never, maxChars), () => cur.buildReferencedFilesContext(files as never, maxChars));
        const quote = words(g, 0, 4);
        const specText = g.chance(0.5) ? `${words(g, 0, 3)} ${quote} ${words(g, 0, 3)}` : words(g, 0, 6);
        compare('verifySpecQuote', () => json([quote, specText]), () => old.verifySpecQuote(quote, specText), () => cur.verifySpecQuote(quote, specText), { flip: (legacy, current) => legacy === false && current === true });
        const context = g.chance(0.5) ? words(g, 0, 3) : undefined;
        compare('buildExtractionUserPrompt', () => json([specText, context]), () => old.buildExtractionUserPrompt(specText, context), () => cur.buildExtractionUserPrompt(specText, context));
        const questions = g.list(0, 4, () => words(g, 1, 3));
        const stack = g.chance(0.5) ? words(g, 0, 3) : undefined;
        compare('buildRecommendationUserPrompt', () => json([questions, specText, stack]), () => old.buildRecommendationUserPrompt(questions, specText, stack), () => cur.buildRecommendationUserPrompt(questions, specText, stack));
        const reason = g.chance(0.3) ? 'x'.repeat(599) + '😀' + words(g, 0, 3) : words(g, 0, 40);
        compare('buildExtractionRetryNote', () => json(reason), () => old.buildExtractionRetryNote(reason), () => cur.buildExtractionRetryNote(reason));
        const requirements = g.list(0, 8, () => genRequirement(g, 1 + g.int(20), true));
        const guideMax = g.pick([0, 20, 60, 100, 150, 200, 400, 1500]);
        compare('summarizeRequirementsForGuide', () => json([requirements, guideMax]), () => old.summarizeRequirementsForGuide(requirements as never, guideMax), () => cur.summarizeRequirementsForGuide(requirements as never, guideMax));
        const steps = g.list(0, 6, () => words(g, 1, 4));
        compare('summarizeManualStepsForGuide', () => json([steps, guideMax]), () => old.summarizeManualStepsForGuide(steps, guideMax), () => cur.summarizeManualStepsForGuide(steps, guideMax));
        const requirement = genRequirement(g, undefined, true);
        compare('buildRequirementWorkPrefill', () => json(requirement), () => old.buildRequirementWorkPrefill(requirement as never), () => cur.buildRequirementWorkPrefill(requirement as never));
        compare('buildAllMustHavesPrefill', () => json(requirements), () => old.buildAllMustHavesPrefill(requirements as never), () => cur.buildAllMustHavesPrefill(requirements as never));
      });
    });

    it(`실행 안 된 테스트·CSV (시드 ${seed})`, () => {
      runWith(seed, (g) => {
        const ids = ['R1', 'R2', 'R1.1'];
        const rows = genRunRows(g, ids);
        const id = g.pick(ids);
        compare('findUnexecutedTests', () => json([id, rows]), () => old.findUnexecutedTests(id, rows as never), () => cur.findUnexecutedTests(id, rows as never));
        const matrix = {
          rows: g.list(0, 5, () => ({
            kind: g.pick(['requirement', 'scenario']),
            id: g.pick(ids),
            ...(g.chance(0.5) ? { parentId: 'R1' } : {}),
            title: g.chance(0.5) ? words(g, 0, 4) : `a,"b"\n${words(g, 0, 2)}`,
            rev: g.pick([1, 2, 10]),
            priority: g.pick(PRIORITIES),
            ...(g.chance(0.5) ? { issue: 1 + g.int(40) } : {}),
            checkpoints: g.list(0, 2, () => ({ sha: 'a', shortSha: g.pick(['abc1234', 'ff00ff0']), message: '' })),
            tests: g.list(0, 3, () => ({ file: 'a.ts', name: words(g, 1, 2), ...(g.chance(0.6) ? { result: g.pick(['pass', 'fail', 'not-run']) } : {}) })),
            gateChecks: g.list(0, 2, () => ({ name: words(g, 1, 2), ok: g.chance(0.5) })),
            status: g.pick(STATUSES),
            verifiedBy: g.pick(['none', '테스트 탭', '게이트', '문서 확인', '사람 확인']),
          })),
          orphanTests: [],
          mustHavesWithoutTests: [],
          mustHavesVerifiedWithoutTests: [],
        };
        compare('buildMatrixCsv', () => json(matrix), () => old.buildMatrixCsv(matrix as never), () => cur.buildMatrixCsv(matrix as never));
      });
    });

    it(`손상 입력: 옛 TS가 던지면 Rust도 던지고, 둘 다 값을 내면 같다 (시드 ${seed})`, () => {
      // 배열·문자열은 뺀다: `[].at`·`'x'.at`은 함수라 옛 TS가 `testRun.at > '2026'` 같은 비교를 참으로 읽는다(JS 내장 메서드 이름과 겹치는 우연)
      const BAD = [undefined, null, 5, {}, true, { id: 7 }];
      runWith(seed, (g) => {
        const requirement = genRequirement(g);
        const keys = Object.keys(requirement);
        const key = g.pick(keys);
        const broken: Json = { ...requirement, [key]: g.pick(BAD) };
        const evidence = genEvidence(g);
        const evidenceKeys = Object.keys(evidence);
        const brokenEvidence: Json = { ...evidence, [g.pick(evidenceKeys)]: g.pick(BAD) };
        const options = { malformed: true } as const;
        compare('손상: computeRequirementStatus', () => json([brokenEvidence, broken]), () => old.computeRequirementStatus(brokenEvidence as never, broken as never), () => cur.computeRequirementStatus(brokenEvidence as never, broken as never), { ...options, flip: (l, c) => l !== '검증됨' && c === '검증됨' });
        compare('손상: lintRequirement', () => json(broken), () => old.lintRequirement(broken as never), () => cur.lintRequirement(broken as never), options);
        compare('손상: requirementContentDrifted', () => json(broken), () => old.requirementContentDrifted(broken as never), () => cur.requirementContentDrifted(broken as never), options);
        compare('손상: isManualStep(partition)', () => json(broken), () => old.partitionManualSteps([broken] as never), () => cur.partitionManualSteps([broken] as never), options);
        compare('손상: requirementSimilarity', () => json(broken), () => old.requirementSimilarity(broken as never, requirement as never), () => cur.requirementSimilarity(broken as never, requirement as never), options);
        compare('손상: buildRequirementWorkPrefill', () => json(broken), () => old.buildRequirementWorkPrefill(broken as never), () => cur.buildRequirementWorkPrefill(broken as never), options);
      });
    });
  }

  it('모든 함수가 같고, 던짐이 어긋나거나 판정이 통과 쪽으로 뒤집힌 곳이 없다', () => {
    const problems: string[] = [];
    let total = 0;
    let flips = 0;
    for (const [name, s] of STATS) {
      if (name.startsWith('대조')) continue;
      total += s.total;
      flips += s.flips;
      if (s.mismatches.length > 0) problems.push(`${name}: ${s.mismatches.join('\n')}`);
      if (s.legacyOnlyThrew > 0) problems.push(`${name}: 옛 TS만 던졌다 ${s.legacyOnlyThrew}번`);
      if (!name.startsWith('손상') && s.rustOnlyThrew > 0) problems.push(`${name}: Rust만 던졌다 ${s.rustOnlyThrew}번`);
    }
    expect(problems).toEqual([]);
    expect(flips).toBe(0);
    expect(total).toBeGreaterThan(SEEDS.length * RUNS * 30);
    if (process.env.REQUIREMENTS_DIFF_REPORT) {
      // 환경 변수가 경로면 그 파일에 쓴다(시험 러너가 console 출력을 가릴 때)
      const lines = [...STATS].map(([name, s]) => `${name}\t합계 ${s.total}\t같음 ${s.same}\t둘다던짐 ${s.bothThrew}\tRust만던짐 ${s.rustOnlyThrew}\t빈결과 ${s.empty}\t값있음 ${s.filled}\t참 ${s.truthy}\t거짓 ${s.falsy}\t뒤집힘 ${s.flips}`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeFileSync(process.env.REQUIREMENTS_DIFF_REPORT, `${lines.join('\n')}\n총 ${total}번, 뒤집힘 ${flips}\n`);
    }
  });

  it('입력이 비지 않았다: 결과 분포(값·빈 결과·참·거짓)가 고르다', () => {
    const min = (name: string, field: 'empty' | 'filled' | 'truthy' | 'falsy', fraction: number) => {
      const s = STATS.get(name);
      expect(s, name).toBeDefined();
      expect(s![field], `${name}.${field}`).toBeGreaterThan(s!.total * fraction);
    };
    // 값이 있는 결과와 빈 결과가 둘 다 충분히 나온다
    for (const name of ['findMentionedIds', 'extractImplementsTrailers', 'findCheckpointMentions', 'findGateCheckMentions', 'extractPathReferences', 'extractRequirementsHeuristically', 'lintText', 'lintRequirement', 'findUnexecutedTests']) {
      min(name, 'filled', 0.05);
    }
    for (const name of ['findMentionedIds', 'extractImplementsTrailers', 'findCheckpointMentions', 'findGateCheckMentions', 'extractPathReferences', 'lintText', 'findUnexecutedTests']) min(name, 'empty', 0.02);
    // 참·거짓이 둘 다 나온다
    for (const [name, lo] of [
      ['isLikelyTestFile', 0.03],
      ['mentionsRequirementId', 0.03],
      ['requirementContentDrifted', 0.03],
      ['requirementIsReady', 0.02],
      ['isManualStepText', 0.03],
      ['verifySpecQuote', 0.05],
    ] as const) {
      min(name, 'truthy', lo);
      min(name, 'falsy', lo);
    }
    // 상태 갈래: 문자열 결과라 참·거짓이 없으므로 갈래마다 따로 센다
    const g = new Gen(7);
    const seen = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const evidence = genEvidence(g);
      const requirement = g.chance(0.85) ? genRequirement(g, 1) : undefined;
      const status = old.computeRequirementStatus(evidence as never, requirement as never);
      seen.set(status, (seen.get(status) ?? 0) + 1);
      const source = old.requirementVerificationSource(evidence as never, requirement as never);
      seen.set(`출처 ${source}`, (seen.get(`출처 ${source}`) ?? 0) + 1);
    }
    for (const label of ['미착수', '작업 중', '검증됨', '재확인 필요', '실패', '출처 test', '출처 docs', '출처 manual', '출처 none']) expect(seen.get(label) ?? 0, label).toBeGreaterThan(40);
    // 병합: 짝지어진 것·새로 붙은 것·사라진 것·분할 힌트가 다 나온다
    const statuses = new Map<string, number>();
    for (let i = 0; i < 1500; i++) {
      const existing = g.list(1, 5, (() => { let n = 0; return () => genRequirement(g, ++n); })());
      const incoming: Json[] = existing.filter(() => g.chance(0.6)).map((r, index) => ({ ...r, id: `R${index + 1}`, title: g.chance(0.6) ? r.title : `${r.title as string} 변경` }));
      incoming.push({ ...genRequirement(g), id: `R${incoming.length + 1}` });
      const result = old.mergeReextractedRequirements(incoming as never, existing as never);
      for (const entry of result.diff) statuses.set(entry.status, (statuses.get(entry.status) ?? 0) + 1);
      if (result.diff.some((entry) => entry.requirement.trace?.supersedes)) statuses.set('분할 힌트', (statuses.get('분할 힌트') ?? 0) + 1);
    }
    for (const label of ['added', 'changed', 'unchanged', 'removed', '분할 힌트']) expect(statuses.get(label) ?? 0, label).toBeGreaterThan(30);
  });
});

describe('대조 장치: 이 시험이 다른 결과를 잡는지', () => {
  it('새 결과를 한 글자만 바꿔도 다른 결과로 센다(값이 있는 결과마다)', () => {
    const g = new Gen(41);
    for (let i = 0; i < 800; i++) {
      const text = words(g, 1, 10);
      compare('대조: findMentionedIds', () => json(text), () => old.findMentionedIds(text), () => perturb(cur.findMentionedIds(text)));
      const doc = words(g, 1, 10, FRAGS, ['\n']);
      compare('대조: lintText', () => json(doc), () => old.lintText(doc), () => perturb(lintText(doc)));
      const requirement = genRequirement(g);
      compare('대조: computeRequirementHash', () => json(requirement), () => old.computeRequirementHash(requirement as never), () => perturb(cur.computeRequirementHash(requirement as never)));
      compare('대조: requirementSimilarity', () => json(requirement), () => old.requirementSimilarity(requirement as never, requirement as never), () => perturb(cur.requirementSimilarity(requirement as never, requirement as never)));
      compare('대조: isManualStepText', () => json(text), () => old.isManualStepText(text), () => perturb(cur.isManualStepText(text)));
    }
    for (const name of ['대조: findMentionedIds', '대조: lintText']) {
      const s = stat(name);
      // 빈 결과도 {x:1}·[null]로 바뀌므로 모든 입력이 다른 결과로 잡힌다
      expect(s.mismatches.length, name).toBe(800);
    }
    expect(stat('대조: computeRequirementHash').mismatches.length).toBe(800);
    expect(stat('대조: requirementSimilarity').mismatches.length).toBe(800);
    expect(stat('대조: isManualStepText').mismatches.length).toBe(800);
  });

  it('통과 쪽으로 뒤집힌 판정은 뒤집힘으로 센다', () => {
    const g = new Gen(42);
    for (let i = 0; i < 1500; i++) {
      const evidence = genEvidence(g);
      const requirement = genRequirement(g, 1);
      // 실패를 검증됨으로 바꾸는 틀린 판정을 흉내 낸다
      compare('대조: 상태 뒤집기', () => json([evidence, requirement]), () => old.computeRequirementStatus(evidence as never, requirement as never), () => {
        const real = cur.computeRequirementStatus(evidence as never, requirement as never);
        return real === '실패' ? '검증됨' : real;
      }, { flip: (legacy, current) => legacy !== '검증됨' && current === '검증됨' });
    }
    const s = stat('대조: 상태 뒤집기');
    expect(s.flips).toBeGreaterThan(30);
    expect(s.mismatches.length).toBe(s.flips);
  });
});

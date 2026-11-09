import { appendFileSync } from 'node:fs';
import { encodeNative, native } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import { buildContractSystem, buildContractUser } from './lane-contracts';
import { appendPlanToRequest, buildPlanBriefSystem, planWordLimit, shouldPlanBrief } from './plan-brief';
import type { TaskLane } from './task-plan';

/**
 * plan-brief·lane-contracts의 순수 함수를 Rust로 옮기면서(ADR-191 3m) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을
 * 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자로 견준다. `legacy`는 옮기기 전 `plan-brief.ts`·`lane-contracts.ts`의 해당 함수 본문이다
 * (`export`만 뗐고, 상수는 인자로 바꿔 다른 상한도 견준다. 복잡도·토큰 추정은 그때 `model-router.ts`의 TS 구현을 그대로 옮겨 적었다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: PLAN_BRIEF_DIFF_SEEDS(쉼표 목록), PLAN_BRIEF_DIFF_ITERATIONS, PLAN_BRIEF_DIFF_REPORT=<파일 경로>(분포를 그 파일에 덧붙인다)
 */
type LegacyProject = { spec: { name: string }; managed: Array<[string, { template?: string; path?: string }]> };
type LegacyLane = { id: string; paths: string[]; tasks: Array<{ id: string; title: string; request: string }> };

const legacy = (() => {
  const COMPLEX = /아키텍처|architecture|migration|마이그레이션|distributed|분산|concurren|동시성|security|보안|refactor|리팩터|multi[- ]?service|멀티|성능|performance|incident|장애/i;
  function estimateTokens(text: string): number {
    const ascii = [...text].filter((character) => character.codePointAt(0)! <= 0x7f).length;
    return Math.max(1, Math.ceil(ascii / 4 + (text.length - ascii) / 1.5));
  }
  function classifyComplexity(prompt: string, inputTokens: number): 'simple' | 'normal' | 'complex' {
    const signals = (COMPLEX.test(prompt) ? 1 : 0) + (inputTokens >= 800 ? 1 : 0) + ((prompt.match(/\n/g)?.length ?? 0) >= 12 ? 1 : 0);
    return signals >= 2 ? 'complex' : signals === 1 ? 'normal' : 'simple';
  }

  const PLAN_BRIEF_MAX_WORDS_SHORT = 150;
  const PLAN_BRIEF_MAX_WORDS_LONG = 400;
  const PLAN_BRIEF_MAX_CHARS = 3_000;
  const MAX_LANE_CONTRACTS = 6;

  function shouldPlanBrief(request: string): boolean {
    const prompt = request.trim();
    if (!prompt) return false;
    return classifyComplexity(prompt, estimateTokens(prompt)) !== 'simple';
  }

  function planWordLimit(request: string, short = PLAN_BRIEF_MAX_WORDS_SHORT, long = PLAN_BRIEF_MAX_WORDS_LONG): number {
    const segments = request
      .trim()
      .split(/(?<=[.!?])\s+|\n+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    return segments.length <= 2 ? short : long;
  }

  function buildPlanBriefSystem(project: LegacyProject, request: string, short = PLAN_BRIEF_MAX_WORDS_SHORT, long = PLAN_BRIEF_MAX_WORDS_LONG): string {
    const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
    const wordLimit = planWordLimit(request, short, long);
    const lineLimit = wordLimit === short ? 10 : 25;
    return `You are a senior engineer writing a short reference plan for project "${project.spec.name}" that a smaller, cheaper coding agent will execute right after you.
Services:
${services}

Plan the MINIMAL change that satisfies the request — nothing more. Do not add files, layers (service/DTO/repository splits), tests, refactors, or verification/self-check steps the request doesn't explicitly ask for. Prefer editing existing files over creating new ones. Do not restate the request — go straight to the plan.

Write the plan in Korean, as plain text (no JSON, no code fences), at most about ${wordLimit} words (roughly ${lineLimit} lines). It is a list of decisions and pitfalls for the executor, not a step-by-step script. Cover only what applies:
1. 바꿀 파일(기존 파일 우선) — 새 파일은 요청이 명시적으로 요구할 때만
2. API·인터페이스 계약, 정확한 경로·이름, 환경 변수 같은 결정 사항(없으면 생략)
3. 놓치기 쉬운 함정
Do not write any code. Do not add a verification or testing step — the platform's gate checks the result after the turn ends (lean self-check, ADR-064), so the executor should not repeat that work. The executor will see this plan appended to the original request as reference notes, not as a message back to the user, and must not treat it as a bigger scope than the request.`;
  }

  function appendPlanToRequest(request: string, plan: string, maxChars = PLAN_BRIEF_MAX_CHARS): string {
    const trimmed = plan.trim();
    const body =
      trimmed.length > maxChars
        ? `${trimmed.slice(0, maxChars)}\n…(계획이 상한 ${maxChars.toLocaleString('ko-KR')}자를 넘어 여기서 잘랐습니다)`
        : trimmed;
    return `${request}\n\n---\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\n${body}\n[계획 끝]\n---`;
  }

  function buildContractSystem(project: LegacyProject, maxContracts = MAX_LANE_CONTRACTS): string {
    const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
    return `You write the interface contracts between parallel coding agents for project "${project.spec.name}".
Services:
${services}

The agents run at the same time in separate workspaces and cannot see each other's code. Write down ONLY the interfaces where two agents must agree: an endpoint one agent serves and another calls, the shape of that response, a field name both sides use.
Reply with ONLY a JSON object: {"contracts":[{"body":"...","refs":["..."]}]}
Rules:
- Each body is one interface, in exactly this shape: "GET /api/books/{id} → 200 JSON, 404 if missing. Fields: id(number), title(string), authors(array of {name(string)}), note(string|null)"
- Name every field exactly, with its type (string, number, boolean, array, object, null) and say whether a value is a list or a map (for example "countsByGenre(object map: genre→count)").
- Include the request (method, path, query or body fields) and the response status codes.
- Do not write anything only one agent uses: private helpers, internal state, styling, refactors.
- refs are the paths this interface belongs to (the api path, or a file both sides touch).
- If no two agents share an interface, reply {"contracts":[]}.
- At most ${maxContracts} contracts. Do not invent interfaces the request does not imply.`;
  }

  function buildContractUser(request: string, lanes: readonly LegacyLane[]): string {
    const laneText = lanes
      .map((lane) => {
        const tasks = lane.tasks.map((task) => `  · ${task.id} (${task.title}): ${task.request}`).join('\n');
        return `- ${lane.id} · 쓰기 경로: ${lane.paths.join(', ')}\n${tasks}`;
      })
      .join('\n');
    return `전체 요청: ${request}

레인 (동시에 실행되고 서로의 코드를 보지 못합니다):
${laneText}`;
  }

  return { shouldPlanBrief, planWordLimit, buildPlanBriefSystem, appendPlanToRequest, buildContractSystem, buildContractUser };
})();

const SEEDS = readEnvList('PLAN_BRIEF_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('PLAN_BRIEF_DIFF_ITERATIONS', 3000);
const REPORT = process.env.PLAN_BRIEF_DIFF_REPORT;

interface Tally {
  compared: number;
  different: number;
  distribution: Map<string, number>;
  examples: string[];
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, distribution: new Map(), examples: [] }));
  return t;
}

function compare(name: string, input: unknown, old: () => unknown, next: () => unknown, bucket: (o: Outcome) => string): void {
  const a = outcome(old);
  const b = outcome(next);
  const t = tally(name);
  t.compared += 1;
  const key = bucket(a);
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
  if (!sameOutcome(a, b)) {
    t.different += 1;
    if (t.examples.length < 3) t.examples.push(`입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}`);
  }
}

const WORDS = ['버튼', '색을', '바꿔줘', 'add', 'fix', 'the', 'login', 'page', '로그인', '화면', 'API', '/api/orders', 'README.md', '주문', 'GET', '😀', '한글', 'x'];
const COMPLEX_WORDS = ['아키텍처', 'architecture', 'MIGRATION', '마이그레이션', 'distributed', '분산', 'concurrency', '동시성', 'Security', '보안', 'refactor', '리팩터', 'multi-service', 'multiservice', 'multi service', '멀티', '성능', 'performance', 'incident', '장애', 'multi\nservice', 'multi--service'];
const SEPARATORS = [' ', ' ', ' ', '. ', '! ', '? ', '.\n', '\n', '\n\n', '.  ', '.\u00a0', '.\ufeff', '.\u2028', '.\u3000', '. \n ', ' . ', '.x', '.', '?!', '\r\n', '。 ', '\u0085', '.\u0085', '\t', ',\n', '\n \n'];
const PADS = ['', '', '', ' ', '\n', '\u00a0', '\ufeff', '\u0085', '\u3000', '\u2028', '\t \n'];

function sentence(g: Gen): string {
  const words = g.list(1, 6, () => (g.chance(0.12) ? g.pick(COMPLEX_WORDS) : g.pick(WORDS)));
  return words.join(' ');
}

function requestText(g: Gen): string {
  const mode = g.int(10);
  let text: string;
  if (mode < 5) {
    // 문장 0~5개를 여러 구분자로 이은 요청(문장 수 경계 2·3)
    const count = g.int(6);
    text = '';
    for (let i = 0; i < count; i++) text += (i > 0 ? g.pick(SEPARATORS) : '') + sentence(g);
  } else if (mode < 7) {
    // 줄 수 경계(12줄): 줄바꿈 n개
    const lines = 10 + g.int(5);
    text = Array.from({ length: lines }, () => sentence(g)).join('\n');
  } else if (mode < 8) {
    // 800토큰 경계: ASCII 3200자, 한글 1200자, 둘이 섞인 길이
    const ascii = 3190 + g.int(20);
    const korean = g.chance(0.4) ? 1190 + g.int(20) : 0;
    text = korean ? '가'.repeat(korean) : 'a'.repeat(ascii);
    if (g.chance(0.4)) text = 'a'.repeat(Math.floor(ascii / 2)) + ' ' + '가'.repeat(Math.floor(1200 / 2) - 1 + g.int(3));
  } else if (mode < 9) {
    text = g.pick(['', ' ', '\n', '\ufeff', '\u0085', '   \n\t ', '.', '. .', '..', '!?', '\n\n.\n\n']);
  } else {
    text = g.text([...'가나다 .!?\n\u00a0aB😀'], g.int(40));
  }
  return g.pick(PADS) + text + g.pick(PADS);
}

function planText(g: Gen): string {
  const mode = g.int(6);
  if (mode === 0) return g.pick(['', ' ', '\n', '\ufeff', '\u0085', '  계획  ', '\n계획\n']);
  if (mode === 1) {
    // 상한 3000 UTF-16 코드 단위 경계(짝 있는 서로게이트 포함)
    const n = 2990 + g.int(20);
    let s = '';
    while (s.length < n) s += g.chance(0.2) ? '😀' : g.chance(0.3) ? '가' : 'a';
    return g.pick(PADS) + s + g.pick(PADS);
  }
  if (mode === 2) return g.pick(PADS) + 'a'.repeat(2998 + g.int(5)) + g.pick(PADS);
  if (mode === 3) return g.pick(PADS) + '😀'.repeat(1498 + g.int(4)) + g.pick(PADS);
  return g.pick(PADS) + g.list(1, 12, () => sentence(g)).join(g.pick(['\n', ' ', '\n- '])) + g.pick(PADS);
}

function projectOf(g: Gen): LegacyProject {
  const managed = g.list(0, 4, (): [string, { template?: string; path?: string }] => {
    const service: { template?: string; path?: string } = {};
    if (g.chance(0.9)) service.template = g.pick(['nextjs', 'spring-boot', 'fastapi', 'node-express', '', 'a b', '😀']);
    if (g.chance(0.9)) service.path = g.pick(['web', 'api', 'services/api', '', 'a\nb', '한글']);
    return [g.pick(['web', 'api', 'worker', 'db', '', '한글', 'a"b']), service];
  });
  return { spec: { name: g.pick(['orders', 'shop', '', '한글 앱', 'a"b', '${x}', '😀', 'multi\nline']) }, managed };
}

function lanesOf(g: Gen): LegacyLane[] {
  return g.list(0, 4, () => ({
    id: g.pick(['api', 'web', 'lane-1', '', '한글']),
    paths: g.list(0, 3, () => g.pick<string | undefined>(['api/', 'web/src/', 'shared', '', 'a b', '한글/', undefined])) as string[],
    tasks: g.list(0, 3, () => ({ id: g.pick(['t1', 't2', 'api-1', '']), title: g.pick(['제목', 'Title', '', 'a(b)']), request: g.chance(0.5) ? sentence(g) : requestText(g) })),
  }));
}

const asProject = (p: LegacyProject): LoadedProject => p as unknown as LoadedProject;
const asLanes = (l: LegacyLane[]): TaskLane[] => l as unknown as TaskLane[];

function lineBucket(o: Outcome): string {
  if (o.threw) return '던짐';
  const v = String(o.value);
  const m = v.match(/\(roughly (\d+) lines\)/);
  return m ? `줄 ${m[1]}` : '해당 없음';
}

function runSeed(seed: number): void {
  const g = new Gen(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    const req = requestText(g);
    const plan = planText(g);
    const project = projectOf(g);
    const lanes = lanesOf(g);

    compare('shouldPlanBrief', req, () => legacy.shouldPlanBrief(req), () => shouldPlanBrief(req), (o) => String(o.threw ? '던짐' : (o as { value: unknown }).value));
    compare('planWordLimit', req, () => legacy.planWordLimit(req), () => planWordLimit(req), (o) => String(o.threw ? '던짐' : (o as { value: unknown }).value));
    // 다른 상한(짧은 상한과 긴 상한이 같은 경우 포함)도 Rust에 직접 견준다
    const [short, long] = g.pick<[number, number]>([[150, 400], [10, 20], [7, 7], [0, 1], [5, 3], [150.5, 1e21]]);
    compare('planWordLimit(상한 인자)', { req, short, long }, () => legacy.planWordLimit(req, short, long), () => native.planWordLimit(req, short, long), (o) => (o.threw ? '던짐' : String((o as { value: unknown }).value) === String(short) ? '짧은' : '긴'));
    compare('buildPlanBriefSystem', { req, project }, () => legacy.buildPlanBriefSystem(project, req), () => buildPlanBriefSystem(asProject(project), req), (o) => lineBucket(o));
    compare('buildPlanBriefSystem(상한 인자)', { req, project, short, long }, () => legacy.buildPlanBriefSystem(project, req, short, long), () => native.buildPlanBriefSystem(encodeNative({ name: project.spec.name, managed: project.managed }), req, short, long), (o) => lineBucket(o));
    compare('appendPlanToRequest', { req, plan }, () => legacy.appendPlanToRequest(req, plan), () => appendPlanToRequest(req, plan), (o) => (o.threw ? '던짐' : String((o as { value: unknown }).value).includes('여기서 잘랐습니다') ? '잘림' : '그대로'));
    const maxChars = g.pick([3000, 0, 1, 2, 5, 2999, 3001, -1, -5, 2.5, 7.9, NaN, Infinity, -Infinity, 1234567, 1e21, 100, -1.5, -0.5, -2.9, 0.4]);
    compare('appendPlanToRequest(상한 인자)', { req, plan, maxChars }, () => legacy.appendPlanToRequest(req, plan, maxChars), () => native.appendPlanToRequest(req, plan, maxChars), (o) => (o.threw ? '던짐' : String((o as { value: unknown }).value).includes('여기서 잘랐습니다') ? '잘림' : '그대로'));
    compare('buildContractSystem', project, () => legacy.buildContractSystem(project), () => buildContractSystem(asProject(project)), (o) => (o.threw ? '던짐' : '글'));
    const maxContracts = g.pick([6, 0, 1, 7, -1, 2.5, 1e21, NaN, Infinity]);
    compare('buildContractSystem(상한 인자)', { project, maxContracts }, () => legacy.buildContractSystem(project, maxContracts), () => native.buildContractSystem(encodeNative({ name: project.spec.name, managed: project.managed }), maxContracts), (o) => (o.threw ? '던짐' : '글'));
    compare('buildContractUser', { req, lanes }, () => legacy.buildContractUser(req, lanes), () => buildContractUser(req, asLanes(lanes)), (o) => (o.threw ? '던짐' : `레인 ${lanes.length}`));
  }
}

describe('plan-brief·lane-contracts 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 × 함수 6개(상한 인자 변형 포함)가 옛 TS와 같다`, () => {
      runSeed(seed);
    }, 600_000);
  }

  it('모든 함수에서 다른 결과가 0이다', () => {
    if (REPORT) {
      for (const [name, t] of tallies) appendFileSync(REPORT, `${name}: 비교 ${t.compared}, 다름 ${t.different}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}\n`);
    }
    const bad = [...tallies].filter(([, t]) => t.different > 0).map(([name, t]) => `${name}: ${t.different}건\n${t.examples.join('\n')}`);
    expect(bad).toEqual([]);
    expect(tallies.size).toBe(10);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았고 입력이 비지 않았다', () => {
    expect([...tally('shouldPlanBrief').distribution.keys()].sort()).toEqual(['false', 'true']);
    expect([...tally('planWordLimit').distribution.keys()].sort()).toEqual(['150', '400']);
    expect([...tally('buildPlanBriefSystem').distribution.keys()].sort()).toEqual(['줄 10', '줄 25']);
    expect([...tally('appendPlanToRequest').distribution.keys()].sort()).toEqual(['그대로', '잘림']);
    expect([...tally('appendPlanToRequest(상한 인자)').distribution.keys()].sort()).toEqual(['그대로', '잘림']);
    expect([...tally('buildContractUser').distribution.keys()].length).toBeGreaterThanOrEqual(4);
    for (const [name, t] of tallies) {
      if (name === '대조') continue;
      expect([...t.distribution.keys()], name).not.toEqual(['던짐']);
      expect(t.compared, name).toBeGreaterThan(0);
    }
  });

  it('옛 구현이 던지는 입력(서비스 누락)을 새 껍데기도 던진다', () => {
    const broken = { spec: { name: 'x' }, managed: [['web', undefined]] } as unknown as LoadedProject;
    expect(() => buildPlanBriefSystem(broken, '요청')).toThrow();
    expect(() => buildContractSystem(broken)).toThrow();
  });

  it('대조 장치: 경계를 ±1 바꾼 옛 구현과 결과 한 글자를 바꾼 값이 차이로 잡힌다', () => {
    const t = tally('대조');
    const req = '버튼 색을 바꿔줘. 그리고 글자도. 마지막으로 이것도.';
    // 문장 수 상한 2를 1로 바꾼 옛 구현
    const mutantLimit = (r: string) => (r.trim().split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).length <= 1 ? 150 : 400);
    compare('대조', req, () => mutantLimit('버튼 색을 바꿔줘. 그리고 글자도.'), () => planWordLimit('버튼 색을 바꿔줘. 그리고 글자도.'), () => '글');
    // 글자 상한 ±1
    const plan = 'a'.repeat(3000);
    compare('대조', plan, () => legacy.appendPlanToRequest('r', plan, 2999), () => appendPlanToRequest('r', plan), () => '글');
    // 결과 한 글자
    const system = legacy.buildContractSystem({ spec: { name: 'p' }, managed: [] });
    compare('대조', system, () => system.replace('At most 6', 'At most 7'), () => buildContractSystem(asProject({ spec: { name: 'p' }, managed: [] })), () => '글');
    compare('대조', system, () => perturb(system), () => buildContractSystem(asProject({ spec: { name: 'p' }, managed: [] })), () => '글');
    compare('대조', system, () => system, () => buildContractSystem(asProject({ spec: { name: 'p' }, managed: [] })), () => '글');
    expect(t.different).toBe(4);
    tallies.delete('대조');
  });
});

import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { hasDocsVerifyTrailer, hasEmptyPassedTrailer } from './checkpoints';
import {
  formatCheckedCoverage,
  formatIncompleteTrailer,
  formatVerifyTrailer,
  formatWorkflowTrailer,
  isDocCheckpointPath,
  maxTurnsFor,
  missingVerificationStages,
  parseIncompleteTrailerValues,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  protectedPathsFor,
  releaseBlockers,
  reviewChanges,
  uncoveredChangeWarnings,
  workflowReleaseRequirements,
  workflowStages,
} from './workflow';
import { legacy } from './workflow-legacy';

/**
 * 워크플로 판정 벡터(ADR-191 3v). 기대값은 옮기기 전 TS(`workflow-legacy.ts`)가 낸 값이다.
 * `WORKFLOW_VECTORS_IMPL=legacy`로 돌리면 같은 벡터를 옛 구현에 넣는다: `intended`로 표시한 벡터(의도한 차이)만 실패해야 한다.
 * 경계(같음·±1), 빈 값, 공백 종류와 함께 인식하는 값마다 거의 같은 거부 입력(접두·덧붙임·대소문자·빈 글자·다른 구분자)을 넣었다.
 */

const useLegacy = process.env.WORKFLOW_VECTORS_IMPL === 'legacy';
const impl = useLegacy
  ? legacy
  : {
      formatWorkflowTrailer, formatVerifyTrailer, formatIncompleteTrailer, parseWorkflowTrailerValues, parseVerifyTrailerValues, parseIncompleteTrailerValues, isDocCheckpointPath,
      hasEmptyPassedTrailer, hasDocsVerifyTrailer, workflowStages, workflowReleaseRequirements, releaseBlockers, missingVerificationStages, reviewChanges, uncoveredChangeWarnings,
      formatCheckedCoverage, maxTurnsFor, protectedPathsFor,
    };

interface Vector {
  name: string;
  intended: boolean;
  run: () => unknown;
  expected: unknown;
}

const vectors: Vector[] = [];
const add = (name: string, run: () => unknown, expected: unknown, intended = false) => vectors.push({ name, run, expected, intended });
const norm = <T>(value: T): T => JSON.parse(JSON.stringify(value === undefined ? null : value)) as T;
const U = {
  nbsp: '\u00a0', bom: '\ufeff', ls: '\u2028', ps: '\u2029', ideo: '\u3000', nel: '\u0085', kelvin: '\u212a', dotlessI: '\u0131', dottedI: '\u0130',
};

function proj(workflow?: Record<string, unknown>, managed?: Array<{ name: string; path: string; includes?: string[]; template: string }>, extra: Record<string, unknown> = {}): LoadedProject {
  return {
    spec: { name: 'x', ...(workflow ? { workflow } : {}) },
    ...(managed ? { managed: managed.map((m) => [m.name, { source: 'managed', ...m }]) } : {}),
    ...extra,
  } as unknown as LoadedProject;
}

// ── 트레일러 만들기 ──────────────────────────────────────────────────────

add('통과 단계가 없으면 none', () => impl.formatWorkflowTrailer([]), 'Workflow-Passed: none');
add('단계는 쉼표와 공백으로 잇는다', () => impl.formatWorkflowTrailer(['run', 'review']), 'Workflow-Passed: run, review');
add('단계 하나', () => impl.formatWorkflowTrailer(['test']), 'Workflow-Passed: test');
for (const mode of ['light', 'docs', 'unverified'] as const) add(`검증 트레일러 ${mode}`, () => impl.formatVerifyTrailer(mode), `Workflow-Verify: ${mode}`);
add('미완 트레일러', () => impl.formatIncompleteTrailer('max_turns'), 'Workflow-Incomplete: max_turns');

// ── Workflow-Passed 읽기 ─────────────────────────────────────────────────

const passed = (...values: string[]) => impl.parseWorkflowTrailerValues(values);
add('값이 없으면 undefined', () => passed(), undefined);
add('빈 값만 있으면 undefined', () => passed(''), undefined);
add('공백만 있으면 undefined', () => passed('   ', '\t\r\n'), undefined);
add('none은 빈 목록', () => passed('none'), []);
add('앞뒤 공백이 있는 none', () => passed(' none \r'), []);
for (const word of ['None', 'NONE', 'nonE']) add(`none의 대소문자 ${word}는 빈 목록`, () => passed(word), []);
add('none에 덧붙이면 알 수 없는 단계라 빈 목록', () => passed('none x'), []);
add('none이 쉼표 목록 안에 있으면 알 수 없는 단계다', () => passed('none, review'), ['review']);
add('목록 끝의 none', () => passed('review, none'), ['review']);
for (const stage of ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review', 'checkpoint']) {
  add(`아는 단계 ${stage}`, () => passed(stage), [stage]);
  add(`단계의 대소문자 ${stage.toUpperCase()}는 모른다`, () => passed(stage.toUpperCase()), []);
  add(`단계에 덧붙인 ${stage}x는 모른다`, () => passed(`${stage}x`), []);
  add(`단계 앞에 덧붙인 x${stage}는 모른다`, () => passed(`x${stage}`), []);
}
for (const unknown of ['deploy', 'tests', 'Run', 'run test', 'run;test', 'run|test', 'run test']) add(`모르는 값 ${JSON.stringify(unknown)}`, () => passed(unknown), []);
add('쉼표 앞뒤 공백', () => passed('run , test ,review'), ['run', 'test', 'review']);
add('빈 조각은 건너뛴다', () => passed('run,,test,'), ['run', 'test']);
add('앞의 쉼표', () => passed(',run'), ['run']);
add('줄 끝 \\r이 붙은 값', () => passed('run\r'), ['run']);
add('줄 끝 \\r이 붙은 조각', () => passed('run\r, test'), ['run', 'test']);
add('탭으로 나눈 조각', () => passed('run,\ttest'), ['run', 'test']);
add('마지막 값만 읽는다', () => passed('run', 'test'), ['test']);
add('마지막 값이 모르는 값이면 빈 목록', () => passed('run', 'deploy'), []);
add('마지막 값이 none', () => passed('run', 'none'), []);
add('앞의 빈 값은 건너뛴다', () => passed('', 'run'), ['run']);
add('앞의 빈 값 둘', () => passed('', '  ', 'run'), ['run']);
add('같은 단계가 반복돼도 그대로', () => passed('run, run'), ['run', 'run']);
add('모든 단계', () => passed('plan, implement, run, browser_check, contract_check, test, concurrency_check, load_check, review, checkpoint'), ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review', 'checkpoint']);
// 의도한 차이 ②: 마지막 값이 비면 통과한 단계가 없다(옛 코드는 빈 값을 건너뛰고 앞의 값을 읽었다)
add('마지막 값이 비면 앞의 값을 읽지 않는다', () => passed('run', ''), [], true);
add('마지막 값이 공백이면 앞의 값을 읽지 않는다', () => passed('run, test', ' \t'), [], true);
add('빈 값 사이에 낀 값', () => passed('', 'run', ''), [], true);
// 의도한 차이 ①: git이 지우는 ASCII 공백만 공백이다
add('NBSP가 앞에 붙은 단계는 모른다', () => passed(`${U.nbsp}run`), [], true);
add('BOM이 앞에 붙은 단계는 모른다', () => passed(`${U.bom}run`), [], true);
add('줄 끝 U+2028이 붙은 단계는 모른다', () => passed(`run${U.ls}`), [], true);
add('쉼표 뒤 NBSP가 붙은 조각은 모른다', () => passed(`run,${U.nbsp}test`), ['run'], true);
add('쉼표 앞 U+3000이 붙은 조각은 모른다', () => passed(`run${U.ideo},test`), ['test'], true);
add('NBSP만 있으면 빈 목록(옛 코드는 값 없음)', () => passed(U.nbsp), [], true);
add('BOM 값 다음 빈 값', () => passed(U.bom, ''), [], true);

// ── Workflow-Verify·Incomplete 읽기 ──────────────────────────────────────

const verify = (...values: string[]) => impl.parseVerifyTrailerValues(values) ?? null;
for (const [value, expected] of [
  ['light', 'light'], ['LIGHT', 'light'], ['Light', 'light'], [' docs ', 'docs'], ['DOCS', 'docs'], ['unverified', 'unverified'], ['UNVERIFIED', 'unverified'], ['full', null], ['lights', null], ['light x', null],
  ['xlight', null], ['li ght', null], ['', null], ['   ', null], ['docs\r', 'docs'], [`${U.nbsp}light`, 'light'], [`${U.bom}docs`, 'docs'], [`docs${U.ls}`, 'docs'], [`unverified${U.ideo}`, 'unverified'],
  [`l${U.dotlessI}ght`, null], [`L${U.dottedI}GHT`, null], ['light\u0000', null], ['docs.', null], ['doc', null],
] as Array<[string, string | null]>) add(`검증 값 ${JSON.stringify(value)}`, () => verify(value), expected);
add('검증 값: 마지막 비지 않은 값', () => verify('light', ''), 'light');
add('검증 값: 앞의 빈 값', () => verify('', 'docs'), 'docs');
add('검증 값: 마지막이 모르는 값이면 앞의 값을 읽지 않는다', () => verify('light', 'full'), null);
add('검증 값: 마지막 값이 우선', () => verify('light', 'docs'), 'docs');
add('검증 값: 값이 없다', () => verify(), null);

const incomplete = (...values: string[]) => impl.parseIncompleteTrailerValues(values) ?? null;
for (const [value, expected] of [
  ['max_turns', 'max_turns'], ['MAX_TURNS', 'max_turns'], [' Max_Turns ', 'max_turns'], ['max_turn', null], ['max_turns2', null], ['max-turns', null], ['max turns', null], ['', null], [`${U.nbsp}max_turns`, 'max_turns'],
  ['max_turns\r', 'max_turns'], ['xmax_turns', null],
] as Array<[string, string | null]>) add(`미완 값 ${JSON.stringify(value)}`, () => incomplete(value), expected);
add('미완 값: 앞의 빈 값', () => incomplete('', 'max_turns'), 'max_turns');
add('미완 값: 마지막이 모르는 값', () => incomplete('max_turns', 'x'), null);

// ── 문서 체크포인트 경로 ─────────────────────────────────────────────────

for (const file of ['docs/a', 'docs/a.md', 'docs/a/b/c.json', 'docs/ ', 'docs/.', 'docs/..', 'docs//', 'docs/é', 'README.md', 'a.md', '..md', '.hidden.md', ' .md', 'é.md', '😀.md', 'a b.md', 'a\\b.md', 'a\nb.md', 'a\rb.md', `a${U.ls}b.md`, '.github/pull_request_template.md']) {
  add(`문서 경로 ${JSON.stringify(file)}`, () => impl.isDocCheckpointPath(file), true);
}
for (const file of [
  '', 'docs', 'docs/', 'Docs/a', 'DOCS/a', 'doc/a', 'xdocs/a', '/docs/a', './docs/a', 'docs\\a', 'a/docs/b', 'docs/\n', 'docs/\r', `docs/${U.ls}`, `docs/${U.ps}`, 'docs/a\nb', 'docs/a\rb', `docs/a${U.ls}`,
  '.md', 'a.MD', 'a.Md', 'a.mdx', 'a.md ', 'a.md/', 'a.md\n', 'a/b.md', './a.md', '/a.md', 'md', 'a.md.txt', 'amd',
  '.github/Pull_Request_Template.md', '.GitHub/pull_request_template.md', '.github/pull_request_template.mdx', '.github/pull_request_template.md/', 'x/.github/pull_request_template.md', '.github/pull_request_template.md\n',
  '.github', '.github/', '.github/other.md', 'github/pull_request_template.md', '.github//pull_request_template.md', 'pull_request_template.md.md/x',
]) {
  add(`문서가 아닌 경로 ${JSON.stringify(file)}`, () => impl.isDocCheckpointPath(file), file === 'pull_request_template.md.md/x' ? false : file === 'a.md\n' ? false : false);
}
add('루트 .md에는 슬래시가 없다', () => impl.isDocCheckpointPath('a/b.md'), false);
add('줄 끝 글자가 끼어도 [^/]+는 맞춘다', () => impl.isDocCheckpointPath('x\ny.md'), true);

// ── 커밋 전 트레일러 확인 ────────────────────────────────────────────────

const empty = (...entries: string[]) => impl.hasEmptyPassedTrailer(entries);
add('none 줄이 있다', () => empty('Workflow-Passed: none'), true);
for (const entry of ['workflow-passed: none', 'WORKFLOW-PASSED: NONE', 'Workflow-Passed:none', '  Workflow-Passed: none  ', 'Workflow-Passed:\tnone', 'Workflow-Passed: None\r', `${U.nbsp}Workflow-Passed: none`, `Wor${U.kelvin}flow-Passed: none`]) {
  add(`none 줄 ${JSON.stringify(entry)}`, () => empty(entry), true);
}
for (const entry of ['Workflow-Passed: test', 'Workflow-Passed:', 'Workflow-Passed: none x', 'Workflow-Passed: xnone', 'Workflow-Passed: no ne', 'Workflow-Passed: none,', 'Workflow-Passed: run, none', 'Workflow-Verify: none', 'Workflow-Passed none', 'Workflow Passed: none', 'x Workflow-Passed: none', 'Workflow-Passed-x: none', '', 'none']) {
  add(`none이 아닌 줄 ${JSON.stringify(entry)}`, () => empty(entry), false);
}
add('빈 목록', () => empty(), false);
add('none 줄이 첫 줄', () => empty('Workflow-Passed: none', 'Workflow-Passed: test'), true);
add('다른 줄 뒤의 none', () => empty('Workflow-Verify: light', 'Workflow-Passed: none'), true);
// 의도한 차이 ③: 하나라도 none이면 막는다(옛 코드는 첫 Workflow-Passed 줄만 봤다)
add('앞에 통과 단계가 있어도 뒤의 none이면 막는다', () => empty('Workflow-Passed: test', 'Workflow-Passed: none'), true, true);
add('앞의 빈 줄 다음의 none', () => empty('Workflow-Passed:', 'Workflow-Passed: none'), true, true);

const docs = (...entries: string[]) => impl.hasDocsVerifyTrailer(entries);
add('docs 줄이 있다', () => docs('Workflow-Verify: docs'), true);
for (const entry of ['workflow-verify: docs', 'WORKFLOW-VERIFY: DOCS', ' Workflow-Verify: docs ', 'Workflow-Verify: Docs\r', `${U.nbsp}Workflow-Verify: docs`]) {
  add(`docs 줄 ${JSON.stringify(entry)}`, () => docs(entry), true);
}
for (const entry of ['Workflow-Verify:docs', 'Workflow-Verify:  docs', 'Workflow-Verify: docs x', 'Workflow-Verify: xdocs', 'Workflow-Verify: doc', 'Workflow-Verify: light', 'Workflow-Verify: unverified', 'Workflow-Verify:', 'Workflow-Passed: docs', 'x Workflow-Verify: docs', 'Workflow-Verify: docs.', 'Workflow-Verify : docs', 'docs', '']) {
  add(`docs가 아닌 줄 ${JSON.stringify(entry)}`, () => docs(entry), false);
}
add('빈 목록은 예외가 없다', () => docs(), false);
add('docs 줄이 마지막이다', () => docs('Workflow-Passed: none', 'Workflow-Verify: docs'), true);
add('docs 줄 둘', () => docs('Workflow-Verify: docs', 'Workflow-Verify: docs'), true);
// 의도한 차이 ③: 마지막 Workflow-Verify 줄이 docs가 아니면 인정하지 않는다(옛 코드는 아무 줄이나 하나)
add('docs 뒤에 다른 검증 줄이 오면 예외가 아니다', () => docs('Workflow-Verify: docs', 'Workflow-Verify: unverified'), false, true);
add('docs 뒤에 빈 검증 줄이 오면 예외가 아니다', () => docs('Workflow-Verify: docs', 'Workflow-Verify:'), false, true);
add('켈빈 기호로 쓴 키의 docs는 예외가 아니다', () => docs(`Wor${U.kelvin}flow-Verify: docs`), false, true);
add('docs 뒤의 켈빈 키 줄은 마지막 검증 줄이다', () => docs('Workflow-Verify: docs', `Wor${U.kelvin}flow-Verify: light`), false, true);

// ── 단계 ─────────────────────────────────────────────────────────────────

const DEFAULTS = ['plan', 'implement', 'run', 'contract_check', 'review', 'checkpoint'];
add('선언이 없으면 기본 단계', () => impl.workflowStages(proj()), DEFAULTS);
add('workflow가 비어 있으면 기본 단계', () => impl.workflowStages(proj({})), DEFAULTS);
add('required는 그대로', () => impl.workflowStages(proj({ required: ['plan', 'review'] })), ['plan', 'review']);
add('required가 빈 배열이면 빈 단계', () => impl.workflowStages(proj({ required: [] })), []);
add('required가 있으면 선언한 확인을 끼우지 않는다', () => impl.workflowStages(proj({ required: ['run'], tests: [{ service: 'a' }] })), ['run']);
add('화면 확인은 contract_check 앞', () => impl.workflowStages(proj({ pageChecks: [{ service: 'a', path: '/' }] })), ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'review', 'checkpoint']);
add('테스트는 review 앞', () => impl.workflowStages(proj({ tests: [{ service: 'a' }] })), ['plan', 'implement', 'run', 'contract_check', 'test', 'review', 'checkpoint']);
add('동시 요청 확인은 review 앞', () => impl.workflowStages(proj({ concurrencyChecks: [{}] })), ['plan', 'implement', 'run', 'contract_check', 'concurrency_check', 'review', 'checkpoint']);
add('부하 확인은 review 앞', () => impl.workflowStages(proj({ loadChecks: [{}] })), ['plan', 'implement', 'run', 'contract_check', 'load_check', 'review', 'checkpoint']);
add('모두 선언하면 순서대로', () => impl.workflowStages(proj({ pageChecks: [{}], tests: [{}], concurrencyChecks: [{}], loadChecks: [{}] })), ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review', 'checkpoint']);
add('빈 선언 배열은 끼우지 않는다', () => impl.workflowStages(proj({ pageChecks: [], tests: [], concurrencyChecks: [], loadChecks: [] })), DEFAULTS);
add('배포 조건 기본값', () => impl.workflowReleaseRequirements(proj()), ['checkpoint']);
add('배포 조건 선언', () => impl.workflowReleaseRequirements(proj({ releaseRequires: ['test', 'review'] })), ['test', 'review']);
add('배포 조건이 빈 배열이면 그대로', () => impl.workflowReleaseRequirements(proj({ releaseRequires: [] })), []);

// ── 배포 막음 ────────────────────────────────────────────────────────────

const blockers = (workflow: Record<string, unknown> | undefined, passedStages: string[] | undefined, mode?: 'light' | 'docs' | 'unverified') => impl.releaseBlockers(proj(workflow), passedStages as never, mode);
add('기본 설정은 통과 기록 없이도 막지 않는다', () => blockers(undefined, undefined), []);
add('기본 설정에서 직접 수정 체크포인트는 checkpoint가 빠진다', () => blockers(undefined, undefined, 'unverified'), ['checkpoint']);
add('기본 설정에서 직접 수정이라도 통과 기록과 상관없다', () => blockers(undefined, ['run', 'review'], 'unverified'), ['checkpoint']);
add('workflow가 있어도 releaseRequires가 없으면 직접 수정은 막는다', () => blockers({ tests: [{}] }, ['test'], 'unverified'), ['checkpoint']);
for (const mode of ['light', 'docs'] as const) add(`기본 설정에서 ${mode}는 막지 않는다`, () => blockers(undefined, undefined, mode), []);
add('선언한 조건이 있으면 직접 수정도 조건대로만 본다', () => blockers({ releaseRequires: ['checkpoint'] }, undefined, 'unverified'), []);
add('선언한 조건: 통과한 단계는 빠지지 않는다', () => blockers({ releaseRequires: ['test', 'review'] }, ['test']), ['review']);
add('선언한 조건: 기록이 없으면 전부 빠진다', () => blockers({ releaseRequires: ['test', 'review'] }, undefined), ['test', 'review']);
add('선언한 조건: 빈 기록이면 전부 빠진다', () => blockers({ releaseRequires: ['test', 'review'] }, []), ['test', 'review']);
add('선언한 조건: 모두 통과', () => blockers({ releaseRequires: ['test', 'review'] }, ['review', 'test', 'run']), []);
add('선언한 조건에 checkpoint가 있어도 건너뛴다', () => blockers({ releaseRequires: ['checkpoint', 'test'] }, []), ['test']);
add('선언한 조건: 직접 수정 + 선언은 조건대로', () => blockers({ releaseRequires: ['test'] }, ['test'], 'unverified'), []);
add('선언한 조건: light 표시는 통과 기록을 지우지 않는다', () => blockers({ releaseRequires: ['test'] }, [], 'light'), ['test']);
add('조건이 빈 배열이면 직접 수정이라도 막지 않는다', () => blockers({ releaseRequires: [] }, [], 'unverified'), []);
add('단계 이름은 글자 그대로 견준다: 대소문자', () => blockers({ releaseRequires: ['test'] }, ['Test']), ['test']);
add('단계 이름은 글자 그대로 견준다: 덧붙임', () => blockers({ releaseRequires: ['test'] }, ['test ', 'tests', 'xtest']), ['test']);
add('단계 이름은 글자 그대로 견준다: 짝 없는 서로게이트', () => blockers({ releaseRequires: ['te\ud800st'] }, ['te\ud801st']), ['te\ud800st']);
add('단계 이름은 글자 그대로 견준다: U+FFFD', () => blockers({ releaseRequires: ['te\ud800st'] }, ['te\ufffdst']), ['te\ud800st']);
add('단계 이름은 글자 그대로 견준다: 같은 짝 없는 서로게이트', () => blockers({ releaseRequires: ['te\ud800st'] }, ['te\ud800st']), []);

const missing = (workflow: Record<string, unknown> | undefined, passedStages: string[]) => impl.missingVerificationStages(proj(workflow), new Set(passedStages as never[]));
add('기본 단계에서 통과 기록이 없으면 검증 단계가 빠진다', () => missing(undefined, []), ['run', 'contract_check', 'review']);
add('통과한 검증 단계는 빠지지 않는다', () => missing(undefined, ['run']), ['contract_check', 'review']);
add('모두 통과하면 빈 결과', () => missing(undefined, ['run', 'contract_check', 'review']), []);
add('plan·implement·checkpoint는 검증 단계가 아니다', () => missing({ required: ['plan', 'implement', 'checkpoint'] }, []), []);
add('required의 검증 단계', () => missing({ required: ['plan', 'test', 'load_check', 'checkpoint'] }, ['load_check']), ['test']);
add('선언한 테스트는 필수 단계다', () => missing({ tests: [{}] }, ['run', 'contract_check', 'review']), ['test']);
add('모르는 단계 이름은 검증 단계가 아니다', () => missing({ required: ['deploy', 'Test'] }, []), []);
add('통과 기록의 대소문자는 글자 그대로 본다', () => missing({ required: ['test'] }, ['Test']), ['test']);
add('통과 기록의 짝 없는 서로게이트도 글자 그대로 본다', () => missing({ required: ['test'] }, ['te\ud800st', '\ufffd']), ['test']);

// ── 보호 경로·턴 상한 ────────────────────────────────────────────────────

add('보호 경로와 평가 자산을 잇는다', () => impl.protectedPathsFor({ protectedPaths: ['.env'], evaluationAssets: ['tests'] } as never), ['.env', 'tests']);
add('보호 경로만', () => impl.protectedPathsFor({ protectedPaths: ['.env'] } as never), ['.env']);
add('평가 자산만', () => impl.protectedPathsFor({ evaluationAssets: ['tests'] } as never), ['tests']);
add('선언이 없으면 빈 목록', () => impl.protectedPathsFor(undefined), []);
add('workflow가 비어 있으면 빈 목록', () => impl.protectedPathsFor({} as never), []);
add('중복은 그대로', () => impl.protectedPathsFor({ protectedPaths: ['a'], evaluationAssets: ['a'] } as never), ['a', 'a']);
const turns = (override: number | undefined, configured?: number) => norm({ v: impl.maxTurnsFor(proj(configured === undefined ? {} : { maxTurns: configured }), override) ?? 'none' }).v;
add('턴 상한: 요청이 우선', () => turns(5, 10), 5);
add('턴 상한: 선언', () => turns(undefined, 10), 10);
add('턴 상한: 둘 다 없으면 undefined', () => turns(undefined), 'none');
add('턴 상한: 0도 값이다', () => turns(0, 10), 0);
add('턴 상한: workflow가 없어도', () => impl.maxTurnsFor(proj(), undefined) ?? 'none', 'none');
add('턴 상한: 요청만', () => impl.maxTurnsFor(proj(), 7), 7);
add('턴 상한: NaN도 값이다', () => String(impl.maxTurnsFor(proj({ maxTurns: 3 }), Number.NaN)), 'NaN');
add('턴 상한: -0', () => Object.is(impl.maxTurnsFor(proj({ maxTurns: 3 }), -0), -0), true);
add('턴 상한: Infinity', () => impl.maxTurnsFor(proj({ maxTurns: 3 }), Infinity), Infinity);

// ── 검토 ─────────────────────────────────────────────────────────────────

const svc = (name: string, path: string, template = 'nextjs', includes?: string[]) => ({ name, path, template, ...(includes ? { includes } : {}) });
const review = (workflow: Record<string, unknown> | undefined, files: string[], managed?: ReturnType<typeof svc>[]) => norm(impl.reviewChanges(proj(workflow, managed), files));
const warns = (workflow: Record<string, unknown> | undefined, files: string[], managed?: ReturnType<typeof svc>[]) => norm(impl.uncoveredChangeWarnings(proj(workflow, managed), files));
const check = (name: string, ok: boolean, detail?: string) => ({ stage: 'review', name, ok, attempts: 1, ...(detail === undefined ? {} : { detail }) });
const protectedDetail = (items: string[]) => `보호 경로가 바뀌었습니다. 되돌리거나 사람 승인 흐름으로 요청하세요: ${items.join(', ')}`;
const testGap = (name: string) => check(`coverage-gap: ${name} 테스트`, true, `${name}에 테스트 파일·설정이 새로 생겼지만 workflow.tests에 '${name}' 서비스를 다루는 항목이 없어 게이트의 test 단계가 돌리지 않았습니다. 돌려야 한다면 studio.yaml의 workflow.tests에 추가하세요.`);
const screenGap = (name: string, paths: string[]) => check(`coverage-gap: ${name} 화면`, true, `${name}에 화면 경로가 바뀌었지만(${paths.join(', ')}) workflow.pageChecks·autoPageChecks가 이 경로를 확인하지 않아 게이트가 열어 보지 않았습니다. studio.yaml에 pageChecks를 추가하거나 autoPageChecks를 켜세요.`);

add('바뀐 파일이 없으면 보호 경로 확인만 통과', () => review(undefined, []), [check('protected-paths', true)]);
add('보호 경로 규칙과 같은 파일', () => review({ protectedPaths: ['.env'] }, ['.env']), [check('protected-paths', false, protectedDetail(['.env (보호 경로 .env)']))]);
add('보호 폴더 아래의 파일', () => review({ protectedPaths: ['infra'] }, ['infra/main.tf']), [check('protected-paths', false, protectedDetail(['infra/main.tf (보호 경로 infra)']))]);
add('이름이 비슷한 폴더는 보호하지 않는다', () => review({ protectedPaths: ['infra'] }, ['infrastructure/x', 'src/infra/x', 'infr']), [check('protected-paths', true)]);
add('평가 자산도 보호한다', () => review({ evaluationAssets: ['tests'] }, ['tests/a.ts']), [check('protected-paths', false, protectedDetail(['tests/a.ts (보호 경로 tests)']))]);
add('보호 경로는 대소문자를 접어 넓게 막는다', () => review({ protectedPaths: ['STUDIO.YAML'] }, ['studio.yaml']), [check('protected-paths', false, protectedDetail(['studio.yaml (보호 경로 STUDIO.YAML)']))]);
add('규칙이 여럿이면 규칙 순서대로', () => review({ protectedPaths: ['b', 'a'] }, ['a/1', 'b/1', 'b/2']), [check('protected-paths', false, protectedDetail(['b/1 (보호 경로 b)', 'b/2 (보호 경로 b)', 'a/1 (보호 경로 a)']))]);
add('꼴을 맞출 수 없는 파일은 막는다', () => review({ protectedPaths: ['infra'] }, ['../x']), [check('protected-paths', false, protectedDetail(['../x (보호 경로 infra)']))]);
add('빈 규칙은 전부 막는다', () => review({ protectedPaths: [''] }, ['a']), [check('protected-paths', false, protectedDetail(['a (보호 경로 )']))]);
add('짝 없는 서로게이트가 든 파일과 규칙은 U+FFFD 꼴로 견준다', () => norm(impl.reviewChanges(proj({ protectedPaths: ['p\ud800'] }), ['p\ud801'])).map((c: { ok: boolean }) => c.ok), [false]);
add('변경 크기: 상한과 같으면 통과', () => review({ maxChangedFiles: 2 }, ['a', 'b']), [check('protected-paths', true), check('change-size', true)]);
add('변경 크기: 상한보다 하나 많으면 실패', () => review({ maxChangedFiles: 2 }, ['a', 'b', 'c']), [check('protected-paths', true), check('change-size', false, '한 요청에서 파일 3개를 바꿨습니다(상한 2). 필요 없는 변경을 되돌리세요')]);
add('변경 크기: 상한 1에 파일 하나', () => review({ maxChangedFiles: 1 }, ['a']), [check('protected-paths', true), check('change-size', true)]);
add('변경 크기: 상한을 적지 않으면 보지 않는다', () => review({}, ['a', 'b', 'c']), [check('protected-paths', true)]);
add('변경 크기와 보호 경로가 함께 실패', () => review({ maxChangedFiles: 1, protectedPaths: ['a'] }, ['a/1', 'b']), [check('protected-paths', false, protectedDetail(['a/1 (보호 경로 a)'])), check('change-size', false, '한 요청에서 파일 2개를 바꿨습니다(상한 1). 필요 없는 변경을 되돌리세요')]);

const web = svc('web', 'apps/web');
const api = svc('api', 'apps/api', 'spring-boot');
add('managed가 없으면 경고가 없다', () => warns({}, ['apps/web/a.test.ts']), []);
add('managed가 비어 있으면 경고가 없다', () => warns({}, ['apps/web/a.test.ts'], []), []);
add('테스트 파일이 새로 생기면 경고', () => warns({}, ['apps/web/lib/a.test.ts'], [web]), [testGap('web')]);
add('테스트를 다루는 서비스면 경고하지 않는다', () => warns({ tests: [{ service: 'web' }] }, ['apps/web/lib/a.test.ts'], [web]), []);
add('다른 서비스의 테스트 선언은 다루는 것이 아니다', () => warns({ tests: [{ service: 'api' }] }, ['apps/web/lib/a.test.ts'], [web]), [testGap('web')]);
add('서비스 이름은 글자 그대로 견준다', () => warns({ tests: [{ service: 'Web' }] }, ['apps/web/lib/a.test.ts'], [web]), [testGap('web')]);
add('서비스 이름 덧붙임도 다른 서비스다', () => warns({ tests: [{ service: 'web ' }] }, ['apps/web/lib/a.test.ts'], [web]), [testGap('web')]);
add('서비스 이름의 짝 없는 서로게이트는 글자 그대로 견준다', () => warns({ tests: [{ service: 'w\ud801' }] }, ['apps/w/a.test.ts'], [svc('w\ud800', 'apps/w', 'express')]).length, 1);
for (const file of ['a.test.ts', 'a.spec.tsx', 'a.test.js', 'a.spec.jsx', 'a.test.cjsx', 'a.test.mtsx', 'a.test.mts', 'a.test.cts', 'a.spec.mjs', 'a.spec.cjs', '.test.ts', 'vitest.config.ts', 'vitest.config.mts', 'jest.config.js', 'jest.config.cjs', 'playwright.config.ts', 'e2e/playwright.config.mjs', '__tests__/a.ts', 'src/__tests__/b/c.ts']) {
  add(`테스트로 보이는 파일 ${file}`, () => warns({}, [`apps/api/${file}`], [api]), [testGap('api')]);
}
for (const file of ['a.test.json', 'a.tests.ts', 'a.test.tsxx', 'a.test.ts.bak', 'atest.ts', 'a.test', 'a.Test.ts', 'xvitest.config.ts', 'vitest.config.json', 'vitest.config.tsx', 'vitest-config.ts', 'my-jest.config.js', 'a__tests__/b.ts', '__tests__', 'src/__test__/a.ts', 'src/main.ts']) {
  add(`테스트로 보이지 않는 파일 ${file}`, () => warns({}, [`apps/api/${file}`], [api]), []);
}
add('서비스 밖의 테스트 파일은 그 서비스의 경고가 아니다', () => warns({}, ['apps/other/a.test.ts', 'apps/webx/a.test.ts'], [web]), []);
add('서비스 폴더 경계는 슬래시다', () => warns({}, ['apps/webx/a.test.ts'], [web]), []);
add('includes로 소유한 폴더의 테스트 파일', () => warns({}, ['shared/a.test.ts'], [svc('web', 'apps/web', 'express', ['shared'])]), [testGap('web')]);
add('path가 .이면 모든 파일을 소유한다', () => warns({}, ['x/a.test.ts'], [svc('root', '.', 'express')]), [testGap('root')]);
add('화면 경로가 바뀌면 경고', () => warns({}, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
add('선언한 화면 경로와 정확히 같으면 경고하지 않는다', () => warns({ pageChecks: [{ service: 'web', path: '/shorts' }] }, ['apps/web/app/shorts/page.tsx'], [web]), []);
add('다른 경로를 선언하면 경고', () => warns({ pageChecks: [{ service: 'web', path: '/' }] }, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
for (const declared of ['/shorts/', '/Shorts', '/shorts ', 'shorts', '/shorts?x=1', '/short', '/shortss']) {
  add(`거의 같은 선언 경로 ${JSON.stringify(declared)}는 확인한 것이 아니다`, () => warns({ pageChecks: [{ service: 'web', path: declared }] }, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
}
add('다른 서비스의 화면 선언은 확인한 것이 아니다', () => warns({ pageChecks: [{ service: 'api', path: '/shorts' }] }, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
const manyPages = Array.from({ length: 12 }, (_, i) => `apps/web/app/p${String(i).padStart(2, '0')}/page.tsx`);
add('화면 경로는 자동 확인 상한(10)까지만 적는다', () => warns({}, manyPages, [web]), [screenGap('web', Array.from({ length: 10 }, (_, i) => `/p${String(i).padStart(2, '0')}`))]);
add('서비스 이름의 짝 없는 서로게이트는 표시에서 U+FFFD가 된다', () => warns({}, ['a/x.test.ts'], [svc('w\ud800', 'a')]), [testGap('w\ufffd')], true);
add('자동 화면 확인이 맡은 서비스는 보지 않는다', () => warns({ autoPageChecks: { service: 'web' } }, ['apps/web/app/shorts/page.tsx'], [web]), []);
add('자동 화면 확인이 다른 서비스를 맡으면 본다', () => warns({ autoPageChecks: { service: 'api' } }, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
add('자동 화면 확인의 서비스 이름은 글자 그대로 견준다', () => warns({ autoPageChecks: { service: 'Web' } }, ['apps/web/app/shorts/page.tsx'], [web]), [screenGap('web', ['/shorts'])]);
add('템플릿 이름이 nextjs와 같아야 화면을 본다', () => warns({}, ['apps/web/app/shorts/page.tsx'], [svc('web', 'apps/web', 'next'), svc('w2', 'apps/web', 'nextjs2'), svc('w3', 'apps/web', 'Nextjs')]), []);
add('nextjs가 아닌 서비스는 화면을 보지 않는다', () => warns({}, ['apps/api/app/shorts/page.tsx'], [api]), []);
add('경로가 여럿이면 정렬해 이어 적는다', () => warns({}, ['apps/web/app/shop/page.tsx', 'apps/web/app/page.tsx', 'apps/web/app/a/page.tsx'], [web]), [screenGap('web', ['/', '/a', '/shop'])]);
add('선언한 경로만 빼고 알린다', () => warns({ pageChecks: [{ service: 'web', path: '/a' }] }, ['apps/web/app/shop/page.tsx', 'apps/web/app/a/page.tsx'], [web]), [screenGap('web', ['/shop'])]);
add('테스트와 화면이 함께 바뀌면 둘 다 알린다', () => warns({}, ['apps/web/app/page.tsx', 'apps/web/a.test.ts'], [web]), [testGap('web'), screenGap('web', ['/'])]);
add('서비스가 둘이면 서비스마다', () => warns({}, ['apps/web/a.test.ts', 'apps/api/b.spec.ts'], [web, api]), [testGap('web'), testGap('api')]);
add('studio.yaml이 바뀌면 모든 서비스가 바뀐 것으로 본다', () => warns({}, ['studio.yaml', 'apps/api/b.spec.ts'], [web, api]), [testGap('api')]);
add('이름이 같은 서비스가 둘이면 첫 항목의 선언으로 본다', () => warns({}, ['apps/web/a.test.ts'], [web, svc('web', 'apps/other', 'express')]), [testGap('web'), testGap('web')]);
add('검토는 보호 경로·크기·경고를 이 순서로 모은다', () => review({ maxChangedFiles: 5, protectedPaths: ['.env'] }, ['.env', 'apps/web/a.test.ts'], [web]), [check('protected-paths', false, protectedDetail(['.env (보호 경로 .env)'])), check('change-size', true), testGap('web')]);

// ── 확인 요약 ────────────────────────────────────────────────────────────

const covered = (stage: string, name: string, ok: boolean, detail?: string) => ({ stage, name, ok, attempts: 1, ...(detail === undefined ? {} : { detail }) });
const coverage = (checks: ReturnType<typeof covered>[] | undefined) => impl.formatCheckedCoverage(checks as never);
add('확인이 없으면 빈 글', () => coverage(undefined), '');
add('빈 목록은 빈 글', () => coverage([]), '');
add('게이트가 확인한 것', () => coverage([covered('test', 'unit', true), covered('browser_check', 'home', false)]), '게이트가 확인함: [test] unit(통과), [browser_check] home(실패)');
add('네 단계만 확인으로 센다', () => coverage([covered('review', 'x', true), covered('run', 'y', true), covered('concurrency_check', 'c', true), covered('load_check', 'l', false)]), '게이트가 확인함: [concurrency_check] c(통과), [load_check] l(실패)');
add('틈은 detail을 쓰고 없으면 이름', () => coverage([covered('review', 'coverage-gap: a', true, '설명'), covered('review', 'coverage-gap: b', true)]), '확인 안 됨:\n- 설명\n- coverage-gap: b');
add('틈의 detail이 빈 글이어도 그대로', () => coverage([covered('review', 'coverage-gap: a', true, '')]), '확인 안 됨:\n- ');
add('틈 접두사는 콜론까지다', () => coverage([covered('review', 'coverage-gap', true, '설명')]), '');
add('틈 접두사는 대소문자를 구분한다', () => coverage([covered('review', 'Coverage-Gap: a', true, '설명')]), '');
add('확인 선언 변경', () => coverage([covered('review', 'declared-checks', true, '테스트 추가')]), '확인 선언 변경: 테스트 추가');
add('통과하지 못한 선언 변경은 적지 않는다', () => coverage([covered('review', 'declared-checks', false, '테스트 추가')]), '');
add('detail이 없는 선언 변경은 적지 않는다', () => coverage([covered('review', 'declared-checks', true)]), '');
add('detail이 빈 선언 변경은 적지 않는다', () => coverage([covered('review', 'declared-checks', true, '')]), '');
add('선언 변경 이름은 글자 그대로', () => coverage([covered('review', 'declared-checks2', true, 'x'), covered('review', 'Declared-Checks', true, 'x')]), '');
add('review 단계의 선언만 센다', () => coverage([covered('test', 'declared-checks', true, 'x')]), '게이트가 확인함: [test] declared-checks(통과)');
add('선언이 둘이면 첫 항목', () => coverage([covered('review', 'declared-checks', true, '첫째'), covered('review', 'declared-checks', true, '둘째')]), '확인 선언 변경: 첫째');
add('세 줄을 이 순서로 잇는다', () => coverage([covered('review', 'declared-checks', true, 'd'), covered('review', 'coverage-gap: a', true, 'g'), covered('test', 't', true)]), '게이트가 확인함: [test] t(통과)\n확인 안 됨:\n- g\n확인 선언 변경: d');

describe('워크플로 판정 벡터', () => {
  for (const vector of vectors) {
    it(`${vector.intended ? '[의도한 차이] ' : ''}${vector.name}`, () => {
      expect(norm(vector.run())).toEqual(norm(vector.expected));
    });
  }

  it('벡터 수', () => {
    expect(vectors.length).toBeGreaterThan(400);
    expect(vectors.filter((vector) => vector.intended).length).toBeGreaterThanOrEqual(15);
  });
});

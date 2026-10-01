import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentUsage } from './loop';
import type { ModelAsk } from './task-plan';
import {
  buildAllMustHavesPrefill,
  buildExtractionUserPrompt,
  buildMatrixCsv,
  buildMissingReferenceQuestion,
  buildReferencedFilePreview,
  buildReferencedFilesContext,
  buildRecommendationUserPrompt,
  buildRequirementWorkPrefill,
  buildTraceabilityMatrix,
  carryForwardRequirementRevision,
  computeRequirementHash,
  computeRequirementStatus,
  discardRevisionIfNeverSaved,
  extractImplementsTrailers,
  extractPathReferences,
  extractRequirementsHeuristically,
  findCheckpointMentions,
  findGateCheckMentions,
  findMentionedIds,
  isManualStepText,
  labelRecommendationSource,
  lintRequirement,
  mentionsRequirementId,
  mergeReextractedRequirements,
  MERGE_MATCH_THRESHOLD,
  requirementSimilarity,
  alignScenarioIds,
  missingReferencedFile,
  parseExtractionReply,
  requestRequirementsExtraction,
  parseRecommendationReply,
  parseRequirementsMarkdown,
  partitionManualSteps,
  RecommendationReplySchema,
  requestQuestionRecommendations,
  requirementContentDrifted,
  REQUIREMENTS_GUIDE_MAX_CHARS,
  RequirementsError,
  requirementConfidence,
  requirementIsReady,
  requirementsReadyBadge,
  requirementVerificationSource,
  reviseRequirementIfChanged,
  resolveReferencedFiles,
  scanTestFilesForOrphans,
  scanTestFilesForRequirementId,
  scanTestFilesForScenarioId,
  serializeRequirementsMarkdown,
  summarizeCoverage,
  summarizeJsonPreview,
  summarizeManualStepsForGuide,
  summarizeRequirementsForGuide,
  verifySpecQuote,
  type Requirement,
} from './requirements';

const noUsage: AgentUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
function scriptedAsk(text: string): ModelAsk {
  return async () => ({ text, usage: noUsage });
}

const sample: Requirement = {
  id: 'R1',
  title: '로그인 API',
  kind: 'api',
  acceptance: ['이메일·비밀번호로 로그인하면 토큰을 돌려준다', '잘못된 비밀번호면 401을 돌려준다'],
  priority: 'must',
};

describe('parseExtractionReply', () => {
  it('올바른 JSON 응답을 파싱한다', () => {
    const text = JSON.stringify({ requirements: [sample], questions: ['비밀번호 최소 길이는 몇 자인가요?'] });
    const reply = parseExtractionReply(text);
    expect(reply.requirements).toEqual([sample]);
    expect(reply.questions).toHaveLength(1);
  });

  it('코드 펜스로 감싼 JSON도 읽는다', () => {
    const text = '설명\n```json\n' + JSON.stringify({ requirements: [sample], questions: [] }) + '\n```';
    expect(parseExtractionReply(text).requirements).toEqual([sample]);
  });

  it('id가 중복되면 RequirementsError', () => {
    const text = JSON.stringify({ requirements: [sample, sample], questions: [] });
    expect(() => parseExtractionReply(text)).toThrow(RequirementsError);
  });

  it('질문이 5개를 넘으면 오류 대신 앞의 5개만 받는다(긴 추출 답을 형식 하나로 버리지 않는다)', () => {
    const text = JSON.stringify({ requirements: [sample], questions: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(parseExtractionReply(text).questions).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('JSON이 아니면 RequirementsError', () => {
    expect(() => parseExtractionReply('그냥 텍스트입니다')).toThrow(RequirementsError);
  });

  it('kind가 허용 값이 아니면 RequirementsError', () => {
    const text = JSON.stringify({ requirements: [{ ...sample, kind: 'backend' }], questions: [] });
    expect(() => parseExtractionReply(text)).toThrow(RequirementsError);
  });
});

describe('buildExtractionUserPrompt', () => {
  it('스펙 원문을 그대로 담는다', () => {
    expect(buildExtractionUserPrompt('  과제: 로그인을 만드세요  ')).toContain('과제: 로그인을 만드세요');
  });

  it('참조 파일 요약이 있으면 뒤에 붙인다', () => {
    const prompt = buildExtractionUserPrompt('스펙', '- seed/seed.json (120 bytes): posts 3개');
    expect(prompt).toContain('스펙');
    expect(prompt).toContain('[참조 파일 요약]');
    expect(prompt).toContain('seed/seed.json');
  });

  it('참조 파일 요약이 없으면 절을 붙이지 않는다', () => {
    expect(buildExtractionUserPrompt('스펙')).not.toContain('[참조 파일 요약]');
  });
});

describe('extractPathReferences', () => {
  it('디렉터리/파일.확장자와 파일.확장자만 있는 이름을 모두 찾는다', () => {
    const spec = '시드 데이터는 seed/seed.json에 있고, API 설명은 openapi.yaml과 docs/api.md, 스키마는 schema.sql을 보세요.';
    expect(extractPathReferences(spec)).toEqual(['seed/seed.json', 'openapi.yaml', 'docs/api.md', 'schema.sql']);
  });

  it('같은 경로가 여러 번 나와도 한 번만 담는다', () => {
    expect(extractPathReferences('seed/seed.json을 읽고 seed/seed.json 형식을 맞추세요')).toEqual(['seed/seed.json']);
  });

  it('URL 안의 경로는 참조 파일로 보지 않는다', () => {
    expect(extractPathReferences('명세는 https://example.com/spec.json 에 있습니다')).toEqual([]);
  });

  it('참조할 확장자가 없는 낱말은 찾지 않는다', () => {
    expect(extractPathReferences('로그인 API를 만드세요')).toEqual([]);
  });
});

describe('summarizeJsonPreview', () => {
  it('배열이면 길이를 담는다', () => {
    expect(summarizeJsonPreview(JSON.stringify([1, 2, 3]))).toBe('배열, 3개 항목');
  });

  it('객체면 키마다 배열 길이를 담아 요약한다', () => {
    const content = JSON.stringify({ posts: new Array(42).fill(0), comments: new Array(2076).fill(0), meta: { ok: true } });
    expect(summarizeJsonPreview(content)).toBe('posts 42개, comments 2,076개, meta');
  });

  it('JSON이 아니면 앞 몇 줄로 대신한다', () => {
    expect(summarizeJsonPreview('그냥 텍스트\n둘째 줄')).toBe('그냥 텍스트\n둘째 줄');
  });
});

describe('buildReferencedFilePreview / buildReferencedFilesContext', () => {
  it('JSON 파일은 요약을, 그 밖은 앞 줄을 미리보기로 담는다', () => {
    const json = buildReferencedFilePreview('seed/seed.json', JSON.stringify({ posts: [1, 2] }), 42);
    expect(json).toEqual({ path: 'seed/seed.json', exists: true, sizeBytes: 42, preview: 'posts 2개' });

    const md = buildReferencedFilePreview('docs/api.md', '# API\n설명', 10);
    expect(md.preview).toBe('# API\n설명');
  });

  it('없는 참조 파일은 missingReferencedFile로 만든다', () => {
    expect(missingReferencedFile('seed/seed.json')).toEqual({ path: 'seed/seed.json', exists: false });
  });

  it('없는 파일에는 참조 파일 질문을 만든다', () => {
    expect(buildMissingReferenceQuestion('seed/seed.json')).toContain('seed/seed.json');
  });

  it('전체 글자 수 상한을 넘으면 뒤는 자른다', () => {
    const files = Array.from({ length: 200 }, (_, index) => buildReferencedFilePreview(`docs/file-${index}.md`, '내용', 10));
    const context = buildReferencedFilesContext(files, 200);
    expect(context.length).toBeLessThanOrEqual(200);
    expect(context).toContain('docs/file-0.md');
  });

  it('상한을 넉넉히 주면 있음/없음 모두 담는다', () => {
    const context = buildReferencedFilesContext([buildReferencedFilePreview('seed/seed.json', '{}', 2), missingReferencedFile('docs/api.md')]);
    expect(context).toContain('seed/seed.json (2 bytes)');
    expect(context).toContain('docs/api.md: 파일 없음');
  });
});

describe('extractRequirementsHeuristically', () => {
  it('헤딩과 글머리 기호로 요구사항을 나눈다', () => {
    const spec = `# 과제\n\n## 로그인 API\n- 이메일로 로그인한다\n- 실패하면 401을 돌려준다\n\n## 목록 화면\n- 주문 목록을 보여주는 화면을 만든다\n`;
    const requirements = extractRequirementsHeuristically(spec);
    expect(requirements).toHaveLength(3); // "과제" 헤딩도 하나의 요구사항으로 잡힌다(인수 조건 없음)
    const login = requirements.find((requirement) => requirement.title === '로그인 API')!;
    expect(login.id).toBe('R2');
    expect(login.acceptance).toEqual(['이메일로 로그인한다', '실패하면 401을 돌려준다']);
    expect(login.kind).toBe('api');
    const screen = requirements.find((requirement) => requirement.title === '목록 화면')!;
    expect(screen.kind).toBe('ui');
  });

  it('번호 매긴 줄도 요구사항 제목으로 본다', () => {
    const spec = `1. 회원가입 API를 만든다\n2. 데이터베이스 스키마를 설계한다\n`;
    const requirements = extractRequirementsHeuristically(spec);
    expect(requirements.map((requirement) => requirement.title)).toEqual(['회원가입 API를 만든다', '데이터베이스 스키마를 설계한다']);
    expect(requirements[1]!.kind).toBe('data');
  });

  it('구조가 없는 평문은 문단 하나를 요구사항 하나로 본다', () => {
    const requirements = extractRequirementsHeuristically('간단한 계산기를 만드세요. 더하기와 빼기를 지원해야 합니다.');
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.id).toBe('R1');
  });

  it('"선택 사항"이 붙으면 우선순위를 could로 본다', () => {
    const spec = `## 다크 모드(선택 사항)\n- 다크 모드를 지원한다\n`;
    const requirements = extractRequirementsHeuristically(spec);
    expect(requirements[0]!.priority).toBe('could');
  });

  it('id는 R1부터 문서 순서대로 매긴다', () => {
    const spec = `## 첫째\n- a\n## 둘째\n- b\n## 셋째\n- c\n`;
    const requirements = extractRequirementsHeuristically(spec);
    expect(requirements.map((requirement) => requirement.id)).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('serializeRequirementsMarkdown / parseRequirementsMarkdown', () => {
  it('왕복하면 같은 요구사항을 돌려준다', () => {
    const requirements = [sample, { ...sample, id: 'R2', title: '목록 화면', kind: 'ui' as const, priority: 'should' as const }];
    const markdown = serializeRequirementsMarkdown(requirements, { R1: '검증됨' });
    expect(markdown).toContain('## R1. 로그인 API');
    expect(markdown).toContain('- 상태: 검증됨');
    expect(markdown).toContain('<!-- b-studio-requirements');
    const { requirements: parsed } = parseRequirementsMarkdown(markdown);
    expect(parsed).toEqual(requirements);
  });

  it('사람이 제목·인수 조건을 손으로 고쳐도 그 값을 그대로 읽는다', () => {
    const markdown = serializeRequirementsMarkdown([sample]);
    const edited = markdown.replace('로그인 API', '로그인 API(이메일)').replace('이메일·비밀번호로 로그인하면 토큰을 돌려준다', '이메일·비밀번호로 로그인하면 JWT를 돌려준다');
    const { requirements } = parseRequirementsMarkdown(edited);
    expect(requirements[0]!.title).toBe('로그인 API(이메일)');
    expect(requirements[0]!.acceptance[0]).toBe('이메일·비밀번호로 로그인하면 JWT를 돌려준다');
  });

  it('사람이 인수 조건을 하나 더 추가해도 읽는다', () => {
    const markdown = serializeRequirementsMarkdown([sample]);
    const edited = markdown.replace('  - 잘못된 비밀번호면 401을 돌려준다', '  - 잘못된 비밀번호면 401을 돌려준다\n  - 토큰은 24시간 뒤 만료된다');
    const { requirements } = parseRequirementsMarkdown(edited);
    expect(requirements[0]!.acceptance).toHaveLength(3);
  });

  it('마크다운 구조가 완전히 깨지면 JSON 블록으로 되돌아간다', () => {
    const markdown = serializeRequirementsMarkdown([sample]);
    const broken = `이 파일은 완전히 다시 쓰였습니다.\n\n${markdown.slice(markdown.indexOf('<!--'))}`;
    const { requirements } = parseRequirementsMarkdown(broken);
    expect(requirements).toEqual([sample]);
  });

  it('아무 구조도 JSON 블록도 없으면 빈 배열', () => {
    expect(parseRequirementsMarkdown('그냥 아무 텍스트').requirements).toEqual([]);
  });

  it('"## 가정" 절도 왕복한다', () => {
    const markdown = serializeRequirementsMarkdown([sample], {}, ['seed 데이터 기준 게시글 42건', '페이지네이션 필요']);
    expect(markdown).toContain('## 가정');
    expect(markdown).toContain('- seed 데이터 기준 게시글 42건');
    const { assumptions } = parseRequirementsMarkdown(markdown);
    expect(assumptions).toEqual(['seed 데이터 기준 게시글 42건', '페이지네이션 필요']);
  });

  it('가정이 없으면 "## 가정" 절 자체를 쓰지 않는다', () => {
    const markdown = serializeRequirementsMarkdown([sample]);
    expect(markdown).not.toContain('## 가정');
    expect(parseRequirementsMarkdown(markdown).assumptions).toEqual([]);
  });

  it('사람이 "## 가정" 절을 통째로 지우면 가정 없음으로 본다', () => {
    const markdown = serializeRequirementsMarkdown([sample], {}, ['지울 가정']);
    const withoutAssumptions = markdown.replace(/## 가정\n- 지울 가정\n\n/, '');
    expect(parseRequirementsMarkdown(withoutAssumptions).assumptions).toEqual([]);
  });

  it('이 기능 전에 저장된 옛 JSON 블록(배열 형식)도 읽는다', () => {
    const legacy = `# 요구사항\n\n## R1. 로그인 API\n\n<!-- b-studio-requirements\n${JSON.stringify([sample], null, 2)}\n-->\n`;
    const broken = `구조가 깨졌습니다.\n\n${legacy.slice(legacy.indexOf('<!--'))}`;
    const { requirements, assumptions } = parseRequirementsMarkdown(broken);
    expect(requirements).toEqual([sample]);
    expect(assumptions).toEqual([]);
  });
});

describe('evidence: mentions', () => {
  it('mentionsRequirementId는 독립 토큰만 맞는다고 본다', () => {
    expect(mentionsRequirementId('요청: [R3] 로그인 기능', 'R3')).toBe(true);
    expect(mentionsRequirementId('R3 테스트 통과', 'R3')).toBe(true);
    expect(mentionsRequirementId('R31 다른 요구사항', 'R3')).toBe(false);
    expect(mentionsRequirementId('로그인 기능', 'R3')).toBe(false);
  });

  it('findCheckpointMentions은 메시지에 id가 있는 체크포인트만 남긴다', () => {
    const checkpoints = [
      { sha: 'a', shortSha: 'a', message: '요청: [R3] 로그인 추가' },
      { sha: 'b', shortSha: 'b', message: '요청: 목록 화면' },
    ];
    expect(findCheckpointMentions(checkpoints, 'R3')).toHaveLength(1);
  });

  it('findGateCheckMentions은 이름에 id가 있는 확인만 남긴다', () => {
    const checks = [
      { name: 'R3 로그인 테스트', ok: true },
      { name: '목록 화면 테스트', ok: true },
    ];
    expect(findGateCheckMentions(checks, 'R3')).toHaveLength(1);
  });
});

describe('scanTestFilesForRequirementId', () => {
  it('Vitest/Jest it·test 이름에서 id를 찾는다', () => {
    const files = [{ path: 'src/login.test.ts', content: `it('R3 로그인 성공', () => {});\ntest('R4 로그아웃', () => {});` }];
    expect(scanTestFilesForRequirementId(files, 'R3')).toEqual([{ file: 'src/login.test.ts', name: 'R3 로그인 성공' }]);
  });

  it('JUnit @DisplayName에서 id를 찾는다', () => {
    const files = [{ path: 'src/test/LoginTest.java', content: `@DisplayName("R3 로그인 성공")\n@Test\nvoid login() {}` }];
    expect(scanTestFilesForRequirementId(files, 'R3')).toEqual([{ file: 'src/test/LoginTest.java', name: 'R3 로그인 성공' }]);
  });

  it('JUnit 메서드 이름에 id가 붙어 있으면 찾는다', () => {
    const files = [{ path: 'src/test/LoginTest.java', content: `@Test\nvoid testR3Login() {}` }];
    expect(scanTestFilesForRequirementId(files, 'R3')).toEqual([{ file: 'src/test/LoginTest.java', name: 'testR3Login' }]);
  });

  it('R31처럼 다른 id의 일부이면 R3로 잡지 않는다', () => {
    const files = [{ path: 'src/test/LoginTest.java', content: `@Test\nvoid testR31Login() {}` }];
    expect(scanTestFilesForRequirementId(files, 'R3')).toEqual([]);
  });

  it('테스트 파일이 아니면 무시한다', () => {
    const files = [{ path: 'src/login.ts', content: `it('R3 로그인', () => {});` }];
    expect(scanTestFilesForRequirementId(files, 'R3')).toEqual([]);
  });
});

describe('computeRequirementStatus', () => {
  it('증거가 없으면 미착수', () => {
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [] })).toBe('미착수');
  });

  it('체크포인트만 있으면 작업 중', () => {
    expect(computeRequirementStatus({ checkpoints: [{ sha: 'a', shortSha: 'a', message: 'R1' }], tests: [], gateChecks: [] })).toBe('작업 중');
  });

  it('테스트만 있어도 작업 중', () => {
    expect(computeRequirementStatus({ checkpoints: [], tests: [{ file: 'a.test.ts', name: 'R1' }], gateChecks: [] })).toBe('작업 중');
  });

  it('id가 붙은 게이트 확인이 모두 통과하면 검증됨', () => {
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [{ name: 'R1', ok: true }] })).toBe('검증됨');
  });

  it('id가 붙은 게이트 확인이 하나라도 실패하면 실패', () => {
    expect(
      computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [{ name: 'R1 a', ok: true }, { name: 'R1 b', ok: false }] }),
    ).toBe('실패');
  });

  it('게이트 확인이 없어도 테스트 탭 실행에서 통과한 테스트가 있으면 검증됨(버그 리포트: 테스트 탭 실행이 증거로 치지 않던 문제)', () => {
    const testRun = { at: '2026-01-01T09:17:00.000Z', sha: '57cb22c1', shortSha: '57cb22c', passed: 5, failed: 0 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [], testRun })).toBe('검증됨');
  });

  it('테스트 탭 실행에 실패한 테스트가 있으면 실패', () => {
    const testRun = { at: '2026-01-01T09:17:00.000Z', sha: '57cb22c1', shortSha: '57cb22c', passed: 3, failed: 1 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [], testRun })).toBe('실패');
  });

  it('게이트 확인과 테스트 탭 실행이 둘 다 있으면 게이트가 우선한다(기존 규칙 그대로)', () => {
    const testRun = { at: '2026-01-01T09:17:00.000Z', sha: '57cb22c1', shortSha: '57cb22c', passed: 5, failed: 0 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [{ name: 'R1', ok: false }], testRun })).toBe('실패');
  });
});

describe('requirementConfidence', () => {
  it('상태별로 신호등 점을 돌려준다', () => {
    expect(requirementConfidence('검증됨')).toBe('🟢');
    expect(requirementConfidence('작업 중')).toBe('🟡');
    expect(requirementConfidence('미착수')).toBe('🔴');
    expect(requirementConfidence('실패')).toBe('🔴');
  });
});

describe('summarizeCoverage', () => {
  it('전체·검증 수와 must 미검증을 센다', () => {
    const requirements: Requirement[] = [sample, { ...sample, id: 'R2', priority: 'should' }, { ...sample, id: 'R3', priority: 'must' }];
    const coverage = summarizeCoverage(requirements, { R1: '검증됨', R2: '검증됨', R3: '작업 중' });
    expect(coverage.text).toBe('3개 중 2개 검증됨');
    expect(coverage.mustTotal).toBe(2);
    expect(coverage.mustVerified).toBe(1);
    expect(coverage.mustGapText).toBe('필수(must) 요구사항 1개 미검증');
  });

  it('must가 모두 검증됐으면 mustGapText가 없다', () => {
    const coverage = summarizeCoverage([sample], { R1: '검증됨' });
    expect(coverage.mustGapText).toBeUndefined();
  });
});

describe('summarizeRequirementsForGuide', () => {
  it('must/should만 담고 could는 뺀다', () => {
    const requirements: Requirement[] = [sample, { ...sample, id: 'R2', priority: 'could', title: '보너스' }];
    const guide = summarizeRequirementsForGuide(requirements);
    expect(guide).toContain('R1');
    expect(guide).not.toContain('보너스');
  });

  it('상한을 넘지 않는다', () => {
    const requirements: Requirement[] = Array.from({ length: 200 }, (_, index) => ({
      ...sample,
      id: `R${index + 1}`,
      title: `요구사항 제목이 꽤 길게 반복되는 문장 ${index + 1}`,
    }));
    const guide = summarizeRequirementsForGuide(requirements);
    expect(guide.length).toBeLessThanOrEqual(REQUIREMENTS_GUIDE_MAX_CHARS);
    expect(guide).toContain('개 생략');
  });

  it('요구사항이 없으면 빈 문자열', () => {
    expect(summarizeRequirementsForGuide([])).toBe('');
  });
});

describe('prefill', () => {
  it('buildRequirementWorkPrefill은 id·제목·인수 조건·테스트 안내를 담는다', () => {
    const text = buildRequirementWorkPrefill(sample);
    expect(text).toContain('[R1] 로그인 API');
    expect(text).toContain('이메일·비밀번호로 로그인하면 토큰을 돌려준다');
    expect(text).toContain('테스트 이름에 R1을(를) 넣어');
  });

  it('buildAllMustHavesPrefill은 must만 나열한다', () => {
    const requirements: Requirement[] = [sample, { ...sample, id: 'R2', priority: 'could', title: '보너스' }];
    const text = buildAllMustHavesPrefill(requirements);
    expect(text).toContain('[R1] 로그인 API');
    expect(text).not.toContain('보너스');
  });
});

describe('resolveReferencedFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'requirements-references-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('작업 복사본에 있는 파일은 크기·미리보기를 담는다', async () => {
    await mkdir(path.join(root, 'seed'), { recursive: true });
    await writeFile(path.join(root, 'seed', 'seed.json'), JSON.stringify({ posts: [1, 2, 3] }));

    const files = await resolveReferencedFiles(root, '시드 데이터는 seed/seed.json에 있습니다');

    expect(files).toEqual([{ path: 'seed/seed.json', exists: true, sizeBytes: expect.any(Number), preview: 'posts 3개' }]);
  });

  it('없는 파일은 missing으로 담는다', async () => {
    const files = await resolveReferencedFiles(root, 'openapi.yaml을 참고하세요');
    expect(files).toEqual([{ path: 'openapi.yaml', exists: false }]);
  });

  it('node_modules 같은 생성물 경로는 Workspace가 거부하므로 없는 것으로 본다(내용을 읽지 않는다)', async () => {
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'seed.json'), '{"secret":true}');
    const files = await resolveReferencedFiles(root, 'node_modules/seed.json을 참고하세요');
    expect(files).toEqual([{ path: 'node_modules/seed.json', exists: false }]);
  });

  it('명세에 참조 파일이 없으면 빈 배열', async () => {
    expect(await resolveReferencedFiles(root, '로그인 API를 만드세요')).toEqual([]);
  });
});

describe('labelRecommendationSource', () => {
  it('웹 검색을 쓸 수 있으면 web, 아니면 model', () => {
    expect(labelRecommendationSource(true)).toBe('web');
    expect(labelRecommendationSource(false)).toBe('model');
  });
});

describe('parseRecommendationReply / RecommendationReplySchema', () => {
  it('추천 답 JSON을 파싱한다', () => {
    const text = JSON.stringify({
      recommendations: [{ question: '비밀번호 최소 길이는?', answer: '8자 이상', rationale: 'OWASP 권장', sources: [{ url: 'https://owasp.org', title: 'OWASP' }] }],
    });
    const reply = parseRecommendationReply(text);
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.recommendations[0]!.answer).toBe('8자 이상');
  });

  it('sources를 생략해도 빈 배열로 채운다(도구 없이 답할 때)', () => {
    const text = JSON.stringify({ recommendations: [{ question: 'q', answer: 'a', rationale: 'r' }] });
    expect(parseRecommendationReply(text).recommendations[0]!.sources).toEqual([]);
  });

  it('JSON이 아니면 RequirementsError', () => {
    expect(() => parseRecommendationReply('그냥 텍스트')).toThrow(RequirementsError);
  });

  it('recommendations가 비어 있으면 스키마 위반(적어도 하나는 있어야 한다)', () => {
    expect(RecommendationReplySchema.safeParse({ recommendations: [] }).success).toBe(false);
  });

  it('sources가 2개를 넘으면 스키마 위반', () => {
    const tooManySources = { recommendations: [{ question: 'q', answer: 'a', rationale: 'r', sources: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }] };
    expect(RecommendationReplySchema.safeParse(tooManySources).success).toBe(false);
  });
});

describe('requestQuestionRecommendations', () => {
  it('모델 응답을 파싱해 usage·durationMs와 함께 돌려준다', async () => {
    const text = JSON.stringify({ recommendations: [{ question: 'q', answer: 'a', rationale: 'r', sources: [] }] });
    const result = await requestQuestionRecommendations(scriptedAsk(text), ['q'], '스펙', false);
    expect(result.recommendations).toHaveLength(1);
    expect(result.usage).toEqual(noUsage);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('응답 형식이 틀리면 RequirementsError(usage·durationMs를 실어서)', async () => {
    await expect(requestQuestionRecommendations(scriptedAsk('그냥 텍스트'), ['q'], '스펙', false)).rejects.toThrow(RequirementsError);
  });
});

// ---------------------------------------------------------------------------
// ADR-090: EARS·시나리오·NFR·개정/재확인·재추출 병합·추적 매트릭스
// ---------------------------------------------------------------------------

const withEars: Requirement = {
  id: 'R1',
  title: '로그인 API',
  kind: 'api',
  priority: 'must',
  acceptance: ['이메일·비밀번호로 로그인하면 토큰을 돌려준다'],
  ears: { pattern: 'event', statement: '사용자가 로그인을 요청하면 시스템은 토큰을 발급해야 한다' },
  scenarios: [{ id: 'R1.1', given: '유효한 자격 증명이 주어지면', when: '로그인을 요청하면', then: '200과 토큰을 돌려준다' }],
};

describe('경계 안전 정규식(\\bR\\d+(\\.\\d+)?\\b)', () => {
  it('findMentionedIds는 R1과 R10을 서로 다른 토큰으로 본다', () => {
    expect(findMentionedIds('R1 그리고 R10을 함께 확인')).toEqual(['R1', 'R10']);
  });

  it('findMentionedIds는 시나리오 id(R4.1)를 통째로 하나의 토큰으로 잡는다', () => {
    expect(findMentionedIds('R4.1 시나리오 확인')).toEqual(['R4.1']);
  });

  it('mentionsRequirementId("R4")는 R4.1 언급도 R4를 가리킨 것으로 본다(시나리오는 상위 요구사항의 일부)', () => {
    expect(mentionsRequirementId('R4.1 테스트 통과', 'R4')).toBe(true);
  });

  it('mentionsRequirementId("R4")는 R41처럼 다른 id의 일부로는 걸리지 않는다', () => {
    expect(mentionsRequirementId('R41 테스트', 'R4')).toBe(false);
  });

  it('mentionsRequirementId("R4.1")는 정확히 그 시나리오만 가리킨다(R4 전체 언급으로는 걸리지 않는다)', () => {
    expect(mentionsRequirementId('R4 전체 완료', 'R4.1')).toBe(false);
    expect(mentionsRequirementId('R4.1 완료', 'R4.1')).toBe(true);
  });
});

describe('extractImplementsTrailers', () => {
  it('"Implements: R4" 트레일러를 찾는다', () => {
    expect(extractImplementsTrailers('feat: 로그인\n\nImplements: R4')).toEqual([{ id: 'R4' }]);
  });

  it('"Implements: R4.1@rev2"처럼 개정까지 있으면 함께 읽는다', () => {
    expect(extractImplementsTrailers('Implements: R4.1@rev2')).toEqual([{ id: 'R4.1', rev: 2 }]);
  });

  it('트레일러가 있으면 자유 언급보다 그것만 증거로 삼는다(findCheckpointMentions)', () => {
    const checkpoints = [
      { sha: 'a', shortSha: 'a', message: 'Implements: R4' },
      { sha: 'b', shortSha: 'b', message: 'R4 관련 이야기(트레일러 아님)' },
    ];
    expect(findCheckpointMentions(checkpoints, 'R4')).toEqual([checkpoints[0]]);
  });

  it('트레일러가 하나도 없으면 자유 언급으로 대신한다', () => {
    const checkpoints = [{ sha: 'a', shortSha: 'a', message: '[R4] 로그인' }];
    expect(findCheckpointMentions(checkpoints, 'R4')).toEqual(checkpoints);
  });
});

describe('computeRequirementHash / requirementContentDrifted / reviseRequirementIfChanged', () => {
  it('title·ears·scenarios·nfr이 같으면 같은 해시', () => {
    expect(computeRequirementHash(withEars)).toBe(computeRequirementHash({ ...withEars }));
  });

  it('acceptance만 달라도 해시는 그대로다(해시는 title+ears+scenarios+nfr만 본다)', () => {
    const differentAcceptance: Requirement = { ...withEars, acceptance: ['다른 인수 조건'] };
    expect(computeRequirementHash(withEars)).toBe(computeRequirementHash(differentAcceptance));
  });

  it('ears 문장이 달라지면 해시도 달라진다', () => {
    expect(computeRequirementHash(withEars)).not.toBe(computeRequirementHash({ ...withEars, ears: { ...withEars.ears!, statement: '다른 문장이어야 한다' } }));
  });

  it('hash가 기록돼 있지 않으면 드리프트 아님으로 본다(이 기능 이전 문서)', () => {
    expect(requirementContentDrifted(withEars)).toBe(false);
  });

  it('첫 저장은 rev 1로 채우고 드리프트로 보지 않는다 — revisedAt은 건드리지 않는다(비교할 이전 값이 없다, ADR-097)', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    expect(saved.rev).toBe(1);
    expect(saved.hash).toBe(computeRequirementHash(withEars));
    expect(saved.revisedAt).toBeUndefined();
  });

  it('내용이 안 바뀌면 다시 저장해도 rev·hash·revisedAt이 그대로다', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const resaved = reviseRequirementIfChanged({ ...saved }, '2026-02-01T00:00:00.000Z');
    expect(resaved).toEqual(saved);
  });

  it('title이 바뀌면(해시가 달라지면) rev가 오르고 revisedAt이 갱신된다', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    expect(requirementContentDrifted({ ...saved, title: '로그인 API(이메일)' })).toBe(true);
    const revised = reviseRequirementIfChanged({ ...saved, title: '로그인 API(이메일)' }, '2026-02-01T00:00:00.000Z');
    expect(revised.rev).toBe(2);
    expect(revised.revisedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(revised.hash).not.toBe(saved.hash);
  });
});

describe('carryForwardRequirementRevision', () => {
  it('이전 값의 rev·hash·revisedAt을 물려받는다(클라이언트가 안 보내도)', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const next = carryForwardRequirementRevision({ ...withEars, title: '로그인 API(이메일)' }, saved);
    expect(next.rev).toBe(saved.rev);
    expect(next.hash).toBe(saved.hash);
    expect(next.revisedAt).toBe(saved.revisedAt);
  });

  it('다음 값이 이미 rev·hash를 갖고 있으면 그 값을 존중한다', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const next = carryForwardRequirementRevision({ ...withEars, rev: 9, hash: 'own-hash' }, saved);
    expect(next.rev).toBe(9);
    expect(next.hash).toBe('own-hash');
  });

  it('이전 값이 없으면(새 요구사항) 그대로 돌려준다', () => {
    expect(carryForwardRequirementRevision(withEars, undefined)).toEqual(withEars);
  });
});

describe('discardRevisionIfNeverSaved — 첫 저장은 개정이 아니다(버그 리포트 33)', () => {
  it('저장된 적이 없는데(previouslySaved 없음) rev·hash·revisedAt을 들고 있으면(다른 세션에서 이어받은 추출 결과 등) 모두 버린다', () => {
    const inherited: Requirement = { ...withEars, rev: 5, hash: '다른-세션-해시', revisedAt: '2026-01-01T00:00:00.000Z' };
    const result = discardRevisionIfNeverSaved(inherited, undefined);
    expect(result.rev).toBeUndefined();
    expect(result.hash).toBeUndefined();
    expect(result.revisedAt).toBeUndefined();
    // 나머지 필드는 그대로다
    expect(result.title).toBe(withEars.title);
  });

  it('저장된 적이 있으면(previouslySaved 있음) 손대지 않는다', () => {
    const previouslySaved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const incoming: Requirement = { ...withEars, title: '로그인 API(이메일)', rev: 9, hash: 'own-hash' };
    expect(discardRevisionIfNeverSaved(incoming, previouslySaved)).toEqual(incoming);
  });

  it('이 함수가 앞단에 있으면, 저장된 적 없는 요구사항에 섞여 들어온 낡은 hash가 더는 개정을 올리지 않는다(실제 저장 파이프라인과 같은 순서)', () => {
    const inherited: Requirement = { ...withEars, rev: 3, hash: '다른-세션-해시', revisedAt: '2020-01-01T00:00:00.000Z' };
    const saved = reviseRequirementIfChanged(carryForwardRequirementRevision(discardRevisionIfNeverSaved(inherited, undefined), undefined), '2026-02-01T00:00:00.000Z');
    expect(saved.rev).toBe(1);
    expect(saved.revisedAt).toBeUndefined();
    expect(saved.hash).toBe(computeRequirementHash(withEars));
  });
});

describe('computeRequirementStatus — 재확인 필요(ADR-090)', () => {
  const emptyEvidence = { checkpoints: [], tests: [], gateChecks: [] };

  it('requirement를 안 주면(기존 호출) 예전 규칙 그대로다', () => {
    expect(computeRequirementStatus(emptyEvidence)).toBe('미착수');
    expect(computeRequirementStatus({ ...emptyEvidence, tests: [{ file: 'a.test.ts', name: 'R1' }] })).toBe('작업 중');
  });

  it('내용이 지금 드리프트돼 있으면(아직 저장 전) 증거와 무관하게 재확인 필요', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const drifted = { ...saved, title: '다른 제목' };
    const evidenceWithGate = { checkpoints: [], tests: [], gateChecks: [{ name: 'R1', ok: true }] };
    expect(computeRequirementStatus(evidenceWithGate, drifted)).toBe('재확인 필요');
  });

  it('개정이 오른 뒤 새 증거가 없으면 재확인 필요(첫 저장만으로는 재확인 필요가 되지 않는다 — 진짜 두 번째 저장이어야 한다)', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const staleCheckpoint = { sha: 'a', shortSha: 'a', message: 'R1', createdAt: '2026-01-01T00:00:00.000Z' };
    expect(computeRequirementStatus({ checkpoints: [staleCheckpoint], tests: [], gateChecks: [] }, revised)).toBe('재확인 필요');
  });

  it('개정이 오른 뒤(revisedAt) 그 시각보다 나중인 체크포인트가 있으면 평소 규칙으로 돌아간다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const freshCheckpoint = { sha: 'a', shortSha: 'a', message: 'R1', createdAt: '2026-03-01T00:00:00.000Z' };
    expect(computeRequirementStatus({ checkpoints: [freshCheckpoint], tests: [], gateChecks: [] }, revised)).toBe('작업 중');
  });

  it('개정이 오른 뒤라도 게이트 확인이 있으면(항상 최신 실행이라 본다) 재확인됐다고 본다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [{ name: 'R1', ok: true }] }, revised)).toBe('검증됨');
  });

  it('첫 저장 직후에는(비교할 이전 값이 없다) 저장 전에 생긴 체크포인트·테스트만으로도 재확인 필요가 되지 않는다(ADR-097)', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const staleCheckpoint = { sha: 'a', shortSha: 'a', message: 'R1', createdAt: '2026-01-01T00:00:00.000Z' };
    expect(computeRequirementStatus({ checkpoints: [staleCheckpoint], tests: [], gateChecks: [] }, firstSave)).toBe('작업 중');
  });

  it('개정이 오른 뒤 그 시각보다 나중인 테스트 탭 실행이 있으면 재확인됐다고 보고 통과 결과대로 검증됨을 매긴다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const freshTestRun = { at: '2026-03-01T00:00:00.000Z', sha: 'a', shortSha: 'a', passed: 2, failed: 0 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [], testRun: freshTestRun }, revised)).toBe('검증됨');
  });

  it('개정이 오른 뒤보다 먼저 돈(오래된) 테스트 탭 실행은 재확인 필요에 머문다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const staleTestRun = { at: '2026-01-10T00:00:00.000Z', sha: 'a', shortSha: 'a', passed: 2, failed: 0 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [], testRun: staleTestRun }, revised)).toBe('재확인 필요');
  });
});

describe('requirementConfidence — 재확인 필요', () => {
  it('재확인 필요는 작업 중과 같은 🟡로 표시한다', () => {
    expect(requirementConfidence('재확인 필요')).toBe('🟡');
  });
});

describe('computeRequirementStatus — 문서 확인·사람 확인(ADR-103)', () => {
  const emptyEvidence = { checkpoints: [], tests: [], gateChecks: [] };

  it('docEvidence가 모두 만족되면(satisfied) 검증됨', () => {
    const docEvidence = { matched: ['a', 'b'], missing: [], satisfied: true, sourceSummary: 'README.md(개요)' };
    expect(computeRequirementStatus({ ...emptyEvidence, docEvidence })).toBe('검증됨');
  });

  it('docEvidence가 일부만 매칭되면(만족 못 함) 작업 중 — 부풀리지 않는다', () => {
    const docEvidence = { matched: ['a'], missing: ['b'], satisfied: false };
    expect(computeRequirementStatus({ ...emptyEvidence, docEvidence })).toBe('작업 중');
  });

  it('docEvidence가 하나도 못 찾으면(matched 0) 미착수', () => {
    const docEvidence = { matched: [], missing: ['a', 'b'], satisfied: false };
    expect(computeRequirementStatus({ ...emptyEvidence, docEvidence })).toBe('미착수');
  });

  it('사람이 "직접 확인함"으로 남긴 기록이 있으면 검증됨', () => {
    const verified: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'c57d72f', note: '화면을 직접 눌러 확인했습니다' } };
    expect(computeRequirementStatus(emptyEvidence, verified)).toBe('검증됨');
  });

  it('실패한 게이트 확인은 사람 확인이 있어도 뒤집지 않는다(실패가 늘 이긴다)', () => {
    const verified: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'c57d72f', note: '확인함' } };
    const evidenceWithFailingGate = { checkpoints: [], tests: [], gateChecks: [{ name: 'R1', ok: false }] };
    expect(computeRequirementStatus(evidenceWithFailingGate, verified)).toBe('실패');
  });

  it('실패한 테스트 탭 실행도 사람 확인이 있어도 뒤집지 않는다', () => {
    const verified: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'c57d72f', note: '확인함' } };
    const testRun = { at: '2026-10-01T00:00:00.000Z', sha: 'c57d72f', shortSha: 'c57d72f', passed: 0, failed: 1 };
    expect(computeRequirementStatus({ checkpoints: [], tests: [], gateChecks: [], testRun }, verified)).toBe('실패');
  });

  it('개정이 오른 뒤(revisedAt) 사람 확인이 그 전 날짜면 재확인 필요에 머문다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const staleManual = { ...revised, manualVerification: { by: '범수', at: '2026-01-10', sha: 'a', note: '예전에 확인함' } };
    expect(computeRequirementStatus(emptyEvidence, staleManual)).toBe('재확인 필요');
  });

  it('개정이 오른 뒤라도 그 뒤 날짜의 사람 확인이면 재확인됐다고 본다', () => {
    const firstSave = reviseRequirementIfChanged(withEars, '2026-01-15T00:00:00.000Z');
    const revised = reviseRequirementIfChanged({ ...firstSave, title: '다른 제목' }, '2026-02-01T00:00:00.000Z');
    const freshManual = { ...revised, manualVerification: { by: '범수', at: '2026-03-01', sha: 'a', note: '다시 확인함' } };
    expect(computeRequirementStatus(emptyEvidence, freshManual)).toBe('검증됨');
  });
});

describe('requirementVerificationSource — 근거 종류 구분(ADR-103)', () => {
  const emptyEvidence = { checkpoints: [], tests: [], gateChecks: [] };

  it('검증됨이 아니면 none', () => {
    expect(requirementVerificationSource(emptyEvidence)).toBe('none');
  });

  it('게이트 확인이 통과면 test', () => {
    expect(requirementVerificationSource({ ...emptyEvidence, gateChecks: [{ name: 'R1', ok: true }] })).toBe('test');
  });

  it('문서 확인만 만족되면 docs', () => {
    const docEvidence = { matched: ['a'], missing: [], satisfied: true };
    expect(requirementVerificationSource({ ...emptyEvidence, docEvidence })).toBe('docs');
  });

  it('사람 확인만 있으면 manual', () => {
    const verified: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: '확인함' } };
    expect(requirementVerificationSource(emptyEvidence, verified)).toBe('manual');
  });

  it('문서 확인과 사람 확인이 둘 다 있으면 문서 확인(자동)을 우선한다', () => {
    const docEvidence = { matched: ['a'], missing: [], satisfied: true };
    const verified: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: '확인함' } };
    expect(requirementVerificationSource({ ...emptyEvidence, docEvidence }, verified)).toBe('docs');
  });
});

describe('lintRequirement / requirementIsReady / requirementsReadyBadge', () => {
  it('한국어 약한 표현을 찾는다', () => {
    const warnings = lintRequirement({ ...withEars, title: '빠르게 로그인하는 API' });
    expect(warnings.some((warning) => warning.code === 'weak-word')).toBe(true);
  });

  it('영어 약한 표현도 찾는다', () => {
    const warnings = lintRequirement({ ...withEars, ears: { pattern: 'event', statement: '사용자가 요청하면 시스템은 user-friendly 화면을 보여줘야 한다' } });
    expect(warnings.some((warning) => warning.code === 'weak-word')).toBe(true);
  });

  it('시나리오가 없으면 no-scenario 경고', () => {
    const warnings = lintRequirement({ ...withEars, scenarios: undefined });
    expect(warnings.some((warning) => warning.code === 'no-scenario')).toBe(true);
  });

  it('nonfunctional인데 NFR이 없으면 nfr-missing 경고', () => {
    const warnings = lintRequirement({ ...withEars, kind: 'nonfunctional' });
    expect(warnings.some((warning) => warning.code === 'nfr-missing')).toBe(true);
  });

  it('nonfunctional이고 NFR이 있으면 nfr-missing 경고가 없다', () => {
    const withNfr: Requirement = { ...withEars, kind: 'nonfunctional', nfr: { metric: '응답 시간', threshold: '300ms 이하', condition: 'p95, 동시 요청 50건', method: 'k6 부하 테스트' } };
    expect(lintRequirement(withNfr).some((warning) => warning.code === 'nfr-missing')).toBe(false);
  });

  it('한 EARS 문장에 "해야 한다"가 여럿이면 multiple-must-statements 경고', () => {
    const warnings = lintRequirement({ ...withEars, ears: { pattern: 'event', statement: '로그인하면 토큰을 발급해야 한다 그리고 로그도 기록해야 한다' } });
    expect(warnings.some((warning) => warning.code === 'multiple-must-statements')).toBe(true);
  });

  it('흠이 없으면 Ready', () => {
    expect(requirementIsReady(withEars)).toBe(true);
    expect(requirementsReadyBadge([withEars])).toBe(true);
  });

  it('must 요구사항 하나라도 Ready가 아니면 배지가 꺼진다', () => {
    const notReady: Requirement = { ...withEars, id: 'R2', scenarios: undefined };
    expect(requirementsReadyBadge([withEars, notReady])).toBe(false);
  });

  it('must 요구사항이 하나도 없으면 배지가 꺼진다(should/could만으로는 Ready를 매기지 않는다)', () => {
    expect(requirementsReadyBadge([{ ...withEars, priority: 'should' }])).toBe(false);
  });
});

describe('마크다운 왕복 — 새 필드(rev·EARS·시나리오·NFR·trace·hash·revisedAt)', () => {
  it('EARS·시나리오·NFR·trace가 있는 요구사항을 왕복한다', () => {
    const requirement: Requirement = {
      ...reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z'),
      nfr: undefined,
      trace: { issue: 12, dependsOn: ['R2', 'R3'], supersedes: 'R9' },
    };
    const markdown = serializeRequirementsMarkdown([requirement], { R1: '검증됨' });
    expect(markdown).toContain('개정: 1');
    expect(markdown).toContain('EARS(event):');
    expect(markdown).toContain('R1.1: (Given)');
    expect(markdown).toContain('추적: 이슈 #12 · 의존 R2, R3 · 대체 R9');
    const { requirements } = parseRequirementsMarkdown(markdown);
    expect(requirements).toEqual([requirement]);
  });

  it('NFR이 있는 요구사항을 왕복한다', () => {
    const requirement: Requirement = {
      ...withEars,
      kind: 'nonfunctional',
      nfr: { metric: '응답 시간', threshold: '300ms 이하', condition: 'p95, 동시 요청 50건', method: 'k6 부하 테스트' },
    };
    const markdown = serializeRequirementsMarkdown([requirement]);
    expect(markdown).toContain('NFR: 지표 응답 시간 · 임계값 300ms 이하');
    const { requirements } = parseRequirementsMarkdown(markdown);
    expect(requirements[0]!.nfr).toEqual(requirement.nfr);
  });

  it('옛 형식(rev·EARS 등이 전혀 없는 문서)도 그대로 읽는다', () => {
    const markdown = serializeRequirementsMarkdown([sample], { R1: '검증됨' });
    expect(markdown).not.toContain('개정:');
    expect(markdown).not.toContain('EARS(');
    const { requirements } = parseRequirementsMarkdown(markdown);
    expect(requirements).toEqual([sample]);
  });

  it('"## 사람이 할 일" 절도 왕복한다', () => {
    const markdown = serializeRequirementsMarkdown([sample], {}, [], ['private 저장소를 만들고 협업자를 추가한다']);
    expect(markdown).toContain('## 사람이 할 일 (에이전트 금지)');
    const { manualSteps } = parseRequirementsMarkdown(markdown);
    expect(manualSteps).toEqual(['private 저장소를 만들고 협업자를 추가한다']);
  });

  it('사람이 몸통에서 title을 고쳐도 hash·rev·revisedAt은 JSON 블록 값을 그대로 지킨다(몸통에 없는 필드라서)', () => {
    const saved = reviseRequirementIfChanged(withEars, '2026-01-01T00:00:00.000Z');
    const markdown = serializeRequirementsMarkdown([saved]);
    const edited = markdown.replace('로그인 API', '로그인 API(이메일)');
    const { requirements } = parseRequirementsMarkdown(edited);
    expect(requirements[0]!.title).toBe('로그인 API(이메일)');
    expect(requirements[0]!.hash).toBe(saved.hash);
    expect(requirements[0]!.rev).toBe(saved.rev);
  });

  it('사람 확인(manualVerification)을 몸통 줄("- 확인: …")로 왕복한다(ADR-103)', () => {
    const requirement: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'c57d72f', note: '디자인 시안과 화면을 눈으로 맞춰 봤습니다' } };
    const markdown = serializeRequirementsMarkdown([requirement]);
    expect(markdown).toContain('- 확인: 범수 · 2026-10-01 · 체크포인트 c57d72f · 메모 디자인 시안과 화면을 눈으로 맞춰 봤습니다');
    const { requirements } = parseRequirementsMarkdown(markdown);
    expect(requirements).toEqual([requirement]);
  });

  it('사람 확인이 없으면 "- 확인:" 줄 자체를 쓰지 않는다', () => {
    const markdown = serializeRequirementsMarkdown([sample]);
    expect(markdown).not.toContain('- 확인:');
  });

  it('구조가 깨져도 사람 확인은 JSON 블록에서 되돌아온다', () => {
    const requirement: Requirement = { ...sample, manualVerification: { by: '범수', at: '2026-10-01', sha: 'c57d72f', note: '확인함' } };
    const markdown = serializeRequirementsMarkdown([requirement]);
    const broken = `완전히 다시 쓰였습니다.\n\n${markdown.slice(markdown.indexOf('<!--'))}`;
    const { requirements } = parseRequirementsMarkdown(broken);
    expect(requirements).toEqual([requirement]);
  });
});

describe('carryForwardRequirementRevision — 사람 확인(manualVerification)', () => {
  it('다음 값이 manualVerification을 안 보내면 이전 값을 물려받는다(편집 화면이 이 필드를 모를 때 조용히 지워지지 않는다)', () => {
    const saved: Requirement = { ...withEars, manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: '확인함' } };
    const next = carryForwardRequirementRevision({ ...withEars, title: '로그인 API(이메일)' }, saved);
    expect(next.manualVerification).toEqual(saved.manualVerification);
  });

  it('다음 값이 이미 manualVerification을 갖고 있으면 그 값을 존중한다', () => {
    const saved: Requirement = { ...withEars, manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: '확인함' } };
    const newer = { by: '다른사람', at: '2026-11-01', sha: 'b', note: '다시 확인함' };
    const next = carryForwardRequirementRevision({ ...withEars, manualVerification: newer }, saved);
    expect(next.manualVerification).toEqual(newer);
  });
});

describe('재추출 병합(mergeReextractedRequirements) — id 안정성·diff', () => {
  it('같은 입력을 두 번 병합하면 id가 하나도 안 바뀐다', () => {
    const first = mergeReextractedRequirements([withEars], []);
    expect(first.diff.map((entry) => entry.status)).toEqual(['added']);
    const second = mergeReextractedRequirements([{ ...withEars, id: 'R1' }], first.merged);
    expect(second.diff.map((entry) => entry.status)).toEqual(['unchanged']);
    expect(second.merged.map((requirement) => requirement.id)).toEqual(first.merged.map((requirement) => requirement.id));
  });

  it('제목·EARS 문장이 비슷하면(모델이 다시 매긴 id가 달라도) 같은 요구사항으로 보고 기존 id를 지킨다', () => {
    const first = mergeReextractedRequirements([withEars], []);
    const reExtracted: Requirement = { ...withEars, id: 'R7', acceptance: ['조금 다르게 쓴 인수 조건'] };
    const second = mergeReextractedRequirements([reExtracted], first.merged);
    expect(second.merged.map((requirement) => requirement.id)).toEqual(['R1']);
    expect(second.diff[0]!.status).toBe('unchanged');
  });

  it('제목·EARS 문장이 실제로 바뀌면 changed로 표시하고 개정을 올린다', () => {
    const first = mergeReextractedRequirements([withEars], []);
    const changed: Requirement = {
      ...withEars,
      id: 'R9',
      title: '로그인 API',
      ears: { pattern: 'event', statement: '사용자가 로그인을 요청하면 시스템은 토큰과 만료 시각을 함께 발급해야 한다' },
    };
    const second = mergeReextractedRequirements([changed], first.merged);
    const entry = second.diff.find((candidate) => candidate.id === 'R1')!;
    expect(entry.status).toBe('changed');
    expect(entry.requirement.rev).toBe(2);
  });

  it('완전히 새 요구사항은 added로, 새 id는 기존 최대 번호 다음부터 매긴다(재사용하지 않는다)', () => {
    const existing = [withEars, { ...withEars, id: 'R5', title: '전혀 다른 요구사항(목록 화면)', ears: { pattern: 'ubiquitous' as const, statement: '시스템은 항상 목록을 보여줘야 한다' } }];
    const incoming: Requirement = { ...withEars, id: 'R1', title: '완전히 새로운 셋째 요구사항', ears: { pattern: 'ubiquitous', statement: '시스템은 항상 완전히 새로운 것을 해야 한다' } };
    const { merged, diff } = mergeReextractedRequirements([withEars, existing[1]!, incoming], existing);
    expect(diff.find((entry) => entry.requirement.title === '완전히 새로운 셋째 요구사항')!.id).toBe('R6');
    expect(merged.map((requirement) => requirement.id)).toEqual(['R1', 'R5', 'R6']);
  });

  it('명세에서 사라진 요구사항은 목록에 그대로 남고(id를 지키고) removed로 표시된다', () => {
    const first = mergeReextractedRequirements([withEars], []);
    const second = mergeReextractedRequirements([], first.merged);
    expect(second.merged).toEqual(first.merged);
    expect(second.diff).toEqual([{ status: 'removed', id: 'R1', requirement: first.merged[0], previous: first.merged[0] }]);
  });
});

describe('scanTestFilesForScenarioId / scanTestFilesForOrphans', () => {
  it('시나리오 id를 정확히 언급하는 테스트만 찾는다(R4 전체 언급은 걸리지 않는다)', () => {
    const files = [{ path: 'src/login.test.ts', content: `it('R1.1 로그인 성공', () => {}); it('R1 전체', () => {});` }];
    expect(scanTestFilesForScenarioId(files, 'R1.1')).toEqual([{ file: 'src/login.test.ts', name: 'R1.1 로그인 성공' }]);
  });

  it('어느 id도 언급하지 않은 테스트를 주인 없는 테스트로 찾는다', () => {
    const files = [{ path: 'src/misc.test.ts', content: `it('아무 관련 없는 테스트', () => {}); it('R2 관련', () => {});` }];
    expect(scanTestFilesForOrphans(files)).toEqual([{ file: 'src/misc.test.ts', name: '아무 관련 없는 테스트' }]);
  });
});

describe('buildTraceabilityMatrix / buildMatrixCsv', () => {
  it('요구사항·시나리오마다 행을 만들고 역방향 목록을 함께 돌려준다', () => {
    const testFiles = [{ path: 'src/login.test.ts', content: `it('R1.1 로그인 성공', () => {}); it('주인 없음', () => {});` }];
    const matrix = buildTraceabilityMatrix({ requirements: [withEars], checkpoints: [], testFiles, gateChecks: [] });
    expect(matrix.rows.map((row) => row.id)).toEqual(['R1', 'R1.1']);
    expect(matrix.rows[1]!.parentId).toBe('R1');
    expect(matrix.rows[1]!.tests).toHaveLength(1);
    expect(matrix.orphanTests).toEqual([{ file: 'src/login.test.ts', name: '주인 없음' }]);
    expect(matrix.mustHavesWithoutTests).toEqual([]);
  });

  it('테스트가 하나도 없는 필수 요구사항을 찾는다', () => {
    const matrix = buildTraceabilityMatrix({ requirements: [withEars], checkpoints: [], testFiles: [], gateChecks: [] });
    expect(matrix.mustHavesWithoutTests.map((requirement) => requirement.id)).toEqual(['R1']);
  });

  it('CSV로 내보낸다(헤더 + 행)', () => {
    const matrix = buildTraceabilityMatrix({ requirements: [withEars], checkpoints: [], testFiles: [], gateChecks: [] });
    const csv = buildMatrixCsv(matrix);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('종류,id,상위 id,제목,개정,우선순위,이슈,커밋,테스트,게이트,상태');
    expect(lines).toHaveLength(1 + matrix.rows.length);
    expect(lines[1]).toContain('요구사항,R1');
  });
});

describe('isManualStepText / partitionManualSteps — 사람이 할 일 가드(ADR-090)', () => {
  it('앱 기능으로 흔한 표현은 저장소 맥락이 없으면 요구사항으로 남긴다', () => {
    expect(isManualStepText('결제 webhook을 받아 주문 상태를 바꾸는 API')).toBe(false);
    expect(isManualStepText('관리자는 사용자 권한을 변경할 수 있다')).toBe(false);
    expect(isManualStepText('팀원을 이메일로 초대하는 기능')).toBe(false);
    expect(isManualStepText('게시글의 공개 범위를 전체·친구·비공개로 설정한다')).toBe(false);
    expect(isManualStepText('API 키 같은 secret은 환경 변수로 읽는다')).toBe(false);
  });

  it('같은 표현이라도 저장소·계정 맥락과 함께면 사람이 할 일로 본다', () => {
    expect(isManualStepText('GitHub 저장소에 배포 webhook을 등록한다')).toBe(true);
    expect(isManualStepText('레포를 private으로 바꾼다')).toBe(true);
    expect(isManualStepText('저장소에 팀원을 초대한다')).toBe(true);
    expect(isManualStepText('APRCORPORATION을 collaborator로 추가한다')).toBe(true);
  });

  it('실제 제출 절차 예시를 사람이 할 일로 잡는다', () => {
    expect(isManualStepText('제출 방법: private 저장소 생성, APRCORPORATION을 collaborator로 추가, PR 병합, 메일로 제출')).toBe(true);
  });

  it('평범한 요구사항 문장은 걸리지 않는다', () => {
    expect(isManualStepText('이메일·비밀번호로 로그인하면 토큰을 돌려준다')).toBe(false);
  });

  it('partitionManualSteps는 사람이 할 일로 보이는 요구사항을 걷어내 manualSteps로 옮긴다', () => {
    const manualStepRequirement: Requirement = {
      id: 'R1',
      title: 'private 저장소 생성, APRCORPORATION을 collaborator로 추가, PR 병합, 메일로 제출',
      kind: 'docs',
      priority: 'must',
      acceptance: ['위 절차대로 제출한다'],
    };
    const normal: Requirement = { ...withEars, id: 'R2' };
    const { requirements, manualSteps } = partitionManualSteps([manualStepRequirement, normal]);
    expect(requirements).toEqual([normal]);
    expect(manualSteps).toHaveLength(1);
    expect(manualSteps[0]).toContain('collaborator');
  });

  it('모델이 이미 manualSteps에 낸 항목은 그대로 유지하면서(중복 없이) 이어 붙인다', () => {
    const { manualSteps } = partitionManualSteps([{ ...withEars, id: 'R2' }], ['기존 사람이 할 일']);
    expect(manualSteps).toEqual(['기존 사람이 할 일']);
  });
});

describe('summarizeManualStepsForGuide', () => {
  it('비어 있으면 빈 문자열', () => {
    expect(summarizeManualStepsForGuide([])).toBe('');
  });

  it('에이전트에게 절대 하지 말라고 못박는 안내를 만든다', () => {
    const guide = summarizeManualStepsForGuide(['private 저장소 생성']);
    expect(guide).toContain('절대 하지 않는다');
    expect(guide).toContain('private 저장소 생성');
  });
});

describe('추천 스펙 우선(ADR-090): specQuote 검증·basis', () => {
  it('basis가 spec인데 specQuote가 실제 스펙에 없으면 practice로 강등한다', () => {
    const specText = '응답은 { "content": "..." } 형태를 그대로 지켜주세요.';
    const text = JSON.stringify({
      recommendations: [{ question: '필드 이름은?', answer: 'excerpt', rationale: '업계 관례', basis: 'spec', specQuote: '응답은 excerpt 필드를 쓴다' }],
    });
    const reply = parseRecommendationReply(text, specText);
    expect(reply.recommendations[0]!.basis).toBe('practice');
    expect(reply.recommendations[0]!.specQuote).toBeUndefined();
  });

  it('specQuote가 공백 차이만 있어도(정규화 후 일치) 스펙 인용으로 인정한다', () => {
    const specText = '응답은\n  content   필드를 쓴다.';
    const text = JSON.stringify({
      recommendations: [{ question: '필드 이름은?', answer: 'content', rationale: '명세 그대로', basis: 'spec', specQuote: '응답은 content 필드를 쓴다' }],
    });
    const reply = parseRecommendationReply(text, specText);
    expect(reply.recommendations[0]!.basis).toBe('spec');
    expect(reply.recommendations[0]!.specQuote).toBe('응답은 content 필드를 쓴다');
  });

  it('specText를 안 주면(과거 호출 호환) 검증 없이 그대로 파싱한다', () => {
    const text = JSON.stringify({ recommendations: [{ question: 'q', answer: 'a', rationale: 'r', basis: 'spec', specQuote: '스펙에 없는 문장' }] });
    expect(parseRecommendationReply(text).recommendations[0]!.basis).toBe('spec');
  });

  it('basis가 없거나 이상한 값이면 practice로 기본값을 채운다', () => {
    const text = JSON.stringify({ recommendations: [{ question: 'q', answer: 'a', rationale: 'r' }] });
    expect(parseRecommendationReply(text).recommendations[0]!.basis).toBe('practice');
  });

  it('verifySpecQuote는 공백을 정규화해 부분 문자열로 비교한다', () => {
    expect(verifySpecQuote('a  b', 'x a b y')).toBe(true);
    expect(verifySpecQuote('없는 문장', 'x a b y')).toBe(false);
  });
});

describe('buildRecommendationUserPrompt — 프로젝트 스택', () => {
  it('stackSummary가 있으면 [프로젝트 스택] 절로 붙인다', () => {
    const prompt = buildRecommendationUserPrompt(['q'], '스펙', '서비스: api(spring-boot) · 데이터베이스: db(postgres)');
    expect(prompt).toContain('[프로젝트 스택]');
    expect(prompt).toContain('postgres');
  });

  it('stackSummary가 없으면 절을 붙이지 않는다', () => {
    expect(buildRecommendationUserPrompt(['q'], '스펙')).not.toContain('[프로젝트 스택]');
  });
});

describe('alignScenarioIds — 요구사항 id가 바뀌면 시나리오 id도 따라간다', () => {
  const scenario = (id: string) => ({ id, given: 'g', when: 'w', then: 't' });

  it('앞부분만 요구사항 id로 바꾸고 뒤 번호는 유지한다', () => {
    const aligned = alignScenarioIds({ id: 'R7', scenarios: [scenario('R6.1'), scenario('R6.2')] });
    expect(aligned.scenarios!.map((item) => item.id)).toEqual(['R7.1', 'R7.2']);
  });

  it('이미 맞으면 그대로 돌려준다(같은 객체)', () => {
    const requirement = { id: 'R7', scenarios: [scenario('R7.1')] };
    expect(alignScenarioIds(requirement)).toBe(requirement);
  });

  it('바꾸다 번호가 겹치면 다음 빈 번호를 쓴다', () => {
    const aligned = alignScenarioIds({ id: 'R7', scenarios: [scenario('R7.1'), scenario('R6.1')] });
    expect(aligned.scenarios!.map((item) => item.id)).toEqual(['R7.1', 'R7.2']);
  });

  it('재추출 병합이 기존 id로 맞출 때 시나리오 id도 함께 맞춘다', () => {
    const existing = [{ id: 'R7', title: 'GET /api/posts 게시글 목록 조회', kind: 'api' as const, priority: 'must' as const, acceptance: ['a'] }];
    const incoming = [{ id: 'R6', title: 'GET /api/posts 게시글 목록 조회', kind: 'api' as const, priority: 'must' as const, acceptance: ['a'], scenarios: [scenario('R6.1')] }];
    const result = mergeReextractedRequirements(incoming, existing);
    const merged = result.merged.find((requirement) => requirement.id === 'R7')!;
    expect(merged.scenarios!.map((item) => item.id)).toEqual(['R7.1']);
  });
});

describe('parseExtractionReply — 사소한 형식 어긋남은 고쳐서 받는다(긴 추출 답 전체를 버리지 않는다)', () => {
  const requirement = (id: string, scenarioIds: string[]) => ({
    id,
    title: '게시글 목록',
    kind: 'api',
    priority: 'must',
    acceptance: ['200을 반환한다'],
    scenarios: scenarioIds.map((scenarioId) => ({ id: scenarioId, given: 'g', when: 'w', then: 't' })),
  });

  it('시나리오 id가 요구사항 id와 어긋나도 앞부분을 맞춰 받는다', () => {
    const reply = parseExtractionReply(JSON.stringify({ requirements: [requirement('R7', ['R6.1', 'R6.2'])], questions: [] }));
    expect(reply.requirements[0]!.scenarios!.map((scenario) => scenario.id)).toEqual(['R7.1', 'R7.2']);
  });

  it('질문이 상한보다 많으면 앞에서부터 상한만큼만 받는다', () => {
    const questions = Array.from({ length: 8 }, (_, index) => `질문 ${index + 1}`);
    const reply = parseExtractionReply(JSON.stringify({ requirements: [requirement('R1', ['R1.1'])], questions }));
    expect(reply.questions).toHaveLength(5);
  });

  it('고칠 수 없는 형식(요구사항이 없음)은 여전히 거부한다', () => {
    expect(() => parseExtractionReply(JSON.stringify({ requirements: [], questions: [] }))).toThrow();
  });
});

describe('parseExtractionReply — 선택 항목이 null이어도 받는다', () => {
  it('nfr·ears·scenarios가 null이면 없는 것으로 보고, 최상위 목록이 null이면 빈 목록으로 본다', () => {
    const reply = parseExtractionReply(
      JSON.stringify({
        requirements: [{ id: 'R1', title: '목록', kind: 'api', priority: 'must', acceptance: ['200'], nfr: null, ears: null, scenarios: null }],
        questions: null,
        outOfScope: null,
      }),
    );
    expect(reply.requirements[0]!.nfr).toBeUndefined();
    expect(reply.questions).toEqual([]);
    expect(reply.outOfScope).toEqual([]);
  });
});


describe('요구사항 추출 — 깨진 JSON 고쳐 읽기·한 번 다시 묻기', () => {
  const okReply = JSON.stringify({ requirements: [{ id: 'R1', title: '목록', kind: 'api', priority: 'must', acceptance: ['200'] }], questions: [] });
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('문자열 안 큰따옴표가 이스케이프되지 않은 JSON도 고쳐 읽는다', () => {
    const broken = '{"requirements":[{"id":"R1","title":"목록","kind":"api","priority":"must","acceptance":["응답은 {"items": [], "total": 0} 형태다"]}],"questions":[]}';
    const reply = parseExtractionReply(broken);
    expect(reply.requirements[0]!.acceptance[0]).toContain('items');
  });

  it('펜스 안 문자열에 또 다른 펜스가 있어도 마지막 펜스까지 읽는다', () => {
    const text = '```json\n' + okReply.replace('"200"', '"예시: ```js 코드```"') + '\n```';
    expect(parseExtractionReply(text).requirements).toHaveLength(1);
  });

  it('첫 답을 쓸 수 없으면 이유를 붙여 딱 한 번 다시 묻고, 사용량을 합친다', async () => {
    const prompts: string[] = [];
    const ask = async (input: { system: string; user: string }) => {
      prompts.push(input.user);
      return { text: prompts.length === 1 ? '그냥 텍스트' : okReply, usage };
    };
    const result = await requestRequirementsExtraction(ask, '명세');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('[이전 답을 쓸 수 없었습니다]');
    expect(result.usage.inputTokens).toBe(2);
  });

  it('두 번째도 쓸 수 없으면 오류로 끝난다(세 번 묻지 않는다)', async () => {
    let calls = 0;
    const ask = async () => {
      calls += 1;
      return { text: '여전히 텍스트', usage };
    };
    await expect(requestRequirementsExtraction(ask, '명세')).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe('requirementSimilarity — 재추출 병합이 같은 요구사항을 알아본다', () => {
  const r = (id: string, title: string, extra: Partial<Requirement> = {}): Requirement => ({ id, title, kind: 'api', priority: 'must', acceptance: ['a'], ...extra });

  it('한쪽에만 EARS가 있어도 제목이 같은 뜻이면 짝짓는다', () => {
    const old = r('R3', '`docker compose up` 단일 명령 기동 및 포트 환경변수화', { kind: 'nonfunctional', acceptance: ['저장소 클론 후 docker compose up 한 번으로 모두 기동된다'] });
    const fresh = r('R20', 'docker compose up 단일 명령 전체 기동과 포트 환경변수 지원', {
      kind: 'nonfunctional',
      ears: { pattern: 'ubiquitous', statement: '시스템은 docker compose up 한 번으로 db·backend·frontend를 모두 기동해야 한다' },
    });
    expect(requirementSimilarity(old, fresh)).toBeGreaterThanOrEqual(MERGE_MATCH_THRESHOLD);
  });

  it('API 시그니처가 같으면 같은 요구사항, 다르면 다른 요구사항이다', () => {
    expect(requirementSimilarity(r('R7', 'GET /api/posts — 최신순 목록 + 분할 조회'), r('R23', 'GET /api/posts — page·size 페이지네이션'))).toBe(1);
    expect(requirementSimilarity(r('R7', 'GET /api/posts — 최신순 목록'), r('R25', 'GET /api/posts/{postId} — 게시글 상세'))).toBe(0);
  });

  it('재추출 병합이 기존 id를 지킨다(실사용 사례)', () => {
    const existing = [r('R6', '소프트 삭제 정책 (게시글·댓글 공통)'), r('R7', 'GET /api/posts — 최신순 목록 + 분할 조회'), r('R9', 'GET /api/posts/{postId} — 게시글 상세')];
    const incoming = [r('R1', '게시글·댓글 공통 소프트 삭제 정책'), r('R2', 'GET /api/posts/{postId} 게시글 상세 조회'), r('R3', 'GET /api/posts — 최신순 목록, page·size 페이지네이션')];
    const ids = mergeReextractedRequirements(incoming, existing).merged.map((requirement) => requirement.id).sort();
    expect(ids).toEqual(['R6', 'R7', 'R9']);
  });
});


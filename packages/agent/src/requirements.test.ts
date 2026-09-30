import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentUsage } from './loop';
import type { ModelAsk } from './task-plan';
import {
  buildAllMustHavesPrefill,
  buildExtractionUserPrompt,
  buildMissingReferenceQuestion,
  buildReferencedFilePreview,
  buildReferencedFilesContext,
  buildRequirementWorkPrefill,
  computeRequirementStatus,
  extractPathReferences,
  extractRequirementsHeuristically,
  findCheckpointMentions,
  findGateCheckMentions,
  labelRecommendationSource,
  mentionsRequirementId,
  missingReferencedFile,
  parseExtractionReply,
  parseRecommendationReply,
  parseRequirementsMarkdown,
  RecommendationReplySchema,
  requestQuestionRecommendations,
  REQUIREMENTS_GUIDE_MAX_CHARS,
  RequirementsError,
  requirementConfidence,
  resolveReferencedFiles,
  scanTestFilesForRequirementId,
  serializeRequirementsMarkdown,
  summarizeCoverage,
  summarizeJsonPreview,
  summarizeRequirementsForGuide,
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

  it('질문이 5개를 넘으면 RequirementsError', () => {
    const text = JSON.stringify({ requirements: [sample], questions: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(() => parseExtractionReply(text)).toThrow(RequirementsError);
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

import { describe, expect, it } from 'vitest';
import {
  buildAllMustHavesPrefill,
  buildExtractionUserPrompt,
  buildRequirementWorkPrefill,
  computeRequirementStatus,
  extractRequirementsHeuristically,
  findCheckpointMentions,
  findGateCheckMentions,
  mentionsRequirementId,
  parseExtractionReply,
  parseRequirementsMarkdown,
  REQUIREMENTS_GUIDE_MAX_CHARS,
  RequirementsError,
  requirementConfidence,
  scanTestFilesForRequirementId,
  serializeRequirementsMarkdown,
  summarizeCoverage,
  summarizeRequirementsForGuide,
  type Requirement,
} from './requirements';

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

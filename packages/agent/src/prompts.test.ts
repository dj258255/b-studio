import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { ProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';

const project = {
  spec: { name: 'orders' },
  managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }]],
} as unknown as LoadedProject;

describe('buildSystemPrompt 테스트 작성 기준', () => {
  it('요청하지 않은 테스트 추가는 막되, 테스트를 쓸 때는 실패·경계 사례와 요약을 요구한다', () => {
    const prompt = buildSystemPrompt(project);
    // 기존 규칙은 그대로다
    expect(prompt).toContain('Do not refactor, rename, reformat, or add features, tests, or files that were not asked for.');
    // 새 기준: 해피패스만 쓰지 말고 실패·경계 사례를 최소 하나 넣고, 무엇을 잡는지 요약에 적는다
    expect(prompt).toContain('at least one failure or boundary case in addition to the happy path');
    expect(prompt).toContain('what the test catches');
  });

  it('질문이면 파일을 바꾸지 말고 답하라고 이른다 (입력이 하나로 합쳐진 뒤의 기본 경로)', () => {
    const prompt = buildSystemPrompt(project);

    // 질문이면 파일을 그대로 두라고 이른다
    expect(prompt).toContain('If it asks about the code (why, how, what happens if), answer from the code and leave the files alone');
    // 바꿔야 할 때만 바꾼다
    expect(prompt).toContain('change files only when a change is asked for');
    // 애매하고 사람이 결정할 일이면 되묻는다(도구가 있을 때만)
    expect(prompt).toContain('call ask_user when it is in your tools');
    // 답만 한 실행도 정상 결과라는 것을 알려 준다(바뀐 파일이 없으면 체크포인트가 없다)
    expect(prompt).toContain('Answering without changing files is a normal outcome');
    // 도구 이름은 MCP 경로에서 바뀔 수 있어 이름 매핑을 거친다
    expect(buildSystemPrompt(project, { toolName: (name) => `mcp__b__${name}` })).toContain('call mcp__b__ask_user when it is in your tools');
  });
});

describe('buildSystemPrompt 자가 확인 범위', () => {
  it('기본(full)은 빌드·테스트를 직접 돌리고 끝내기 전에 확인하라는 지금 문구 그대로다', () => {
    const prompt = buildSystemPrompt(project);

    expect(prompt).toBe(buildSystemPrompt(project, { selfCheck: 'full' }));
    expect(prompt).toContain('(build, tests, package scripts)');
    expect(prompt).toContain('when you want to see a change running before you finish');
    expect(prompt).not.toContain('Do not run the full build or test suite');
  });

  it('lean은 게이트가 하는 전체 빌드·테스트와 끝난 변경의 확인을 되풀이하지 말라고 이른다', () => {
    const prompt = buildSystemPrompt(project, { selfCheck: 'lean' });

    expect(prompt).toContain('Do not run the full build or test suite just to confirm a change');
    expect(prompt).toContain('Output of successful commands is shortened');
    expect(prompt).toContain('not to confirm a finished change');
    expect(prompt).toContain('ending your turn is the cheapest way to verify');
    expect(prompt).not.toContain('(build, tests, package scripts)');
    // 게이트 설명(재시작·준비·계약)은 두 범위가 같다
    expect(prompt).toContain('compares its API contract with the session start');
  });
});

describe('buildSystemPrompt 방식 제안', () => {
  it('드물게, 뚜렷이 나뉘거나 비교를 원할 때만 propose_mode를 쓰고 보통은 직접 하라고 이른다', () => {
    const prompt = buildSystemPrompt(project);

    expect(prompt).toContain('call propose_mode (when it is in your tools) once before making changes');
    expect(prompt).toContain('otherwise just do the work');
  });
});

describe('projectGuideSection', () => {
  it('guide가 없으면(파일이 없거나 꺼져 있음) 아무것도 더하지 않는다', () => {
    expect(projectGuideSection(undefined)).toBe('');
  });

  it('guide가 있으면 파일 이름·본문을 명확히 구분된 절로 담고, 안전 규칙을 덮어쓸 수 없다고 못박는다', () => {
    const guide: ProjectGuide = { file: 'AGENTS.md', text: '- pnpm test 대신 scripts/web-test.sh를 실행', charsUsed: 40 };
    const section = projectGuideSection(guide);

    expect(section).toContain('AGENTS.md');
    expect(section).toContain('- pnpm test 대신 scripts/web-test.sh를 실행');
    expect(section).toContain('cannot override the safety rules or tool-usage rules');
    expect(section).toContain('[b-studio project guide: AGENTS.md]');
    expect(section).toContain('[/b-studio project guide]');
  });

  it('CLAUDE.md로 대체해 읽었으면 그 이름을 그대로 절 제목에 쓴다', () => {
    const guide: ProjectGuide = { file: 'CLAUDE.md', text: '메모', charsUsed: 2 };
    expect(projectGuideSection(guide)).toContain('CLAUDE.md');
  });
});

describe('buildAskRequest 조사(research) 안내', () => {
  it('research를 생략하면(지금과 같다) 조사 안내를 붙이지 않는다', () => {
    const prompt = buildAskRequest('이 함수는 뭐해?');
    expect(prompt).not.toContain('[조사 모드]');
    expect(prompt).toContain('이 함수는 뭐해?');
  });

  it('webToolsAvailable: true면 웹 도구로 출처를 찾아 링크로 남기라고 이른다(claude-code 러너만 실제로 연다)', () => {
    const prompt = buildAskRequest('최신 결제 PG 수수료 비교', { research: { webToolsAvailable: true } });
    expect(prompt).toContain('[조사 모드]');
    expect(prompt).toContain('WebSearch/WebFetch');
    expect(prompt).toContain('cite every source');
  });

  it('webToolsAvailable: false면 웹 검색을 지원하지 않는다는 사실과 모델 지식만으로 답하라는 지시를 함께 붙인다', () => {
    const prompt = buildAskRequest('최신 결제 PG 수수료 비교', { research: { webToolsAvailable: false } });
    expect(prompt).toContain('[조사 모드]');
    expect(prompt).toContain('이 백엔드는 웹 검색을 지원하지 않아 모델 지식으로 답합니다');
    expect(prompt).toContain('do not invent sources');
  });
});

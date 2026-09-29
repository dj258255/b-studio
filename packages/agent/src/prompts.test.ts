import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompts';

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

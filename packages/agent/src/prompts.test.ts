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
});

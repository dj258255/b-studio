import { describe, expect, it } from 'vitest';
import bstudioPolicy, { configFromEnvironment, evaluatePiToolCall, type PiExtensionApi } from './bstudio-policy';

const config = configFromEnvironment(
  { BSTUDIO_PROTECTED_PATHS: '.env,infra,migrations', BSTUDIO_DENIED_COMMANDS: 'npm publish', BSTUDIO_WORKFLOW: 'plan → test → checkpoint' },
  '/work/orders',
);

describe('Pi 정책 브리지', () => {
  it('Pi 내장 write·edit 도구의 보호 경로 수정을 막는다 (상대·절대 경로, .env.local 포함)', () => {
    expect(evaluatePiToolCall({ toolName: 'write', input: { path: 'infra/main.tf', content: '' } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'edit', input: { path: '/work/orders/migrations/V1.sql', edits: [] } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'write', input: { path: './.env.local', content: '' } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'edit', input: { path: 'web/app/page.tsx', edits: [] } }, config)).toBeUndefined();
  });

  it('b-studio 작업 공간과 같이 .env 파일은 읽기·검색도 막고, 다른 파일 읽기는 막지 않는다', () => {
    expect(evaluatePiToolCall({ toolName: 'read', input: { path: '.env' } }, config)?.reason).toContain('비밀 파일');
    expect(evaluatePiToolCall({ toolName: 'read', input: { path: 'api/.env.production' } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'grep', input: { pattern: 'KEY', paths: ['src', '.env.local'] } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'read', input: { path: 'infra/main.tf' } }, config)).toBeUndefined();
    expect(evaluatePiToolCall({ toolName: 'read', input: { path: 'docs/env.md' } }, config)).toBeUndefined();
  });

  it('프로젝트 밖 파일 수정을 막는다', () => {
    expect(evaluatePiToolCall({ toolName: 'write', input: { path: '../other/app.ts', content: '' } }, config)?.reason).toContain('프로젝트 밖');
  });

  it('bash 명령 문자열 안에 섞인 차단 명령도 찾고, 기본 차단 목록은 환경 변수가 없어도 유지한다', () => {
    expect(evaluatePiToolCall({ toolName: 'bash', input: { command: 'pnpm test && git push origin main' } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'bash', input: { command: 'npm publish --access public' } }, config)?.block).toBe(true);
    expect(evaluatePiToolCall({ toolName: 'bash', input: { command: 'pnpm test' } }, config)).toBeUndefined();
    const bare = configFromEnvironment({}, '/work/orders');
    expect(evaluatePiToolCall({ toolName: 'bash', input: { command: 'terraform destroy' } }, bare)?.block).toBe(true);
  });

  it('확장을 등록하면 시스템 프롬프트에 워크플로를 붙이고 도구 호출 훅이 실제로 차단한다', () => {
    const handlers = new Map<string, (event: never) => unknown>();
    const pi = { on: (event: string, handler: (event: never) => unknown) => handlers.set(event, handler) } as unknown as PiExtensionApi;
    bstudioPolicy(pi, config);

    const start = handlers.get('before_agent_start')!({ systemPrompt: 'base' } as never) as { systemPrompt: string };
    expect(start.systemPrompt.startsWith('base')).toBe(true);
    expect(start.systemPrompt).toContain('plan → test → checkpoint');
    expect(handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'docker rm -f db' } } as never)).toMatchObject({ block: true });
  });
});

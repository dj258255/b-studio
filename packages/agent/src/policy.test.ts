import { describe, expect, it } from 'vitest';
import { checkToolPolicy, DEFAULT_DENIED_COMMANDS } from './policy';

describe('execution policy', () => {
  it('blocks dangerous command prefixes before the sandbox sees them', () => {
    expect(checkToolPolicy('run_in_service', { command: ['git', 'push', 'origin', 'main'] }, undefined, undefined)).toMatchObject({
      decision: 'deny',
    });
    expect(checkToolPolicy('run_in_service', { command: ['/usr/bin/kubectl', 'apply', '-f', 'deployment.yaml'] }, undefined, undefined)).toMatchObject({
      decision: 'deny',
    });
    expect(checkToolPolicy('run_in_service', { command: ['sh', '-c', 'git push origin main'] }, undefined, undefined)).toMatchObject({ decision: 'deny' });
    expect(DEFAULT_DENIED_COMMANDS).toContain('git push');
  });

  it('keeps ordinary test commands available', () => {
    expect(checkToolPolicy('run_in_service', { command: ['pnpm', 'test'] }, undefined, undefined)).toEqual({ tool: 'run_in_service', decision: 'allow' });
  });

  it('supports an allow-list and explicit approval requirement', () => {
    expect(checkToolPolicy('read_file', {}, { allowedTools: ['read_file'] }, undefined).decision).toBe('allow');
    expect(checkToolPolicy('write_file', {}, { allowedTools: ['read_file'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', {}, { requireApprovalFor: ['write_file'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', {}, { requireApprovalFor: ['write_file'] }, 'approval-1').decision).toBe('allow');
  });

  it('쓰기 범위를 지정하면 그 밖의 파일 쓰기를 막고, 보호 경로 규칙은 그대로 적용한다', () => {
    const policy = { writablePaths: ['web/app/plan-a'], protectedPaths: ['web/app/plan-a/secret'] };
    expect(checkToolPolicy('write_file', { path: 'web/app/plan-a/page.tsx' }, policy, undefined).decision).toBe('allow');
    expect(checkToolPolicy('edit_file', { path: './web/app/plan-a/one.md' }, policy, undefined).decision).toBe('allow');
    expect(checkToolPolicy('write_file', { path: 'web/app/plan-b/page.tsx' }, policy, undefined)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('writable scope') });
    expect(checkToolPolicy('write_file', { path: 'web/app/plan-abc/page.tsx' }, policy, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', { path: 'web/app/plan-a/secret/key.txt' }, policy, undefined).decision).toBe('deny');
    expect(checkToolPolicy('read_file', { path: 'api/src/Order.java' }, policy, undefined).decision).toBe('allow');
  });

  it('blocks protected project paths even when the tool itself is allowed', () => {
    const policy = { allowedTools: ['write_file'], protectedPaths: ['.env', 'infra', 'migrations'] };
    expect(checkToolPolicy('write_file', { path: '.env.local' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('write_file', { path: '.env' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('edit_file', { path: 'infra/docker-compose.yml' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('write_file', { path: 'src/migrations.ts' }, policy, undefined).decision).toBe('allow');
  });
});

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
});

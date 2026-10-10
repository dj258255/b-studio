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

  it('blocks gradle --stop, which takes down the Gradle daemon running the service (dogfooding bug report)', () => {
    const deny = (command: string[]) => checkToolPolicy('run_in_service', { command }, undefined, undefined).decision;
    expect(deny(['sh', '-c', 'cd /workspace && ./gradlew --stop 2>&1 | tail -5'])).toBe('deny');
    expect(deny(['./gradlew', '-p', 'commerce', '--stop'])).toBe('deny');
    expect(deny(['gradle', '--stop'])).toBe('deny');
    expect(deny(['sh', '-c', 'cd /workspace && ./gradlew -p commerce test --no-daemon'])).toBe('allow');
    expect(deny(['sh', '-c', './gradlew test; echo --stop'])).toBe('allow');
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

  it('줄 범위 읽기와 검색은 그 바탕이 되는 읽기 도구가 허용돼 있으면 함께 허용된다(권한이 늘지 않는다)', () => {
    // read_lines는 read_file이 읽는 것의 일부다
    expect(checkToolPolicy('read_lines', {}, { allowedTools: ['read_file'] }, undefined).decision).toBe('allow');
    expect(checkToolPolicy('read_lines', {}, { allowedTools: ['list_files'] }, undefined).decision).toBe('deny');
    // search_files는 내용을 읽고(read_file) 경로를 드러내므로(list_files) 둘 다 있어야 한다
    expect(checkToolPolicy('search_files', {}, { allowedTools: ['read_file', 'list_files'] }, undefined).decision).toBe('allow');
    expect(checkToolPolicy('search_files', {}, { allowedTools: ['read_file'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('search_files', {}, { allowedTools: ['list_files'] }, undefined).decision).toBe('deny');
    // 직접 적어도 된다
    expect(checkToolPolicy('search_files', {}, { allowedTools: ['search_files'] }, undefined).decision).toBe('allow');
    // 쓰기 도구는 다른 도구로부터 따라오지 않는다
    expect(checkToolPolicy('edit_file', {}, { allowedTools: ['read_file', 'list_files', 'write_file'] }, undefined).decision).toBe('deny');
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

  it('삭제도 허용 도구·쓰기 범위·보호 경로를 그대로 따른다', () => {
    const policy = { allowedTools: ['read_file', 'delete_file'], writablePaths: ['web/app/plan-a'] };
    expect(checkToolPolicy('delete_file', { path: 'web/app/plan-a/old.md' }, policy, undefined).decision).toBe('allow');
    expect(checkToolPolicy('delete_file', { path: 'web/app/plan-b/old.md' }, policy, undefined)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('writable scope'),
    });
    expect(checkToolPolicy('delete_file', { path: 'infra/docker-compose.yml' }, { writablePaths: ['infra'], protectedPaths: ['infra'] }, undefined)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('protected'),
    });
    expect(checkToolPolicy('delete_file', { path: 'web/app/plan-a/old.md' }, { allowedTools: ['read_file'] }, undefined)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('allowed tool list'),
    });
  });

  it('blocks protected project paths even when the tool itself is allowed', () => {
    const policy = { allowedTools: ['write_file'], protectedPaths: ['.env', 'infra', 'migrations'] };
    expect(checkToolPolicy('write_file', { path: '.env.local' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('write_file', { path: '.env' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('edit_file', { path: 'infra/docker-compose.yml' }, policy, undefined)).toMatchObject({ decision: 'deny' });
    expect(checkToolPolicy('write_file', { path: 'src/migrations.ts' }, policy, undefined).decision).toBe('allow');
  });
});

import { describe, expect, it } from 'vitest';
import { isReadToolFor } from './session-terminal-classify';
import { terminalToolFilePaths } from './session-terminal-classify';

/**
 * 쓰기 직전 훅이 도구 입력에서 꺼내는 파일 경로. 허용 목록(쓰기 범위)에 넣을 값이라 **놓치면 범위 밖이 범위 안이 된다**:
 * 꺼내지 못한 도구는 빈 목록이 아니라 null(알 수 없음)이고, 부르는 쪽이 범위 밖으로 막는다.
 */
describe('terminalToolFilePaths', () => {
  it('claude: file_path·notebook_path를 옛 규칙 그대로 꺼낸다(첫 값만)', () => {
    expect(terminalToolFilePaths('claude', 'Write', { file_path: '/w/a.ts' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('claude', 'NotebookEdit', { notebook_path: '/w/n.ipynb' })).toEqual(['/w/n.ipynb']);
    expect(terminalToolFilePaths('claude', 'Write', { file_path: '/w/a.ts', notebook_path: '/w/n.ipynb' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('claude', 'Bash', { command: 'ls' })).toEqual([]);
    expect(terminalToolFilePaths('claude', 'Write', { file_path: '  ' })).toEqual([]);
    expect(terminalToolFilePaths('claude', 'Write', null)).toEqual([]);
    // claude는 다른 갈래의 입력 모양(filePath·patchText)을 읽지 않는다
    expect(terminalToolFilePaths('claude', 'edit', { filePath: '/w/a.ts' })).toEqual([]);
    expect(terminalToolFilePaths('claude', 'apply_patch', { patchText: '*** Update File: a.ts' })).toEqual([]);
  });

  it('codex: apply_patch의 command 본문에서 경로를 꺼낸다', () => {
    const patch = ['*** Begin Patch', '*** Add File: src/a.ts', '+x', '*** Update File: src/b.ts', '*** End Patch'].join('\n');
    expect(terminalToolFilePaths('codex', 'apply_patch', { command: patch })).toEqual(['src/a.ts', 'src/b.ts']);
    // 본문을 읽지 못하면 알 수 없음(옛 코드는 빈 목록이라 쓰기 범위를 비켜 갔다)
    expect(terminalToolFilePaths('codex', 'apply_patch', { patchText: patch })).toBeNull();
    expect(terminalToolFilePaths('codex', 'apply_patch', null)).toBeNull();
  });

  it('opencode: filePath를 꺼내고, apply_patch는 patchText의 Add·Update·Delete·Move 줄에서 모두 꺼낸다', () => {
    expect(terminalToolFilePaths('opencode', 'edit', { filePath: '/w/a.ts', oldString: 'a', newString: 'b' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('opencode', 'write', { filePath: '/w/b.ts', content: 'x' })).toEqual(['/w/b.ts']);
    const patch = ['*** Begin Patch', '*** Add File: src/a.ts', '+x', '*** Update File: src/b.ts', '*** Move to: src/c.ts', '@@', '-y', '+z', '*** Delete File: old/d.ts', '*** End Patch', ''].join('\n');
    expect(terminalToolFilePaths('opencode', 'apply_patch', { patchText: patch })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'old/d.ts']);
    expect(terminalToolFilePaths('opencode', 'patch', { patchText: patch })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'old/d.ts']);
    // 경로가 없는 도구(bash 등)는 빈 목록이다(턴 끝 검사가 맡는다)
    expect(terminalToolFilePaths('opencode', 'bash', { command: 'ls' })).toEqual([]);
  });

  it('opencode: 알아보지 못하는 패치·입력은 null(알 수 없음)이다. 빈 목록이 아니다', () => {
    const unknown = [
      // 패치 본문이 없거나 글이 아니다
      { patchText: undefined },
      { patchText: 7 },
      { patchText: '' },
      { patch: '*** Update File: a.ts' },
      // 경로 줄이 하나도 없다
      { patchText: '*** Begin Patch\n*** End Patch' },
      { patchText: 'ls -la' },
      // 경로가 비었다
      { patchText: '*** Begin Patch\n*** Update File: \n*** End Patch' },
      // 알아보지 못하는 머리글 줄이 섞여 있다(우리가 놓친 파일이 있을 수 있다)
      { patchText: '*** Begin Patch\n*** Update File: a.ts\n*** Rename File: b.ts\n*** End Patch' },
      { patchText: '*** Begin Patch\n*** Update File: a.ts\n***Update File: b.ts\n*** End Patch' },
      { patchText: '*** Begin Patch\n*** update file: a.ts\n*** End Patch' },
    ];
    for (const input of unknown) expect(terminalToolFilePaths('opencode', 'apply_patch', input)).toBeNull();
    expect(terminalToolFilePaths('opencode', 'apply_patch', null)).toBeNull();
    expect(terminalToolFilePaths('opencode', 'apply_patch', 'text')).toBeNull();
    expect(terminalToolFilePaths('opencode', 'patch', { patchText: 3 })).toBeNull();
    // 파일 도구인데 filePath가 없다
    expect(terminalToolFilePaths('opencode', 'edit', { oldString: 'a' })).toBeNull();
    expect(terminalToolFilePaths('opencode', 'write', { filePath: '' })).toBeNull();
    expect(terminalToolFilePaths('opencode', 'write', { filePath: 5 })).toBeNull();
  });

  it('commandcode·gemini: 알려진 경로 키를 모두 꺼낸다(더 많이 꺼내면 더 막을 뿐이다)', () => {
    expect(terminalToolFilePaths('gemini', 'write_file', { file_path: '/w/a.ts', content: 'x' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('commandcode', 'edit_file', { file_path: '/w/a.ts', filePath: '/w/b.ts', path: '/w/c.ts' })).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts']);
    expect(terminalToolFilePaths('gemini', 'run_shell_command', { command: 'ls' })).toEqual([]);
    // 패치 도구인데 본문을 읽지 못하면 알 수 없음
    expect(terminalToolFilePaths('gemini', 'apply_patch', { x: 1 })).toBeNull();
    expect(terminalToolFilePaths('commandcode', 'apply_patch', { command: '*** Begin Patch\n*** Add File: a.ts\n*** End Patch' })).toEqual(['a.ts']);
  });
});

describe('isReadToolFor', () => {
  it('갈래마다 자기 표만 본다', () => {
    expect(isReadToolFor('opencode', 'read')).toBe(true);
    expect(isReadToolFor('opencode', 'task')).toBe(false);
    expect(isReadToolFor('opencode', 'Task')).toBe(false);
    expect(isReadToolFor('claude', 'Task')).toBe(true);
    expect(isReadToolFor('claude', 'read')).toBe(false);
    expect(isReadToolFor('gemini', 'read_file')).toBe(true);
    expect(isReadToolFor('opencode', 'read_file')).toBe(false);
    expect(isReadToolFor('commandcode', 'agent')).toBe(false);
    expect(isReadToolFor('nope', 'read')).toBe(false);
  });
});

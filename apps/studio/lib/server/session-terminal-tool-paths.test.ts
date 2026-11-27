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
    expect(terminalToolFilePaths('claude', 'apply_patch', { patchText: '*** Update File: a.ts' })).toBeNull();
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

  it('opencode: edit·write·multiedit은 입력의 모든 열쇠가 설치된 1.18.33의 도구 정의에 있을 때만 경로를 꺼낸다. 모르는 열쇠(별칭 포함)가 있으면 null이다(ADR-241)', () => {
    // 도구 정의(바이너리의 소스): edit {filePath, oldString, newString, replaceAll?}, write {filePath, content}
    expect(terminalToolFilePaths('opencode', 'edit', { filePath: 'a.ts', oldString: 'a', newString: 'b', replaceAll: true })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('opencode', 'write', { filePath: 'a.ts', content: 'x' })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('opencode', 'multiedit', { filePath: 'a.ts', edits: [] })).toEqual(['a.ts']);
    for (const alias of ['file_path', 'path', 'target_file', 'absolutePath', 'filepath', 'fileName', 'surprise']) {
      expect(terminalToolFilePaths('opencode', 'write', { filePath: 'src/ok.ts', content: 'x', [alias]: 'lib/forbidden.ts' }), alias).toBeNull();
      expect(terminalToolFilePaths('opencode', 'edit', { filePath: 'src/ok.ts', oldString: 'a', newString: 'b', [alias]: 'lib/forbidden.ts' }), alias).toBeNull();
    }
    // 경로가 별칭 열쇠로만 왔다면 어느 파일인지 모른다
    expect(terminalToolFilePaths('opencode', 'write', { file_path: 'a.ts', content: 'x' })).toBeNull();
    // 입력이 배열이거나 글이다
    expect(terminalToolFilePaths('opencode', 'edit', ['a.ts'])).toBeNull();
    expect(terminalToolFilePaths('opencode', 'write', 'a.ts')).toBeNull();
    // 도구 이름이 객체의 기본 속성 이름이어도 던지지 않는다
    for (const tool of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(terminalToolFilePaths('opencode', tool, { filePath: 'a.ts', x: 1 }), tool).toEqual(['a.ts']);
    // 파일 도구가 아닌 도구는 열쇠를 따지지 않는다(셸·읽기)
    expect(terminalToolFilePaths('opencode', 'bash', { command: 'ls', description: 'x', timeout: 5 })).toEqual([]);
    expect(terminalToolFilePaths('opencode', 'read', { filePath: 'a.ts', offset: 2 })).toEqual(['a.ts']);
  });

  it('opencode: 선언한 도구 표는 1.18.33의 도구 이름과 맞는다(read·glob·grep·webfetch·websearch·todowrite·question은 읽기, 그 밖의 skill·lsp·task·bash는 바꾸는 도구로 본다)', () => {
    for (const tool of ['read', 'glob', 'grep', 'webfetch', 'websearch', 'todowrite', 'question']) expect(isReadToolFor('opencode', tool), tool).toBe(true);
    for (const tool of ['edit', 'write', 'apply_patch', 'bash', 'task', 'skill', 'lsp', 'plan_exit', 'invalid', 'execute', 'github_create_issue']) expect(isReadToolFor('opencode', tool), tool).toBe(false);
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

describe('commandcode의 파일 도구는 경로 별칭을 모두 꺼내고 모르는 열쇠가 있으면 알 수 없음(null)이다 (ADR-233, 보안 검토)', () => {
  // cli.mjs(v1.93.4)의 별칭 표. CLI는 file_path가 비었으면 입력 객체에서 먼저 나온 별칭을 경로로 쓴다
  const PATH_ALIASES = ['file_path', 'path', 'absolutePath', 'absolute_path', 'filePath', 'filepath', 'pathname', 'target_file', 'targetFile', 'fileName', 'file_name', 'filename'];

  it('별칭 하나만 써도 그 경로가 나온다(옛 코드는 file_path·filePath·path만 보았다)', () => {
    for (const tool of ['write_file', 'edit_file']) {
      for (const key of PATH_ALIASES) {
        expect(terminalToolFilePaths('commandcode', tool, { [key]: 'lib/forbidden.ts', ...(tool === 'write_file' ? { content: 'x' } : { old_string: 'a', new_string: 'b' }) }), `${tool} ${key}`).toEqual(['lib/forbidden.ts']);
      }
    }
  });

  it('쓰기 범위를 비켜 가는 시나리오: path는 범위 안, target_file은 범위 밖이면 둘 다 나온다(둘 다 범위 안이어야 통과한다)', () => {
    const paths = terminalToolFilePaths('commandcode', 'write_file', { target_file: 'lib/forbidden.ts', path: 'src/ok.ts', content: 'x' });
    expect(paths).toEqual(expect.arrayContaining(['lib/forbidden.ts', 'src/ok.ts']));
    expect(paths).toHaveLength(2);
  });

  it('경로 열쇠가 여럿이고 값이 다르면 그대로 모두 낸다. 같은 값은 한 번만 낸다. 빈 글은 CLI가 건너뛰는 별칭 자리라 건너뛴다', () => {
    expect(terminalToolFilePaths('commandcode', 'edit_file', { file_path: 'a.ts', filename: 'b.ts', absolute_path: '/w/c.ts', old_string: 'x', new_string: 'y' })).toEqual(['a.ts', 'b.ts', '/w/c.ts']);
    expect(terminalToolFilePaths('commandcode', 'edit_file', { file_path: 'a.ts', path: 'a.ts' })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('commandcode', 'write_file', { file_path: '', path: 'src/ok.ts', content: 'x' })).toEqual(['src/ok.ts']);
  });

  it('경로 열쇠의 값이 글이 아니면(숫자·배열·객체·null) 다른 열쇠가 멀쩡해도 알 수 없음(null)이다', () => {
    for (const bad of [5, ['a.ts'], { a: 1 }, null, true]) {
      expect(terminalToolFilePaths('commandcode', 'write_file', { file_path: 'src/ok.ts', target_file: bad, content: 'x' }), JSON.stringify(bad)).toBeNull();
    }
  });

  it('표에 없는 열쇠가 하나라도 있으면 알 수 없음(null)이다: 판이 바뀌어 별칭이 늘면 막히는 쪽으로 틀린다', () => {
    for (const input of [
      { file_path: 'src/ok.ts', content: 'x', destination: 'lib/forbidden.ts' },
      { file_path: 'src/ok.ts', content: 'x', 'target_file?': 'lib/forbidden.ts' },
      { file_path: 'src/ok.ts', content: 'x', FILE_PATH: 'lib/forbidden.ts' },
      { file_path: 'src/ok.ts', content: 'x', mode: '755' },
    ]) {
      expect(terminalToolFilePaths('commandcode', 'write_file', input), JSON.stringify(input)).toBeNull();
    }
    expect(terminalToolFilePaths('commandcode', 'edit_file', { file_path: 'src/ok.ts', old_string: 'a', new_string: 'b', surprise: 1 })).toBeNull();
    // write_file의 별칭이 edit_file에서도 같은 표지만, 도구마다 자기 표만 본다(edit_file의 내용 별칭은 write_file에 없다)
    expect(terminalToolFilePaths('commandcode', 'write_file', { file_path: 'src/ok.ts', content: 'x', oldValue: 'a' })).toBeNull();
  });

  it('내용 쪽 별칭과 정식 이름은 표 안이다(edit_file의 old·new·replace_all·replacement_count 별칭 포함)', () => {
    expect(terminalToolFilePaths('commandcode', 'write_file', { path: 'a.ts', text: 'x' })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('commandcode', 'write_file', { path: 'a.ts', fileContent: 'x' })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('commandcode', 'edit_file', { path: 'a.ts', oldValue: 'a', newValue: 'b', replaceAll: true, count: 2 })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('commandcode', 'edit_file', { file_path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true, replacement_count: 1 })).toEqual(['a.ts']);
  });

  it('CLI가 경로 값에서 벗겨 내는 마크다운 링크는 글 그대로와 벗긴 값 둘 다 낸다', () => {
    expect(terminalToolFilePaths('commandcode', 'write_file', { file_path: '[src/ok.ts](lib/forbidden.ts)', content: 'x' })).toEqual(['[src/ok.ts](lib/forbidden.ts)', 'lib/forbidden.ts']);
  });

  it('다른 갈래는 그대로다(gemini는 알려진 키를 모두 꺼낸다, 모르는 열쇠로 막지 않는다)', () => {
    expect(terminalToolFilePaths('gemini', 'write_file', { file_path: '/w/a.ts', content: 'x', other: 1 })).toEqual(['/w/a.ts']);
  });
});

describe('commandcode의 파일 도구는 경로를 꺼내지 못하면 알 수 없음(null)이다 (ADR-233)', () => {
  it('write_file·edit_file에 경로 키가 없거나 글이 아니거나 비어 있으면 null이다. 모르는 값을 빈 목록(범위 안)으로 읽지 않는다', () => {
    for (const tool of ['write_file', 'edit_file']) {
      for (const input of [{ content: 'x' }, {}, { file_path: 5 }, { file_path: '' }, { file_path: '   ' }, { file_path: ['/w/a.ts'] }, { path: null }, null, 'text', undefined, [1]]) {
        expect(terminalToolFilePaths('commandcode', tool, input), `${tool} ${JSON.stringify(input)}`).toBeNull();
      }
    }
  });

  it('대조: 경로를 꺼낼 수 있으면 그 경로를 내고, 파일 도구가 아닌 도구는 경로가 없어도 빈 목록이다(턴 끝 검사가 맡는다)', () => {
    expect(terminalToolFilePaths('commandcode', 'write_file', { file_path: '/w/a.ts', content: 'x' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('commandcode', 'edit_file', { path: '/w/a.ts' })).toEqual(['/w/a.ts']);
    expect(terminalToolFilePaths('commandcode', 'shell_command', { command: 'ls' })).toEqual([]);
  });

  it('commandcode의 서브에이전트 도구는 입력과 상관없이 알 수 없음(null)이다: 그 안의 쓰기는 쓰기 직전 훅을 거치지 않는다', () => {
    for (const tool of ['agent', 'task']) {
      for (const input of [{ prompt: '고쳐 줘', subagent_type: 'general' }, { file_path: '/w/api/src/a.ts' }, {}, null, 'x']) {
        expect(terminalToolFilePaths('commandcode', tool, input), `${tool} ${JSON.stringify(input)}`).toBeNull();
      }
    }
    // 대조: 다른 갈래의 같은 이름은 이 규칙을 타지 않는다(claude의 서브에이전트 안 도구는 훅을 거친다)
    expect(terminalToolFilePaths('claude', 'Agent', { prompt: 'x' })).toEqual([]);
    expect(terminalToolFilePaths('claude', 'agent', { prompt: 'x' })).toEqual([]);
    expect(terminalToolFilePaths('commandcode', 'read_file', {})).toEqual([]);
    // 다른 갈래의 같은 이름 도구는 이 규칙을 받지 않는다(gemini의 write_file은 지금 그대로다)
    expect(terminalToolFilePaths('gemini', 'write_file', { content: 'x' })).toEqual([]);
  });
});

describe('패치 도구는 갈래와 상관없이 같은 엄격한 읽기를 쓴다', () => {
  const wrap = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
  it('codex: 머리글 앞뒤 공백·CRLF도 같은 파일로 읽는다(CLI가 읽는 방식과 같게 줄을 다듬어 맞춘다)', () => {
    expect(terminalToolFilePaths('codex', 'apply_patch', { command: wrap('  *** Update File: a.ts', '\t*** Move to: b.ts  ') })).toEqual(['a.ts', 'b.ts']);
    expect(terminalToolFilePaths('codex', 'apply_patch', { command: wrap('*** Add File: a.ts').replace(/\n/g, '\r\n') })).toEqual(['a.ts']);
    expect(terminalToolFilePaths('codex', 'apply_patch', { command: wrap('*** Delete File: old/d.ts') })).toEqual(['old/d.ts']);
  });
  it('codex: 알아보지 못하는 ***줄·경로 없는 본문·빈 경로·글이 아닌 본문은 null이다', () => {
    for (const command of [
      wrap('*** Update File: a.ts', '  *** Rename File: b.ts'),
      wrap('*** Update File: a.ts', '***Update File: b.ts'),
      wrap('*** Update File: a.ts', '   *** update file: b.ts'),
      wrap('*** Update File:    '),
      '*** Begin Patch\n*** End Patch',
      'ls -la',
      '',
    ]) expect(terminalToolFilePaths('codex', 'apply_patch', { command }), JSON.stringify(command)).toBeNull();
    expect(terminalToolFilePaths('codex', 'apply_patch', { command: 7 })).toBeNull();
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

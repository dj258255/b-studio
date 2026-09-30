import { describe, expect, it } from 'vitest';
import type { StudioEvent } from './studio-events';
import {
  BIG_READ_CHARS,
  buildNoteSummaryRequest,
  buildScriptRequest,
  findRepeatedActions,
  normalizeCommandText,
  normalizeWhitespace,
  stripVolatile,
  type RepeatedActionsSessionInput,
} from './repeated-actions';

// ---------- 픽스처 도우미 ----------

function toolCall(runId: string, name: string, input: unknown): StudioEvent {
  return { type: 'agent', runId, event: { type: 'tool_call', name, input } };
}

function toolResult(runId: string, name: string, chars: number): StudioEvent {
  return { type: 'agent', runId, event: { type: 'tool_result', name, ok: true, content: 'x'.repeat(Math.min(chars, 40)), chars } };
}

/** 실행 하나를 도구 호출 목록으로 만든다(run_started/run_finished로 감싼다) */
function run(runId: string, calls: Array<{ name: string; input: unknown; chars?: number }>): StudioEvent[] {
  const events: StudioEvent[] = [{ type: 'run_started', runId, request: `요청 ${runId}` }];
  for (const call of calls) {
    events.push(toolCall(runId, call.name, call.input));
    events.push(toolResult(runId, call.name, call.chars ?? 100));
  }
  events.push({ type: 'run_finished', runId, status: 'done', summary: '끝' });
  return events;
}

function sessionOf(sessionId: string, ...runs: StudioEvent[][]): RepeatedActionsSessionInput {
  return { sessionId, events: runs.flat() };
}

const runCommand = (service: string, command: string[], chars = 100) => ({ name: 'run_in_service', input: { service, command }, chars });
const readFile = (path: string, chars = 100) => ({ name: 'read_file', input: { path }, chars });
const listFiles = (path: string, chars = 100) => ({ name: 'list_files', input: { path }, chars });

// ---------- 정규화 ----------

describe('stripVolatile', () => {
  it('임시 경로·uuid·시각·포트·epoch를 표시자로 바꾼다', () => {
    expect(stripVolatile('/tmp/b-studio-orders-8f3a/run.log')).toBe('<tmp>');
    expect(stripVolatile('/private/var/folders/zz/abcd1234/T/orders/run.log')).toBe('<tmp>');
    expect(stripVolatile('id 4b1f1c1a-7e2b-4c3d-9a1b-1234567890ab 완료')).toBe('id <uuid> 완료');
    expect(stripVolatile('2026-09-30T12:00:00.000Z에 시작')).toBe('<timestamp>에 시작');
    expect(stripVolatile('--port 54231로 기동')).toBe('--port <port>로 기동');
    expect(stripVolatile('localhost:5432 접속')).toBe('localhost:<port> 접속');
    expect(stripVolatile('epoch 1735689600000 기록')).toBe('epoch <epoch> 기록');
  });

  it('평범한 텍스트는 그대로 둔다', () => {
    expect(stripVolatile('pnpm test --filter web')).toBe('pnpm test --filter web');
  });
});

describe('normalizeWhitespace', () => {
  it('앞뒤 공백을 없애고 연속 공백을 하나로 줄인다', () => {
    expect(normalizeWhitespace('  pnpm   test  \n--filter  web  ')).toBe('pnpm test --filter web');
  });
});

describe('normalizeCommandText', () => {
  it('서비스와 인자를 합치고 변동 부분을 지운 뒤 비교 가능한 키를 만든다', () => {
    const a = normalizeCommandText('web', ['pnpm', 'test', '--port', '54231']);
    const b = normalizeCommandText('web', ['pnpm', 'test', '--port', '61234']);
    expect(a).toBe(b);
  });
});

// ---------- (a) 반복 명령 ----------

describe('findRepeatedActions — 반복 명령', () => {
  it('같은 명령이 실행 2개에 걸쳐 3번 반복되면 후보가 된다', () => {
    const sessions = [
      sessionOf('s1', run('r1', [runCommand('web', ['pnpm', 'test'])]), run('r2', [runCommand('web', ['pnpm', 'test'])])),
      sessionOf('s2', run('r3', [runCommand('web', ['pnpm', 'test'])])),
    ];

    const candidates = findRepeatedActions(sessions);
    const command = candidates.find((c) => c.kind === 'command');
    expect(command).toBeDefined();
    expect(command!.occurrences).toBe(3);
    expect(command!.runCount).toBe(3);
    expect(command!.sessionCount).toBe(2);
    expect(command!.suggestion.scriptName).toMatch(/^web-pnpm/);
    expect(command!.suggestion.scriptBody).toContain('pnpm test');
  });

  it('변동 부분(포트·임시 경로)만 다르면 같은 명령으로 묶는다', () => {
    const sessions = [
      sessionOf(
        's1',
        run('r1', [runCommand('web', ['curl', 'localhost:5432/health'])]),
        run('r2', [runCommand('web', ['curl', 'localhost:5555/health'])]),
        run('r3', [runCommand('web', ['curl', 'localhost:6000/health'])]),
      ),
    ];

    const candidates = findRepeatedActions(sessions);
    expect(candidates.filter((c) => c.kind === 'command')).toHaveLength(1);
  });

  it('실행이 하나뿐이면(반복이 다른 실행에 걸치지 않으면) 후보로 보지 않는다', () => {
    const sessions = [sessionOf('s1', run('r1', [runCommand('web', ['pnpm', 'test']), runCommand('web', ['pnpm', 'test']), runCommand('web', ['pnpm', 'test'])]))];

    expect(findRepeatedActions(sessions).filter((c) => c.kind === 'command')).toHaveLength(0);
  });

  it('반복 횟수가 기준에 못 미치면(2번뿐) 후보로 보지 않는다', () => {
    const sessions = [sessionOf('s1', run('r1', [runCommand('web', ['pnpm', 'test'])]), run('r2', [runCommand('web', ['pnpm', 'test'])]))];

    expect(findRepeatedActions(sessions).filter((c) => c.kind === 'command')).toHaveLength(0);
  });
});

// ---------- (b) 반복 순서 ----------

describe('findRepeatedActions — 반복 순서', () => {
  it('같은 도구 순서가 실행 3개에서 반복되면 후보가 된다', () => {
    const steps = () => [listFiles('src'), readFile('src/a.ts'), runCommand('web', ['pnpm', 'test'])];
    const sessions = [sessionOf('s1', run('r1', steps()), run('r2', steps())), sessionOf('s2', run('r3', steps()))];

    const candidates = findRepeatedActions(sessions);
    const sequence = candidates.find((c) => c.kind === 'sequence');
    expect(sequence).toBeDefined();
    expect(sequence!.runCount).toBe(3);
    expect(sequence!.title).toContain('list_files');
    expect(sequence!.title).toContain('read_file');
    expect(sequence!.title).toContain('run_in_service');
  });

  it('긴 순서가 후보가 되면 그 안에 통째로 들어가는 짧은 부분 순서는 따로 보고하지 않는다', () => {
    const steps = () => [listFiles('src'), readFile('src/a.ts'), runCommand('web', ['pnpm', 'test'])];
    const sessions = [sessionOf('s1', run('r1', steps()), run('r2', steps()), run('r3', steps()))];

    const candidates = findRepeatedActions(sessions).filter((c) => c.kind === 'sequence');
    // 길이 3짜리 순서 하나만 남고, 그 안에 포함되는 길이 2짜리(list_files→read_file, read_file→run_in_service)는 버려진다
    expect(candidates).toHaveLength(1);
  });

  it('도구 이름은 같아도 입력(경로)이 다르면 다른 신호로 본다', () => {
    const sessions = [
      sessionOf(
        's1',
        run('r1', [readFile('src/a.ts'), runCommand('web', ['pnpm', 'test'])]),
        run('r2', [readFile('src/b.ts'), runCommand('web', ['pnpm', 'test'])]),
        run('r3', [readFile('src/c.ts'), runCommand('web', ['pnpm', 'test'])]),
      ),
    ];

    expect(findRepeatedActions(sessions).filter((c) => c.kind === 'sequence')).toHaveLength(0);
  });

  it('run_in_service만으로 이뤄진 순서는 셸 스크립트 초안을 명령 그대로 담는다', () => {
    const steps = () => [runCommand('web', ['pnpm', 'lint']), runCommand('web', ['pnpm', 'test'])];
    const sessions = [sessionOf('s1', run('r1', steps()), run('r2', steps()), run('r3', steps()))];

    const sequence = findRepeatedActions(sessions).find((c) => c.kind === 'sequence')!;
    expect(sequence.suggestion.scriptBody).toContain('pnpm lint');
    expect(sequence.suggestion.scriptBody).toContain('pnpm test');
  });
});

// ---------- (c) 반복해서 크게 읽는 파일 ----------

describe('findRepeatedActions — 반복해서 크게 읽는 파일', () => {
  it('큰 파일을 실행 3개에서 다시 읽으면 노트 제안 후보가 된다', () => {
    const sessions = [
      sessionOf('s1', run('r1', [readFile('docs/spec.md', BIG_READ_CHARS + 500)]), run('r2', [readFile('docs/spec.md', BIG_READ_CHARS + 200)])),
      sessionOf('s2', run('r3', [readFile('docs/spec.md', BIG_READ_CHARS + 900)])),
    ];

    const candidates = findRepeatedActions(sessions);
    const bigRead = candidates.find((c) => c.kind === 'big_read');
    expect(bigRead).toBeDefined();
    expect(bigRead!.runCount).toBe(3);
    expect(bigRead!.suggestion.noteText).toContain('docs/spec.md');
    expect(bigRead!.suggestion.scriptName).toBeUndefined();
  });

  it('예산보다 작은 읽기는 세지 않는다', () => {
    const sessions = [
      sessionOf(
        's1',
        run('r1', [readFile('docs/spec.md', BIG_READ_CHARS - 1)]),
        run('r2', [readFile('docs/spec.md', BIG_READ_CHARS - 1)]),
        run('r3', [readFile('docs/spec.md', BIG_READ_CHARS - 1)]),
      ),
    ];

    expect(findRepeatedActions(sessions).filter((c) => c.kind === 'big_read')).toHaveLength(0);
  });
});

// ---------- 비용 대리 지표·정렬·상한 ----------

describe('findRepeatedActions — 비용 대리 지표와 정렬', () => {
  it('totalChars는 결과 글자 수 합이고, 큰 순서로 정렬한다', () => {
    const smallSteps = () => [runCommand('web', ['pnpm', 'lint'], 50)];
    const bigSteps = () => [runCommand('worker', ['pnpm', 'build'], 9_000)];
    const sessions = [
      sessionOf('s1', run('r1', smallSteps()), run('r2', smallSteps())),
      sessionOf('s2', run('r3', smallSteps())),
      sessionOf('s3', run('r4', bigSteps()), run('r5', bigSteps())),
      sessionOf('s4', run('r6', bigSteps())),
    ];

    const candidates = findRepeatedActions(sessions).filter((c) => c.kind === 'command');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.totalChars).toBeGreaterThan(candidates[1]!.totalChars);
    expect(candidates[0]!.totalChars).toBe(27_000);
    expect(candidates[1]!.totalChars).toBe(150);
  });

  it('세션 상한을 넘는 오래된 세션은 보지 않는다', () => {
    const recent = Array.from({ length: 25 }, (_, i) => sessionOf(`s${i}`, run(`r${i}`, [])));
    const withOldRepeat = [
      sessionOf('old-1', run('old-r1', [runCommand('web', ['pnpm', 'test'])])),
      sessionOf('old-2', run('old-r2', [runCommand('web', ['pnpm', 'test'])])),
      sessionOf('old-3', run('old-r3', [runCommand('web', ['pnpm', 'test'])])),
      ...recent,
    ];

    // 상한 안에 반복 명령이 든 세 세션만 있으면 후보가 나온다
    expect(findRepeatedActions(withOldRepeat, { maxSessions: 3 }).filter((c) => c.kind === 'command')).toHaveLength(1);
    // 반복 명령이 든 세션이 상한(20개) 뒤로 밀리면 후보가 나오지 않는다
    expect(findRepeatedActions([...recent, ...withOldRepeat.slice(0, 3)], { maxSessions: 20 }).filter((c) => c.kind === 'command')).toHaveLength(0);
  });
});

// ---------- 대화 프리필 ----------

describe('buildScriptRequest / buildNoteSummaryRequest', () => {
  it('스크립트 요청은 파일 경로·초안·실행 권한·AGENTS.md의 "## 스크립트" 절 안내를 담는다', () => {
    const [candidate] = findRepeatedActions([
      sessionOf('s1', run('r1', [runCommand('web', ['pnpm', 'test'])]), run('r2', [runCommand('web', ['pnpm', 'test'])]), run('r3', [runCommand('web', ['pnpm', 'test'])])),
    ]);
    const text = buildScriptRequest(candidate!);
    expect(text).toContain(`scripts/${candidate!.suggestion.scriptName}.sh`);
    expect(text).toContain('chmod +x');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('## 스크립트');
    expect(text).toContain('pnpm test');
  });

  it('노트 요약 요청은 파일 경로와 AGENTS.md의 "## 메모" 절 안내를 담는다', () => {
    const sessions = [
      sessionOf('s1', run('r1', [readFile('docs/spec.md', BIG_READ_CHARS + 100)]), run('r2', [readFile('docs/spec.md', BIG_READ_CHARS + 100)])),
      sessionOf('s2', run('r3', [readFile('docs/spec.md', BIG_READ_CHARS + 100)])),
    ];
    const candidate = findRepeatedActions(sessions).find((c) => c.kind === 'big_read')!;
    const text = buildNoteSummaryRequest(candidate);
    expect(text).toContain('docs/spec.md');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('## 메모');
  });
});

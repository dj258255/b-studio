import { describe, expect, it } from 'vitest';
import { boardMcpToolSpecs, externalBoardAccess, runBoardMcpTool } from './board-mcp';
import { Board } from './coordination';

function starBoard() {
  return new Board({ topology: 'star', hub: 'plan' });
}

describe('boardMcpToolSpecs', () => {
  it('쓰기 가능하면 post_note·read_notes 둘 다, 읽기 전용이면 read_notes만 준다', () => {
    expect(boardMcpToolSpecs({ modelWrites: true }).map((spec) => spec.name)).toEqual(['post_note', 'read_notes']);
    expect(boardMcpToolSpecs({}).map((spec) => spec.name)).toEqual(['post_note', 'read_notes']);
    expect(boardMcpToolSpecs({ modelWrites: false }).map((spec) => spec.name)).toEqual(['read_notes']);
  });

  it('post_note 스키마는 kind를 contract·fact로만 한정한다(failure는 외부 에이전트에 보이지 않는다)', () => {
    const spec = boardMcpToolSpecs({ modelWrites: true }).find((candidate) => candidate.name === 'post_note')!;
    expect((spec.input_schema.properties.kind as { enum: string[] }).enum).toEqual(['contract', 'fact']);
  });
});

describe('runBoardMcpTool', () => {
  it('post_note로 쓰고 read_notes로 읽는다', async () => {
    const board = starBoard();
    const access = externalBoardAccess(board, { lane: 'guest-codex' });

    const posted = await runBoardMcpTool('post_note', { kind: 'fact', body: '환경: node 22', refs: [] }, access);
    expect(posted.ok).toBe(true);
    expect(posted.content).toContain('fact');

    const read = await runBoardMcpTool('read_notes', { kinds: [] }, access);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('환경: node 22');
    expect(read.content).toContain('guest-codex');
  });

  it('외부 에이전트는 실패(failure) 메모를 쓸 수 없다(스키마를 우회해 불러도 Board가 거부한다)', async () => {
    const board = starBoard();
    const access = externalBoardAccess(board, { lane: 'guest-codex' });

    const outcome = await runBoardMcpTool('post_note', { kind: 'failure', body: '가짜 실패', refs: [] }, access);

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Unknown note kind');
    // Board 자체도 플랫폼이 아니면 실패 메모를 거부한다(레인과 같은 규칙)
    const direct = board.post({ kind: 'failure', body: '가짜 실패' }, { lane: 'guest-codex', by: 'model' });
    expect(direct).toEqual({ ok: false, reason: '실패 메모는 검증기만 씁니다' });
  });

  it('modelWrites가 꺼져 있으면(S2·S5) post_note를 거부한다', async () => {
    const board = new Board({ topology: 'mesh', modelWrites: false });
    const access = externalBoardAccess(board, { lane: 'guest-codex' });

    const outcome = await runBoardMcpTool('post_note', { kind: 'fact', body: '아무거나', refs: [] }, access);

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('읽기만');
  });

  it('입력이 잘못되면 실패 결과로 돌려준다(예외를 던지지 않는다)', async () => {
    const board = starBoard();
    const access = externalBoardAccess(board, { lane: 'guest-codex' });

    const badKind = await runBoardMcpTool('post_note', { kind: 123, body: 'x', refs: [] }, access);
    expect(badKind.ok).toBe(false);

    const unknown = await runBoardMcpTool('unknown_tool', {}, access);
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain('Unknown tool');
  });

  it('읽기 상한을 넘기면 안내를 덧붙인다', async () => {
    const board = new Board({ topology: 'mesh', limits: { readLimit: 1 } });
    const access = externalBoardAccess(board, { lane: 'guest-codex' });
    board.post({ kind: 'fact', body: '하나' }, { lane: 'a', by: 'model' });
    board.post({ kind: 'fact', body: '둘' }, { lane: 'b', by: 'model' });

    const read = await runBoardMcpTool('read_notes', { kinds: [] }, access);

    expect(read.content).toContain('[...');
  });
});

describe('externalBoardAccess와 topology', () => {
  it('star에서는 외부 에이전트가 다른 레인의 모델 메모를 읽지 못하지만, 플랫폼 메모와 자기 메모는 읽는다', async () => {
    const board = starBoard();
    board.post({ kind: 'contract', body: '레인 a의 계약', refs: ['api'] }, { lane: 'lane-a', by: 'model' });
    board.post({ kind: 'failure', body: '검증 실패' }, { lane: 'lane-a', by: 'platform' });

    const access = externalBoardAccess(board, { lane: 'guest-codex' });
    access.post({ kind: 'fact', body: '내 메모' });

    const read = await runBoardMcpTool('read_notes', { kinds: [] }, access);

    expect(read.content).not.toContain('레인 a의 계약');
    expect(read.content).toContain('검증 실패');
    expect(read.content).toContain('내 메모');
  });

  it('mesh에서는 외부 에이전트도 다른 레인의 메모를 읽는다', async () => {
    const board = new Board({ topology: 'mesh' });
    board.post({ kind: 'contract', body: '레인 a의 계약', refs: ['api'] }, { lane: 'lane-a', by: 'model' });

    const access = externalBoardAccess(board, { lane: 'guest-codex' });
    const read = await runBoardMcpTool('read_notes', { kinds: [] }, access);

    expect(read.content).toContain('레인 a의 계약');
  });

  it('본문·refs를 가림 함수로 가린 뒤에 게시한다', () => {
    const board = new Board({ topology: 'mesh' });
    const redact = (text: string) => text.replace('비밀', '***');
    const access = externalBoardAccess(board, { lane: 'guest-codex' }, redact);

    access.post({ kind: 'fact', body: '값은 비밀이다', refs: ['비밀/경로'] });

    const notes = board.snapshot();
    expect(notes[0]!.body).toBe('값은 ***이다');
    expect(notes[0]!.refs).toEqual(['***/경로']);
  });
});

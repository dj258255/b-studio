import type { VerificationReport } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { createView, reduceSession } from './session-view';
import type { SessionSnapshot, StudioEvent } from './studio-events';
import {
  clampSplit,
  decodeTerminalData,
  readAgentSurface,
  readRecordOpen,
  readSplit,
  SPLIT_DEFAULT,
  terminalActivity,
  terminalGateStatus,
  terminalPasteText,
  terminalStatusLabel,
  writeAgentSurface,
  writeRecordOpen,
  writeSplit,
} from './terminal';

describe('세션 터미널 화면의 순수 함수', () => {
  it('base64 출력을 바이트 그대로 되돌린다(제어 문자와 여러 바이트 글자)', () => {
    const bytes = Buffer.concat([Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]), Buffer.from('한글', 'utf8'), Buffer.from([0xff, 0x00])]);
    expect(Buffer.from(decodeTerminalData(bytes.toString('base64')))).toEqual(bytes);
  });

  it('상태를 한 줄로 알린다. 닫힌 사유와 종료 코드를 숨기지 않는다', () => {
    expect(terminalStatusLabel({ state: 'opening' })).toBe('컨테이너를 준비하는 중');
    expect(terminalStatusLabel({ state: 'open' })).toBe('열림');
    expect(terminalStatusLabel({ state: 'closed', message: '터미널을 열지 못했습니다: 이미지가 없습니다' })).toBe('닫힘 — 터미널을 열지 못했습니다: 이미지가 없습니다');
    expect(terminalStatusLabel({ state: 'exited', code: 0 })).toBe('터미널이 끝났습니다');
    expect(terminalStatusLabel({ state: 'exited', code: 137 })).toBe('터미널이 끝났습니다 (종료 코드 137)');
  });

  const memory = () => {
    const store = new Map<string, string>();
    return { store, storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } };
  };
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };

  it('일을 시키는 자리는 터미널이 기본이다. 사람이 대화 입력을 골랐을 때만 대화로 열린다(이슈 #689)', () => {
    const { store, storage } = memory();
    expect(readAgentSurface(storage)).toBe('terminal');
    writeAgentSurface(storage, 'chat');
    expect(readAgentSurface(storage)).toBe('chat');
    writeAgentSurface(storage, 'terminal');
    expect(readAgentSurface(storage)).toBe('terminal');
    store.set('b-studio:agent-surface', '<script>');
    expect(readAgentSurface(storage)).toBe('terminal');
    expect(readAgentSurface(broken)).toBe('terminal');
    expect(() => writeAgentSurface(broken, 'chat')).not.toThrow();
    expect(readAgentSurface(undefined)).toBe('terminal');
  });

  it('경계의 자리를 기억하되 쓸 수 없을 만큼 좁아지지 않게 범위 안으로 맞춘다', () => {
    const { store, storage } = memory();
    expect(readSplit(storage)).toBe(SPLIT_DEFAULT);
    writeSplit(storage, 0.62);
    expect(readSplit(storage)).toBe(0.62);
    writeSplit(storage, 0.95);
    expect(readSplit(storage)).toBe(0.7);
    writeSplit(storage, 0.01);
    expect(readSplit(storage)).toBe(0.3);
    store.set('b-studio:terminal-split', 'wide');
    expect(readSplit(storage)).toBe(SPLIT_DEFAULT);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
    expect(readSplit(broken)).toBe(SPLIT_DEFAULT);
    expect(() => writeSplit(broken, 0.4)).not.toThrow();
  });

  it('활동 기록을 펼쳐 뒀는지 기억한다. 기본은 접힘이다', () => {
    const { storage } = memory();
    expect(readRecordOpen(storage)).toBe(false);
    writeRecordOpen(storage, true);
    expect(readRecordOpen(storage)).toBe(true);
    writeRecordOpen(storage, false);
    expect(readRecordOpen(storage)).toBe(false);
    expect(readRecordOpen(broken)).toBe(false);
    expect(() => writeRecordOpen(broken, true)).not.toThrow();
  });

  it('다른 패널이 넘긴 글을 터미널에 붙여 넣을 꼴로 다듬는다. 읽기만은 스위치 대신 글로 적는다', () => {
    expect(terminalPasteText('  #12 이슈를 해결해줘: 정렬 추가\r\n\r\n본문  ')).toBe('#12 이슈를 해결해줘: 정렬 추가\n\n본문');
    expect(terminalPasteText('R3가 무슨 뜻인지 알려줘', { readOnly: true })).toBe('파일은 바꾸지 말고 답만 해 주세요.\n\nR3가 무슨 뜻인지 알려줘');
    expect(terminalPasteText('   ', { readOnly: true })).toBe('');
  });
});

describe('터미널에서 보낸 마지막 요청의 검증 상태 (이슈 #673 2단계)', () => {
  const snapshot: SessionSnapshot = { id: 's1', projectId: 'orders', projectName: 'orders', workDir: '/tmp/orders-s1', status: 'ready', mode: 'claude-code', running: false, checkpoints: [], services: [] };
  const report = (ok: boolean) => ({ ok, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }) satisfies VerificationReport;
  /** 화면이 실제로 받는 이벤트에서 대화 항목을 만든다(항목을 손으로 지어내지 않는다) */
  const chatOf = (events: StudioEvent[]) => events.reduce(reduceSession, createView(snapshot)).chat;
  const started: StudioEvent = { type: 'run_started', runId: 't1', request: '메모 필드 추가', via: 'terminal' };
  const verifying: StudioEvent = { type: 'agent', runId: 't1', event: { type: 'verify_start', files: ['api/Order.java'] } };
  const verified = (ok: boolean): StudioEvent => ({ type: 'agent', runId: 't1', event: { type: 'verify_result', report: report(ok), text: '' } });
  const check = (ok: boolean): StudioEvent => ({ type: 'agent', runId: 't1', event: { type: 'workflow_check', check: { stage: 'test', name: 'unit', ok, attempts: 1 } } });
  const finished = (status: 'done' | 'failed' | 'cancelled' | 'error'): StudioEvent => ({ type: 'run_finished', runId: 't1', status, summary: '끝' });

  it('터미널에서 보낸 요청이 없으면 아무것도 보이지 않는다. 대화 창의 요청은 세지 않는다', () => {
    expect(terminalGateStatus(chatOf([]))).toBeUndefined();
    expect(terminalGateStatus(chatOf([{ type: 'run_started', runId: 'c1', request: '대화 창 요청' }, verifying]))).toBeUndefined();
  });

  it('처리 중 → 검증 중 → 통과(체크포인트)를 차례로 알린다', () => {
    expect(terminalGateStatus(chatOf([started]))).toMatchObject({ tone: 'working', text: expect.stringContaining('턴이 끝나면 검증합니다') });
    expect(terminalGateStatus(chatOf([started, verifying]))).toMatchObject({ tone: 'working', text: expect.stringContaining('검증하는 중') });
    // 재시작·계약 결과가 통과로 와도 테스트가 이어지는 동안은 아직 검증 중이다
    expect(terminalGateStatus(chatOf([started, verifying, verified(true)]))).toMatchObject({ tone: 'working' });
    expect(terminalGateStatus(chatOf([started, verifying, verified(true), check(true), finished('done')]))).toMatchObject({ tone: 'ok', text: expect.stringContaining('체크포인트') });
  });

  it('검증에 실패해 에이전트에게 돌려준 상태를 통과와 구분한다. 선언한 확인의 실패도 실패다', () => {
    expect(terminalGateStatus(chatOf([started, verifying, verified(false)]))).toMatchObject({ tone: 'fail', text: expect.stringContaining('에이전트에게 돌려줬습니다') });
    expect(terminalGateStatus(chatOf([started, verifying, verified(true), check(false)]))).toMatchObject({ tone: 'fail' });
    // 고친 뒤 다시 검증이 시작되면 앞 검증의 실패는 지금 상태가 아니다
    expect(terminalGateStatus(chatOf([started, verifying, verified(true), check(false), verifying]))).toMatchObject({ tone: 'working', text: expect.stringContaining('검증하는 중') });
  });

  it('끝난 요청: 실패·닫힘·검증 못 함을 통과처럼 보이지 않게 한다. 파일을 바꾸지 않은 요청은 체크포인트를 말하지 않는다', () => {
    expect(terminalGateStatus(chatOf([started, verifying, verified(true), check(false), finished('failed')]))).toMatchObject({ tone: 'fail', text: expect.stringContaining('변경을 되돌렸습니다') });
    expect(terminalGateStatus(chatOf([started, finished('cancelled')]))).toMatchObject({ tone: 'idle', text: expect.stringContaining('닫고 변경을 되돌렸습니다') });
    expect(terminalGateStatus(chatOf([started, finished('error')]))).toMatchObject({ tone: 'fail', text: expect.stringContaining('검증하지 못했습니다') });
    const answered = terminalGateStatus(chatOf([started, finished('done')]))!;
    expect(answered.tone).toBe('idle');
    expect(answered.text).not.toContain('체크포인트');
  });

  it('가장 최근의 터미널 요청을 본다', () => {
    const later: StudioEvent = { type: 'run_started', runId: 't2', request: '다음 요청', via: 'terminal' };
    expect(terminalGateStatus(chatOf([started, verifying, verified(true), finished('done'), later]))).toMatchObject({ tone: 'working', text: expect.stringContaining('턴이 끝나면') });
  });

  describe('활동 줄(이슈 #689)', () => {
    const checkOf = (stage: string, name: string, ok: boolean): StudioEvent => ({ type: 'agent', runId: 't1', event: { type: 'workflow_check', check: { stage: stage as never, name, ok, attempts: 1 } } });
    const points = [{ shortSha: '7e12902' }, { shortSha: 'c846466' }];

    it('터미널 요청이 없으면 단계가 없고, 체크포인트가 세션 시작뿐이면 체크포인트도 없다', () => {
      expect(terminalActivity(chatOf([]), [{ shortSha: 'c846466' }])).toEqual({ stages: [] });
      // 대화 창의 요청은 활동 줄의 단계로 세지 않는다
      expect(terminalActivity(chatOf([{ type: 'run_started', runId: 'c1', request: '대화 창 요청' }, verifying, verified(true)]), [{ shortSha: 'c846466' }]).stages).toEqual([]);
    });

    it('마지막 검증 회차가 확인한 단계를 순서대로, 단계마다 하나로 모은다', () => {
      const activity = terminalActivity(chatOf([started, verifying, verified(true), checkOf('test', 'unit', true), checkOf('test', 'web', true), checkOf('review', 'protected-paths', true), finished('done')]), points);
      expect(activity.stages).toEqual([{ stage: 'run', ok: true }, { stage: 'test', ok: true }, { stage: 'review', ok: true }]);
      expect(activity.status).toMatchObject({ tone: 'ok' });
      expect(activity.checkpoint).toEqual({ shortSha: '7e12902', incomplete: false });
    });

    it('한 단계의 확인 가운데 하나라도 실패하면 그 단계는 실패다', () => {
      const activity = terminalActivity(chatOf([started, verifying, verified(true), checkOf('test', 'unit', true), checkOf('test', 'web', false)]), points);
      expect(activity.stages).toEqual([{ stage: 'run', ok: true }, { stage: 'test', ok: false }]);
    });

    it('고친 뒤 다시 검증하면 앞 회차의 단계는 지우고 새 회차의 것만 보인다', () => {
      const chat = chatOf([started, verifying, verified(true), checkOf('test', 'unit', false), verifying, verified(true), checkOf('test', 'unit', true)]);
      expect(terminalActivity(chat, points).stages).toEqual([{ stage: 'run', ok: true }, { stage: 'test', ok: true }]);
      // 새 회차가 막 시작돼 아직 결과가 없으면 단계도 없다(앞 회차의 실패를 지금 상태처럼 보이지 않게 한다)
      expect(terminalActivity(chatOf([started, verifying, verified(false), verifying]), points).stages).toEqual([]);
    });

    it('서비스 재시작이나 계약 비교가 실패하면 실행 단계가 실패다', () => {
      expect(terminalActivity(chatOf([started, verifying, verified(false)]), points).stages).toEqual([{ stage: 'run', ok: false }]);
    });

    it('턴 상한에서 남긴 체크포인트는 그렇다고 알린다', () => {
      expect(terminalActivity(chatOf([]), [{ shortSha: '7e12902', incomplete: 'max_turns' }, { shortSha: 'c846466' }]).checkpoint).toEqual({ shortSha: '7e12902', incomplete: true });
    });
  });
});

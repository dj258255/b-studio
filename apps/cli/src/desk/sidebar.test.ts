import { describe, expect, it } from 'vitest';
import { agentStatus, gateStatus, sidebarRows } from './sidebar';
import type { DeskItem } from './types';

const base: DeskItem = { kind: 'session', id: 's1', title: '주문 목록', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-22T00:00:00Z' };

describe('사이드바 상태', () => {
  it('권한을 묻는 터미널은 작업 중보다 먼저 "권한 대기"로 보인다', () => {
    expect(agentStatus({ ...base, state: 'working', terminal: { cli: 'up', waiting: 'permission' } })).toEqual({ label: '권한 대기', tone: 'warn' });
  });

  it('작업 중, 답 기다림, CLI 대기, 쉼, 오류를 가른다', () => {
    expect(agentStatus({ ...base, state: 'working' }).label).toBe('작업 중');
    expect(agentStatus({ ...base, attention: 'question' }).label).toBe('답 기다림');
    expect(agentStatus({ ...base, terminal: { cli: 'up' } }).label).toBe('CLI 대기');
    expect(agentStatus({ ...base, terminal: { cli: 'down' } }).label).toBe('쉼');
    expect(agentStatus({ ...base, state: 'error' })).toEqual({ label: '오류', tone: 'fail' });
  });

  it('게이트 상태를 싣는 서버면 그것을, 아니면 개입 사유로 실패만 보인다', () => {
    expect(gateStatus({ ...base, gate: { state: 'verifying', checkpoints: 2 } })).toEqual({ label: '검증 중', tone: 'busy' });
    expect(gateStatus({ ...base, gate: { state: 'passed', checkpoints: 2 } })).toEqual({ label: '통과', tone: 'ok' });
    expect(gateStatus({ ...base, gate: { state: 'failed', checkpoints: 0 } })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus({ ...base, gate: { state: 'none', checkpoints: 0 } })).toBeUndefined();
    expect(gateStatus({ ...base, attention: 'gate_failed' })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus(base)).toBeUndefined();
  });

  it('통과했어도 확인 필요로 표시된 실행은 "확인 필요"가 이긴다', () => {
    expect(gateStatus({ ...base, attention: 'needs_review', gate: { state: 'passed', checkpoints: 1 } })).toEqual({ label: '확인 필요', tone: 'warn' });
  });
});

describe('사이드바 줄', () => {
  it('항목마다 두 줄: AI·프로젝트, 그 아래 상태·게이트·체크포인트·비용', () => {
    const rows = sidebarRows([{ ...base, state: 'working', gate: { state: 'passed', checkpoints: 3 }, costUsd: 0.1234 }], 0, new Map(), 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toContain('Claude');
    expect(rows[0]!.text).toContain('shop');
    expect(rows[0]!.selected).toBe(true);
    expect(rows[1]!.text).toContain('작업 중');
    expect(rows[1]!.text).toContain('통과');
    expect(rows[1]!.text).toContain('체크포인트 3');
    expect(rows[1]!.text).toContain('$0.12');
  });

  it('칸에 열린 세션은 칸 번호를 붙이고, 계획 승인 같은 세션 밖 항목은 뺀다', () => {
    const rows = sidebarRows([base, { ...base, id: 'plan:p1', kind: 'lane' }], 0, new Map([['s1', 2]]), 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toContain('[2]');
  });

  it('항목이 없으면 새 요청 안내 한 줄', () => {
    const rows = sidebarRows([], 0, new Map(), 40);
    expect(rows.map((row) => row.text).join('\n')).toContain('Ctrl-b n');
  });
});

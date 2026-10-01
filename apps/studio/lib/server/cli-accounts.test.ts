/**
 * cli-accounts.ts 테스트. 실제 로그인은 절대 실행하지 않는다 — child_process.spawn은 항상 가짜로 바꿔 끼우고,
 * preflight 함수도 주입한 가짜로 바꾼다(진짜 CLI를 부르지 않는다).
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelLogin,
  checkAccountStatus,
  extractLoginHint,
  getLoginProgress,
  isCliAccountBackend,
  listAccountStatuses,
  LOGIN_TIMEOUT_MS,
  loginCommandFor,
  loginCommandText,
  type MinimalChildProcess,
  resetLoginSessionsForTest,
  startLogin,
} from './cli-accounts';

beforeEach(() => {
  resetLoginSessionsForTest();
});

describe('isCliAccountBackend', () => {
  it('네 백엔드만 참이다', () => {
    expect(isCliAccountBackend('claude-code')).toBe(true);
    expect(isCliAccountBackend('codex')).toBe(true);
    expect(isCliAccountBackend('commandcode')).toBe(true);
    expect(isCliAccountBackend('opencode')).toBe(true);
    expect(isCliAccountBackend('api')).toBe(false);
    expect(isCliAccountBackend('demo')).toBe(false);
    expect(isCliAccountBackend(123)).toBe(false);
  });
});

describe('loginCommandFor / loginCommandText', () => {
  it('claude-code는 --claudeai로 선택 메뉴를 건너뛴다', () => {
    expect(loginCommandText('claude-code')).toBe('claude auth login --claudeai');
    expect(loginCommandFor('claude-code').spawnable).toBe(true);
  });

  it('codex는 기기 인증 플래그를 쓴다', () => {
    expect(loginCommandText('codex')).toBe('codex login --device-auth');
  });

  it('commandcode는 provider 인자 없이 cmd 계정으로 로그인한다', () => {
    expect(loginCommandText('commandcode')).toBe('cmd login');
  });

  it('opencode는 대화형 CLI라 자동으로 띄우지 않는다', () => {
    const spec = loginCommandFor('opencode');
    expect(spec.spawnable).toBe(false);
    expect(spec.note).toBeTruthy();
    expect(loginCommandText('opencode')).toBe('opencode auth login');
  });
});

describe('extractLoginHint', () => {
  // 아래 줄은 실제로 CLI를 실행해 관측한 출력이 아니다(지시에 따라 로그인을 실제로 시작하지 않았다).
  // codex login --device-auth의 --device-auth 플래그와, 일반적인 OAuth 기기 인증 흐름(GitHub CLI 등)의
  // 공개된 문구 꼴을 본떠 만든 합성(synthetic) 픽스처다.
  it('기기 인증 문구에서 URL과 코드를 함께 찾는다(합성 픽스처)', () => {
    const line = 'To authenticate, visit https://github.com/login/device and enter code WXYZ-1234';
    expect(extractLoginHint(line)).toEqual({ url: 'https://github.com/login/device', code: 'WXYZ-1234' });
  });

  it('URL만 있는 줄은 URL만 찾는다(합성 픽스처, claude auth login 꼴)', () => {
    const line = 'Please visit the following URL to authorize this device: https://claude.ai/oauth/authorize?state=abc123';
    const hint = extractLoginHint(line);
    expect(hint.url).toBe('https://claude.ai/oauth/authorize?state=abc123');
    expect(hint.code).toBeUndefined();
  });

  it('URL 쿼리 안에 코드처럼 보이는 글자가 있어도 URL 안의 것은 코드로 잘못 집지 않는다(합성 픽스처)', () => {
    const line = 'Open https://example.com/login?code=AB12CD34 to finish signing in';
    const hint = extractLoginHint(line);
    expect(hint.url).toBe('https://example.com/login?code=AB12CD34');
    expect(hint.code).toBeUndefined();
  });

  it('URL이 없으면 코드만 찾는다(합성 픽스처)', () => {
    expect(extractLoginHint('Enter this code on the other device: AB12CD34')).toEqual({ code: 'AB12CD34' });
  });

  it('URL도 코드도 없는 줄은 빈 값이다', () => {
    expect(extractLoginHint('Waiting for authorization...')).toEqual({});
    expect(extractLoginHint('')).toEqual({});
  });
});

describe('checkAccountStatus', () => {
  it('claude-code: 연결돼 있으면 계정 종류를 담는다', async () => {
    const status = await checkAccountStatus('claude-code', {
      claudeCode: async () => ({ ok: true, account: { subscriptionType: 'max' } }),
    });
    expect(status).toEqual({ backend: 'claude-code', label: '로컬 Claude Agent', connected: true, installed: true, accountKind: 'max 구독' });
  });

  it('claude-code: 로그인 안 됐으면 설치는 돼 있다고 본다', async () => {
    const status = await checkAccountStatus('claude-code', {
      claudeCode: async () => ({ ok: false, reason: 'Claude Code에 로그인돼 있지 않습니다. 터미널에서 `claude`를 실행해 /login으로 로그인하세요.' }),
    });
    expect(status.connected).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.reason).toContain('로그인돼 있지 않습니다');
  });

  it('codex: CLI를 못 찾으면(ENOENT) 설치 안 됨으로 본다', async () => {
    const status = await checkAccountStatus('codex', {
      codex: async () => ({ ok: false, reason: 'Codex CLI에 로그인돼 있지 않습니다. (spawn codex ENOENT)' }),
    });
    expect(status.connected).toBe(false);
    expect(status.installed).toBe(false);
  });

  it('commandcode: 연결되면 계정 종류 없이 연결됨만 돌려준다(토큰 파일을 읽지 않으므로 지어내지 않는다)', async () => {
    const status = await checkAccountStatus('commandcode', { commandCode: async () => ({ ok: true }) });
    expect(status).toEqual({ backend: 'commandcode', label: '로컬 Command Code Agent', connected: true, installed: true });
  });

  it('opencode: 연결 안 됐고 설치도 안 됐으면', async () => {
    const status = await checkAccountStatus('opencode', {
      openCode: async () => ({ ok: false, reason: 'OpenCode CLI를 찾지 못했습니다. (command not found: opencode)' }),
    });
    expect(status.connected).toBe(false);
    expect(status.installed).toBe(false);
  });
});

describe('listAccountStatuses', () => {
  it('네 백엔드를 모두 확인한다', async () => {
    const statuses = await listAccountStatuses({
      claudeCode: async () => ({ ok: true, account: {} }),
      codex: async () => ({ ok: true }),
      commandCode: async () => ({ ok: false, reason: '로그인 필요' }),
      openCode: async () => ({ ok: false, reason: '로그인 필요' }),
    });
    expect(statuses.map((status) => status.backend)).toEqual(['claude-code', 'codex', 'commandcode', 'opencode']);
    expect(statuses.filter((status) => status.connected)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 로그인 시작·진행·취소(가짜 child_process)

/** stdout·stderr을 흉내 내는 최소 가짜 자식 프로세스. 실제 프로세스를 띄우지 않는다 */
function fakeChild(): MinimalChildProcess & EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const kill = vi.fn();
  return Object.assign(emitter, { stdout, stderr, kill });
}

describe('startLogin / getLoginProgress / cancelLogin (상태 기계)', () => {
  it('시작하면 running 상태고, 로그 줄에서 URL·코드를 뽑는다(합성 픽스처)', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);

    const progress = startLogin('codex', { spawn });

    expect(spawn).toHaveBeenCalledWith('codex', ['login', '--device-auth'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(progress.state).toBe('running');

    child.stdout.emit('data', 'To authenticate, visit https://github.com/login/device and enter code WXYZ-1234\n');

    expect(progress.url).toBe('https://github.com/login/device');
    expect(progress.code).toBe('WXYZ-1234');
    expect(progress.lines).toContain('To authenticate, visit https://github.com/login/device and enter code WXYZ-1234');
  });

  it('이미 돌고 있으면 다시 띄우지 않고 같은 진행 상황을 돌려준다', () => {
    const spawn = vi.fn(() => fakeChild());
    const first = startLogin('codex', { spawn });
    const second = startLogin('codex', { spawn });

    expect(second).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('프로세스가 끝나면 exited 상태와 종료 코드를 남긴다', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const progress = startLogin('codex', { spawn });

    child.emit('exit', 0);

    expect(progress.state).toBe('exited');
    expect(progress.exitCode).toBe(0);
    expect(getLoginProgress('codex')).toBe(progress);
  });

  it('취소하면 프로세스를 죽이고 cancelled 상태로 남는다', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    startLogin('codex', { spawn });

    const progress = cancelLogin('codex');

    expect(progress?.state).toBe('cancelled');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('돌고 있지 않으면 취소해도 아무 일도 없다', () => {
    expect(cancelLogin('codex')).toBeUndefined();
  });

  it('시간이 지나면 timeout으로 자동 취소한다', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const spawn = vi.fn(() => child);
      const progress = startLogin('codex', { spawn, timeoutMs: 1000 });

      vi.advanceTimersByTime(1000);

      expect(progress.state).toBe('timeout');
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('기본 타임아웃은 10분이다', () => {
    expect(LOGIN_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('spawn 오류가 나면 exited 상태로 이유를 남긴다', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const progress = startLogin('codex', { spawn });

    child.emit('error', new Error('spawn codex ENOENT'));

    expect(progress.state).toBe('exited');
    expect(progress.error).toContain('ENOENT');
  });

  it('opencode처럼 자동으로 못 띄우는 백엔드는 시작 자체를 거부한다', () => {
    expect(() => startLogin('opencode')).toThrow(/대화형/);
  });

  it('로그가 200줄을 넘으면 앞에서부터 자른다', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const progress = startLogin('codex', { spawn });

    for (let i = 0; i < 250; i++) child.stdout.emit('data', `줄 ${i}\n`);

    expect(progress.lines).toHaveLength(200);
    expect(progress.lines[0]).toBe('줄 50');
    expect(progress.lines.at(-1)).toBe('줄 249');
  });
});

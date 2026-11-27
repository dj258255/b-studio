import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionTerminalMode, terminalBackend, isTerminalRunnableBackend } from './session-terminal';
import { resolveTerminalMode, sessionTerminalAllowed } from './terminal-allowed';

const AUTH: Record<string, Record<string, string>> = {
  none: { B_STUDIO_AUTH: 'none' },
  token: { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: 'x'.repeat(40), B_STUDIO_AUTH_TOKENS: `alice:${'t'.repeat(30)}` },
  proxy: { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: 'p'.repeat(40) },
  broken: { B_STUDIO_AUTH: 'bogus' },
};

function stub(auth: string, terminal: string | undefined, experimental: boolean, serverSwitch = false): void {
  for (const key of ['B_STUDIO_AUTH', 'B_STUDIO_AUTH_SECRET', 'B_STUDIO_AUTH_TOKENS', 'B_STUDIO_AUTH_PROXY_SECRET']) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(AUTH[auth]!)) vi.stubEnv(key, value);
  vi.stubEnv('B_STUDIO_TERMINAL', terminal ?? '');
  vi.stubEnv('B_STUDIO_EXPERIMENTAL', experimental ? '1' : '');
  vi.stubEnv('B_STUDIO_SERVER_TERMINAL', serverSwitch ? '1' : '');
}

afterEach(() => vi.unstubAllEnvs());

type Row = { auth: string; terminal: string | undefined; experimental: boolean; serverSwitch: boolean; allowed: boolean; mode: 'host' | 'container' | 'throws' };

// 판정 표다. 인증을 끈 개인 PC(none)는 운영자 스위치(B_STUDIO_SERVER_TERMINAL)를 보지 않는다.
// 인증을 켠 서버(token·proxy)는 스위치를 켜고, 컨테이너 방식이고, 실험 기능이 켜졌을 때만 연다 — 이 컴퓨터 방식(host)은 스위치를 켜도 닫는다.
// 망가진 인증 값과 모르는 방식(오타)은 어떤 조합이든 닫는다(여는 자리가 던지는 값을 허용으로 세지 않는다)
const rows: Row[] = [];
for (const auth of ['none', 'token', 'proxy', 'broken']) {
  for (const terminal of [undefined, 'host', ' host ', 'container', 'hosts', 'HOST']) {
    for (const experimental of [false, true]) {
      for (const serverSwitch of [false, true]) {
        const normalized = terminal?.trim();
        const known = !normalized || normalized === 'host' || normalized === 'container';
        const mode: Row['mode'] = !known ? 'throws' : normalized === 'container' ? 'container' : 'host';
        const personal = auth === 'none' && (mode === 'host' || (mode !== 'throws' && experimental));
        const server = (auth === 'token' || auth === 'proxy') && serverSwitch && mode === 'container' && experimental;
        rows.push({ auth, terminal, experimental, serverSwitch, allowed: personal || server, mode });
      }
    }
  }
}

describe('세션 터미널 방식 판정 표', () => {
  it.each(rows)('인증 $auth · B_STUDIO_TERMINAL=$terminal · 실험 $experimental · 서버 스위치 $serverSwitch → 허용 $allowed, 방식 $mode', (row) => {
    stub(row.auth, row.terminal, row.experimental, row.serverSwitch);
    expect(sessionTerminalAllowed()).toBe(row.allowed);
    // 같은 판정 하나에서 나온 값이어야 한다: 허용 여부와 방식이 resolveTerminalMode와 늘 같다
    const resolved = resolveTerminalMode();
    expect(resolved.allowed).toBe(row.allowed);
    expect(resolved.mode).toBe(row.mode === 'throws' ? undefined : row.mode);
    if (!resolved.allowed) expect(resolved.reason.length).toBeGreaterThan(0);
    if (resolved.allowed) expect(isTerminalRunnableBackend('codex')).toBe(resolved.mode === 'host');
    if (row.mode === 'throws') expect(() => sessionTerminalMode()).toThrow('B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다');
    else expect(sessionTerminalMode()).toBe(row.mode);
  });

  it('닫힌 까닭이 서버 방식의 스위치·방식·실험 기능을 가려서 적는다', () => {
    stub('token', 'container', true, false);
    expect(resolveTerminalMode()).toMatchObject({ allowed: false, mode: 'container' });
    expect((resolveTerminalMode() as { reason: string }).reason).toContain('B_STUDIO_SERVER_TERMINAL=1');
    stub('token', undefined, true, true);
    expect((resolveTerminalMode() as { reason: string }).reason).toContain('B_STUDIO_TERMINAL=container');
    stub('proxy', 'container', false, true);
    expect((resolveTerminalMode() as { reason: string }).reason).toContain('B_STUDIO_EXPERIMENTAL=1');
  });

  it('스위치는 정확히 1일 때만 켠다(true·yes·공백 섞인 값은 켜지 않는다)', () => {
    for (const value of ['true', 'yes', 'on', '0', '11', '1 1']) {
      stub('token', 'container', true, false);
      vi.stubEnv('B_STUDIO_SERVER_TERMINAL', value);
      expect(sessionTerminalAllowed(), value).toBe(false);
    }
    stub('token', 'container', true, false);
    vi.stubEnv('B_STUDIO_SERVER_TERMINAL', ' 1 ');
    expect(sessionTerminalAllowed()).toBe(true);
  });
});

describe('이 컴퓨터 방식 백엔드의 방어선', () => {
  it('인증을 켠 서버에서는 직접 불러도 준비를 거절한다(판정을 거치지 않은 호출)', async () => {
    for (const auth of ['token', 'proxy', 'broken']) {
      stub(auth, 'host', true);
      await expect(terminalBackend('host').prepare({ sandboxId: 'x', root: '/tmp/none' } as never, { host: '127.0.0.1', port: 1, token: 't' } as never)).rejects.toThrow('인증을 끈 개인 PC 모드에서만');
    }
  });
});

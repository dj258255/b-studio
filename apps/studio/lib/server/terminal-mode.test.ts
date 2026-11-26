import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionTerminalMode, terminalBackend, isTerminalRunnableBackend } from './session-terminal';
import { resolveTerminalMode, sessionTerminalAllowed } from './terminal-allowed';

const AUTH: Record<string, Record<string, string>> = {
  none: { B_STUDIO_AUTH: 'none' },
  token: { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: 'x'.repeat(40), B_STUDIO_AUTH_TOKENS: `alice:${'t'.repeat(30)}` },
  proxy: { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: 'p'.repeat(40) },
  broken: { B_STUDIO_AUTH: 'bogus' },
};

function stub(auth: string, terminal: string | undefined, experimental: boolean): void {
  for (const key of ['B_STUDIO_AUTH', 'B_STUDIO_AUTH_SECRET', 'B_STUDIO_AUTH_TOKENS', 'B_STUDIO_AUTH_PROXY_SECRET']) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(AUTH[auth]!)) vi.stubEnv(key, value);
  vi.stubEnv('B_STUDIO_TERMINAL', terminal ?? '');
  vi.stubEnv('B_STUDIO_EXPERIMENTAL', experimental ? '1' : '');
}

afterEach(() => vi.unstubAllEnvs());

type Row = { auth: string; terminal: string | undefined; experimental: boolean; allowed: boolean; mode: 'host' | 'container' | 'throws' };

// 지금(고치기 전) 동작을 그대로 못 박은 표다. 인증을 켠 서버(token·proxy)와 망가진 인증 값은 어떤 조합이든 닫힌다.
// 모르는 값(오타)은 sessionTerminalMode가 던지고, 실험 기능이 꺼져 있으면 닫힌다. 실험 기능이 켜져 있어도 닫힌다(여는 자리가 던지는 값을 허용으로 세지 않는다)
const rows: Row[] = [];
for (const auth of ['none', 'token', 'proxy', 'broken']) {
  for (const terminal of [undefined, 'host', ' host ', 'container', 'hosts', 'HOST']) {
    for (const experimental of [false, true]) {
      const normalized = terminal?.trim();
      const known = !normalized || normalized === 'host' || normalized === 'container';
      const mode: Row['mode'] = !known ? 'throws' : normalized === 'container' ? 'container' : 'host';
      const allowed = auth === 'none' && (mode === 'host' || (mode !== 'throws' && experimental));
      rows.push({ auth, terminal, experimental, allowed, mode });
    }
  }
}

describe('세션 터미널 방식 판정 표', () => {
  it.each(rows)('인증 $auth · B_STUDIO_TERMINAL=$terminal · 실험 $experimental → 허용 $allowed, 방식 $mode', (row) => {
    stub(row.auth, row.terminal, row.experimental);
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
});

describe('이 컴퓨터 방식 백엔드의 방어선', () => {
  it('인증을 켠 서버에서는 직접 불러도 준비를 거절한다(판정을 거치지 않은 호출)', async () => {
    for (const auth of ['token', 'proxy', 'broken']) {
      stub(auth, 'host', true);
      await expect(terminalBackend('host').prepare({ sandboxId: 'x', root: '/tmp/none' } as never, { host: '127.0.0.1', port: 1, token: 't' } as never)).rejects.toThrow('인증을 끈 개인 PC 모드에서만');
    }
  });
});

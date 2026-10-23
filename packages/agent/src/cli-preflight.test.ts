import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preflightCodex } from './codex-runner';
import { preflightCommandCode } from './commandcode-runner';
import { preflightGemini } from './gemini-cli-runner';
import { preflightOpenCode } from './opencode-runner';

/**
 * 로그인 확인 명령이 실패하면 CLI의 오류 출력이 화면(계정 연결)으로 간다. CLI는 색 코드를 붙여 찍으므로
 * 그대로 옮기면 `[31m✖ [39m Not authenticated`처럼 보인다(이슈 #720). 실제 CLI 대신 같은 꼴로 실패하는 스크립트를 쓴다.
 */
let dir: string;
let failing: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'b-studio-preflight-'));
  failing = path.join(dir, 'fake-cli');
  await writeFile(failing, "#!/bin/sh\nprintf -- '- Checking authentication status...\\n\\033[31m✖\\033[39m Not authenticated\\n' >&2\nexit 1\n");
  await chmod(failing, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each([
  ['Command Code', preflightCommandCode],
  ['Codex', preflightCodex],
  ['OpenCode', preflightOpenCode],
  ['Gemini', preflightGemini],
] as const)('%s 로그인 확인 실패', (_name, preflight) => {
  it('이유에 색 코드를 남기지 않고, 한국어 요약과 CLI 원문을 나눠 돌려준다', async () => {
    const result = await preflight({ command: failing, timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toMatch(/\u001b|\[3\dm/);
    expect(result.summary).toMatch(/[가-힣]/);
    expect(result.summary).not.toContain('Command failed');
    expect(result.detail).toContain('✖ Not authenticated');
    expect(result.detail).not.toMatch(/\u001b/);
    // 세션 시작·CLI 명령은 지금처럼 reason 하나만 보여 준다. 요약과 원문이 모두 들어 있어야 한다
    expect(result.reason).toContain(result.summary);
    expect(result.reason).toContain('✖ Not authenticated');
  });
});

describe('계정마다 로그인 확인(#885)', () => {
  it('Codex 로그인 확인은 넘긴 환경(계정의 CODEX_HOME)으로 CLI를 부른다', async () => {
    const fake = path.join(dir, 'fake-codex-home');
    // 계정 폴더가 맞을 때만 로그인돼 있다고 답한다
    await writeFile(fake, '#!/bin/sh\n[ "$CODEX_HOME" = "/home/kim/.codex-2" ] && exit 0\nprintf "Not logged in\\n" >&2\nexit 1\n');
    await chmod(fake, 0o755);
    expect(await preflightCodex({ command: fake, timeoutMs: 10_000, env: { ...process.env, CODEX_HOME: '/home/kim/.codex-2' } })).toEqual({ ok: true });
    expect((await preflightCodex({ command: fake, timeoutMs: 10_000, env: { ...process.env, CODEX_HOME: '/elsewhere' } })).ok).toBe(false);
  });
});

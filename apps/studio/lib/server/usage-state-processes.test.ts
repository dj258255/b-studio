import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { userUsage } from './usage-state';

/**
 * 프로세스 둘이 같은 사용량 폴더에 동시에 더해도 하나도 잃지 않는다(4f B3c 결함 2, 트러블슈팅 226).
 * 자식 프로세스(`usage-state-child.ts`)가 시작 신호를 같이 보고 달린다. 사용량 폴더는 임시 폴더만 쓴다.
 */
const roots: string[] = [];
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const child = path.join(studio, 'lib/server/usage-state-child.ts');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(dir: string, go: string, user: string, count: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, go, user, String(count)], { cwd: studio, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('프로세스 사이의 더하기', () => {
  it('프로세스 둘이 같은 사람에게 동시에 150번씩 더하면 합계는 300이다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-usage-procs-'));
    roots.push(root);
    const dir = path.join(root, 'usage');
    const go = path.join(root, 'go');
    const a = run(dir, go, 'alice', 150);
    const b = run(dir, go, 'alice', 150);
    // 둘 다 떠서 신호를 기다리는 동안을 넉넉히 준다
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await writeFile(go, '1');
    const [first, second] = await Promise.all([a, b]);
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining('"failed":0') });
    expect(second).toMatchObject({ code: 0, out: expect.stringContaining('"failed":0') });
    expect(userUsage('alice', 'day', new Date(2026, 8, 12, 9), dir)?.inputTokens).toBe(300);
  }, 60_000);
});

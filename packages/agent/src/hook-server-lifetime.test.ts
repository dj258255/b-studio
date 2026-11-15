import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 서버가 열려 있는 동안 Node 프로세스가 살아 있고(옛 `node:http`처럼), close 뒤에는 스스로 끝나는지(ADR-201, 4f A7a).
 * 자식 node 프로세스가 네이티브 모듈로 서버를 띄운다. 자식은 임시 폴더의 스크립트고 저장소의 코드를 부르지 않는다.
 */
const NATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sandbox/native/bstudio_node.node');

const CHILD = `
const { createRequire } = require('node:module');
const native = createRequire(__filename)(process.argv[2]);
const mode = process.argv[3];
(async () => {
  const { id, port } = await native.startLoopbackServer('t'.repeat(48), [], ['/stop'], async () => ({ status: 200, body: Buffer.from('{}') }));
  process.stdout.write('port ' + port + '\\n');
  if (mode === 'close') await native.closeLoopbackServer(id);
  if (mode === 'close-twice') { await native.closeLoopbackServer(id); await native.closeLoopbackServer(id); }
  if (mode === 'close-after-request') {
    const response = await fetch('http://127.0.0.1:' + port + '/stop', { method: 'POST', headers: { authorization: 'Bearer ' + 't'.repeat(48) }, body: '{}' });
    process.stdout.write('status ' + response.status + '\\n');
    await native.closeLoopbackServer(id);
  }
})();
`;

interface Child {
  exited: Promise<number | null>;
  output: () => string;
  isAlive: () => boolean;
  kill: () => void;
}

function run(mode: string, directory: string): Child {
  const script = path.join(directory, 'child.cjs');
  writeFileSync(script, CHILD);
  const child = spawn(process.execPath, [script, NATIVE, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  let alive = true;
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      alive = false;
      resolve(code);
    }),
  );
  return { exited, output: () => out, isAlive: () => alive, kill: () => child.kill('SIGKILL') };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function exitsWithin(child: Child, ms: number): Promise<boolean> {
  return Promise.race([child.exited.then(() => true), sleep(ms).then(() => false)]);
}

describe('훅 서버의 프로세스 수명', () => {
  it('close를 부르지 않으면 서버가 열려 있는 동안 프로세스가 끝나지 않는다(node:http와 같다)', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hook-life-'));
    const child = run('hold', directory);
    try {
      await sleep(2500);
      expect(child.output()).toMatch(/^port \d+/);
      expect(child.isAlive()).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

  it('close를 부르면 프로세스가 스스로 끝난다(두 번 불러도, 요청을 받은 뒤에도)', async () => {
    for (const mode of ['close', 'close-twice', 'close-after-request']) {
      const directory = mkdtempSync(path.join(tmpdir(), 'hook-life-'));
      const child = run(mode, directory);
      try {
        expect(await exitsWithin(child, 8000), `${mode}: close 뒤에도 프로세스가 끝나지 않았다`).toBe(true);
        expect(await child.exited).toBe(0);
        if (mode === 'close-after-request') expect(child.output()).toContain('status 200');
      } finally {
        child.kill();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 40000);
});

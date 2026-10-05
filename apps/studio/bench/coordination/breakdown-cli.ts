/**
 * 벤치 결과 폴더들의 토큰 분해를 마크다운 표로 출력한다.
 *
 *   pnpm bench:coordination:tokens ~/.cache/b-studio/bench/coordination/<폴더>...
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { breakdownByCondition, breakdownMarkdown } from './breakdown';
import type { BenchRow } from './summary';

async function readRows(dir: string): Promise<BenchRow[]> {
  const text = await readFile(path.join(dir, 'results.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as BenchRow);
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error('사용법: pnpm bench:coordination:tokens <결과 폴더>...');
    process.exitCode = 2;
    return;
  }
  const rows = (await Promise.all(argv.map(readRows))).flat();
  const { conditions, skipped } = breakdownByCondition(rows);
  console.log(breakdownMarkdown(conditions, skipped));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

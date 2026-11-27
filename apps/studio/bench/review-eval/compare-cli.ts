/**
 * 결과 파일 두 개를 견준다: pnpm bench:review-eval:compare <전.json> <후.json>
 * 세트 해시가 다르면 비교하지 않고 종료 코드 1로 끝난다.
 */
import { readFile } from 'node:fs/promises';
import { compareResults, formatComparison } from './compare';
import type { EvalResult } from './run-core';

async function load(file: string): Promise<EvalResult> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<EvalResult>;
  if (typeof parsed.evalSetHash !== 'string' || typeof parsed.promptHash !== 'string' || !parsed.totals || !Array.isArray(parsed.items)) {
    throw new Error(`평가 결과 파일이 아닙니다: ${file}`);
  }
  return parsed as EvalResult;
}

async function main(): Promise<void> {
  const [beforeFile, afterFile, ...rest] = process.argv.slice(2);
  if (!beforeFile || !afterFile || rest.length > 0) throw new Error('사용법: pnpm bench:review-eval:compare <전.json> <후.json>');
  const comparison = compareResults(await load(beforeFile), await load(afterFile));
  process.stdout.write(formatComparison(comparison));
  if (!comparison.comparable) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

/**
 * 리뷰 평가 세트 실행기.
 *
 *   pnpm bench:review-eval --ask claude-code --model sonnet --out before.json
 *   pnpm bench:review-eval --ask fake            (기대 지적을 그대로 돌려주는 가짜 리뷰어. 배선 확인용이라 모델 성능이 아니다)
 *
 * claude-code는 본인 PC에 로그인된 구독 CLI로 항목마다 한 번씩 묻는다(도구 없음, 제품의 리뷰 호출과 같은 공용 함수 claudeCodeAsk).
 * 결과 JSON(세트 해시, 프롬프트 해시, 모델, 항목별 결과, 합계)을 --out에 쓴다. 없으면 화면에만 요약한다.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelAsk } from '@b-studio/agent';
import { parseArgs } from './args';
import { EVAL_CASES } from './cases';
import { oracleAsk, runEval } from './run-core';
import { formatTotals } from './format';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let ask: ModelAsk;
  let workDir: string | undefined;
  if (args.ask === 'fake') ask = oracleAsk();
  else {
    const { claudeCodeAsk } = await import('../../lib/server/claude-code-ask');
    workDir = await mkdtemp(path.join(tmpdir(), 'b-studio-review-eval-'));
    ask = claudeCodeAsk({ cwd: workDir, ...(args.model ? { model: args.model } : {}) });
  }
  try {
    const result = await runEval({
      ask,
      askName: args.ask,
      ...(args.model ? { model: args.model } : {}),
      onItem: (item) => {
        const hits = item.expected.filter((e) => e.hit).length;
        console.log(`${item.readable ? '읽음' : '못 읽음'}  ${item.id}  지적 ${item.findings}  맞음 ${hits}/${item.expected.length}`);
      },
    });
    console.log(`\n항목 ${EVAL_CASES.length}개\n${formatTotals(result.totals)}`);
    if (args.out) {
      await writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`결과: ${args.out}`);
    }
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

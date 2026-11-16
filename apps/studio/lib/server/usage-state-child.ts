/**
 * 사람별 사용량 파일 시험의 자식 프로세스(usage-state-processes.test.ts가 띄운다). 시작 신호 파일이 생기면 `count`번 1토큰씩 더하고 끝난다.
 * 인자: 사용량 폴더, 시작 신호 파일, 사람, 횟수
 */
import { existsSync } from 'node:fs';
import { addUserUsage } from './usage-state';

const [dir, go, user, count] = process.argv.slice(2) as [string, string, string, string];
const day = new Date(2026, 8, 12, 9);

async function main(): Promise<void> {
  while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 1));
  let failed = 0;
  for (let at = 0; at < Number(count); at++) {
    try {
      await addUserUsage(user, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'day', day, dir);
    } catch (error) {
      failed += 1;
      console.error(String(error));
    }
  }
  console.log(JSON.stringify({ failed }));
}

void main();

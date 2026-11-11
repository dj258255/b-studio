// 시험 전용 가짜 대화형 `claude`(터미널 방식, ADR-195 4f F0). 진짜 CLI처럼 PTY 안에서 떠서 입력을 기다리기만 한다.
// 훅은 이 프로세스가 부르지 않는다 — 시험이 CLI 대신 같은 훅 스크립트(`b-studio-hook.mjs <이벤트>`)를 같은 입력으로 불러, 게이트가 보는 입력을 직접 정한다.
// 호출: node fake-claude-terminal.mjs <기록 파일> [claude 인자...]
import { appendFileSync } from 'node:fs';

const [logFile, ...args] = process.argv.slice(2);
// `claude auth status`(로그인 확인)
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'someone@example.com' })}\n`);
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (fake)\n');
  process.exit(0);
}
appendFileSync(logFile, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
process.stdout.write('fake claude ready\n');
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));

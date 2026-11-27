/** 관문 폴더에 두는 시작 파일 검사 스크립트의 이름 */
export const STARTUP_CHECK_NAME = 'b-studio-startup-check.mjs';

/**
 * 감싸개(터미널 셸의 `opencode`·`gemini`)가 `exec` 직전에 부르는 검사 스크립트(#1475). 열린 셸에서 CLI를 다시 띄우면 띄우기 전 검사(`session-terminal.ts`의 `preflight`)가 돌지 않으므로,
 * 이 스크립트가 관문의 `/startup-check`에 "이 폴더에서 이 CLI를 띄워도 되나"를 묻는다. **판정은 스튜디오가 띄우기 전 검사와 같은 TS 코드(`startupConfigRefusal`)로 한다**:
 * 설정 JSON의 훅·샌드박스, OpenCode의 설정 파일·플러그인 폴더(위 폴더·전역·관리형 포함), `.env`·bunfig를 모두 같은 코드로 보고, 이 스크립트에는 판정 코드가 없다(손으로 옮긴 사본이 없다).
 * `/usr/bin/env -i <node 절대 경로> <이 파일> <opencode|gemini> <작업 폴더>`로 부른다. 종료 코드: 0 = 열어도 됨, 2 = 거절(이유를 표준 오류에), 3 = 물어보지 못함·이상한 답.
 * 답이 없거나 오류거나 모르는 모양이면 띄우지 않는다(열린 쪽은 `{ok:true}` 하나뿐). 주소·토큰은 자기 옆의 주소 파일에서 읽고 루프백 IP(`127.0.0.1`)의 http만 받는다
 */
export const STARTUP_CHECK = `// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import { readFileSync } from 'node:fs';
import http from 'node:http';

const TIMEOUT_MS = 20000;
const [cli, cwd] = process.argv.slice(2);

function stop(code, message) {
  process.stderr.write('[b-studio] ' + message + '\\n');
  process.exit(code);
}

if (!cli || !cwd) stop(3, '검사할 CLI와 작업 폴더를 알 수 없어 띄우지 않았습니다');
let base;
let token;
try {
  const address = JSON.parse(readFileSync(new URL('./b-studio-gateway.json', import.meta.url), 'utf8'));
  const url = new URL(address.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || typeof address.token !== 'string' || !address.token) throw new Error('주소가 맞지 않습니다');
  base = url;
  token = address.token;
} catch (error) {
  stop(3, '관문의 주소를 읽지 못해 띄우지 않았습니다(' + (error && error.message) + ')');
}

const body = Buffer.from(JSON.stringify({ cli, cwd }));
const request = http.request(new URL('/startup-check', base), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer ' + token } }, (response) => {
  const parts = [];
  response.on('data', (part) => parts.push(part));
  response.on('error', () => stop(3, '관문의 답이 끊겨 띄우지 않았습니다'));
  response.on('end', () => {
    if (response.statusCode !== 200) stop(3, '관문이 검사하지 못해(HTTP ' + response.statusCode + ') 띄우지 않았습니다');
    let answer;
    try {
      answer = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      stop(3, '관문의 답을 읽지 못해 띄우지 않았습니다');
    }
    if (answer && typeof answer === 'object' && typeof answer.refusal === 'string' && answer.refusal) stop(2, answer.refusal);
    if (answer && typeof answer === 'object' && answer.ok === true && Object.keys(answer).length === 1) process.exit(0);
    stop(3, '관문의 답이 낯설어 띄우지 않았습니다');
  });
});
request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('시간 초과')));
request.on('error', (error) => stop(3, '관문에 닿지 못해 띄우지 않았습니다(' + (error.code || error.message) + ')'));
request.end(body);
`;

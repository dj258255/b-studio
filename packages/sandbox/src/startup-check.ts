import { envCodeLoadRules } from './env-risk';
import { ENV_RISK_NAMES, ENV_SAFE_GEMINI_NAMES, MAX_CONFIG_BYTES, MAX_LEVELS } from './gemini-config';
import { INVISIBLE, MAX_STARTUP_FILE_BYTES } from './opencode-config';

/** 관문 폴더에 두는 검사 스크립트의 이름 */
export const STARTUP_CHECK_NAME = 'b-studio-startup-check.mjs';

/**
 * 감싸개(터미널 셸의 `opencode`·`gemini`)가 `exec` 직전에 부르는 검사 스크립트(#1475). 열린 셸에서 CLI를 다시 띄우면 띄우기 전 검사(`session-terminal.ts`의 `preflight`)가 돌지 않으므로,
 * 에이전트가 셸로 쓴 `.env`·`bunfig.toml`을 이 스크립트가 다시 본다. `/usr/bin/env -i <node 절대 경로> <이 파일> <opencode|gemini> <작업 폴더>`로 부르고, 거절하면 이유를 표준 오류에 적고 종료 코드 2다.
 * 의존성이 없다(node 내장만): 거절 규칙의 목록(코드 적재 변수·Gemini 위험 이름·크기 상한)은 TS와 같은 상수에서 JSON으로 끼우고, 판정 코드는 `openCodeConfigRefusal`·`geminiConfigRefusal`의 `.env`·bunfig 부분을 옮긴 것이다.
 * 두 쪽이 같은 답을 내는지는 `startup-check.test.ts`가 같은 입력을 양쪽에 넣어 거절 글까지 견준다. `.env` 읽기는 `dotenv` 없이 느슨한 줄 읽기만 쓴다(`env-risk.ts`의 `envRiskKeyIn`에 포함 관계의 근거가 있다).
 * 읽지 못한 것·모르는 모양은 거절이다(통과로 읽지 않는다)
 */
export const STARTUP_CHECK = `// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RULES = ${JSON.stringify({
  codeLoad: envCodeLoadRules(),
  geminiRiskNames: [...ENV_RISK_NAMES],
  geminiSafeNames: [...ENV_SAFE_GEMINI_NAMES],
  maxLevels: MAX_LEVELS,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxStartupBytes: MAX_STARTUP_FILE_BYTES,
})};
const INVISIBLE = new RegExp(${JSON.stringify(INVISIBLE.source)}, 'g');
const LOOSE = /^[\\s]*(?:export\\s+)?([\\w.-]+)\\s*[=:]/gmu;
const BUN_ENV_FILE = /^\\.env(\\..*)?$/u;
const BUNFIG_NAMES = new Set(['bunfig.toml', '.bunfig.toml']);

function fold(name) {
  return name.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/[. ]+$/u, '');
}

function codeLoadKey(key) {
  const upper = key.toUpperCase();
  const { exact, prefixes, suffixes, allowed } = RULES.codeLoad;
  return !allowed.includes(upper) && (exact.includes(upper) || prefixes.some((prefix) => upper.startsWith(prefix)) || suffixes.some((suffix) => upper.endsWith(suffix)));
}

function riskKeyIn(text, risky) {
  for (const match of text.replace(/\\r\\n?/gu, '\\n').matchAll(LOOSE)) if (risky(match[1])) return match[1];
  return undefined;
}

// ── OpenCode: 작업 폴더의 .env 계열과 bunfig.toml(Bun이 시작할 때 읽는다) ──
function opencodeKeyRisky(key) {
  const upper = key.toUpperCase();
  return upper.startsWith('OPENCODE_') || upper.startsWith('BUN_') || codeLoadKey(key);
}

function opencodeRefusal(cwd) {
  let names;
  try {
    names = readdirSync(cwd);
  } catch (error) {
    return \`작업 폴더 \${cwd}을(를) 읽지 못해 터미널을 열지 않았습니다(\${error.message}). OpenCode가 시작할 때 읽는 .env·bunfig.toml을 확인할 수 없습니다\`;
  }
  for (const name of names) {
    const folded = fold(name);
    const isEnv = BUN_ENV_FILE.test(folded);
    const isBunfig = BUNFIG_NAMES.has(folded);
    if (!isEnv && !isBunfig) continue;
    const file = path.join(cwd, name);
    if (isBunfig) return \`\${file}이(가) 있습니다. OpenCode는 시작할 때 작업 폴더의 bunfig.toml을 읽고 그 preload가 코드를 실행해 b-studio의 플러그인이 붙었는지 알 수 없어 터미널을 열지 않았습니다. 그 파일을 지우거나 옮긴 뒤 다시 여세요\`;
    let text;
    try {
      const link = lstatSync(file);
      if (!link.isFile()) return \`\${file}이(가) 일반 파일이 아니라(링크이거나 폴더) 읽지 않았습니다. OpenCode가 시작할 때 읽는 .env일 수 있어 터미널을 열지 않았습니다\`;
      if (link.size > RULES.maxStartupBytes) return \`\${file}이(가) 너무 커서(\${link.size}바이트) 읽지 않았습니다. OpenCode의 설정을 바꾸는지 알 수 없어 터미널을 열지 않았습니다\`;
      text = readFileSync(file, 'utf8');
    } catch (error) {
      return \`\${file}을(를) 읽지 못해 터미널을 열지 않았습니다(\${error.message}). OpenCode의 설정을 바꾸는지 알 수 없습니다\`;
    }
    const risky = riskKeyIn(text, opencodeKeyRisky);
    if (risky) return \`\${file}이(가) \${risky}을(를) 정합니다. OpenCode는 시작할 때 작업 폴더의 .env를 환경에 넣어 설정·플러그인·권한을 바꾸거나 코드를 실행할 수 있어 터미널을 열지 않았습니다. 그 줄을 지운 뒤 다시 여세요\`;
  }
  return undefined;
}

// ── Gemini: 작업 폴더와 위 폴더의 .env·.gemini/.env ──
function geminiKeyRisky(key) {
  const upper = key.toUpperCase();
  if (RULES.geminiRiskNames.includes(upper)) return true;
  if (codeLoadKey(key)) return true;
  return upper.startsWith('GEMINI_') && !RULES.geminiSafeNames.includes(upper);
}

function geminiEnvFileRefusal(file) {
  let text;
  try {
    const info = statSync(file);
    if (info.isFile() && info.size > RULES.maxConfigBytes) return \`\${file}이(가) 너무 커서 읽지 않았습니다. Gemini의 믿음 설정을 바꾸는지 알 수 없어 터미널을 열지 않았습니다\`;
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    return \`\${file}을(를) 읽지 못해 터미널을 열지 않았습니다(\${error.message}). Gemini의 믿음 설정을 바꾸는지 알 수 없습니다\`;
  }
  const risky = riskKeyIn(text, geminiKeyRisky);
  if (risky) return \`\${file}이(가) \${risky}을(를) 정합니다. 훅이 불러와지지 않게 하거나 CLI를 샌드박스에서 다시 띄울 수 있어 터미널을 열지 않았습니다. 그 줄을 지운 뒤 다시 여세요\`;
  return undefined;
}

function geminiRefusal(cwd) {
  let current = path.resolve(cwd);
  for (let level = 0; level < RULES.maxLevels; level += 1) {
    for (const file of [path.join(current, '.gemini', '.env'), path.join(current, '.env')]) {
      const refusal = geminiEnvFileRefusal(file);
      if (refusal) return refusal;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

const [cli, cwd] = process.argv.slice(2);
let refusal;
try {
  if (!cwd) refusal = '[b-studio] 검사할 작업 폴더가 없어 띄우지 않았습니다';
  else if (cli === 'opencode') refusal = opencodeRefusal(cwd);
  else if (cli === 'gemini') refusal = geminiRefusal(cwd);
  else refusal = '[b-studio] 모르는 CLI라 검사하지 못해 띄우지 않았습니다';
} catch (error) {
  refusal = '[b-studio] 시작 파일을 검사하지 못해 띄우지 않았습니다(' + (error && error.message) + ')';
}
if (refusal) {
  process.stderr.write('[b-studio] ' + refusal + '\\n');
  process.exit(2);
}
`;

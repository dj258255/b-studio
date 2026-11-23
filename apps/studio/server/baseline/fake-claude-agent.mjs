// 시험 전용 가짜 대화형 `claude`: 스스로 훅과 텔레메트리를 부르는 판(#1358). `fake-claude-terminal.mjs`는 입력을 기다리기만 하고 훅은 시험이 대신 불렀다.
// 서버가 스스로 모는 흐름(Fleet, 작업 분해의 터미널 레인)에서는 시험이 끼어들 자리가 없어서, 진짜 CLI처럼 CLI가 직접 부른다.
//
// 호출: node fake-claude-agent.mjs <실행 기록(claude-terminal.jsonl)> <동작 기록(claude-agent.jsonl)> <대본 파일> [claude 인자...]
//  - `--version`, `auth status`는 fake-claude-terminal.mjs와 같이 답한다
//  - `--settings <json 파일>`의 hooks 명령과 env(텔레메트리 끝점·머리글)를 읽는다. `--model`(`--model=<id>`도)은 대본을 고르는 데 쓴다
//  - 뜨면 SessionStart 훅을 부르고, 마지막 위치 인자(첫 요청)가 있으면 그 글로 요청을 시작한다
//  - stdin에서 bracketed paste(`ESC[200~ … ESC[201~`)와 Enter(`\r`)를 알아보면 그 글로 요청을 시작한다(서버가 터미널에 붙여 넣는 방식)
//  - 요청 하나는 UserPromptSubmit 훅을 부른 뒤 대본의 단계를 차례로 실행한다
//
// 대본(JSON): { "scripts": [ { "match": { "model"?: 글, "request"?: 글 }, "steps": [ 단계… ] } ] }
//  - match의 칸은 모두 맞아야 하고(부분 문자열), 처음 맞는 대본을 쓴다. 맞는 것이 없으면 단계 없이 요청을 닫는다(Stop 훅을 부르지 않는다)
//  - 단계:
//      { "telemetry": { "requestId", "model"?, "input", "output", "cacheRead"?, "cacheCreation"?, "costUsd"? } }  모델 요청 하나(api_request 로그)를 관문에 보낸다
//      { "write": { "path", "content" } }  PreToolUse 훅(도구 Write)을 부르고, 거절(permissionDecision: deny)이 아니면 작업 폴더 기준 경로에 쓴다
//      { "stop": { "text" } }  Stop 훅을 부른다. 답이 decision: block이면 대본의 다음 단계로 이어가고, 아니면 이 요청은 끝난다
// 동작 기록(JSONL): paste(요청 글과 들어온 길), script(고른 대본 번호), hook(이벤트·입력·답), telemetry(상태), write(경로·거절 여부), end(끝난 까닭)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [launchLog, actionLog, scriptFile, ...args] = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'someone@example.com' })}\n`);
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (fake)\n');
  process.exit(0);
}

appendFileSync(launchLog, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const log = (record) => appendFileSync(actionLog, `${JSON.stringify(record)}\n`);

/** 값을 받는 옵션(그 다음 낱말은 위치 인자가 아니다). 진짜 CLI가 서버에서 받는 것만 안다 */
const VALUE_OPTIONS = new Set(['--settings', '--mcp-config', '--model', '--resume']);
let model;
let settingsFile;
const positional = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const name = eq > 0 ? arg.slice(0, eq) : arg;
  const value = eq > 0 ? arg.slice(eq + 1) : VALUE_OPTIONS.has(arg) ? args[++index] : undefined;
  if (name === '--model') model = value;
  else if (name === '--settings') settingsFile = value;
  else if (!arg.startsWith('-') && !VALUE_OPTIONS.has(name)) positional.push(arg);
}
const settings = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
const hookEnv = { ...process.env, ...(settings.env ?? {}) };
const base = { session_id: 'conversation-1', cwd: process.cwd(), transcript_path: '/dev/null' };
let toolCount = 0;

/** 훅 명령 하나를 진짜 CLI처럼 셸로 실행해 입력 JSON을 stdin으로 넘기고 stdout의 JSON을 돌려준다 */
function runHookCommand(command, timeoutSeconds, input) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env: hookEnv, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds ?? 60) * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      let output = {};
      try {
        output = stdout.trim() ? JSON.parse(stdout) : {};
      } catch {
        output = { unparsed: stdout };
      }
      resolve({ output, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** 이벤트의 훅을 부른다. 도구 이벤트는 matcher(정규식)가 도구 이름에 맞는 항목만 부른다. 거절·막음이 있으면 그 답을, 아니면 처음 비어 있지 않은 답을 돌려준다 */
async function callHook(event, input) {
  const full = { ...base, hook_event_name: event, ...input };
  const answers = [];
  for (const entry of settings.hooks?.[event] ?? []) {
    // 진짜 CLI처럼 matcher가 없거나 빈 값이나 `*`면 모든 도구, 아니면 도구 이름 전체에 맞춰 보는 정규식이다
    if (entry.matcher !== undefined && entry.matcher !== '' && entry.matcher !== '*' && !new RegExp(`^(?:${entry.matcher})$`).test(input.tool_name ?? '')) continue;
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== 'command' || hook.async) continue;
      answers.push((await runHookCommand(hook.command, hook.timeout, full)).output);
    }
  }
  const answer = answers.find((one) => one.decision === 'block' || one.hookSpecificOutput?.permissionDecision === 'deny') ?? answers.find((one) => Object.keys(one).length > 0) ?? {};
  log({ kind: 'hook', event, input: full, output: answer });
  return answer;
}

/** OTLP/HTTP JSON 로그로 api_request 하나를 보낸다(끝점·머리글은 설정의 env에서) */
async function sendTelemetry(step) {
  const env = settings.env ?? {};
  const headers = { 'content-type': 'application/json' };
  for (const pair of (env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? '').split(',').filter(Boolean)) {
    const at = pair.indexOf('=');
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  const str = (stringValue) => ({ stringValue });
  const int = (intValue) => ({ intValue: String(intValue) });
  const attributes = [
    { key: 'event.name', value: str('api_request') },
    { key: 'model', value: str(step.model ?? model ?? 'fake-model') },
    { key: 'input_tokens', value: int(step.input ?? 0) },
    { key: 'output_tokens', value: int(step.output ?? 0) },
    { key: 'cache_read_tokens', value: int(step.cacheRead ?? 0) },
    { key: 'cache_creation_tokens', value: int(step.cacheCreation ?? 0) },
    ...(step.costUsd === undefined ? [] : [{ key: 'cost_usd', value: { doubleValue: step.costUsd } }]),
    { key: 'duration_ms', value: int(100) },
    { key: 'request_id', value: str(step.requestId) },
  ];
  let status;
  try {
    const response = await fetch(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }] }) });
    status = response.status;
  } catch (error) {
    status = `error: ${error.message}`;
  }
  log({ kind: 'telemetry', requestId: step.requestId, status });
}

/** 요청 하나: UserPromptSubmit 훅 → 대본의 단계. 요청마다 대본을 새로 고른다 */
async function handleRequest(text, via) {
  log({ kind: 'paste', text, via });
  await callHook('UserPromptSubmit', { prompt: text });
  const index = (script.scripts ?? []).findIndex((entry) => (entry.match?.model === undefined || (model ?? '').includes(entry.match.model)) && (entry.match?.request === undefined || text.includes(entry.match.request)));
  log({ kind: 'script', index: index < 0 ? null : index });
  if (index < 0) return log({ kind: 'end', reason: 'no-script' });
  let stopActive = false;
  for (const step of script.scripts[index].steps) {
    if (step.telemetry) await sendTelemetry(step.telemetry);
    else if (step.write) {
      const target = path.resolve(process.cwd(), step.write.path);
      const answer = await callHook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: target, content: step.write.content }, tool_use_id: `toolu_${++toolCount}` });
      const denied = answer.hookSpecificOutput?.permissionDecision === 'deny';
      if (!denied) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, step.write.content);
      }
      log({ kind: 'write', path: step.write.path, denied });
    } else if (step.stop) {
      const answer = await callHook('Stop', { stop_hook_active: stopActive, last_assistant_message: step.stop.text });
      if (answer.decision !== 'block') return log({ kind: 'end', reason: 'stopped' });
      // 훅이 막으면 CLI는 그 까닭을 모델에게 돌려주고 모델이 이어서 일한다: 대본의 다음 단계
      stopActive = true;
    }
  }
  log({ kind: 'end', reason: 'script-exhausted' });
}

let chain = Promise.resolve();
const queue = (text, via) => {
  chain = chain.then(() => handleRequest(text, via)).catch((error) => log({ kind: 'error', message: String(error?.stack ?? error) }));
};

/** stdin 해석: 글자는 입력 줄에 쌓이고, 붙여 넣기(ESC[200~…ESC[201~)는 그 글이 통째로 쌓이며, Enter(\r)가 입력 줄을 요청으로 보낸다. 빈 입력 줄의 Enter는 무시한다 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
let buffer = '';
let line = '';
let pasted = false;
function consume() {
  for (;;) {
    if (pasted) {
      const end = buffer.indexOf(PASTE_END);
      if (end < 0) return;
      line += buffer.slice(0, end);
      buffer = buffer.slice(end + PASTE_END.length);
      pasted = false;
      continue;
    }
    const start = buffer.indexOf(PASTE_START);
    const enter = buffer.indexOf('\r');
    if (start >= 0 && (enter < 0 || start < enter)) {
      line += buffer.slice(0, start);
      buffer = buffer.slice(start + PASTE_START.length);
      pasted = true;
    } else if (enter >= 0) {
      line += buffer.slice(0, enter);
      buffer = buffer.slice(enter + 1);
      if (line.trim()) queue(line, 'paste');
      line = '';
    } else {
      // 붙여 넣기 표식이 잘려 올 수 있어 표식 앞 조각은 남긴다
      const keep = Math.min(buffer.length, PASTE_START.length - 1);
      line += buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return;
    }
  }
}

process.stdout.write('fake claude ready\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  consume();
});
// 파이프로 시험할 때(PTY가 아닐 때)는 입력이 끝나면 하던 일을 마치고 나간다. PTY에서는 끝나지 않는다(SIGTERM·HUP으로 끝난다)
process.stdin.on('end', () => void chain.then(() => process.exit(0)));
process.on('SIGTERM', () => process.exit(0));
if (!process.stdin.isTTY) setInterval(() => {}, 1000);

// 뜨면 SessionStart 훅, 그다음 첫 요청(마지막 위치 인자)
{
  chain = chain.then(() => callHook('SessionStart', { source: 'startup' })).catch((error) => log({ kind: 'error', message: String(error?.stack ?? error) }));
  const first = positional.at(-1);
  if (first) queue(first, 'argv');
}

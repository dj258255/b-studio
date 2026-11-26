import { AGENT_HOOK_EVENTS, GATEWAY_FILE_NAME } from './docker/agent-terminal';

/**
 * Command Code(`commandcode --mod <관문 폴더>/b-studio-mod.ts`)의 훅을 관문의 훅 통로에 잇는 mod 파일(ADR-233, 실험).
 * Claude Code 터미널의 훅 스크립트(AGENT_HOOK_SCRIPT)와 같은 통로를 부르므로 판정 코드는 같다: 쓰기 범위·보호 경로, 쓰기 뒤 기록, 턴 끝 게이트, 요청 받기.
 *
 * **훅이 던지면 Command Code는 그 훅을 건너뛴다**(문서: "failing tool hooks are skipped", 도구는 그대로 돈다). 열리는 쪽으로 실패하는 것이다.
 * 그래서 막는 훅(쓰기 직전·요청 받기)은 어떤 예외가 나도 던지지 않고 막는 답을 돌려준다. 서버에 닿지 못해도, 응답이 이상해도, 시간이 지나도 마찬가지다.
 * 응답은 **허용 목록**으로 읽는다: 관문이 실제로 내는 꼴(`{}`, `{systemMessage}`, 거절, 요청 막기, 맥락 글)만 알아보고 나머지는 이상한 응답이다.
 *
 * 글 안에 의존성이 없다(관문 폴더에는 node_modules가 없다): node 내장만 가져온다. 토큰과 주소는 글에 박지 않고,
 * 감싸개가 환경 변수(B_STUDIO_GATEWAY_DIR)로 알려 주는 관문 폴더의 주소 파일에서 부를 때마다 읽는다(Claude의 훅 스크립트가 자기 옆 파일을 읽는 것과 같다).
 * mod 글은 jiti가 불러오므로 TypeScript 문법을 쓰지 않는 평범한 ES 모듈이다. `import.meta`도 쓰지 않는다(지원하지 않는 판이면 mod가 통째로 불러와지지 않고, 그러면 훅이 하나도 없다).
 * 이 글에는 백틱과 `${`를 쓰지 않는다(템플릿 문자열로 담겨 있다).
 */

/** 관문 폴더 안의 mod 파일 이름. Rust 관문 파일 목록(GATEWAY_FILE_NAMES)과 같아야 한다 */
export const COMMAND_CODE_MOD_NAME = 'b-studio-mod.ts';
/** 감싸개가 mod에 세션의 관문 폴더를 알리는 환경 변수(Codex 감싸개의 B_STUDIO_GATEWAY_DIR와 같은 방식) */
export const COMMAND_CODE_GATEWAY_DIR_ENV = 'B_STUDIO_GATEWAY_DIR';

export const COMMAND_CODE_MOD = String.raw`// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_SECONDS = __B_STUDIO_TIMEOUTS__;
const ADDRESS_FILE = __B_STUDIO_ADDRESS_FILE__;
const GATEWAY_DIR_ENV = __B_STUDIO_GATEWAY_DIR_ENV__;
// 시간 상한은 낮추기만 할 수 있다(시험이 쓴다). 낮추면 더 막을 뿐이다
const TIMEOUT_CAP_MS = Number(process.env.B_STUDIO_MOD_TIMEOUT_MS);
const BEFORE_TOOL_TEXT = '[b-studio] 관문에 닿지 못해(';
const NOTE =
  '# b-studio\n' +
  '이 작업 폴더는 b-studio 세션의 작업 복사본이다. 커밋하지 않는다: git commit·git push·git reset·git checkout·git stash로 기록이나 브랜치를 바꾸지 않는다. 체크포인트(커밋)는 턴이 끝난 뒤 b-studio가 검증을 통과시켜 남긴다.\n' +
  '작업 폴더 밖의 파일을 바꾸지 않는다.\n' +
  '검증이 실패하면 결과가 이어서 돌아온다. 그것은 사용자의 새 요청이 아니라 검증 결과다. 고친 뒤 다시 턴을 끝낸다. 끝내 통과하지 못하면 b-studio가 이번 요청의 변경을 되돌린다.\n' +
  '사용자에게 보이는 글은 한국어로 쓴다.';

const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

// 이 글이 한 번 불린 동안의 상태. 둘 다 닫는 쪽으로만 쓰인다
let stopUnreachable = 0;
let stopBlocked = false;
// 마지막 턴 끝 확인이 관문에 닿지 못했다(검증되지 않은 채 끝날 수 있다)
let stopUnverified = false;

// 관문의 주소와 토큰. 부를 때마다 읽는다(글에 박지 않는다). 루프백 http가 아니면 받지 않는다
function readAddress() {
  const dir = process.env[GATEWAY_DIR_ENV];
  if (!nonEmpty(dir) || !path.isAbsolute(dir)) throw new Error('관문 폴더를 알 수 없습니다');
  const parsed = JSON.parse(readFileSync(path.join(dir, ADDRESS_FILE), 'utf8'));
  if (!isPlain(parsed) || !nonEmpty(parsed.url) || !nonEmpty(parsed.token)) throw new Error('주소 파일이 이상합니다');
  const url = new URL(parsed.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '') throw new Error('관문 주소가 루프백 http가 아닙니다');
  return { base: url.origin, token: parsed.token };
}

// 관문에 한 번 보낸다. 성공(200)이고 JSON으로 읽힌 것만 값으로 돌려주고, 나머지는 모두 던진다
function post(event, payload) {
  return new Promise((resolve, reject) => {
    let seconds = TIMEOUT_SECONDS[event];
    let address;
    let body;
    try {
      if (!(seconds > 0)) throw new Error('모르는 훅 종류입니다');
      address = readAddress();
      body = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // 훅의 상한보다 조금 먼저 끊는다
    let limitMs = Math.max(1, seconds - 3) * 1000;
    if (Number.isFinite(TIMEOUT_CAP_MS) && TIMEOUT_CAP_MS > 0) limitMs = Math.min(limitMs, TIMEOUT_CAP_MS);
    let settled = false;
    let timer;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    let request;
    try {
      request = http.request(address.base + '/' + event, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer ' + address.token } }, (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.on('error', () => done(reject, new Error('응답이 끊겼습니다')));
        response.on('end', () => {
          if (response.statusCode !== 200) return done(reject, new Error('HTTP ' + response.statusCode));
          try {
            done(resolve, JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch {
            done(reject, new Error('응답을 읽지 못했습니다'));
          }
        });
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    timer = setTimeout(() => {
      done(reject, new Error('시간 초과'));
      request.destroy();
    }, limitMs);
    request.on('error', (error) => done(reject, new Error(error && error.code ? error.code : '연결하지 못했습니다')));
    request.end(body);
  });
}

const why = (error) => (error instanceof Error && error.message ? error.message : String(error));

// 사용자에게만 보이는 알림 한 줄. 알림이 던져도 판정은 그대로다
function notify(cmd, text) {
  try {
    if (nonEmpty(text)) cmd.ui.notify(text);
  } catch {
    // 알림일 뿐이다
  }
}

// 관문의 답 읽기: 알아보는 꼴만 받는다. 모르는 꼴은 던진다(이상한 응답)
function readMessageOnly(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  for (const key of Object.keys(answer)) if (key !== 'systemMessage') throw new Error('모르는 응답입니다');
  if (answer.systemMessage !== undefined && typeof answer.systemMessage !== 'string') throw new Error('모르는 응답입니다');
  return answer.systemMessage;
}

function readPreTool(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  const output = answer.hookSpecificOutput;
  if (output === undefined) return { message: readMessageOnly(answer) };
  if (Object.keys(answer).length !== 1 || !isPlain(output) || output.hookEventName !== 'PreToolUse' || output.permissionDecision !== 'deny' || !nonEmpty(output.permissionDecisionReason)) throw new Error('모르는 응답입니다');
  return { deny: output.permissionDecisionReason };
}

function readPrompt(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  const keys = Object.keys(answer);
  if (answer.decision !== undefined) {
    if (keys.length !== 2 || answer.decision !== 'block' || !nonEmpty(answer.reason)) throw new Error('모르는 응답입니다');
    return { blocked: answer.reason };
  }
  const output = answer.hookSpecificOutput;
  if (output !== undefined) {
    if (keys.length !== 1 || !isPlain(output) || output.hookEventName !== 'UserPromptSubmit' || !nonEmpty(output.additionalContext)) throw new Error('모르는 응답입니다');
    return { note: output.additionalContext };
  }
  readMessageOnly(answer);
  return {};
}

function readStop(answer) {
  if (!isPlain(answer)) throw new Error('응답이 객체가 아닙니다');
  if (answer.decision !== undefined) {
    if (Object.keys(answer).length !== 2 || answer.decision !== 'block' || !nonEmpty(answer.reason)) throw new Error('모르는 응답입니다');
    return { feedback: answer.reason };
  }
  return { message: readMessageOnly(answer) };
}

// 지켜보기만 하는 통로(도구의 끝, 서브에이전트). 던지지 않고 기다리지도 않는다. 판정과 상관없다
function observe(payload) {
  try {
    post('activity', payload).catch(() => {});
  } catch {
    // 지켜보기일 뿐이다
  }
}

export default function (cmd) {
  const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : undefined;

  cmd.hooks({
    // 요청 받기(UserPromptSubmit). 관문에 닿지 못하거나 응답이 이상하면 요청을 보내지 않는다(handled). 던지면 CLI가 훅을 건너뛰고 요청이 간다
    transformInput: async (input) => {
      try {
        stopUnreachable = 0;
        stopBlocked = false;
        stopUnverified = false;
        const text = input.text;
        const answer = readPrompt(await post('prompt', { hook_event_name: 'UserPromptSubmit', prompt: text, ...(cwd ? { cwd } : {}) }));
        if (answer.blocked) return { action: 'handled', message: answer.blocked };
        if (answer.note) return { action: 'transform', text: text + '\n\n' + answer.note };
        return { action: 'continue' };
      } catch (error) {
        return { action: 'handled', message: BEFORE_TOOL_TEXT + why(error) + ') 요청을 보내지 않았습니다. 다시 보내 주세요.' };
      }
    },

    // 쓰기 직전(PreToolUse). 모든 도구를 관문에 묻는다: 읽기 도구를 거르는 표는 서버에 한 곳뿐이다. 어떤 예외든 막는 답이다
    beforeToolCall: async (call) => {
      try {
        const answer = readPreTool(
          await post('pre-tool', { hook_event_name: 'PreToolUse', tool_name: call.toolName, tool_input: call.input, tool_use_id: call.toolCallId, ...(cwd ? { cwd } : {}) }),
        );
        if (answer.deny) return { block: true, additionalContext: answer.deny };
        notify(cmd, answer.message);
        return undefined;
      } catch (error) {
        return { block: true, additionalContext: BEFORE_TOOL_TEXT + why(error) + ') 파일을 바꿀 수 있는 도구를 막았습니다. 변경 전 기준을 잡을 수 없습니다.' };
      }
    },

    // 쓰기 뒤(PostToolUse·PostToolUseFailure). 지켜보기만 한다. 도구의 출력은 보내지 않는다
    afterToolCall: async (call) => {
      try {
        observe({ hook_event_name: call.isError === true ? 'PostToolUseFailure' : 'PostToolUse', tool_name: call.toolName, tool_input: call.input, tool_use_id: call.toolCallId, ...(call.isError === true ? { error: '도구 실행이 실패했습니다' } : {}), ...(cwd ? { cwd } : {}) });
      } catch {
        // 지켜보기일 뿐이다
      }
      return undefined;
    },

    // 턴 끝 게이트(Stop). 실패하면 사유를 reason으로 돌려주며 이어가게 한다. 서버에 닿지 못하면 통과로 읽지 않는다
    onStop: async (info) => {
      try {
        const last = info && typeof info.lastAssistantText === 'string' ? info.lastAssistantText : '';
        const answer = readStop(await post('stop', { hook_event_name: 'Stop', last_assistant_message: last, ...(cwd ? { cwd } : {}) }));
        stopUnreachable = 0;
        stopUnverified = false;
        if (answer.feedback) {
          stopBlocked = true;
          return { continue: true, reason: answer.feedback };
        }
        stopBlocked = false;
        notify(cmd, answer.message);
        return { continue: false };
      } catch (error) {
        // 검증이 돌지 않았다. 체크포인트는 생기지 않는다. 한 번은 에이전트에게 알려 다시 끝내게 하고(관문이 돌아올 수 있다), 연달아 닿지 못하면 멈추되 사용자에게 알린다.
        // CLI는 이어가기를 8번까지만 받으므로 끝없이 돌지 않는다
        stopBlocked = false;
        stopUnverified = true;
        stopUnreachable += 1;
        const text = '[b-studio] 관문에 닿지 못해(' + why(error) + ') 이번 변경을 검증하지 못했습니다. 체크포인트가 생기지 않았습니다.';
        if (stopUnreachable <= 1) return { continue: true, reason: text + ' 같은 변경을 다시 보여 주며 턴을 끝내세요.' };
        notify(cmd, text);
        return { continue: false };
      }
    },

    // 훅 없이 끝난 실행(턴 상한·권한 거절은 onStop이 불리지 않는다). 열린 실행을 실패로 닫고 되돌리게 한다(StopFailure). 던지지 않는다
    onRunEnd: async (info) => {
      try {
        const reason = info && isPlain(info.result) && typeof info.result.stopReason === 'string' ? info.result.stopReason : '';
        const natural = reason === 'end_turn';
        // 게이트가 실패해 이어가게 했는데 끝난 실행은 통과하지 못한 채 끝난 것이다
        const gaveUp = natural && stopBlocked;
        // 턴 끝 확인이 관문에 닿지 못한 채 끝난 실행도 검증되지 않았다. 관문이 그 사이 돌아왔으면 실패로 닫게 알린다
        const unverified = natural && stopUnverified;
        stopBlocked = false;
        stopUnverified = false;
        stopUnreachable = 0;
        if (natural && !gaveUp && !unverified) return;
        // 사람이 누른 중단(Esc)은 실패가 아니다. 실행을 열어 두고 다음 요청이 이어 간다(Claude Code 터미널에서 중단하면 훅이 오지 않는 것과 같다).
        // 서버가 건 취소는 서버가 스스로 닫는다
        if (reason === 'interrupted') return;
        await post('stop-failure', { hook_event_name: 'StopFailure', error: gaveUp ? 'stop_gate_not_passed' : unverified ? 'stop_unverified' : 'run_end:' + (reason || 'unknown'), ...(cwd ? { cwd } : {}) });
      } catch {
        // 알리지 못했다. 실행은 열린 채 남고 체크포인트는 생기지 않는다
      }
    },

    // CLI가 떴다/끝났다. mod만 다시 불러온 것(reload)은 CLI의 시작·끝이 아니다
    onSessionStart: async (info) => {
      try {
        if (info && info.source === 'reload') return;
        await post('session-start', { hook_event_name: 'SessionStart', ...(cwd ? { cwd } : {}) });
      } catch {
        // 알리기만 한다
      }
    },
    onSessionEnd: async (info) => {
      try {
        if (info && info.reason === 'reload') return;
        await post('session-end', { hook_event_name: 'SessionEnd', ...(cwd ? { cwd } : {}) });
      } catch {
        // 알리기만 한다
      }
    },

    // 시스템 프롬프트에 덧붙이는 글. 매번 같은 글이라 프롬프트 캐시를 깨지 않는다
    appendSystemPrompt: () => NOTE,
  });

  // 서브에이전트의 시작과 끝(지켜보기만 한다). 서브에이전트 안의 도구 호출은 이 mod의 beforeToolCall을 거치지 않는다
  cmd.on('subagent_start', (event) => {
    if (isPlain(event)) observe({ hook_event_name: 'SubagentStart', agent_id: String(event.toolCallId), agent_type: String(event.subagentType) });
  });
  cmd.on('subagent_stop', (event) => {
    if (isPlain(event)) observe({ hook_event_name: 'SubagentStop', agent_id: String(event.toolCallId), agent_type: String(event.subagentType) });
  });
}
`
  .replace('__B_STUDIO_TIMEOUTS__', () => JSON.stringify({ ...AGENT_HOOK_EVENTS }))
  .replace('__B_STUDIO_ADDRESS_FILE__', () => JSON.stringify(GATEWAY_FILE_NAME))
  .replace('__B_STUDIO_GATEWAY_DIR_ENV__', () => JSON.stringify(COMMAND_CODE_GATEWAY_DIR_ENV));

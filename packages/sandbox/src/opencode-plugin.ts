import { AGENT_HOOK_EVENTS, GATEWAY_FILE_NAME } from './docker/agent-terminal';

/**
 * OpenCode(`OPENCODE_CONFIG=<관문 폴더>/opencode.json`의 `plugin`에 적힌 이 파일)의 훅을 관문의 훅 통로에 잇는 플러그인(ADR-241, 실험).
 * Claude Code 터미널의 훅 스크립트(AGENT_HOOK_SCRIPT)와 같은 통로를 부르므로 판정 코드는 같다: 쓰기 범위·보호 경로, 쓰기 뒤 기록, 턴 끝 게이트, 요청 받기.
 *
 * 근거는 설치된 opencode 1.18.33의 바이너리에 든 소스와 `@opencode-ai/plugin` 1.18.33의 타입이다(실제로 띄워 보지는 않았다):
 * - 도구가 실행되기 전에 `tool.execute.before`를 **순서대로 기다리며** 부르고, 훅이 던지면 그 도구는 실행되지 않는다(`trigger`는 훅의 거절을 삼키지 않는다). 그래서 막는 방법은 던지기다.
 *   열리는 쪽(건너뛰기)으로 실패하지 않으므로 Command Code의 mod와 달리 "실패하면 막는다"가 던지기 하나로 된다. 그래도 정상 경로가 아닌 모든 길(관문에 닿지 못함·이상한 응답·시간 초과·직렬화 실패·이상한 훅 인자)에서 던진다.
 * - 플러그인이 불러와지지 않으면(파일을 읽지 못함·내보내기가 함수가 아님) OpenCode는 오류만 알리고 그대로 뜬다. 그래서 세션 시작 신호(`/session-start`)가 오지 않으면 서버가 위반으로 본다.
 *   신호는 **설정 훅에서 설정을 확인한 뒤에만** 보낸다: 설정에 우리 플러그인 말고 다른 플러그인(설정 파일·`.opencode/plugins`·원격 설정이 더한 것)이 하나라도 있으면 신호를 보내지 않고 모든 도구를 막는다.
 *   다른 플러그인은 우리 훅 뒤에 `output.args`를 바꿔 쓸 수 있기 때문이다.
 * - OpenCode에는 턴 끝을 막고 이어가게 하는 훅이 없다. 턴이 끝나면 `session.idle` 소식이 오고(기다려 주지 않는다), 이 플러그인이 그때 `/stop`을 부른다.
 *   게이트가 돌려보내면 사유를 같은 세션의 **다음 요청**(`client.session.promptAsync`)으로 보낸다. 보내지 못하면 통과로 읽지 않고 실패(`stop-failure`)로 알린다.
 * - 하위 에이전트(`task`)는 자기 세션(parentID가 있다)에서 같은 도구 훅을 거친다. 그 세션의 요청 받기·턴 끝은 사용자의 것이 아니라서 보내지 않는다.
 *
 * 응답은 **허용 목록**으로 읽는다: 관문이 실제로 내는 꼴(`{}`, `{systemMessage}`, 거절, 요청 막기, 맥락 글)만 알아보고 나머지는 이상한 응답이다.
 * 글 안에 의존성이 없다(관문 폴더에는 node_modules가 없다): node 내장만 가져온다. 토큰과 주소는 글에 박지 않고, 감싸개가 환경 변수(B_STUDIO_GATEWAY_DIR)로 알려 주는
 * 관문 폴더의 주소 파일에서 부를 때마다 읽는다. **내보내기는 기본 함수 하나뿐이다**(OpenCode는 함수가 아닌 내보내기가 있으면 플러그인을 불러오지 않는다).
 * 이 글에는 백틱과 `${`를 쓰지 않는다(템플릿 문자열로 담겨 있다).
 */

/** 관문 폴더 안의 플러그인 파일 이름. Rust 관문 파일 목록(GATEWAY_FILE_NAMES)과 같아야 한다 */
export const OPENCODE_PLUGIN_NAME = 'b-studio-opencode-plugin.js';
/** 관문 폴더 안의 OpenCode 설정 파일 이름(`OPENCODE_CONFIG`가 가리킨다). Rust 관문 파일 목록과 같아야 한다 */
export const OPENCODE_CONFIG_NAME = 'opencode.json';
/** 감싸개가 플러그인에 세션의 관문 폴더를 알리는 환경 변수(Command Code·Codex 감싸개와 같은 방식) */
export const OPENCODE_GATEWAY_DIR_ENV = 'B_STUDIO_GATEWAY_DIR';

export const OPENCODE_PLUGIN = String.raw`// b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_SECONDS = __B_STUDIO_TIMEOUTS__;
const ADDRESS_FILE = __B_STUDIO_ADDRESS_FILE__;
const GATEWAY_DIR_ENV = __B_STUDIO_GATEWAY_DIR_ENV__;
const PLUGIN_FILE = __B_STUDIO_PLUGIN_FILE__;
// 시간 상한은 낮추기만 할 수 있다(시험이 쓴다). 낮추면 더 막을 뿐이다
const TIMEOUT_CAP_MS = Number(process.env.B_STUDIO_MOD_TIMEOUT_MS);
// 게이트가 돌려보낸 뒤 이어서 받는 횟수. Claude Code·Command Code의 이어가기 상한과 같다
const MAX_CONTINUES = 8;
const MAX_LAST_TEXT = 20000;
// 관문의 응답 상한. 읽기 전에 센다: 이보다 크면 이상한 응답이다
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// 우리가 보낸 돌려보내기 글을 기억하는 시간. 이 시간이 지난 글은 사용자가 같은 글을 쳐도 새 요청으로 본다
const OWN_FEEDBACK_MS = 10 * 60 * 1000;
const BEFORE_TOOL_TEXT = '[b-studio] 관문에 닿지 못해(';
const PLUGIN_TEXT = '[b-studio] OpenCode의 설정에 b-studio의 플러그인 말고 다른 플러그인이 있거나 설정을 읽지 못해 모든 도구를 막았습니다. 다른 플러그인은 b-studio의 확인 뒤에 도구 입력을 바꿀 수 있습니다. 그 플러그인을 지운 뒤 터미널을 다시 여세요.';
const NOTE =
  '# b-studio\n' +
  '이 작업 폴더는 b-studio 세션의 작업 복사본이다. 커밋하지 않는다: git commit·git push·git reset·git checkout·git stash로 기록이나 브랜치를 바꾸지 않는다. 체크포인트(커밋)는 턴이 끝난 뒤 b-studio가 검증을 통과시켜 남긴다.\n' +
  '작업 폴더 밖의 파일을 바꾸지 않는다. OpenCode의 설정(opencode.json·.opencode 폴더)을 바꾸지 않는다.\n' +
  '검증이 실패하면 결과가 다음 요청으로 돌아온다. 그것은 사용자의 새 요청이 아니라 검증 결과다. 고친 뒤 다시 턴을 끝낸다. 끝내 통과하지 못하면 b-studio가 이번 요청의 변경을 되돌린다.\n' +
  '사용자에게 보이는 글은 한국어로 쓴다.';

const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const why = (error) => (error instanceof Error && error.message ? error.message : String(error));

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

// 이 플러그인 파일이 설정에 적히는 꼴(file URL). 설정 확인이 이 글과 견준다
function ownSpec() {
  const dir = process.env[GATEWAY_DIR_ENV];
  if (!nonEmpty(dir) || !path.isAbsolute(dir)) return undefined;
  return pathToFileURL(path.join(dir, PLUGIN_FILE)).href;
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
        let received = 0;
        response.on('data', (part) => {
          received += part.length;
          if (received > MAX_RESPONSE_BYTES) {
            done(reject, new Error('응답이 너무 큽니다'));
            request.destroy();
            return;
          }
          parts.push(part);
        });
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

// 설정의 플러그인 항목에서 이름(spec)만 꺼낸다: 글이거나 [글, 옵션]이다. 다른 모양은 읽을 수 없다
function specOf(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return undefined;
}

// 합쳐진 설정이 싣는 플러그인 이름 전부(plugin과 plugin_origins). 읽을 수 없으면 undefined
function configuredSpecs(config) {
  if (!isPlain(config) || !Array.isArray(config.plugin)) return undefined;
  const specs = [];
  for (const entry of config.plugin) {
    const spec = specOf(entry);
    if (spec === undefined) return undefined;
    specs.push(spec);
  }
  if (config.plugin_origins !== undefined) {
    if (!Array.isArray(config.plugin_origins)) return undefined;
    for (const origin of config.plugin_origins) {
      const spec = isPlain(origin) ? specOf(origin.spec) : undefined;
      if (spec === undefined) return undefined;
      specs.push(spec);
    }
  }
  return specs;
}

export default async function bStudioPlugin(input) {
  const cwd = isPlain(input) && typeof input.directory === 'string' ? input.directory : undefined;
  const client = isPlain(input) && isPlain(input.client) ? input.client : undefined;
  // 설정 확인이 끝나 우리 플러그인 하나뿐임을 본 뒤에만 도구를 관문에 묻는다. 그 전과 확인에 실패한 뒤에는 모든 도구를 막는다
  let configOk = false;
  let ended = false;
  const sessions = new Map();
  // 우리가 보낸 돌려보내기 글({text, at}). 요청 받기 훅이 이 글을 다시 받으면 사용자의 새 요청이 아니다. 오래된 글은 잊는다
  let ownFeedback = [];
  const takeOwnFeedback = (text) => {
    const now = Date.now();
    ownFeedback = ownFeedback.filter((entry) => now - entry.at < OWN_FEEDBACK_MS);
    const at = ownFeedback.findIndex((entry) => entry.text === text);
    if (at < 0) return false;
    ownFeedback.splice(at, 1);
    return true;
  };

  const stateFor = (id) => {
    let state = sessions.get(id);
    if (!state) {
      state = { root: undefined, running: false, aborted: false, errored: undefined, blocked: false, continues: 0, unreachable: 0, unverified: false, assistantId: undefined, texts: new Map() };
      sessions.set(id, state);
    }
    return state;
  };
  const resetRun = (state) => {
    state.blocked = false;
    state.continues = 0;
    state.unreachable = 0;
    state.unverified = false;
  };
  const sessionIdOf = (value) => (isPlain(value) && nonEmpty(value.sessionID) ? value.sessionID : undefined);

  // 사용자에게만 보이는 알림 한 줄. 알림이 던져도 판정은 그대로다
  const toast = (text) => {
    try {
      if (nonEmpty(text) && client && isPlain(client.tui) && typeof client.tui.showToast === 'function') Promise.resolve(client.tui.showToast({ body: { message: text, variant: 'info' } })).catch(() => {});
    } catch {
      // 알림일 뿐이다
    }
  };
  // 지켜보기만 하는 통로(도구의 끝, 세션 시작·끝). 던지지 않고 기다리지도 않는다. 판정과 상관없다
  const observe = (event, payload) => {
    try {
      post(event, payload).catch(() => {});
    } catch {
      // 지켜보기일 뿐이다
    }
  };
  const failure = (error) => post('stop-failure', { hook_event_name: 'StopFailure', error, ...(cwd ? { cwd } : {}) }).catch(() => {});

  // 하위 에이전트(parentID가 있는 세션)인가. 모르면 물어서 안다(재개한 세션은 created 소식이 없다). 알 수 없으면 루트로 본다: 게이트를 건너뛰는 쪽으로 틀리지 않는다
  const isRoot = async (id) => {
    const state = stateFor(id);
    if (state.root !== undefined) return state.root;
    let root = true;
    try {
      const result = client && isPlain(client.session) && typeof client.session.get === 'function' ? await client.session.get({ path: { id } }) : undefined;
      const data = isPlain(result) ? result.data : undefined;
      if (isPlain(data) && typeof data.parentID === 'string' && data.parentID !== '') root = false;
    } catch {
      root = true;
    }
    state.root = root;
    return root;
  };

  // 게이트의 사유를 같은 세션의 다음 요청으로 보낸다. 보내지 못하면 false
  const deliver = async (id, text) => {
    if (!client || !isPlain(client.session) || typeof client.session.promptAsync !== 'function') return false;
    const entry = { text, at: Date.now() };
    ownFeedback.push(entry);
    try {
      const result = await client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } });
      if (isPlain(result) && result.error) throw new Error('요청이 받아들여지지 않았습니다');
      return true;
    } catch {
      const at = ownFeedback.indexOf(entry);
      if (at >= 0) ownFeedback.splice(at, 1);
      return false;
    }
  };

  const lastText = (state) => [...state.texts.values()].join('\n').slice(0, MAX_LAST_TEXT);

  // 턴 끝 게이트(Stop에 해당). 사용자의 중단은 알리지 않고, 오류로 끝난 턴은 실패로 알리고, 자연스러운 끝은 게이트를 돈다.
  // 서버에 닿지 못하면 통과로 읽지 않는다: 한 번은 검증하지 못했다고 알려 다시 끝내게 하고, 연달아 닿지 못하면 멈추되 알린다
  const turnEnded = async (id) => {
    if (!configOk) return;
    const state = stateFor(id);
    if (state.running) return;
    state.running = true;
    try {
      if (!(await isRoot(id))) return;
      if (state.aborted) {
        state.aborted = false;
        resetRun(state);
        return;
      }
      if (state.errored !== undefined) {
        const name = state.errored;
        state.errored = undefined;
        resetRun(state);
        await failure('run_end:error:' + name);
        return;
      }
      let answer;
      try {
        answer = readStop(await post('stop', { hook_event_name: 'Stop', last_assistant_message: lastText(state), ...(cwd ? { cwd } : {}) }));
      } catch (error) {
        state.blocked = false;
        state.unverified = true;
        state.unreachable += 1;
        const text = '[b-studio] 관문에 닿지 못해(' + why(error) + ') 이번 변경을 검증하지 못했습니다. 체크포인트가 생기지 않았습니다.';
        if (state.unreachable <= 1 && (await deliver(id, text + ' 같은 변경을 다시 보여 주며 턴을 끝내세요.'))) return;
        toast(text);
        resetRun(state);
        await failure('stop_unverified');
        return;
      }
      state.unreachable = 0;
      state.unverified = false;
      if (answer.feedback) {
        state.blocked = true;
        state.continues += 1;
        if (state.continues > MAX_CONTINUES) {
          resetRun(state);
          await failure('stop_gate_not_passed');
          return;
        }
        if (!(await deliver(id, answer.feedback))) {
          resetRun(state);
          await failure('stop_feedback_not_delivered');
        }
        return;
      }
      resetRun(state);
      toast(answer.message);
    } finally {
      state.running = false;
    }
  };

  const sessionEnd = async () => {
    if (ended) return;
    ended = true;
    // 인스턴스를 다시 만드는 경우(설정 다시 읽기)와 CLI의 끝을 가를 수 없다. 서버는 이 알림으로 열린 실행을 닫지 않는다(reason: dispose)
    await post('session-end', { hook_event_name: 'SessionEnd', reason: 'dispose', ...(cwd ? { cwd } : {}) }).catch(() => {});
  };

  const handleEvent = async (event) => {
    const properties = isPlain(event.properties) ? event.properties : {};
    switch (event.type) {
      case 'session.created': {
        const info = isPlain(properties.info) ? properties.info : undefined;
        if (info && nonEmpty(info.id)) stateFor(info.id).root = !(typeof info.parentID === 'string' && info.parentID !== '');
        return;
      }
      case 'session.deleted': {
        const info = isPlain(properties.info) ? properties.info : undefined;
        if (info && nonEmpty(info.id)) sessions.delete(info.id);
        return;
      }
      case 'message.updated': {
        const info = isPlain(properties.info) ? properties.info : undefined;
        if (info && info.role === 'assistant' && nonEmpty(info.id) && nonEmpty(info.sessionID)) {
          const state = stateFor(info.sessionID);
          if (state.assistantId !== info.id) {
            state.assistantId = info.id;
            state.texts = new Map();
          }
        }
        return;
      }
      case 'message.part.updated': {
        const part = isPlain(properties.part) ? properties.part : undefined;
        if (part && part.type === 'text' && typeof part.text === 'string' && nonEmpty(part.id) && nonEmpty(part.sessionID)) {
          const state = stateFor(part.sessionID);
          if (part.messageID === state.assistantId) state.texts.set(part.id, part.text);
        }
        return;
      }
      case 'session.error': {
        const id = sessionIdOf(properties);
        if (id === undefined) return;
        const error = isPlain(properties.error) ? properties.error : undefined;
        const name = error && nonEmpty(error.name) ? error.name : 'unknown';
        // 사람이 누른 중단은 실패가 아니다. 실행을 열어 두고 다음 요청이 이어 간다
        if (name === 'MessageAbortedError') stateFor(id).aborted = true;
        else stateFor(id).errored = name;
        return;
      }
      case 'session.idle': {
        const id = sessionIdOf(properties);
        if (id === undefined) return;
        try {
          await turnEnded(id);
        } catch {
          // 게이트를 돌리지 못했다. 소식을 읽다 나는 예상 밖의 오류를 통과로 읽지 않는다: 검증하지 못한 끝으로 알린다
          await failure('stop_unverified');
        }
        return;
      }
      case 'server.instance.disposed':
        await sessionEnd();
        return;
      default:
        return;
    }
  };

  return {
    // 합쳐진 설정을 본다. 우리 플러그인 하나뿐이어야 한다: 다른 플러그인은 우리 훅 뒤에 도구 입력을 바꿔 쓸 수 있다. 확인한 뒤에만 세션 시작 신호를 보낸다
    config: async (config) => {
      try {
        const specs = configuredSpecs(config);
        const ours = ownSpec();
        configOk = specs !== undefined && ours !== undefined && specs.length > 0 && specs.every((spec) => spec === ours);
      } catch {
        configOk = false;
      }
      if (configOk) observe('session-start', { hook_event_name: 'SessionStart', source: 'startup', ...(cwd ? { cwd } : {}) });
    },

    // 요청 받기(UserPromptSubmit). 관문에 닿지 못하거나 응답이 이상하면 던져 요청을 받지 않는다. 우리가 보낸 돌려보내기 글과 하위 에이전트의 요청은 사용자의 요청이 아니다
    'chat.message': async (hookInput, output) => {
      if (!configOk) throw new Error(PLUGIN_TEXT);
      const id = sessionIdOf(hookInput);
      const parts = isPlain(output) && Array.isArray(output.parts) ? output.parts : undefined;
      if (id === undefined || parts === undefined) throw new Error(BEFORE_TOOL_TEXT + '요청을 읽지 못해) 요청을 보내지 않았습니다. 다시 보내 주세요.');
      const texts = parts.filter((part) => isPlain(part) && part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true);
      const text = texts.map((part) => part.text).join('\n');
      if (takeOwnFeedback(text)) return;
      // 글이 없는 요청(자동으로 끼워 넣은 글뿐인 메시지)은 사용자의 요청이 아니다. 실행은 첫 쓰기 직전 훅이 연다
      if (texts.length === 0) return;
      if (!(await isRoot(id))) return;
      const state = stateFor(id);
      resetRun(state);
      state.aborted = false;
      state.errored = undefined;
      let answer;
      try {
        answer = readPrompt(await post('prompt', { hook_event_name: 'UserPromptSubmit', prompt: text, ...(cwd ? { cwd } : {}) }));
      } catch (error) {
        throw new Error(BEFORE_TOOL_TEXT + why(error) + ') 요청을 보내지 않았습니다. 다시 보내 주세요.');
      }
      if (answer.blocked) throw new Error(answer.blocked);
      if (answer.note && texts.length > 0) texts[0].text = texts[0].text + '\n\n' + answer.note;
    },

    // 쓰기 직전(PreToolUse). 모든 도구를 관문에 묻는다: 읽기 도구를 거르는 표는 서버에 한 곳뿐이다. 정상 경로가 아니면 모두 던진다(던지면 도구는 실행되지 않는다)
    'tool.execute.before': async (hookInput, output) => {
      if (!configOk) throw new Error(PLUGIN_TEXT);
      if (!isPlain(hookInput) || !isPlain(output) || !nonEmpty(hookInput.tool)) throw new Error(BEFORE_TOOL_TEXT + '훅 인자를 읽지 못해) 파일을 바꿀 수 있는 도구를 막았습니다.');
      let answer;
      try {
        answer = readPreTool(await post('pre-tool', { hook_event_name: 'PreToolUse', tool_name: hookInput.tool, tool_input: output.args, tool_use_id: String(hookInput.callID), ...(cwd ? { cwd } : {}) }));
      } catch (error) {
        throw new Error(BEFORE_TOOL_TEXT + why(error) + ') 파일을 바꿀 수 있는 도구를 막았습니다. 변경 전 기준을 잡을 수 없습니다.');
      }
      if (answer.deny) throw new Error(answer.deny);
      toast(answer.message);
    },

    // 쓰기 뒤(PostToolUse). 지켜보기만 한다. 도구의 출력은 보내지 않는다
    'tool.execute.after': async (hookInput) => {
      try {
        if (!configOk || !isPlain(hookInput) || !nonEmpty(hookInput.tool)) return;
        observe('activity', { hook_event_name: 'PostToolUse', tool_name: hookInput.tool, tool_input: hookInput.args, tool_use_id: String(hookInput.callID), ...(cwd ? { cwd } : {}) });
      } catch {
        // 지켜보기일 뿐이다
      }
    },

    // 시스템 프롬프트에 덧붙이는 글. 매번 같은 글이라 프롬프트 캐시를 깨지 않는다
    'experimental.chat.system.transform': async (hookInput, output) => {
      try {
        if (configOk && isPlain(output) && Array.isArray(output.system)) output.system.push(NOTE);
      } catch {
        // 안내일 뿐이다
      }
    },

    // 세션 소식. OpenCode는 기다려 주지 않으므로 던지지 않는다
    event: async (hookInput) => {
      try {
        const event = isPlain(hookInput) ? hookInput.event : undefined;
        if (isPlain(event) && typeof event.type === 'string') await handleEvent(event);
      } catch {
        // 소식을 읽지 못해도 판정은 그대로다
      }
    },

    dispose: async () => {
      try {
        await sessionEnd();
      } catch {
        // 알리기만 한다
      }
    },
  };
}
`
  .replace('__B_STUDIO_TIMEOUTS__', () => JSON.stringify({ ...AGENT_HOOK_EVENTS }))
  .replace('__B_STUDIO_ADDRESS_FILE__', () => JSON.stringify(GATEWAY_FILE_NAME))
  .replace('__B_STUDIO_GATEWAY_DIR_ENV__', () => JSON.stringify(OPENCODE_GATEWAY_DIR_ENV))
  .replace('__B_STUDIO_PLUGIN_FILE__', () => JSON.stringify(OPENCODE_PLUGIN_NAME));

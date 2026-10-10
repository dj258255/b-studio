// 부하 확인(workflow.loadChecks) 러너. 샌드박스의 internal 네트워크에 붙인 일회용 컨테이너 안에서 돈다.
// 호출자가 이 파일 앞에 `globalThis.B_STUDIO_LOAD = {...};` 한 줄을 붙여 표준 입력으로 넘긴다(인자·환경 변수에 본문을 싣지 않는다).
// 결과는 표준 출력의 마지막 줄에 JSON 한 줄로 쓴다. 판정은 하지 않는다 — 잰 값만 돌려주고 판정은 게이트가 한다.
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

const config = globalThis.B_STUDIO_LOAD;
const { host, requests, concurrent, warmup = 0, threads = 1, deadlineMs } = config;
const deadlineAt = Date.now() + deadlineMs;
// 이름은 한 번만 푼다. 연결마다 풀면 이름 풀이가 줄을 서서 연결 시간에 섞인다
const { address } = await lookup(host);

/**
 * 스레드 하나가 하는 일. 문자열로 바꿔 Worker에 넘기므로 바깥 변수를 쓰지 않는다.
 * 러너를 스레드로 나누는 까닭: 한 스레드가 초당 수천 건의 응답을 처리하면 응답을 받아 놓고도 시각을 늦게 찍어 응답 시간이 부풀려진다
 */
function worker() {
  // Worker는 부모의 --input-type을 물려받아 모듈로도, 스크립트로도 평가될 수 있다. 어느 쪽에서도 되는 방법으로 내장 모듈을 가져온다
  const builtin = (name) => process.getBuiltinModule(name);
  const { randomUUID } = builtin('node:crypto');
  const http = builtin('node:http');
  const net = builtin('node:net');
  const { monitorEventLoopDelay, performance } = builtin('node:perf_hooks');
  const { parentPort, workerData } = builtin('node:worker_threads');
  const { address, host, port, method, path, headers = {}, body, latencyOf, requestTimeoutMs, deadlineAt, total, connections, firstSeq, step } = workerData;

  const expired = () => Date.now() > deadlineAt;
  const fill = (text, seq) => text.replaceAll('{{seq}}', String(seq)).replaceAll('{{uuid}}', () => randomUUID());

  /** 연결 하나를 맺고 걸린 시간을 잰다. 맺지 못하면 socket 없이 돌려준다 */
  function connect() {
    return new Promise((resolve) => {
      const started = performance.now();
      const socket = net.connect({ host: address, port });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), requestTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve({ socket, ms: performance.now() - started });
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error.code ?? 'CONNECT' });
      });
    });
  }

  /** 미리 맺어 둔 연결부터 내주는 연결 풀. 다 쓰면 평소처럼 새로 맺는다 */
  class WarmAgent extends http.Agent {
    constructor(sockets, options) {
      super(options);
      this.warm = sockets;
    }

    createConnection(options, callback) {
      return this.warm.pop() ?? super.createConnection(options, callback);
    }
  }

  /**
   * 요청 하나. 응답 시간은 요청을 연결에 실어 보내는 때부터 응답 본문을 다 받을 때까지다.
   * 연결은 미리 맺어 둔 것을 쓰므로 응답 시간에 들어가지 않는다(연결에 걸린 시간은 따로 잰다)
   */
  function send(seq, agent) {
    return new Promise((resolve) => {
      const payload = body === undefined || method === 'GET' ? undefined : fill(body, seq);
      const filled = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, fill(value, seq)]));
      if (!Object.keys(filled).some((name) => name.toLowerCase() === 'host')) filled.host = `${host}:${port}`;
      if (payload !== undefined) {
        if (!Object.keys(filled).some((name) => name.toLowerCase() === 'content-type')) filled['content-type'] = 'application/json';
        filled['content-length'] = Buffer.byteLength(payload);
      }
      let settled = false;
      let timer;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const request = http.request({ host: address, port, method, path: fill(path, seq), agent, headers: filled });
      timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), requestTimeoutMs);
      let sent = performance.now();
      // 요청을 만든 때가 아니라 연결에 실어 보내는 때부터 잰다. 한 번에 수백 건을 만들면 만드는 데만 수십 ms가 걸려, 만든 때부터 재면 그 시간이 응답 시간에 섞인다.
      // 미리 맺은 연결이 없어 새로 맺어야 했다면 맺어진 뒤부터 잰다
      request.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => (sent = performance.now()));
        else sent = performance.now();
      });
      request.on('response', (response) => {
        response.resume();
        response.on('end', () => done({ status: response.statusCode, ms: performance.now() - sent }));
        response.on('error', (error) => done({ error: error.code ?? 'RESPONSE' }));
      });
      request.on('error', (error) => done({ error: error.code ?? error.name ?? 'ERROR' }));
      request.end(payload);
    });
  }

  const count = (map, key) => (map[key] = (map[key] ?? 0) + 1);

  (async () => {
    const size = Math.min(connections, total);
    // 연결을 먼저 모두 맺은 뒤 신호를 받고 한꺼번에 보내기 시작한다 — 동시에 새 연결 수백 개를 여는 비용이 응답 시간에 섞이지 않게 하려는 것이다
    const opened = await Promise.all(Array.from({ length: size }, connect));
    const agent = new WarmAgent(
      opened.flatMap((entry) => (entry.socket ? [entry.socket] : [])),
      { keepAlive: true, maxSockets: size },
    );
    parentPort.postMessage({ ready: true, connectMs: opened.flatMap((entry) => (entry.socket ? [entry.ms] : [])), connectErrors: opened.filter((entry) => entry.error).length });
    await new Promise((resolve) => parentPort.once('message', resolve));

    const statuses = {};
    const errors = {};
    const selected = [];
    let next = 0;
    // 연결을 다 맺은 뒤부터 이 스레드의 밀림을 잰다
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    await Promise.all(
      Array.from({ length: size }, async () => {
        while (next < total && !expired()) {
          const result = await send(firstSeq + step * next++, agent);
          if (result.error) count(errors, result.error);
          else {
            count(statuses, String(result.status));
            if (!latencyOf || latencyOf.includes(result.status)) selected.push(result.ms);
          }
        }
      }),
    );
    loop.disable();
    agent.destroy();
    parentPort.postMessage({ done: true, statuses, errors, selected, sent: next, loopP99: loop.percentile(99) / 1e6, loopMax: loop.max / 1e6 });
  })();
}

/**
 * total건을 스레드 parts개, 연결 connections개로 나눠 보낸다. 모든 스레드가 연결을 다 맺은 뒤 한꺼번에 시작한다.
 * 요청 번호({{seq}})는 스레드마다 겹치지 않게 건너뛰며 쓴다
 */
async function run(total, connections, firstSeq, parts) {
  const size = Math.max(1, Math.min(parts, connections, total));
  const { host: _host, requests: _requests, concurrent: _concurrent, warmup: _warmup, threads: _threads, deadlineMs: _deadlineMs, ...request } = config;
  const workers = Array.from({ length: size }, (_, index) => {
    const share = (amount) => Math.floor(amount / size) + (index < amount % size ? 1 : 0);
    return new Worker(`(${worker.toString()})()`, {
      eval: true,
      workerData: { ...request, host, address, deadlineAt, total: share(total), connections: share(connections), firstSeq: firstSeq + index, step: size },
    });
  });
  // 스레드가 메시지를 보내기 전에 죽으면 기다리지 않고 실패로 끝낸다
  const message = (entry, key) =>
    new Promise((resolve, reject) => {
      const listen = (value) => (value?.[key] ? resolve(value) : entry.once('message', listen));
      entry.once('message', listen);
      entry.once('error', reject);
      entry.once('exit', (code) => reject(new Error(`load worker exited with ${code}`)));
    });
  const ready = await Promise.all(workers.map((entry) => message(entry, 'ready')));
  const began = performance.now();
  const finished = workers.map((entry) => message(entry, 'done'));
  for (const entry of workers) entry.postMessage('go');
  const parts_ = await Promise.all(finished);
  const elapsedMs = performance.now() - began;
  await Promise.all(workers.map((entry) => entry.terminate()));
  return { ready, parts: parts_, elapsedMs };
}

const round = (value) => Math.round(value * 10) / 10;

/** 가까운 순위 방식의 백분위. 표본이 적으면 높은 백분위는 최댓값과 같아진다 */
function summarize(values) {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1)) };
}

const merge = (maps) => {
  const total = {};
  for (const map of maps) for (const [key, value] of Object.entries(map)) total[key] = (total[key] ?? 0) + value;
  return total;
};
const sum = (values) => values.reduce((total, value) => total + value, 0);

// 준비 요청은 재지 않는다. 적은 동시 수로 보내 JIT·연결 풀 같은 첫 요청 비용만 걷어 낸다
const warm = { requests: 0, errors: 0 };
if (warmup > 0) {
  const warmed = await run(warmup, Math.min(concurrent, 20), 1, 1);
  warm.requests = sum(warmed.parts.map((part) => part.sent));
  warm.errors = sum(warmed.parts.map((part) => sum(Object.values(part.errors))));
}

const measured = await run(requests, concurrent, warm.requests + 1, threads);
const statuses = merge(measured.parts.map((part) => part.statuses));
const errors = merge(measured.parts.map((part) => part.errors));
const sentCount = sum(measured.parts.map((part) => part.sent));
// 제한 시간 때문에 보내지 못한 요청도 응답을 받지 못한 요청으로 센다
if (sentCount < requests) errors.DEADLINE = requests - sentCount;

const result = {
  requests,
  concurrent,
  threads: measured.parts.length,
  completed: sum(Object.values(statuses)),
  elapsedMs: round(measured.elapsedMs),
  statuses,
  errors,
  latency: summarize(measured.parts.flatMap((part) => part.selected)),
  connect: { ...summarize(measured.ready.flatMap((part) => part.connectMs)), errors: sum(measured.ready.map((part) => part.connectErrors)) },
  // 러너 자신이 밀린 정도(스레드 가운데 가장 큰 값). 이 값이 크면 응답 시간에 러너의 지연이 섞였다는 뜻이다
  loopDelay: { p99: round(Math.max(...measured.parts.map((part) => part.loopP99))), max: round(Math.max(...measured.parts.map((part) => part.loopMax))) },
  warmup: warm,
};
process.stdout.write(`\n${JSON.stringify(result)}\n`);

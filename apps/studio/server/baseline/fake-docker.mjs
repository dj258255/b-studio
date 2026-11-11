// 시험 전용 가짜 `docker`(ADR-195 4f F0). 진짜 docker를 부르지 않는다: 받은 인자를 기록하고, 시나리오가 정한 결과를 돌려준다.
// 호출: node fake-docker.mjs <가짜 bin 폴더> [docker 인자...]  (같은 폴더의 `docker` 실행 파일이 이렇게 부른다)
//
// 시나리오는 호출할 때마다 `<폴더>/docker-scenario.json`을 새로 읽는다(시험이 실행 도중에 바꿀 수 있다). 기록은 `<폴더>/docker-calls.jsonl`에 한 줄씩 붙인다.
// 모르는 하위 명령은 "성공, 빈 출력"이 아니라 실패(exit 125)로 답하고 기록한다 — 기준 사진이 모르는 호출을 조용히 지나치지 않게 한다.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [binDir, ...argv] = process.argv.slice(2);
const scenario = existsSync(path.join(binDir, 'docker-scenario.json')) ? JSON.parse(readFileSync(path.join(binDir, 'docker-scenario.json'), 'utf8')) : {};
const COUNTS = path.join(binDir, 'docker-rule-counts');

// compose 공통 옵션(프로젝트 이름·폴더·파일)을 떼고 하위 명령만 남긴다
let project;
let sub = argv;
if (argv[0] === 'compose') {
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-name') project = argv[++i];
    else if (['--project-directory', '--file', '--env-file', '-f', '--profile', '--ansi', '--progress'].includes(a)) i++;
    else rest.push(a);
  }
  sub = ['compose', ...rest];
}

const stdin = process.stdin.isTTY ? '' : await new Promise((resolve) => {
  let text = '';
  process.stdin.on('data', (chunk) => (text += chunk));
  process.stdin.on('end', () => resolve(text));
  process.stdin.on('error', () => resolve(text));
  setTimeout(() => resolve(text), 50).unref();
});

const entry = { argv, sub, project, cwd: process.cwd(), stdinBytes: stdin.length };
const finish = (reply, how) => {
  appendFileSync(path.join(binDir, 'docker-calls.jsonl'), `${JSON.stringify({ ...entry, how, exit: reply.exit ?? 0 })}\n`);
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exit(reply.exit ?? 0);
};

const isSubsequence = (needle, hay) => {
  let at = 0;
  for (const token of hay) if (token === needle[at]) at++;
  return at === needle.length;
};

// 1) 시나리오가 정한 규칙이 먼저. when은 하위 명령 토큰의 부분열이다. times를 주면 그 횟수만 쓴다(횟수는 규칙마다 파일 하나에 덧붙여 센다: 호출이 겹쳐도 서로의 기록을 덮지 않는다)
mkdirSync(COUNTS, { recursive: true });
for (const [index, rule] of (scenario.rules ?? []).entries()) {
  if (!isSubsequence(rule.when, sub)) continue;
  if (rule.times !== undefined) {
    const file = path.join(COUNTS, String(index));
    appendFileSync(file, 'x');
    if (statSync(file).size > rule.times) continue;
  }
  if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
  if (!rule.inspectPatch) finish(rule.reply ?? {}, `rule:${index}`);
  break;
}

// 2) 기본 응답: 정상 compose 프로젝트 하나(서비스 목록은 시나리오의 services)
const services = [...(scenario.services ?? ['app']), 'b-studio-edge'];
const managed = scenario.services ?? ['app'];
// 컨테이너 id는 (프로젝트, 서비스)에서 정하고, `docker inspect <id>`가 프로젝트를 되찾도록 id마다 파일 하나에 적어 둔다(호출이 겹쳐도 안전하다)
const IDS = path.join(binDir, 'docker-ids');
mkdirSync(IDS, { recursive: true });
const idOf = (service, owner = project) => {
  const id = createHash('sha256').update(`${owner}/${service}`).digest('hex');
  writeFileSync(path.join(IDS, id), JSON.stringify({ project: owner, service }));
  return id;
};
const knownId = (id) => (existsSync(path.join(IDS, id)) ? JSON.parse(readFileSync(path.join(IDS, id), 'utf8')) : undefined);
const patchRule = (scenario.rules ?? []).find((rule) => rule.inspectPatch && isSubsequence(rule.when, sub));
const state = scenario.state ?? 'running';
const inspectRow = (id) => {
  const { project, service } = knownId(id) ?? { project: 'unknown', service: 'app' };
  const base = {
    Id: id,
    Name: `/${project}-${service}-1`,
    State: { Status: state, Running: state === 'running', ExitCode: 0 },
    Config: { Labels: { 'com.docker.compose.service': service } },
    HostConfig: {},
    NetworkSettings: { Networks: { [`${project}_b-studio-sandbox`]: {}, ...(service === 'b-studio-edge' ? { [`${project}_b-studio-egress`]: {} } : {}) } },
    Mounts: [],
  };
  const patch = patchRule?.inspectPatch?.[service];
  return patch ? { ...base, ...patch, HostConfig: { ...base.HostConfig, ...(patch.HostConfig ?? {}) } } : base;
};

const [cmd, ...rest] = sub;
const reply = (() => {
  if (cmd === 'compose') {
    const [verb, ...args] = rest;
    if (verb === 'config') return { stdout: JSON.stringify({ services: Object.fromEntries(managed.map((name) => [name, {}])), volumes: {} }) };
    if (verb === 'build' || verb === 'up' || verb === 'start' || verb === 'stop' || verb === 'down' || verb === 'restart' || verb === 'rm') return {};
    if (verb === 'port') return { stdout: `0.0.0.0:${scenario.readyPort ?? 1}\n` };
    if (verb === 'ps') {
      if (args.includes('--quiet')) return { stdout: services.map((s) => idOf(s)).join('\n') + '\n' };
      const names = args.filter((a) => !a.startsWith('-') && a !== 'json');
      const wanted = names.length > 0 ? names.filter((name) => services.includes(name)) : services;
      return { stdout: wanted.map((name) => JSON.stringify({ Service: name, State: state, Name: `${project}-${name}-1` })).join('\n') + '\n' };
    }
    if (verb === 'logs') {
      return { stdout: (scenario.logs ?? []).map((line) => `${project}-app-1  | ${line}\n`).join(''), hang: args.includes('--follow') };
    }
    if (verb === 'exec') return { stdout: '', exit: 0 };
  }
  if (cmd === 'inspect') {
    const wantedIds = rest.filter((a) => !a.startsWith('-') && a !== '{{json .State}}');
    if (rest.includes('--format')) return { stdout: wantedIds.map(() => JSON.stringify({ Status: state, ExitCode: 0, Health: { Status: 'healthy' } })).join('\n') + '\n' };
    return { stdout: JSON.stringify(wantedIds.map((id) => inspectRow(id))) };
  }
  if (cmd === 'volume' || cmd === 'network' || cmd === 'rm' || cmd === 'start' || cmd === 'stop') return rest[0] === 'inspect' ? { stdout: '[]' } : {};
  if (cmd === 'image') return { stdout: '' };
  if (cmd === 'stats') {
    return { stdout: rest.filter((a) => !a.startsWith('-') && !a.startsWith('{')).map((name) => JSON.stringify({ Name: name, CPUPerc: '0.50%', MemUsage: '10MiB / 1GiB', MemPerc: '1.00%', NetIO: '1kB / 2kB' })).join('\n') + '\n' };
  }
  if (cmd === 'run') {
    // 파일 반영 확인(SYNC_SCRIPT): `--volume <프로젝트>:/project:ro` 안의 파일마다 sha256을 낸다
    return { sync: true };
  }
  if (cmd === 'info' || cmd === 'version') return { stdout: '{}\n' };
  return { exit: 125, stderr: `fake-docker: 시나리오가 모르는 호출입니다: ${argv.join(' ')}\n` };
})();

if (reply.sync) {
  const { readFileSync: read, statSync } = await import('node:fs');
  const volume = argv[argv.indexOf('--volume') + 1] ?? '';
  const root = volume.slice(0, volume.lastIndexOf(':/project'));
  const sep = argv.lastIndexOf('sh');
  const targets = argv.slice(sep + 1);
  let out = '';
  for (const target of targets) {
    try {
      if (!statSync(path.join(root, target)).isFile()) throw new Error('not file');
      out += `${createHash('sha256').update(read(path.join(root, target))).digest('hex')} ${target}\n`;
    } catch {
      out += `MISSING ${target}\n`;
    }
  }
  finish({ stdout: out }, 'default:sync');
}
if (reply.hang) {
  appendFileSync(path.join(binDir, 'docker-calls.jsonl'), `${JSON.stringify({ ...entry, how: 'default:follow', exit: null })}\n`);
  process.stdout.write(reply.stdout);
  setTimeout(() => process.exit(0), 10 * 60_000);
  process.on('SIGTERM', () => process.exit(143));
  process.stdout.on('error', () => process.exit(0));
} else {
  finish(reply, reply.exit === 125 ? 'unknown' : 'default');
}

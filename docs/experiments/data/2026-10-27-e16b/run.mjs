// 사용: node run.mjs base | node run.mjs rep <A|D> <회차>
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ask, PROJECT } from './harness.mjs';
import { REQUESTS, SETUP } from './plan.mjs';

const S = path.dirname(new URL(import.meta.url).pathname);
const reset = () => execFileSync('rsync', ['-a', '--delete', `${S}/pristine/`, `${PROJECT}/`]);
const state = () => (existsSync(`${S}/state.json`) ? JSON.parse(readFileSync(`${S}/state.json`, 'utf8')) : {});
const save = (s) => writeFileSync(`${S}/state.json`, JSON.stringify(s, null, 1));

function judge(req, r) {
  if (req.kind === 'edit') {
    const text = readFileSync(path.join(PROJECT, req.check.file), 'utf8');
    const ok = (!req.check.includes || text.includes(req.check.includes)) && (!req.check.excludes || !text.includes(req.check.excludes));
    return ok ? 'ok' : 'fail';
  }
  const answer = r.result ?? r.lastText ?? '';
  if (answer.includes(req.expect)) return 'ok';
  if (/모르|기억나지|기억이 나지|확인할 수 없|알 수 없/.test(answer)) return 'unknown';
  return 'wrong';
}

const [cmd, variant, rep] = process.argv.slice(2);
if (cmd === 'base') {
  reset();
  let id;
  for (const [i, text] of SETUP.entries()) {
    const r = await ask(text, { resume: id, label: `base:s${i + 1}`, maxTurns: 30 });
    id = r.sessionId;
    console.log(`s${i + 1}`, r.subtype, r.turns, 'turns', 'ctx', r.firstContext, 'compactions', JSON.stringify(r.compactions));
  }
  save({ ...state(), base: id });
  console.log('base', id);
}
if (cmd === 'rep') {
  const { base } = state();
  reset();
  const label = `${variant}${rep}`;
  // 반복마다 같은 시작 대화를 복제한다. 캐시 데우기도 따로 복제한 대화에서 한다(본 대화를 더럽히지 않게)
  const warm = (await forkSession(base, { dir: PROJECT })).sessionId;
  const w = await ask("준비 확인입니다. '네'라고만 답해 주세요.", { resume: warm, label: `${label}:warm` });
  console.log('warm', w.firstContext, 'read', w.usage?.cacheRead, 'write', w.usage?.cacheWrite);
  let id = (await forkSession(base, { dir: PROJECT })).sessionId;
  // D는 앞 요청(시작 대화의 마지막 요청)이 끝났으므로 먼저 압축해 둔다
  const compact = async (after) => {
    const c = await ask('/compact', { resume: id, label: `${label}:compact:${after}` });
    id = c.sessionId;
    console.log(`  compact after ${after}`, JSON.stringify(c.compactions), 'ms', c.wallMs);
  };
  if (variant === 'D') await compact('base');
  for (const [i, req] of REQUESTS.entries()) {
    const r = await ask(req.text, { resume: id, label: `${label}:${req.id}` });
    id = r.sessionId;
    const verdict = judge(req, r);
    const line = JSON.stringify({ rep: label, id: req.id, kind: req.kind, verdict, answer: (r.result ?? r.lastText ?? '').slice(0, 300), turns: r.turns, wallMs: r.wallMs, firstContext: r.firstContext, usage: r.usage, compactions: r.compactions, subtype: r.subtype });
    execFileSync('sh', ['-c', `cat >> ${S}/verdicts.jsonl`], { input: line + '\n' });
    console.log(`  ${req.id} ${verdict} turns=${r.turns} ${r.wallMs}ms ctx=${r.firstContext} auto=${r.compactions.length}`);
    if (variant === 'D' && i < REQUESTS.length - 1) await compact(req.id);
  }
}

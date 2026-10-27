import { readFileSync, writeFileSync } from 'node:fs';
const S = process.argv[2];
const calls = readFileSync(`${S}/calls.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const verdicts = readFileSync(`${S}/verdicts.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const conv = (u) => u.input + u.cacheRead * 0.1 + u.cacheWrite * 1.25 + u.output * 5;
const mu = (m) => Object.values(m ?? {}).reduce((a, x) => ({ input: a.input + x.inputTokens, cacheRead: a.cacheRead + x.cacheReadInputTokens, cacheWrite: a.cacheWrite + x.cacheCreationInputTokens, output: a.output + x.outputTokens }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const reps = ['A1', 'D1', 'A2', 'D2', 'A3', 'D3'];
const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'];
// 요청은 modelUsage(보조 모델 포함)로 센다. 압축도 같은 기준이다
const req = (rep, id) => calls.find((c) => c.label === `${rep}:${id}`);
const cmp = (rep, after) => calls.find((c) => c.label === `${rep}:compact:${after}`);
const out = { requests: [], compactions: [], perVariant: {} };
for (const rep of reps) {
  for (const id of ids) {
    const c = req(rep, id); const u = mu(c.modelUsage); const v = verdicts.find((x) => x.rep === rep && x.id === id);
    out.requests.push({ rep, variant: rep[0], id, kind: v.kind, verdict: v.verdict, answer: v.answer, turns: c.turns, wallMs: c.wallMs, firstContext: c.firstContext, ...u, converted: Math.round(conv(u)) });
  }
  if (rep[0] === 'D') for (const after of ['base', ...ids.slice(0, 9)]) {
    const c = cmp(rep, after); const u = mu(c.modelUsage);
    out.compactions.push({ rep, after, pre: c.compactions[0]?.pre, post: c.compactions[0]?.post, ms: c.compactions[0]?.ms, wallMs: c.wallMs, ...u, converted: Math.round(conv(u)) });
  }
}
for (const v of ['A', 'D']) {
  const rs = out.requests.filter((r) => r.variant === v); const cs = out.compactions.filter((c) => c.rep[0] === v);
  const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
  const recall = rs.filter((r) => r.kind === 'recall');
  out.perVariant[v] = {
    editsOk: `${rs.filter((r) => r.kind === 'edit' && r.verdict === 'ok').length}/21`,
    recallOk: recall.filter((r) => r.verdict === 'ok').length, recallUnknown: recall.filter((r) => r.verdict === 'unknown').length, recallWrong: recall.filter((r) => r.verdict === 'wrong').length,
    byRecall: Object.fromEntries(['r3', 'r6', 'r10'].map((id) => [id, recall.filter((r) => r.id === id && r.verdict === 'ok').length + '/3'])),
    reqWallSec: +(sum(rs, 'wallMs') / 3000).toFixed(1), reqTurns: sum(rs, 'turns') / 3,
    reqCacheRead: Math.round(sum(rs, 'cacheRead') / 3), reqCacheWrite: Math.round(sum(rs, 'cacheWrite') / 3), reqInput: Math.round(sum(rs, 'input') / 3), reqOutput: Math.round(sum(rs, 'output') / 3),
    reqConverted: Math.round(sum(rs, 'converted') / 3),
    compactCount: cs.length / 3, compactWallSec: +(sum(cs, 'wallMs') / 3000).toFixed(1), compactConverted: Math.round(sum(cs, 'converted') / 3),
    compactInput: Math.round(sum(cs, 'input') / 3), compactOutput: Math.round(sum(cs, 'output') / 3), compactCacheRead: Math.round(sum(cs, 'cacheRead') / 3), compactCacheWrite: Math.round(sum(cs, 'cacheWrite') / 3),
  };
}
// H2: 자리마다 (A 요청 환산 평균 − D 요청 환산 평균) 대 그 앞 압축 환산 평균
out.h2 = ids.map((id, i) => {
  const avg = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const a = avg(out.requests.filter((r) => r.variant === 'A' && r.id === id).map((r) => r.converted));
  const d = avg(out.requests.filter((r) => r.variant === 'D' && r.id === id).map((r) => r.converted));
  const after = i === 0 ? 'base' : ids[i - 1];
  const c = avg(out.compactions.filter((x) => x.after === after).map((x) => x.converted));
  const cm = avg(out.compactions.filter((x) => x.after === after).map((x) => x.wallMs));
  return { id, aConverted: Math.round(a), dConverted: Math.round(d), saved: Math.round(a - d), compactBefore: Math.round(c), compactSec: +(cm / 1000).toFixed(1) };
});
writeFileSync(`${S}/aggregate.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.perVariant, null, 1)); console.table(out.h2);
console.table(out.compactions.map(({ rep, after, pre, post, ms, input, output, cacheRead, cacheWrite, converted }) => ({ rep, after, pre, post, sec: +(ms / 1000).toFixed(1), input, output, cacheRead, cacheWrite, converted })));

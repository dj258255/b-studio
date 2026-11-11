// merge 중심 생성기(ADR-197): 앵커가 있는 매핑과 `<<` 사용(단일·시퀀스·중첩·덮어쓰기·순서·이상한 키)
// merge 중심 생성기: 앵커가 있는 매핑과 `<<` 사용(단일, 시퀀스, 중첩, 덮어쓰기, 순서, 이상한 키). 사용: node genmerge.js <seed> <count> <out>
export function generateMergeYaml({ seed, count }) {
let a = Number(seed) >>> 0;
function rnd() { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (n) => Math.floor(rnd() * n); const pick = (x) => x[ri(x.length)]; const chance = (p) => rnd() < p;
const KEYS = ['a', 'b', 'c', 'd', 'e', '1', '2', '10', '0', 'null', '~', 'true', 'yes', '1.5', '-1', 'x y', '__proto__', 'constructor', 'é', '<<'];
const VALS = ['1', 'x', 'true', 'null', '~', '"s"', '[1, 2]', '{k: v}', '1e3', '0x1F', 'no', '.5', "'q'"];
function map(ind, depth, anchors) {
  const pad = ' '.repeat(ind); let s = ''; const n = 1 + ri(4); const used = new Set();
  for (let i = 0; i < n; i++) {
    if (chance(0.25) && anchors.length) { // 병합
      const r = rnd();
      if (r < 0.55) s += `${pad}<<: *${pick(anchors)}\n`;
      else if (r < 0.9) s += `${pad}<<: [${[...Array(1 + ri(3))].map(() => '*' + pick(anchors)).join(', ')}]\n`;
      else s += `${pad}<<: ${pick(['{p: 1}', '[{p: 1}, {q: 2}]', '1', '[1]', 'null', '~', '*' + pick(anchors) + ' # c', '"<<"'])}\n`;
      continue;
    }
    let k = pick(KEYS); if (k === '<<') k = pick(['a', 'b']); if (used.has(k) && chance(0.8)) continue; used.add(k);
    if (chance(0.15) && depth < 2) s += `${pad}${k}:\n${map(ind + 2, depth + 1, anchors)}`; else s += `${pad}${k}: ${pick(VALS)}\n`;
  }
  return s;
}
const out = [];
for (let i = 0; i < Number(count); i++) {
  const anchors = []; let s = '';
  const nb = 1 + ri(3);
  for (let j = 0; j < nb; j++) {
    const name = 'b' + j;
    const useAnchors = anchors.slice();
    const body = chance(0.2) ? `{${[...Array(1 + ri(3))].map(() => pick(KEYS.filter((x) => x !== '<<')) + ': ' + pick(VALS.filter((x) => !x.startsWith('[') && !x.startsWith('{')))).join(', ')}}` : null;
    if (body) s += `${name}: &${name} ${body}\n`; else s += `${name}: &${name}\n${map(2, 1, useAnchors)}`;
    anchors.push(name);
  }
  s += 'target:\n' + map(2, 1, anchors);
  if (chance(0.3)) s += 'target2:\n' + map(2, 1, anchors);
  out.push(s);
}
return out;
}

// 무작위 YAML 생성기(ADR-197). 문법 요소(블록·흐름 매핑·시퀀스, 따옴표, 블록 스칼라, 앵커·별칭, `<<`, 태그, 주석, 문서 표시, 중복 키, 숫자·불리언·null 꼴, 유니코드·제어 글자,
// BOM, CRLF, 탭)를 섞고 `realistic`가 아니면 줄·글자 변이를 더한다. 시드가 같으면 같은 글이 나온다.
// 무작위 YAML 생성기. 사용: node gen.js <seed> <count> <out.json>
export function generateYaml({ seed, count, realistic }) {
let a = Number(seed) >>> 0;
function rnd() { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[ri(arr.length)];
const chance = (p) => rnd() < p;

const WORDS = ['name', 'image', 'ports', 'env', 'a', 'b', 'key', 'x1', 'user_name', 'my-key', 'Key With Space', '한글', 'é', 'тест', 'emoji😀', 'a.b', 'http://x.y/z', 'a#b', 'a #b', 'c: d', "it's", 'q"q', '-x', '?x', '@x', '`x', '%x', '*x', '&x', '!x', '|x', '>x', '{x', '[x', 'x]', 'x}', 'x,y'];
const NUMS = ['0', '1', '-1', '+1', '007', '08', '0x1F', '0xFF', '0XFF', '0o17', '0O17', '0b101', '1e3', '1E3', '1.5e-3', '.5', '5.', '1.0', '-0', '-0.0', '+.inf', '.inf', '-.inf', '.Inf', '.INF', '.nan', '.NaN', '.NAN', '-.nan', '1_000', '1,000', '12345678901234567890', '9007199254740993', '-9007199254740993', '0.1', '1e400', '1e-400', '0x', '0o', '1e', 'e3', '1.2.3', '0.0000001', '1e21', '100000000000000000000000', '0xFFFFFFFFFFFFFFFFFFFF', '1:30', '1:30:00', '0123', '0_1', '+', '-', '.', '..', '1 2', '3.14', '-3.14', '1e+3', '1e-3', '.e3', '0e0', '00', '-00'];
const BOOLS = ['true', 'false', 'True', 'False', 'TRUE', 'FALSE', 'yes', 'no', 'Yes', 'No', 'YES', 'NO', 'on', 'off', 'On', 'Off', 'ON', 'OFF', 'y', 'n', 'Y', 'N', 'tRue', 'fALSE'];
const NULLS = ['null', 'Null', 'NULL', '~', 'nULL', '', 'nil', 'None'];
const DATES = ['2001-12-14', '2001-12-14t21:59:43.10-05:00', '2001-12-14 21:59:43.10 -5', '2002-12-14', '12:30:45', '2024-02-30', '1e1_0'];
let SPECIAL = ['<<', '=', 'null', 'true', '~', '0', '1', '"', "'", '\\', '\\n', '\t', ' ', '\u0085', ' ', ' ', '﻿', '​', '\u0000', '\u0007', '\u001b', '\u007f', '😀', '\ud83d', '漢字', 'á', '/', '<', '>', '=>', '--', '---', '...', ': ', ' #', '- ', '? '];
let TAGS = ['!!str', '!!int', '!!float', '!!bool', '!!null', '!!map', '!!seq', '!!binary', '!!timestamp', '!!set', '!!omap', '!foo', '!!foo', '!', '!<tag:yaml.org,2002:str>', '!<!local>', '!e!x'];

const REALISTIC = realistic === true;
if (REALISTIC) { SPECIAL = ['<<', '=', 'null', 'true', '~', '0', '1', '/', '<', '>', '--', ': ', ' #', '- ']; TAGS = []; }
let anchors = [];
function anchorName() { return 'a' + ri(4); }
function scalarText(inKey) {
  const r = rnd();
  if (r < 0.25) return pick(WORDS);
  if (r < 0.42) return pick(NUMS);
  if (r < 0.57) return pick(BOOLS);
  if (r < 0.65) return pick(NULLS);
  if (r < 0.69) return pick(DATES);
  if (r < 0.78) return quoted();
  if (r < 0.83) return pick(WORDS) + pick(SPECIAL) + pick(WORDS);
  if (r < 0.86) return pick(SPECIAL);
  return pick(WORDS) + ri(100);
}
function quoted() {
  const body = () => pick(['hello', 'a b', '', 'yes', '123', 'null', '~', "it''s", 'q\\"q', '\\n\\t', '\\x41', '\\u00e9', '\\U0001F600', '\\0', '\\e', '\\_', '\\N', '\\L', '\\P', '\\ ', '\\/', '\\q', '#x', ': ', 'multi\n  line', 'trail  ', '  lead', '<<', pick(SPECIAL)]);
  const b = body();
  const r = rnd();
  if (r < 0.45) return '"' + b.replace(/''/g, "'") + '"';
  if (r < 0.9) return "'" + b.replace(/\\"/g, '"').replace(/\\/g, '\\') + "'";
  return pick(['"', "'", '"unterminated', "'unterminated"]);
}
function props() {
  let s = '';
  if (chance(0.08)) { const n = anchorName(); anchors.push(n); s += '&' + n + ' '; }
  if (TAGS.length && chance(0.06)) s += pick(TAGS) + ' ';
  return s;
}
function aliasOrNull() { return anchors.length && chance(0.9) ? '*' + pick(anchors) : '*' + anchorName(); }
function flowScalar() {
  let t = scalarText();
  if (/^[^"'\[\]{},]*$/.test(t) && !chance(0.1)) return t; // 평범한 글자
  return chance(0.5) ? quoted() : t;
}
function flow(depth) {
  const r = rnd();
  if (depth > 2 || r < 0.15) return props() + flowScalar();
  if (r < 0.2) return aliasOrNull();
  if (r < 0.6) {
    const n = ri(4); const it = [];
    for (let i = 0; i < n; i++) it.push(chance(0.1) ? flowScalar() + ': ' + flow(depth + 1) : flow(depth + 1));
    return props() + '[' + it.join(pick([', ', ',', ' , ', ',\n  '])) + (chance(0.1) ? ',' : '') + ']';
  }
  const n = ri(4); const it = [];
  for (let i = 0; i < n; i++) {
    const k = flowScalar();
    const f = rnd();
    it.push(f < 0.75 ? k + ': ' + flow(depth + 1) : f < 0.85 ? k : f < 0.92 ? k + ':' : '? ' + k);
  }
  return props() + '{' + it.join(pick([', ', ',', ' , '])) + (chance(0.1) ? ',' : '') + '}';
}
function blockScalar(ind) {
  const style = pick(['|', '>']); const chomp = pick(['', '-', '+']); const ind2 = chance(0.15) ? String(1 + ri(3)) : '';
  const hdr = chance(0.5) ? style + chomp + ind2 : style + ind2 + chomp;
  const n = 1 + ri(4); const pad = ' '.repeat(ind + 2);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(chance(0.2) ? '' : pad + (chance(0.2) ? '  ' : '') + pick(WORDS) + (chance(0.1) ? ' #c' : ''));
  return props() + hdr + (chance(0.1) ? ' # comment' : '') + '\n' + lines.join('\n') + (chance(0.5) ? '\n' : '') + (chance(0.15) ? '\n\n' : '');
}
function comment() { return chance(0.1) ? ' # ' + pick(WORDS) : ''; }
function key() {
  const r = rnd();
  if (r < 0.5) return pick(WORDS);
  if (r < 0.6) return pick(NUMS);
  if (r < 0.68) return pick(BOOLS);
  if (r < 0.74) return pick(NULLS.filter(Boolean));
  if (r < 0.82) return quoted();
  if (r < 0.88) return '<<';
  if (r < 0.92) return '? ' + pick(WORDS);
  if (r < 0.95) return props() + pick(WORDS);
  if (r < 0.97) return '[' + pick(WORDS) + ']';
  return pick(WORDS) + ri(3);
}
function value(ind, depth, inSeq) {
  const r = rnd();
  const pad = ' '.repeat(ind);
  if (depth > 3 || r < 0.38) return ' ' + props() + scalarText() + comment() + '\n';
  if (r < 0.43) return ' ' + aliasOrNull() + '\n';
  if (r < 0.52) return ' ' + flow(0) + comment() + '\n';
  if (r < 0.58) return ' ' + blockScalar(ind) + '\n';
  if (r < 0.62) return '\n';
  if (r < 0.80) { const p = props(); return (p ? ' ' + p.trimEnd() : '') + '\n' + blockMap(ind + 2, depth + 1); }
  if (r < 0.92) { const p = props(); return (p ? ' ' + p.trimEnd() : '') + '\n' + blockSeq(chance(0.3) ? ind : ind + 2, depth + 1); }
  return ' ' + props() + scalarText() + ' ' + pick(['', '# c', '#c']) + '\n';
}
function blockMap(ind, depth) {
  const n = 1 + ri(4); let s = ''; const pad = ' '.repeat(ind);
  const used = [];
  for (let i = 0; i < n; i++) {
    let k = key();
    if (used.length && chance(0.05)) k = pick(used); // 중복 키
    used.push(k);
    if (k === '<<' && chance(0.7)) { s += pad + '<<: ' + (chance(0.5) ? aliasOrNull() : '[' + aliasOrNull() + ', ' + aliasOrNull() + ']') + '\n'; continue; }
    if (k.startsWith('? ')) { s += pad + k + '\n' + pad + ': ' + scalarText() + '\n'; continue; }
    s += pad + k + ':' + value(ind, depth, false);
  }
  return s;
}
function blockSeq(ind, depth) {
  const n = 1 + ri(4); let s = ''; const pad = ' '.repeat(ind);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.15 && depth < 3) s += pad + '- ' + blockMap(ind + 2, depth + 1).replace(/^\s+/, '');
    else if (r < 0.2 && depth < 3) s += pad + '-\n' + blockMap(ind + 2, depth + 1);
    else if (r < 0.25) s += pad + '- ' + flow(0) + '\n';
    else if (r < 0.3) s += pad + '- ' + blockScalar(ind) + '\n';
    else if (r < 0.34) s += pad + '- ' + aliasOrNull() + '\n';
    else if (r < 0.38 && depth < 3) s += pad + '- - ' + scalarText() + '\n' + pad + '  - ' + scalarText() + '\n';
    else s += pad + '- ' + props() + scalarText() + comment() + '\n';
  }
  return s;
}
function doc() {
  anchors = [];
  const r = rnd();
  let s = '';
  if (chance(0.1)) s += '# ' + pick(WORDS) + '\n';
  if (!REALISTIC && chance(0.06)) s += '%YAML 1.2\n---\n';
  else if (!REALISTIC && chance(0.08)) s += '---' + pick(['', ' ', ' # c', ' !!map', ' &d']) + '\n';
  if (r < 0.62) s += blockMap(0, 0);
  else if (r < 0.78) s += blockSeq(0, 0);
  else if (r < 0.88) s += props() + scalarText() + '\n';
  else if (r < 0.95) s += flow(0) + '\n';
  else s += blockScalar(-2) + '\n';
  if (!REALISTIC && chance(0.06)) s += '...\n';
  if (!REALISTIC && chance(0.05)) s += '---\n' + blockMap(0, 1);
  return s;
}
function mutate(s) {
  const n = 1 + ri(3);
  for (let i = 0; i < n; i++) {
    const r = rnd(); const lines = s.split('\n');
    const li = ri(lines.length);
    if (r < 0.10) lines[li] = '\t' + lines[li];
    else if (r < 0.18) lines[li] = ' ' + lines[li];
    else if (r < 0.24) lines[li] = lines[li].replace(/^ {2}/, '');
    else if (r < 0.30) lines.splice(li, 0, lines[li]);
    else if (r < 0.34) lines.splice(li, 1);
    else if (r < 0.38) lines.splice(li, 0, pick(['---', '...', '--- a', '--- |', '# c', '', '  ', '\t', '%TAG ! tag:x,2000:', '- a', 'a: b']));
    else if (r < 0.50) { const p = ri(s.length + 1); s = s.slice(0, p) + pick(SPECIAL) + s.slice(p); continue; }
    else if (r < 0.58) { const p = ri(s.length); s = s.slice(0, p) + s.slice(p + 1); continue; }
    else if (r < 0.64) { s = s.replace(/\n/g, '\r\n'); continue; }
    else if (r < 0.68) { s = '﻿' + s; continue; }
    else if (r < 0.71) { s = s.replace(/\n/g, '\r'); continue; }
    else if (r < 0.75) { s = s.replace(/\n$/, ''); continue; }
    else if (r < 0.80) { s = s + pick(['\n---\n', '\n---\na: 1\n', '\n...\n', '  ', '\t', ' #c']); continue; }
    else if (r < 0.86) lines[li] = lines[li].replace(/: /, pick([':', ' : ', ':  ', ':\t', ': \t']));
    else if (r < 0.92) lines[li] = lines[li] + pick([' #x', '#x', ' &z', ' !!str', ' *a0', '  ']);
    else { const lj = ri(lines.length); [lines[li], lines[lj]] = [lines[lj], lines[li]]; }
    s = lines.join('\n');
  }
  return s;
}
const out = [];
for (let i = 0; i < count; i++) {
  let d = doc();
  if (!REALISTIC && chance(0.35)) d = mutate(d);
  out.push(d);
}
return out.map((t) => t.toWellFormed());
}

/**
 * YAML 읽기 벡터 생성기(ADR-197). 기대값은 JS `yaml@2.9.0`(`parse(text)`·`parse(text, { merge: true })`)이 만든다.
 * Rust 쪽(tests/yaml_vectors.rs)이 같은 글을 읽어 `bstudio_guard::yaml::parse`와 견준다.
 *
 * 입력: 손으로 쓴 프로브 + 무작위(변이 포함·없음) + merge 집중 + 저장소의 실제 YAML 파일. 씨앗이 고정이라 같은 코드·같은 yaml 판본이면 같은 파일이 나온다.
 * 각 사례의 `js`는 (글자가 `lone-surrogate`이면 JS는 읽지만 값에 짝 없는 서로게이트가 있어 Rust 글자로 쓸 수 없다는 뜻이다) 기본 모드·merge 모드별 JS 결과다: `null`이면 JS가 던진다, 글자면 값(키 순서·NaN·Infinity·-0을 `encodeNative`와 같은 표시로 쓴 JSON).
 * `rust`는 그때 Rust 읽기의 상태(`v` 값 / `u` 지원하지 않는 꼴 / `s` 문법 오류)다. 읽기 규칙을 바꾸면 이 줄이 달라지므로 시험이 실패한다(의도한 변화면 이 파일을 다시 만든다).
 *
 * 실행(저장소 루트, pnpm build:native 뒤): node crates/bstudio-guard/tests/vectors/gen-yaml-vectors.mjs
 * 임시 폴더·네트워크는 쓰지 않는다. 3000번 포트·실제 서비스는 쓰지 않는다
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { generateYaml } from './yaml-gen.mjs';
import { generateMergeYaml } from './yaml-gen-merge.mjs';
import { probes } from './yaml-probes.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
// yaml 판본은 저장소가 잠근 것(sandbox의 의존성)을 쓴다
const { parse } = createRequire(path.join(root, 'packages/sandbox/package.json'))('yaml');
const native = createRequire(import.meta.url)(path.join(root, 'packages/sandbox/native/bstudio_node.node'));
const OUT = process.env.VECTOR_OUT ?? path.join(import.meta.dirname, 'yaml-vectors.json');
const COUNTS = { realistic: Number(process.env.VECTOR_REALISTIC ?? 2400), random: Number(process.env.VECTOR_RANDOM ?? 2400), merge: Number(process.env.VECTOR_MERGE ?? 1200) };

process.emitWarning = () => {};
const NF = '\u0000nf';
const encode = (value) => JSON.stringify(value, (_k, item) => (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)) ? { [NF]: Object.is(item, -0) ? '-0' : String(item) } : item));

const LONE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

function jsResult(text, merge) {
  const warnings = [];
  process.emitWarning = (w) => warnings.push(String(w?.message ?? w));
  try {
    const value = parse(text, merge ? { merge: true } : undefined);
    // 컬렉션을 키로 쓴 매핑은 JS가 키를 YAML 글자로 바꾼다(경고). Rust는 지원하지 않는 꼴로 거절하고 기대값을 만들지 않는다
    if (warnings.some((w) => /Keys with collection values/.test(w))) return 'collection-key';
    const encoded = encode(value);
    // 짝 없는 서로게이트(`"\ud83d"`)를 담은 값은 Rust 글자로 쓸 수 없다. Rust는 값으로 읽지 않아야 한다
    if (LONE.test(encoded)) return 'lone-surrogate';
    return encoded;
  } catch {
    return null;
  }
}

const texts = new Map(); // 글 → 이름(중복 제거)
// 짝 없는 서로게이트는 UTF-8 파일에서 나올 수 없다(읽을 때 U+FFFD가 된다)
const add = (raw, name) => { const text = raw.toWellFormed(); if (!texts.has(text)) texts.set(text, name); };
for (const [category, text] of probes) add(text, `probe:${category}`);
generateYaml({ seed: 20261111, count: COUNTS.random, realistic: false }).forEach((t, i) => add(t, `random:${i}`));
generateYaml({ seed: 20261113, count: COUNTS.realistic, realistic: true }).forEach((t, i) => add(t, `realistic:${i}`));
generateMergeYaml({ seed: 20261116, count: COUNTS.merge }).forEach((t, i) => add(t, `merge:${i}`));
const files = execFileSync('git', ['ls-files', '*.yaml', '*.yml'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !f.endsWith('pnpm-lock.yaml'));
for (const file of files) add(readFileSync(path.join(root, file), 'utf8'), `file:${file}`);

const status = { value: 'v', unsupported: 'u', syntax: 's' };
const cases = [];
for (const [text, name] of texts) {
  const plain = jsResult(text, false);
  const merged = jsResult(text, true);
  if (plain === 'collection-key' || merged === 'collection-key') continue;
  cases.push({ name, text, plain: { js: plain, rust: status[native.yamlParse(text, false).kind] }, merge: { js: merged === plain ? '=' : merged, rust: status[native.yamlParse(text, true).kind] } });
}
writeFileSync(OUT, `${JSON.stringify(cases)}\n`);
const count = (pick) => cases.filter(pick).length;
console.log(`사례 ${cases.length}건(기본 모드 JS 성공 ${count((c) => c.plain.js !== null)}, 읽음 ${count((c) => c.plain.rust === 'v')}, 거절 ${count((c) => c.plain.rust === 'u')}) → ${OUT}`);

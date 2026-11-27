// `b-studio` 명령을 설치·제거한다(#1448).
//   node scripts/install-cli.mjs [--dir <폴더>]         기본 ~/.local/bin/b-studio → 이 저장소의 bin/b-studio.mjs 링크
//   node scripts/install-cli.mjs --uninstall [--dir <폴더>]
// 같은 이름의 남의 파일·링크는 덮어쓰거나 지우지 않고 멈춘다. 다른 체크아웃의 b-studio 실행 파일로 가는 링크만 이 체크아웃으로 바꾼다.
// 셸 설정 파일(PATH)은 고치지 않는다 — 폴더가 PATH에 없으면 넣는 방법만 알려 준다
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const MARKER = '// b-studio-launcher:';
const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const launcher = path.join(root, 'bin', 'b-studio.mjs');

const { values } = parseArgs({ options: { dir: { type: 'string' }, uninstall: { type: 'boolean', default: false } } });
const dir = path.resolve(values.dir ?? path.join(homedir(), '.local', 'bin'));
const target = path.join(dir, 'b-studio');

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** 이 자리에 무엇이 있는가: 없음 / 이 체크아웃의 링크 / 다른 체크아웃의 b-studio 실행 파일 링크 / 남의 것 */
function inspect() {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'none';
    throw error;
  }
  if (!stat.isSymbolicLink()) return 'foreign';
  let resolved;
  try {
    resolved = realpathSync(target);
  } catch {
    return 'foreign'; // 끊긴 링크도 남의 것으로 본다(무엇이었는지 모른다)
  }
  if (resolved === launcher) return 'ours';
  try {
    if (path.basename(resolved) === 'b-studio.mjs' && readFileSync(resolved, 'utf8').split('\n', 3).some((line) => line.startsWith(MARKER))) return 'other-checkout';
  } catch {
    // 읽지 못하면 남의 것으로 본다
  }
  return 'foreign';
}

const state = inspect();
if (values.uninstall) {
  if (state === 'none') {
    process.stdout.write(`${target}에 b-studio가 없습니다\n`);
  } else if (state === 'ours' || state === 'other-checkout') {
    unlinkSync(target);
    process.stdout.write(`${target}를 지웠습니다\n`);
  } else {
    fail(`${target}는 b-studio가 만든 링크가 아니라서 지우지 않았습니다`);
  }
} else {
  if (state === 'foreign') fail(`${target}에 다른 파일이 있어 덮어쓰지 않았습니다. 확인한 뒤 직접 옮기거나 --dir로 다른 폴더를 고르세요`);
  if (state === 'ours') {
    process.stdout.write(`이미 설치돼 있습니다: ${target} → ${launcher}\n`);
  } else {
    mkdirSync(dir, { recursive: true });
    if (state === 'other-checkout') unlinkSync(target);
    symlinkSync(launcher, target);
    process.stdout.write(`설치했습니다: ${target} → ${launcher}\n`);
  }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir);
  if (!onPath) process.stdout.write(`${dir}가 PATH에 없습니다. 셸 설정(~/.zshrc 등)에 export PATH="${dir}:$PATH"를 더하세요\n`);
}

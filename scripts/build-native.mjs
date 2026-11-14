// b-studio의 Rust 판정 모듈(crates/bstudio-node)을 빌드해 packages/sandbox/native/bstudio_node.node로 둔다(ADR-191).
// pnpm install 뒤(postinstall)와 pnpm test 앞에서 돈다. cargo는 바뀐 것이 없으면 바로 끝난다.
// 이 모듈이 없으면 sandbox가 판정을 하지 못해 던진다. TS로 대신 판정하는 길은 없다.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNative } from './install-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 운영 이미지의 node 단계에는 cargo가 없다. 앞 단계에서 빌드한 파일을 복사해 넣는다(apps/studio/Dockerfile)
if (process.env.B_STUDIO_SKIP_NATIVE_BUILD === '1') {
  console.log('[build-native] B_STUDIO_SKIP_NATIVE_BUILD=1 — 빌드를 건너뜁니다');
  process.exit(0);
}

const cargo = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'bstudio-node'], { cwd: root, stdio: 'inherit' });
if (cargo.error) {
  console.error(`[build-native] Rust 툴체인(cargo)이 필요합니다: https://rustup.rs (${cargo.error.message})`);
  process.exit(1);
}
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const built = { darwin: 'libbstudio_node.dylib', linux: 'libbstudio_node.so', win32: 'bstudio_node.dll' }[process.platform];
if (!built) {
  console.error(`[build-native] 이 플랫폼(${process.platform})의 빌드 결과 이름을 모릅니다`);
  process.exit(1);
}
const outDir = path.join(root, 'packages', 'sandbox', 'native');
const out = path.join(outDir, 'bstudio_node.node');
mkdirSync(outDir, { recursive: true });
installNative(path.join(root, 'target', 'release', built), out);
console.log(`[build-native] ${path.relative(root, out)}`);

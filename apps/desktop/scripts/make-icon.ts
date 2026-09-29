/**
 * `pnpm desktop:icon` — 아이콘 원본(`build/icon.svg`)에서 macOS 아이콘(.icns)과 창 아이콘(.png)을 만든다.
 *
 * 외부 도구를 받지 않고 macOS 기본 도구만 쓴다: sips로 SVG → 1024 PNG(알파 유지) → 크기별 PNG →
 * iconutil로 .icns. qlmanage는 미리보기 배경을 흰색으로 채워 둥근 모서리 바깥이 불투명해지므로 쓰지 않는다.
 *
 * 만든 파일(`icon.icns`·`icon-1024.png`·`icon.png`)은 저장소에 함께 둔다. 빌드하는 CI에는 macOS 도구가
 * 없어서 electron-builder가 그대로 쓸 파일이 필요하다. 그래서 이 스크립트는 macOS에서만 돈다.
 *
 * 스튜디오 favicon.ico도 같은 SVG에서 만든다 — 앱과 웹의 모양을 한 곳에서 맞춘다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');
/** 아이콘 원본과 결과물이 함께 사는 폴더(electron-builder의 buildResources 기본값이기도 하다) */
const buildDir = path.join(desktopDir, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const png1024Path = path.join(buildDir, 'icon-1024.png');
const icnsPath = path.join(buildDir, 'icon.icns');
/** 리눅스·윈도우 창 아이콘(BrowserWindow icon). macOS는 앱 번들의 .icns를 쓴다 */
const windowPngPath = path.join(buildDir, 'icon.png');
/** 스튜디오 favicon. 같은 SVG에서 만든다 */
const faviconPath = path.resolve(desktopDir, '..', 'studio', 'app', 'favicon.ico');

/** .icns가 요구하는 iconset 구성(파일 이름 → 픽셀 크기) */
export const ICONSET: ReadonlyArray<readonly [string, number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** favicon.ico에 넣는 크기(브라우저 탭 16, 작업 표시줄 32, 바로 가기 48) */
export const FAVICON_SIZES: readonly number[] = [16, 32, 48];

/**
 * PNG들을 ICO 한 파일로 묶는다. 요즘 브라우저와 윈도우는 ICO 안의 PNG를 그대로 읽으므로 BMP로 바꾸지 않는다.
 * 헤더 6바이트 + 항목 16바이트×N + PNG 본문 순서다(항목의 offset은 첫 PNG의 시작 위치).
 */
export function packIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 예약
  header.writeUInt16LE(1, 2); // 1 = 아이콘
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = 16 * index;
    // 256은 한 바이트에 담기지 않아 0으로 적는다
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // 팔레트 없음
    directory.writeUInt8(0, entry + 3); // 예약
    directory.writeUInt16LE(1, entry + 4); // 평면 수
    directory.writeUInt16LE(32, entry + 6); // 픽셀당 비트
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'ignore' });
}

/** sips로 SVG를 size×size PNG로 굽는다(알파 유지). 원본이 1024라 1024는 다시 줄이지 않는다 */
function renderPng(svg: string, size: number, out: string): void {
  run('sips', ['-s', 'format', 'png', ...(size === 1024 ? [] : ['-z', String(size), String(size)]), svg, '--out', out]);
}

/** sips는 파일로만 쓰므로 임시 폴더를 거쳐 PNG 바이트를 받는다 */
function renderPngBuffer(svg: string, size: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'b-studio-icon-'));
  try {
    const out = path.join(dir, `${size}.png`);
    renderPng(svg, size, out);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeIcon(): void {
  if (process.platform !== 'darwin') throw new Error('아이콘은 macOS 기본 도구(sips·iconutil)로만 만들 수 있습니다. macOS에서 실행하세요');
  if (!existsSync(svgPath)) throw new Error(`아이콘 원본을 찾지 못했습니다: ${svgPath}`);
  mkdirSync(buildDir, { recursive: true });
  console.log(`원본: ${svgPath}`);

  renderPng(svgPath, 1024, png1024Path);
  console.log(`1024 PNG: ${png1024Path}`);

  // 창 아이콘(리눅스·윈도우)은 1024 PNG 하나면 된다 — Electron과 electron-builder가 알아서 줄인다
  writeFileSync(windowPngPath, readFileSync(png1024Path));
  console.log(`창 아이콘 PNG: ${windowPngPath}`);

  const iconset = mkdtempSync(path.join(tmpdir(), 'b-studio-iconset-'));
  try {
    const dir = path.join(iconset, 'icon.iconset');
    mkdirSync(dir);
    for (const [name, size] of ICONSET) renderPng(svgPath, size, path.join(dir, name));
    run('iconutil', ['-c', 'icns', dir, '-o', icnsPath]);
    console.log(`macOS 아이콘: ${icnsPath}`);
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }

  const favicon = packIco(FAVICON_SIZES.map((size) => ({ size, png: renderPngBuffer(svgPath, size) })));
  writeFileSync(faviconPath, favicon);
  console.log(`스튜디오 favicon: ${faviconPath}`);
}

// 테스트가 이 파일을 불러올 때는 만들지 않는다(직접 실행했을 때만)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    makeIcon();
  } catch (error) {
    console.error(`아이콘을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * `pnpm desktop:install` — 데스크톱 앱을 빌드해 `~/Applications/b-studio.app`에 넣는다.
 *
 * Dock·Finder에서 켠 앱에는 터미널 PATH(nvm·corepack)가 없다. 그래서 **설치 시점**에 확인한
 * 저장소 루트·node 실행 파일·pnpm 실행 파일을 `~/.config/b-studio/desktop.json`에 적어 두고,
 * 앱은 그 값만 쓴다(없으면 앱이 "pnpm desktop:install을 다시 실행하세요" 화면을 띄운다).
 *
 * 서명을 하지 않으므로 macOS Gatekeeper가 처음 실행을 막는다 — Finder에서 앱을 우클릭 → 열기로 한 번 열어야 한다.
 * 이 스크립트는 빌드·복사·설정만 한다(앱을 실행하지 않는다).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { configPath, readConfig, writeConfig } from '../src/config';

const desktopDir = path.resolve(import.meta.dirname, '..');
const root = path.resolve(desktopDir, '..', '..');

function main(): void {
  const pnpm = whichPnpm();
  console.log(`설치 시점 경로: node ${process.execPath}\n             pnpm ${pnpm}\n        저장소 루트 ${root}`);

  // ① .app 빌드(현재 아키텍처, 서명 없음)
  console.log('앱을 빌드합니다…');
  execFileSync(pnpm, ['--filter', '@b-studio/desktop', 'build:app'], { cwd: root, stdio: 'inherit' });

  // ② ~/Applications에 복사(이미 있으면 교체)
  const built = findApp(path.join(desktopDir, 'dist-app'));
  const target = path.join(homedir(), 'Applications', 'b-studio.app');
  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(built, target, { recursive: true, verbatimSymlinks: true });

  // ③ 설정 파일. 창 크기처럼 이미 있는 값은 남긴다
  const file = configPath();
  const previous = readConfig(file);
  writeConfig({ ...previous, root, node: process.execPath, pnpm, mode: previous?.mode ?? 'local' }, file);

  console.log(`\n설치했습니다: ${target}`);
  console.log(`설정 파일: ${file}`);
  console.log('\n처음 한 번은 Finder에서 b-studio.app을 우클릭 → "열기"로 열어야 합니다(서명이 없어서 경고가 뜹니다).');
  console.log('이후에는 Dock·Spotlight에서 그냥 열면 됩니다. 앱은 서버를 스스로 켜고, 닫을 때 앱이 켠 서버만 끕니다.');
}

/** electron-builder가 만든 .app을 찾는다(출력 폴더가 mac·mac-arm64 등으로 갈린다) */
function findApp(outputDir: string): string {
  if (!existsSync(outputDir)) throw new Error(`앱 빌드 결과를 찾지 못했습니다: ${outputDir}`);
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(outputDir, entry.name);
    for (const inner of readdirSync(candidate, { withFileTypes: true })) {
      if (inner.isDirectory() && inner.name.endsWith('.app')) return path.join(candidate, inner.name);
    }
  }
  throw new Error(`${outputDir} 아래에서 .app을 찾지 못했습니다`);
}

/**
 * pnpm 실행 파일 경로. 로그인 셸에서 찾는다(nvm·corepack은 셸 초기화에서 PATH가 만들어진다).
 * 못 찾으면 이 스크립트를 돌린 러너의 경로로 대체한다.
 */
function whichPnpm(): string {
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v pnpm'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    // 셸을 못 쓰는 환경(드문 경우)은 아래 대체 경로로 간다
  }
  const fallback = process.env.npm_execpath;
  if (fallback) return fallback;
  throw new Error('pnpm 실행 파일을 찾지 못했습니다. 터미널에서 `pnpm desktop:install`을 실행하세요');
}

try {
  main();
} catch (error) {
  console.error(`설치하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

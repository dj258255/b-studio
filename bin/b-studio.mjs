#!/usr/bin/env node
// b-studio-launcher: 어느 폴더에서든 `b-studio`로 스튜디오를 띄운다(#1448). scripts/install-cli.mjs가 이 표시로 우리 실행 파일을 알아본다
//
// 링크(~/.local/bin/b-studio 등)를 따라가 이 파일이 있는 저장소를 찾고, 사용자의 작업 폴더는 그대로 둔 채(desk의 셸이 거기서 열린다)
// `pnpm studio`와 같은 진입점(apps/cli/src/main.ts)을 tsx로 돌린다. 인자·종료 코드·신호를 그대로 넘긴다
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = realpathSync(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(self), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(root, 'apps', 'cli', 'src', 'main.ts');
// 작업 폴더의 tsconfig.json(남의 프로젝트일 수 있다)을 읽지 않도록 저장소의 설정을 정해 준다
const tsconfig = path.join(root, 'apps', 'cli', 'tsconfig.json');

if (!existsSync(tsx) || !existsSync(entry)) {
  process.stderr.write(`b-studio: ${root}에서 실행에 필요한 파일을 찾지 못했습니다. 그 폴더에서 pnpm install을 먼저 하세요\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, '--tsconfig', tsconfig, entry, ...process.argv.slice(2)], { stdio: 'inherit' });

// 터미널의 Ctrl-C(SIGINT)는 같은 프로세스 그룹인 자식도 받는다 — 여기서는 무시하고 자식이 끝나기를 기다린다.
// 이 프로세스에만 온 종료 신호(kill <pid>)는 자식에게 넘긴다
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on('error', (error) => {
  process.stderr.write(`b-studio: 실행하지 못했습니다: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    // 자식이 신호로 끝났으면 같은 신호로 끝나 부른 셸이 같은 상태를 보게 한다
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

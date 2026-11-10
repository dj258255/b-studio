import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * CLI 실행 파일 고르기 시험(ADR-191 3ac)이 함께 쓰는 폴더 모양. 시험 파일(`claude-cli-command-*.test.ts`)만 쓴다. 임시 폴더만 만든다.
 *
 * base/
 *   project/            ← 프로젝트 루트(막을 폴더)
 *     bin/claude, ..bin/claude, claude, node_modules/.bin/claude   실행 파일(프로젝트 안)
 *     tools -> ../outside/bin                                      프로젝트 안의 링크가 바깥을 가리킨다
 *   project-extra/bin/claude                                       이름이 루트의 접두인 형제 폴더(밖)
 *   Project2/bin/claude                                            대소문자만 다르게 부를 수 있는 폴더(막을 폴더로 쓴다)
 *   outside/bin/claude, outside/noexec/claude(0644), outside/dir/claude/(폴더)
 *   linkin/claude -> project/claude                                프로젝트 안을 가리키는 링크
 *   outlink/claude -> outside/bin/claude                           바깥을 가리키는 링크
 *   alias -> project                                               루트를 가리키는 링크
 */
export interface Fixture {
  base: string;
  project: string;
  project2: string;
}

function plant(file: string, mode = 0o755): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, mode);
}

export function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'b-studio-cli-command-')));
  const project = path.join(base, 'project');
  for (const dir of ['bin', '..bin', '.', 'node_modules/.bin']) plant(path.join(project, dir, 'claude'));
  plant(path.join(base, 'project-extra', 'bin', 'claude'));
  plant(path.join(base, 'Project2', 'bin', 'claude'));
  plant(path.join(base, 'outside', 'bin', 'claude'));
  plant(path.join(base, 'outside', 'noexec', 'claude'), 0o644);
  mkdirSync(path.join(base, 'outside', 'dir', 'claude'), { recursive: true });
  mkdirSync(path.join(base, 'linkin'), { recursive: true });
  symlinkSync(path.join(project, 'claude'), path.join(base, 'linkin', 'claude'));
  mkdirSync(path.join(base, 'outlink'), { recursive: true });
  symlinkSync(path.join(base, 'outside', 'bin', 'claude'), path.join(base, 'outlink', 'claude'));
  symlinkSync(project, path.join(base, 'alias'));
  symlinkSync(path.join(base, 'outside', 'bin'), path.join(project, 'tools'));
  return { base, project, project2: path.join(base, 'Project2') };
}

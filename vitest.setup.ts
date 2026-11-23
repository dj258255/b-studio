// 시험이 사용자의 실제 claude 설정 파일(~/.claude.json)을 건드리지 않게 한다.
// 복사 모드 세션을 만들면 b-studio가 claude의 폴더 신뢰를 기본 계정의 설정 파일(기본은 홈의 .claude.json)에 적는다(ADR-222).
// 그 위치를 정하는 B_STUDIO_CLAUDE_CONFIG_DIR을 빈 임시 폴더로 돌린다. 그 폴더에는 .claude.json이 없어 b-studio는 아무것도 쓰지 않는다(fail-closed).
// HOME은 바꾸지 않는다: rustup·docker·CLI 찾기가 홈을 본다
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.B_STUDIO_CLAUDE_CONFIG_DIR) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'b-studio-test-claude-config-'));
  process.env.B_STUDIO_CLAUDE_CONFIG_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}

// 모델 관측(라우터가 읽는 모델별 통과율, 기본은 ~/.cache/b-studio/model-observations.json)도 시험이 사용자의 실제 파일에 쓰지 않게 임시 폴더로 돌린다.
// 터미널 실행은 텔레메트리가 온 실행이 끝날 때마다 관측을 남긴다(#1359). 경로를 직접 정하는 시험은 그대로 덮어쓴다
if (!process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'b-studio-test-observations-'));
  process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(dir, 'model-observations.json');
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}

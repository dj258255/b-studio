import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('벤치 모듈 불러오기', () => {
  // vitest는 ESM으로 돌아 이 경로를 밟지 않는다. 벤치는 tsx가 apps/studio 파일을 CommonJS로 옮겨 돌리므로,
  // ESM 전용 의존성(@openai/codex-sdk)을 정적으로 import하면 벤치가 시작도 못 한다(#51 뒤 실제로 그랬다)
  it('tsx의 CommonJS 경로에서 @b-studio/agent를 불러온다', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/bench/coordination/fixtures/load-agent.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(result.stdout).toContain('loaded:function');
  }, 90_000);
});

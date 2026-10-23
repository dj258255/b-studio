import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// 스튜디오 서버 코드가 쓰는 경로 별칭(@/, tsconfig paths)을 테스트에서도 푼다. @b-studio/* 같은 스코프 패키지와 겹치지 않도록 "@/"로 시작할 때만 바꾼다
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(import.meta.dirname, 'apps/studio')}/` }],
  },
  test: {
    // 예제·템플릿 Next 앱을 빌드하면 생기는 .next 안의 사본은 테스트가 아니다
    exclude: [...configDefaults.exclude, '**/.next/**'],
    // 가짜 docker 테스트는 명령마다 셸을 띄워 부하에 따라 수 초가 걸린다 — 순서·결과를 보는 테스트라 속도로 실패시키지 않는다
    testTimeout: 15_000,
  },
});

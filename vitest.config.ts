import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// 스튜디오 컴포넌트가 쓰는 Next.js 경로 별칭(@/)을 테스트에서도 푼다. @b-studio/* 같은 스코프 패키지와 겹치지 않도록 "@/"로 시작할 때만 바꾼다
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(import.meta.dirname, 'apps/studio')}/` }],
  },
  test: {
    // next build의 standalone 결과물은 추적에 딸려 온 bench·라우트 테스트 사본을 품는다.
    // 그대로 두면 build 뒤에 테스트를 돌릴 때 사본이 저장소 루트를 잘못 잡아 실패한다
    exclude: [...configDefaults.exclude, '**/.next/**'],
  },
});

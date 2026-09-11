import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 스튜디오 컴포넌트가 쓰는 Next.js 경로 별칭(@/)을 테스트에서도 푼다. @b-studio/* 같은 스코프 패키지와 겹치지 않도록 "@/"로 시작할 때만 바꾼다
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(import.meta.dirname, 'apps/studio')}/` }],
  },
});

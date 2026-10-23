import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// 스튜디오는 화면 없는 API 서버다(ADR-186, ADR-188). Next 설정(eslint-config-next)이 쓰던 TypeScript 규칙을 그대로 둔다:
// typescript-eslint 권장 규칙과, 쓰지 않는 값·식은 경고(lint는 --max-warnings 0이라 경고도 막는다)
export default defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
    },
  },
]);

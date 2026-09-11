import { createHash, randomBytes } from 'node:crypto';

/** 스튜디오 auth.ts와 같은 이름 규칙 */
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * 스튜디오 token 모드에 쓸 접근 토큰을 만든다. 토큰은 그 사람에게만 전하고, 서버의 환경 변수에는 해시만 넣는다.
 * 토큰은 사람이 고른 비밀번호가 아니라 192비트 임의 값이라 SHA-256 한 번으로 충분하다
 */
export function authToken(name: string): number {
  if (!USER_NAME.test(name)) {
    console.error('이름에는 영문, 숫자, . _ @ - 만 쓸 수 있습니다 (64자 이하)');
    return 2;
  }
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  console.log(`${name}에게 전할 접근 토큰 (다시 보여 주지 않습니다):`);
  console.log(`  ${token}`);
  console.log();
  console.log('스튜디오 서버의 B_STUDIO_AUTH_TOKENS에 넣을 값 (여러 명이면 쉼표로 잇습니다):');
  console.log(`  ${name}:sha256:${hash}`);
  return 0;
}

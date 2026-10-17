/**
 * 서버가 시작할 때 이 서버의 로컬 토큰을 만들어 파일에 둔다(첫 요청을 기다리지 않는다).
 * `studio launch`가 이 파일을 읽어 브라우저를 열 토큰 교환 주소를 만든다(lib/server/local-token.ts).
 * 파일을 만들지 못해도 서버는 뜬다 — 그때는 터미널을 열 때 같은 사유가 화면에 보인다.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { localToken } = await import('./lib/server/local-token');
    localToken();
  } catch (error) {
    console.error('[b-studio] 로컬 토큰을 만들지 못했습니다:', error instanceof Error ? error.message : String(error));
  }
}

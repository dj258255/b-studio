/** 작업 화면 맨 위 한 줄(#848): 터미널에서 여러 AI를 나란히 쓰는 길. 터미널을 쓸 수 있는 설정에서만 보인다 */
export function DeskHint() {
  return (
    <p className="mb-4 text-xs text-muted">
      터미널 하나에서 여러 AI를 나란히 쓰려면 <code className="rounded bg-panel px-1 py-0.5 font-mono">pnpm studio desk</code>를 실행하세요. 사이드바에 AI마다 상태와 게이트 결과가 보입니다.
    </p>
  );
}

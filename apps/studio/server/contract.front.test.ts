/**
 * contract.test.ts의 같은 요청을 Rust 앞단(crates/bstudio-server) 너머로 보낸다(ADR-195 결정 7, 4a).
 * 서버(app.ts)는 contract.test.ts처럼 이 프로세스 안에서 유닉스 소켓으로 듣고, 앞단은 `--upstream-socket`으로 그 소켓에 붙어
 * 임시 TCP 포트를 연다. 계약 시험의 모든 요청(쿠키 인증·SSE·터미널 통로 포함)이 앞단을 거쳐도 같은 결과여야 한다.
 */
process.env.B_STUDIO_CONTRACT_VIA = 'front';
await import('./contract.test');
export {};

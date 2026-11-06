/**
 * 문자열 두 개(바꾸기 전·바꾼 뒤)의 통합 diff(unified diff)를 git으로 만든다. git이 저장소 어디서나 쓰는
 * 흔한 비교 방식이라 화면의 `DiffView`(apps/studio/lib/highlight.ts의 parsePatch)가 그대로 읽을 수 있다 —
 * 새 diff 그리기 코드를 만들지 않고 "생성 파일 다시 만들기"(ADR-101) 미리보기가 체크포인트 diff와 같은 모양으로 보인다.
 */

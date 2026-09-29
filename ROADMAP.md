# 로드맵

이 문서는 현재 어디까지 왔고, 각 단계의 완료 조건과 예상·실제가 무엇인지 한 곳에 모읍니다. 무엇을 왜 만들기로 했는지는 이슈에서, 무엇이 들어갔는지는 [변경 기록](CHANGELOG.md)에서 봅니다. 이슈 상태가 바뀌거나 PR이 병합되면 이 문서를 갱신합니다.

마지막 갱신: 2026-09-29

## 상태 표기

| 상태 | 뜻 |
|---|---|
| 조사 중 | 불확실성을 줄이는 단계입니다. 아직 만드는 단계가 아닙니다. |
| 구현 중 | 코드나 문서를 만드는 단계입니다. |
| 검증 중 | 결과를 실제 환경이나 검사로 확인하는 단계입니다. |
| 완료 | 완료 조건을 확인했습니다. |
| 보류 | 조건을 기다립니다. 앞 단계의 결과에 따라 진행합니다. |

이 구분은 Basecamp Shape Up의 hill chart에서 가져왔습니다([출처](https://basecamp.com/shapeup/3.4-chapter-13)).

## 진행 중

| 마일스톤 | 목표 | 이슈 | 상태 | 예상 | 실제 | 완료 조건 |
|---|---|---|---|---|---|---|
| M1 저장소 가시성 | 계획·예상·변경·검증·배포를 저장소에서 따라가게 합니다 | [#43](https://github.com/dj258255/b-studio/issues/43) | 완료 | 반나절 (09-25까지) | 약 22분 ([#46](https://github.com/dj258255/b-studio/pull/46), [#47](https://github.com/dj258255/b-studio/pull/47)) | issue form 3종 표시, 문서 링크 검사 통과 |
| M2 협업 비용 기준 측정 | 작업 분해의 격리 병렬과 직렬화를 같은 과제로 잽니다 | [#44](https://github.com/dj258255/b-studio/issues/44), [#45](https://github.com/dj258255/b-studio/issues/45), [#49](https://github.com/dj258255/b-studio/pull/49) | 완료 | 도구 1일 + 실험 기계 시간 2~5시간 (09-29까지) | 도구 약 2시간 ([#49](https://github.com/dj258255/b-studio/pull/49)). 실험 기계 시간 104.7분(24회, 09-29). [보고서](docs/experiments/2026-09-29-e1-isolated-parallel-baseline.md): H1 확인 | 24회 실행 결과와 실패 원인 분류를 `docs/experiments/`에 기록 |
| M3 레인 간 조율 전략 | 계약 먼저·게시판·통합 후 수리·실패 서명 공유를 같은 과제로 비교합니다 | [#42](https://github.com/dj258255/b-studio/issues/42)에서 결정, [#62](https://github.com/dj258255/b-studio/issues/62), [#73](https://github.com/dj258255/b-studio/issues/73), [#76](https://github.com/dj258255/b-studio/pull/76), 실험 [#84](https://github.com/dj258255/b-studio/issues/84) | 완료 | 2~3일 | 메커니즘 약 1일, E2 36회. [보고서](docs/experiments/2026-09-29-e2-coordination-strategies.md): S2 9/9, 공유 17/18 대 공유 없음 9/18 | 전략마다 실제 실행이 게이트를 통과하고, 효과는 E2 결과로만 주장 |
| M4 구독 백엔드 확장 | 유료 API 없이 본인 PC에 로그인된 구독 CLI(Codex·Command Code·OpenCode)로 에이전트를 돌립니다 | [#48](https://github.com/dj258255/b-studio/issues/48), [#52](https://github.com/dj258255/b-studio/issues/52)~[#55](https://github.com/dj258255/b-studio/issues/55), [#58](https://github.com/dj258255/b-studio/issues/58), [#63](https://github.com/dj258255/b-studio/issues/63) | 구현 중 | 3~5일 + 1.5~2.5일 (10-25 이후 확인) | Codex 러너 병합 ([#51](https://github.com/dj258255/b-studio/pull/51)), Command Code [#61](https://github.com/dj258255/b-studio/pull/61) 검토 중 | 실제 계정 실행이 게이트를 통과하고 b-studio 도구 밖 파일 변경 0건 |
| M5 이슈·PR 추적성 | 이 저장소와 b-studio 제품 모두에서 PR이 끝내는 이슈와 검증을 올리기 전에 확인한다 | [#56](https://github.com/dj258255/b-studio/issues/56), [#57](https://github.com/dj258255/b-studio/issues/57) | 구현 중 | 반나절 + 1~1.5일 (10-02까지) | pr-body 검사 병합 ([#59](https://github.com/dj258255/b-studio/pull/59)), PR 미리보기 [#60](https://github.com/dj258255/b-studio/pull/60) | pr-body 검사 동작, b-studio PR 미리보기 |
| M6 미리보기 QA | 게이트의 화면 확인을 스튜디오 미리보기에서 실시간으로 보이고, 서버 소유 브라우저를 원격으로 조작합니다 | [#64](https://github.com/dj258255/b-studio/issues/64), [#75](https://github.com/dj258255/b-studio/issues/75) | 완료 | 2~3일 | 약 1일 ([#81](https://github.com/dj258255/b-studio/pull/81)). 실제 브라우저 QA에서 버그 1건을 찾아 고침 | 세션 미리보기에서 QA 프레임·단계 스크린샷 확인, 세션 서비스 밖 요청 차단 |
| M7 디자인 비교 | Figma 프레임을 가져와 실제 화면과 픽셀 차이 비율로 비교합니다 | [#65](https://github.com/dj258255/b-studio/issues/65), [#77](https://github.com/dj258255/b-studio/issues/77) | 검증 중 | 1~2일 | 기능 병합 ([#81](https://github.com/dj258255/b-studio/pull/81)). 실제 Figma 파일·과제 화면 확인 전 | 과제 화면에서 잰 차이 비율로 허용치를 정함 |
| M8 계획 이슈화 | 승인한 작업 계획을 추적 이슈·하위 이슈로 올리고 통합 PR이 닫습니다 | [#66](https://github.com/dj258255/b-studio/issues/66), [#68](https://github.com/dj258255/b-studio/pull/68) | 구현 중 | 1일 | — | 실제 Gitea·GitHub에서 하위 이슈 생성과 PR 닫힘 확인 |
| M9 채용 과제 | 과제를 b-studio 에이전트로 구현하고 게이트·QA·PR로 검증합니다 | [#67](https://github.com/dj258255/b-studio/issues/67) | 보류 | 2~3일 | — | M6·M7이 병합되고 Figma 가져오기가 동작한 뒤 착수 |
| M10 토큰 절감 | 어디서 토큰이 새는지 턴 단위로 보이고, 도구 결과 예산으로 줄인 효과를 잽니다 | [#87](https://github.com/dj258255/b-studio/issues/87), 실험 [#90](https://github.com/dj258255/b-studio/issues/90) | 검증 중 | 1~2일 + 실험 | 도구 결과 예산·토큰 탭 [#96](https://github.com/dj258255/b-studio/pull/96), 묶어서 비우기 [#120](https://github.com/dj258255/b-studio/pull/120)(기본 끔), 기준선 P0 [#93](https://github.com/dj258255/b-studio/pull/93) 병합. E3 측정 전 | 같은 과제에서 캐시 읽기 토큰이 줄고 통합 성공이 줄지 않음 |
| M11 되묻기 | 요청이 모호하면 에이전트가 만들기 전에 선택지로 묻고, 답을 받아 이어 갑니다 | [#88](https://github.com/dj258255/b-studio/issues/88) | 완료 | 1일 | 약 반나절 ([#99](https://github.com/dj258255/b-studio/pull/99)). 예제 허용 도구에서 빠져 있던 것을 실제 실행에서 찾아 고침 | 질문 카드로 답하면 같은 세션이 이어서 만듦 |
| M12 모델 승격 | 싼 모델로 시작하고 게이트가 같은 실패를 두 번 내면 비싼 모델로 올립니다 | [#89](https://github.com/dj258255/b-studio/issues/89), [#98](https://github.com/dj258255/b-studio/pull/98) | 구현 중 | 1일 + 실험 | API 루프는 구현. 로컬 Claude 러너는 main의 되묻기·실행 중 지시 위에 다시 얹는 중 | 가설 H5(비용 감소·성공 유지)를 같은 과제로 판정 |
| M13 여러 에이전트 관리 | 관제 화면·나란히 보기·실행 중 지시·알림·관계 그래프로 여러 에이전트를 한곳에서 다룹니다 | [#100](https://github.com/dj258255/b-studio/issues/100) | 완료 | 2~3일 | 약 1일 ([#106](https://github.com/dj258255/b-studio/pull/106), [#107](https://github.com/dj258255/b-studio/pull/107), [#108](https://github.com/dj258255/b-studio/pull/108), [#117](https://github.com/dj258255/b-studio/pull/117), [#122](https://github.com/dj258255/b-studio/pull/122)) | 개입이 필요한 에이전트가 관제 화면 맨 위에 오고, 실행 중 지시가 다음 모델 호출에 들어감 |
| M14 테스트 품질·부하·동시성 | 앱 게이트에 동시 요청 확인·로드 예산을 넣고, b-studio 자체의 동시 쓰기·부하를 테스트로 고정합니다 | [#112](https://github.com/dj258255/b-studio/issues/112) | 구현 중 | 2일 | 게이트 확인 [#119](https://github.com/dj258255/b-studio/pull/119), 동시 쓰기·부하 [#118](https://github.com/dj258255/b-studio/pull/118)(세션 저장 유실 버그를 찾아 고침). 변이 테스트 [#115](https://github.com/dj258255/b-studio/issues/115)는 보류 | 동시 요청 불변식이 게이트에서 실패를 잡고, 스튜디오 부하 스모크에서 이벤트 유실 0 |
| M15 조율 후속 | E2가 남긴 한계를 줄입니다: 계획 모델이 계약을 직접 쓰기, 게이트가 api 값이 화면에 그려지는지 확인 | [#123](https://github.com/dj258255/b-studio/issues/123), [#124](https://github.com/dj258255/b-studio/issues/124) | 구현 중 | 1~2일 + 실험 | — | 모델 계약 S2가 사람 계약 S2와 구별되지 않음(H9), 데이터 확인으로 S4 수리가 시작됨(H10) |

## 왜 이 순서인가

범용 core 분리는 쓰는 곳이 개발 하나뿐이라 추상화 비용만 들고 이득은 가정에 머뭅니다. 레인 간 통신도 지금 레인이 최대 3개라 방식 사이의 차이가 작아, 먼저 만들면 무엇이 나아졌는지 재기 어렵습니다. 그래서 격리 병렬(ADR-051)이 만든 실제 비용부터 같은 과제로 잽니다. 이 측정이 조율 전략을 만들지 말지를 정하므로, 그 판단은 추적 이슈 [#42](https://github.com/dj258255/b-studio/issues/42)에 모읍니다. 유료 API를 쓸 수 없어 실험은 본인 PC에 로그인된 구독 CLI로 돌립니다. 측정 지표는 청구 없이도 잴 수 있고, 비용은 API 단가 환산 추정치로만 적습니다.

09-28에 순서를 일부 바꿨습니다. 여러 에이전트가 서로 통신하는 구조를 직접 써 보고 싶다는 요청이 있어, 조율 메커니즘(M3)을 E1과 나란히 만들었습니다. 대신 기본값은 지금과 같은 "공유 없음"으로 두고, 켜야만 동작하게 했습니다. 어느 전략이 나은지는 E1·E2 결과가 나오기 전까지 주장하지 않습니다. 만든 순서가 바뀌었을 뿐, 결정은 여전히 측정 뒤에 합니다.

## 완료한 단계

| 단계 | 기간 | 대표 PR |
|---|---|---|
| 런타임 코어·샌드박스 | 09-10 | PR 없음 ([c733cc8](https://github.com/dj258255/b-studio/commit/c733cc8) ~ [4499334](https://github.com/dj258255/b-studio/commit/4499334)) |
| 에이전트 루프·검증 게이트 | 09-10 ~ 09-11 | [#3](https://github.com/dj258255/b-studio/pull/3), [#4](https://github.com/dj258255/b-studio/pull/4) |
| 체크포인트 | 09-10 ~ 09-11 | [#2](https://github.com/dj258255/b-studio/pull/2), [#6](https://github.com/dj258255/b-studio/pull/6) |
| 정책·격리 | 09-11 ~ 09-12 | [#7](https://github.com/dj258255/b-studio/pull/7)~[#12](https://github.com/dj258255/b-studio/pull/12), [#35](https://github.com/dj258255/b-studio/pull/35), [#36](https://github.com/dj258255/b-studio/pull/36), [#38](https://github.com/dj258255/b-studio/pull/38) |
| 배포 | 09-11 ~ 09-12 | [#27](https://github.com/dj258255/b-studio/pull/27), [#28](https://github.com/dj258255/b-studio/pull/28), [#29](https://github.com/dj258255/b-studio/pull/29) |
| 멀티 모델·Fleet | 09-13 | PR 없음 |
| 작업 분해·워크플로 강제 | 09-15 ~ 09-16 | PR 없음 |
| 화면 문법 정리 | 09-16 ~ 09-24 | [#40](https://github.com/dj258255/b-studio/pull/40) (이슈 [#39](https://github.com/dj258255/b-studio/issues/39)) |

이 표는 커밋 기록으로 나중에 다시 구성했습니다. 당시에는 예상 시간을 적지 않아 실제와 비교할 기록이 없습니다.

## 하지 않기로 한 것

- 범용 core 패키지 분리 — 쓰는 곳이 개발 하나뿐입니다.
- 제한 없는 full mesh·message bus — 레인 간 공유는 크기·쓰기 횟수·읽기 예산이 있는 게시판 메모로 한정합니다([#62](https://github.com/dj258255/b-studio/issues/62)). 기본값은 공유 없음이고, 효과는 E2로 잰 뒤에만 주장합니다.
- 약관·개인정보 페이지 — [ADR-031](docs/decisions.md) 보강 절을 참조합니다.

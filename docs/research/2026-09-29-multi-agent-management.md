# 여러 에이전트를 한 곳에서 관리하는 도구 조사 — herdr 같은 경험을 b-studio 안에

조사일: 2026-09-29. 각 도구는 공식 문서·엔지니어링 블로그 등 1차 출처 기준으로 정리했고, 1차 출처로 확인하지 못한 항목은 ⚠️ 로 표시했다.

## 1. 결론 먼저

- herdr가 하는 일(에이전트별 pane, idle/working 상태, 텍스트 전송, 출력 읽기)에 구조적으로 가장 가까운 것은 **Conductor**, **Sculptor(Imbue)**, **claude-squad** 세 가지다. 셋 다 "git worktree 하나 = 에이전트 하나"를 기본 단위로 삼고, 데스크톱 앱(Conductor·Sculptor) 또는 터미널 TUI(claude-squad)에서 여러 워크트리를 나란히 보여주며 사람이 각 에이전트에 개별적으로 말을 걸고 diff를 검토한다.
- 그 다음으로 가까운 것은 **GitHub Copilot Agent HQ의 Mission Control**과 **VS Code Agent Sessions 뷰**다. 이 둘은 herdr에는 없는 "지금 개입이 필요한 에이전트만 모아 보여주는 인박스/배지" 개념을 제품화했다는 점에서 b-studio가 참고할 가치가 크다.
- 빅테크 3사(Google Antigravity, GitHub/VS Code, OpenAI Codex)는 모두 2025년 하반기~2026년 상반기 사이에 "여러 에이전트를 한 화면에서 지휘한다"는 컨셉을 공식적으로 "mission control"이라는 표현으로 밀고 있다 — 업계 전체가 같은 UX 패턴으로 수렴 중이라는 신호다.
- 격리 방식은 로컬 도구(Cursor, Conductor, Sculptor, Vibe Kanban, claude-squad, Amp)는 거의 전부 **git worktree**, 클라우드 도구(Codex Cloud, Jules, Devin, OpenHands)는 **VM/컨테이너**를 쓴다. b-studio의 "세션당 Docker 샌드박스"는 후자 쪽 무게감(격리는 강하지만 기동은 무겁다)에 가깝고, 로컬 worktree 경량 병렬 실행 옵션은 아직 없다.
- 비용/토큰 가시성을 실제로 제품에 노출한 곳은 소수뿐이다: Devin은 자식 세션별 ACU 소비량을, VS Code Agent Sessions는 세션별 토큰/AI 크레딧을, Claude Code Agent Teams는 팀원별 토큰 비용이 선형으로 늘어난다는 점을 문서로 명시한다. 나머지 대부분은 "구독 그대로 쓰고 있어서" 비용 가시성 자체를 아예 제공하지 않는다.

## 2. 비교 표

| 도구 | 격리 | 관리 화면 | 사람 개입 | 결과 전달 | 비용 가시성 | 출처 |
|---|---|---|---|---|---|---|
| **Google Antigravity** (Agent Manager) | 워크스페이스별 실행(⚠️ 샌드박스 구체 구조는 1차 출처에 미기재) | Manager 뷰 = "mission control", Inbox + 사이드 패널 알림 | Google-Docs 스타일 코멘트를 아티팩트/스크린샷에 남기면 에이전트 멈추지 않고 반영 | task list, 구현 계획, walkthrough, 스크린샷, 브라우저 녹화 | 5시간 단위 rate limit만 언급, 에이전트별 토큰/비용 노출 없음 | [Antigravity 공식 블로그](https://antigravity.google/blog/introducing-google-antigravity) |
| **GitHub Copilot Agent HQ / Mission Control** | ⚠️ 세션 실행 환경 상세 비공개, Codespaces/VS Code Insiders/CLI에서 이어받기 가능 | 단일 대시보드에서 여러 에이전트에 작업 할당·추적, task view에서 "개입 필요" 상태 한눈에 확인 | 세션 진행 중 채팅 입력 또는 Files changed 뷰 코멘트로 실시간 steering(현재 tool call 끝나면 반영) | PR로 귀결, 커밋 사유를 실시간으로 표시 | 언급 없음 | [GitHub Changelog](https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/), [Agent HQ 발표](https://github.blog/news-insights/company-news/welcome-home-agents/) |
| **VS Code Agent Sessions 뷰** | 기본은 워크스페이스 공유, "worktree-isolated session"으로 격리 선택 가능 | 사이드바 Agent Sessions에 전체 세션 나열, active/in progress/completed/archived 상태, "개입 필요" 배지 카운트 | 세션에 메시지 전송, 대화 fork, 사이드챗, chat editor에서 진행 중 course-correct | 세션별 Changes 필, 결과 JSON export/Markdown 복사 | 컨텍스트 창에 토큰 수·카테고리별 사용량·총 AI 크레딧 표시 | [VS Code 공식 문서](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions) |
| **OpenAI Codex (Cloud tasks / Codex app)** | Codex Cloud는 태스크별 격리 클라우드 샌드박스(기본 인터넷 차단), Codex app은 git worktree 기반 로컬 병렬 | Codex app이 여러 에이전트를 한 화면에서 관리하는 전용 인터페이스 | ⚠️ 세부 개입 방식은 앱 공식 페이지가 403으로 직접 확인 불가, 서드파티 가이드 기준 진행 중 지시 가능 | diff 제안, PR 생성 | 언급 없음(서드파티 소스만 확인) | [OpenAI Codex 소개](https://openai.com/index/introducing-codex/), [Codex app 소개](https://openai.com/index/introducing-the-codex-app/) |
| **Cursor Agents Window** | git worktree, `.cursor/worktrees.json`으로 셋업 커스터마이즈 | Agents Window: 로컬/클라우드/worktree/원격 SSH 에이전트를 한 창에서 병렬 표시, Cmd+Shift+P로 오픈, 최대 8개 동시 실행 | 실행 중 진행 상황 모니터링, 완료 후 리뷰, `/apply-worktree`로 메인에 반영 | 워크트리에서 바로 커밋/PR 또는 메인 워크스페이스로 결과 반입 | 문서에 명시 없음 | [Cursor Worktrees 문서](https://cursor.com/docs/configuration/worktrees) |
| **Anthropic Claude Code Agent Teams** | 팀원마다 독립 컨텍스트 윈도우(같은 파일시스템 공유, git worktree 아님) | 터미널 에이전트 패널(리더 아래) 또는 split-pane(tmux/iTerm2), idle/working 표시, 3명 넘게 idle이면 접힘 | 화살표로 팀원 선택 후 Enter로 직접 메시지, plan 승인, shutdown 요청 | 팀원이 끝나면 자동으로 리더에 알림 + 최종 답변 포함, 공유 task list(pending/in progress/completed) | "팀 토큰 비용은 선형으로 증가" 명시, 팀원 수만큼 비용 스케일 경고 있지만 실시간 대시보드는 없음 | [공식 문서: Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) |
| **Devin (Cognition) — Managed Devins** | 관리되는 Devin마다 완전히 독립된 VM(자체 터미널·브라우저·개발환경) | 오케스트레이터 Devin이 작업 분해·할당·모니터링·충돌 해결·결과 취합, Devin Desktop이 커맨드센터 역할 | 개별 세션 링크로 직접 확인, 메시지 전송, 일시정지/종료 가능 | 각 하위 Devin이 스스로 검증 후 보고, 상위 Devin이 trajectory 읽고 다음 위임 개선 | **ACU(compute) 소비량을 자식 세션별로 추적 가능** — 조사 대상 중 가장 구체적인 비용 가시성 | [Devin can now manage Devins](https://cognition.com/blog/devin-can-now-manage-devins) |
| **Google Jules** | 태스크별 클라우드 VM(레포 클론+의존성 설치) | `/remote` 대시보드에서 태스크 개수/잔여량, 완료·대기·에러 로그 확인, Jules Tools CLI로도 관리 | **실행 전 계획을 사람이 검토·승인**해야 코드 변경 시작(다른 도구에 드문 프리-실행 게이트) | ⚠️ diff/PR 형태 세부는 문서에서 명시적으로 확인 못함 | "Usage and limits" 메뉴로 동시 실행 가능 태스크 수(요금제별 15~60개) 노출 | [Jules 공식 문서](https://jules.google/docs/), [Jules Tools](https://developers.googleblog.com/en/meet-jules-tools-a-command-line-companion-for-googles-async-coding-agent/) |
| **AWS Kiro (+ Kiro Crew)** | 서브에이전트별 독립 컨텍스트, Kiro Crew는 EC2 인스턴스당 headless 세션 + S3 공유 상태 | 세션 탭, `/rewind`로 특정 시점 복귀·분기 | ⚠️ 실시간 개입 세부는 1차 출처(kiro.dev changelog)에서 완전히 확인되지 않음 | ⚠️ 결과 전달 형식(PR 등) 명시 부족 | 언급 없음 | [Kiro Changelog: AWS Control, Session Tabs](https://kiro.dev/changelog/crew/0-5/) |
| **Vibe Kanban** (오픈소스, 현재 커뮤니티 유지보수·후속 Easy Vibe Kanban 포크 존재) | 태스크마다 git worktree, 실행 후 자동 정리 | 칸반 보드: Plan → Prompt → Review 3단계, 카드에 상태 표시 | 이슈/서브이슈로 작업 분해 후 백그라운드로 에이전트에 위임, 진행 중 상태 확인 | 전용 diff 뷰, 코멘트, 내장 브라우저로 QA, PR 플로우 | 명시 없음 | [Vibe Kanban 공식 사이트](https://www.vibekanban.com/) |
| **Conductor** (macOS) | git worktree("개발 격리"일 뿐 보안 샌드박스 아님, 로컬 기본 권한으로 실행 — Conductor Cloud만 진짜 샌드박스) | 워크스페이스 단위: 브랜치+채팅 스레드+파일트리+터미널+diff, 워크스페이스 여러 개 = 에이전트 여러 개 병렬 | 워크스페이스별 채팅으로 개별 지시, diff 보고 병합 여부 판단 | 브랜치별 diff 검토 후 GitHub로 병합, 2026년 8월부터 stacked PR 지원 | Conductor 자체는 모델 과금 없음(구독 그대로 사용), 사용량 계측/한도 기능 없음 | [Conductor 소개(써드파티 가이드)](https://continuumcode.ai/guides/what-is-conductor/), [Product Hunt](https://www.producthunt.com/products/conductor-aa77ddef-e6d3-4805-a179-7b2e17b6e22e) |
| **Sculptor (Imbue)** | 에이전트마다 독립 git worktree(자체 브랜치·터미널·diff), MIT 오픈소스 | "채팅창이 아니라 워크스페이스" — 여러 에이전트를 한 창에서 동시에, 5개 이상 티켓 병렬 가능 | 에이전트 출력 vs 내 입력, plan vs changes를 UI에서 구분해서 판단 | 워크스페이스별 diff, 같은 화면에서 리뷰·병합 후 git fetch/checkout | Claude/Claude Max 구독 그대로 사용, 토큰 재판매·캡 없음(=가시성도 없음) | [Sculptor 제품 페이지](https://imbue.com/product/sculptor), [발표 블로그](https://imbue.com/blog/sculptor-announce) |
| **claude-squad / Crystal(→Nimbalyst)** (오픈소스 터미널·데스크톱 도구) | 에이전트(태스크)마다 git worktree | TUI에서 실행 중 에이전트 전체를 pane으로 동시 표시, 각 pane에 현재 파일·상태 표시 | pane 전환해서 직접 대화·전송 | 워크트리 기반 diff, 충돌 없이 리뷰 후 병합 | 명시 없음 | [claude-squad GitHub](https://github.com/smtg-ai/claude-squad), [Crystal GitHub](https://github.com/stravu/crystal) |
| **Sourcegraph Amp (Thread Map)** | 스레드/서브에이전트 단위(⚠️ 파일시스템 격리 방식 미상세) | Thread Map으로 활성·완료 스레드 관계를 시각화, 어느 스레드가 무슨 결과를 냈고 어디서 멈췄는지 추적 | 여러 스레드에 서로 다른 작업 동시 지시 | 스레드별 결과, Thread Map으로 중복/정체 파악 | 명시 없음 | [Amp Thread Map 발표](https://ainativedev.io/news/amp-launches-thread-map-to-help-navigate-ai-coding-agent-work) |
| **Factory.ai Droid** | 세션마다 독립 컨텍스트+시스템 프롬프트, git worktree 지원(서비스별 분리) | Coordinator 에이전트가 티켓을 분해해 여러 Droid에 분배·순서화, Sessions API로 프로그래매틱 관리 | ⚠️ 실시간 개입 UI 세부는 공식 블로그에서 완전히 확인 못함(문서 페이지 접근 제한) | 최종 메시지를 부모 에이전트에 반환, 서비스별 병렬 작업 후 수렴 | 언급 없음 | [Factory Droid 문서(서드파티 요약)](https://sidbharath.com/blog/factory-ai-guide/) |
| **OpenHands** (오픈소스) | 에이전트마다 Docker 샌드박스 | 웹 UI(Agent Canvas)로 로컬/원격/클라우드 백엔드의 에이전트를 동일 인터페이스에서 제어 | ⚠️ 개입 세부는 이번 조사에서 1차 문서까지 못 감(공식 블로그 요약 수준) | ⚠️ diff/PR 여부 미확인 | 언급 없음 | [OpenHands 블로그: 병렬 에이전트로 대규모 리팩터](https://www.openhands.dev/blog/automating-massive-refactors-with-parallel-agents) |

## 3. 공통 패턴

거의 모든 도구가 공유하는 요소:

- **격리 단위 = 에이전트 1개**: 로컬 도구는 git worktree, 클라우드 도구는 VM/컨테이너. "같은 체크아웃을 여러 에이전트가 건드리면 충돌한다"는 문제의식이 업계 전반에 있고, b-studio의 세션당 Docker 샌드박스도 같은 문제의식의 연장선이다.
- **한 화면에 여러 에이전트 상태를 나열**: 패널/보드/윈도우 형태는 다르지만, idle vs working vs 개입 필요를 구분해서 보여주는 것은 공통.
- **"개입 필요" 신호를 사람이 놓치지 않게 하는 장치**: VS Code의 배지 카운트, GitHub Mission Control의 task view, Devin의 ACU 추적, Claude Code의 idle row 등 — 표현 방식은 다르지만 전부 "지금 봐야 할 에이전트만 골라 보여주기"를 제품화했다.
- **diff 우선 리뷰 → PR/커밋으로 수렴**: 거의 전 도구가 결과를 코드 diff로 보여주고 최종적으로 PR/커밋으로 병합시킨다. 스크린샷·브라우저 녹화(Antigravity)나 Thread Map(Amp) 같은 보조 아티팩트는 소수만 제공.
- **비용 가시성은 예외적**: 대부분 "기존 구독 그대로 쓴다"는 이유로 아예 노출하지 않는다. 노출하는 곳(Devin ACU, VS Code 토큰/크레딧, Claude Code 팀 비용 경고)이 오히려 소수파다.

## 4. b-studio에 없는 것 후보

b-studio 현재 기능: 세션당 Docker 샌드박스, 검증 게이트, 병렬 lane으로 나뉘는 task plan, Agent Fleet 페이지(`apps/studio/app/fleets/page.tsx`), 세션별 채팅 패널, 실행마다 새 토큰 탭, 원격 브라우저 미리보기. 이걸 기준으로 비교하면:

1. **"지금 개입이 필요한 세션만" 모아 보여주는 인박스/배지** — GitHub Mission Control, VS Code Agent Sessions가 갖고 있음. Agent Fleet 페이지가 있어도 "전체 나열"과 "개입 필요만 필터링"은 다른 기능. b-studio는 후자가 없어 보임.
2. **실행 중(mid-run) 스티어링** — GitHub Copilot(현재 tool call 끝나면 즉시 반영), Claude Code Agent Teams(팀원 선택해 바로 메시지), Antigravity(스크린샷에 코멘트하면 멈추지 않고 반영). b-studio 채팅 패널이 실행 도중 지시를 얼마나 실시간으로 반영하는지가 관건인데, 최소한 "diff/스크린샷에 직접 코멘트를 남기면 멈추지 않고 반영"하는 Antigravity 식 UX는 없어 보임.
3. **경량 로컬 병렬 격리(git worktree) 옵션** — Cursor, Conductor, Sculptor, Vibe Kanban, claude-squad는 전부 Docker보다 훨씬 가벼운 worktree 격리를 기본으로 쓴다. b-studio는 세션마다 Docker 샌드박스만 있어서, 가볍고 빠르게 여러 에이전트를 띄우는 용도로는 상대적으로 무겁다.
4. **실행 전 계획 승인 게이트** — Google Jules는 코드를 건드리기 전에 사람이 계획을 검토·승인해야 한다. b-studio의 검증 게이트는 (설명상) 결과물에 대한 게이트로 보이며, 실행 전 계획 단계 승인은 별개 기능.
5. **에이전트 간 파이프라인 시각화 (Thread Map류)** — Amp의 Thread Map처럼 "어느 서브 에이전트가 무엇을 만들었고 어디서 막혔는지"를 그래프로 보여주는 것. b-studio의 task plan lane은 정적으로 나뉘어 있을 뿐, lane 간 관계·의존성을 시각화하는 화면은 없어 보임.
6. **상위 에이전트가 하위 에이전트들을 재위임·재조정** — Devin의 Managed Devins, Factory의 Coordinator처럼 상위 에이전트가 하위 에이전트의 trajectory를 읽고 다음 작업 분배를 스스로 개선하는 구조. b-studio의 task plan은 (설명상) 요청 시점에 lane을 나누는 정적 분할에 가까워 보이고, 실행 중 재분배 오케스트레이터 레이어는 없어 보인다.
7. **동적 작업 큐 + 셀프 클레임** — Claude Code Agent Teams의 공유 task list(의존성 있는 작업은 완료돼야 잠금 해제, 팀원이 스스로 다음 일을 집음). b-studio의 lane은 미리 정해진 분할이라 이런 동적 재배정이 없어 보인다.
8. **에이전트별 실시간 비용/크레딧 표시(Fleet 전체 합산 포함)** — VS Code는 세션마다 토큰/크레딧을, Devin은 자식 세션마다 ACU를 보여준다. b-studio는 "실행마다 새 토큰 탭"이 있어 개별 실행 단위 가시성은 있지만, Fleet 전체를 한 화면에서 합산해 보여주는 대시보드가 있는지는 불확실 — 있다면 이 항목은 이미 충족.
9. **터미널 여러 개를 한 화면에 동시 배치(split-pane)** — Claude Code의 tmux/iTerm2 split-pane, claude-squad의 TUI pane이 여기 해당. b-studio는 세션별 채팅 패널이 있지만 herdr처럼 "여러 세션의 터미널/출력을 동시에 나란히" 보는 뷰는 없어 보인다 — 이게 사실 herdr를 가장 직접적으로 대체할 기능.

## 5. 출처 목록

- https://antigravity.google/blog/introducing-google-antigravity
- https://github.blog/news-insights/company-news/welcome-home-agents/
- https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/
- https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions
- https://code.visualstudio.com/docs/agents/overview
- https://openai.com/index/introducing-codex/
- https://openai.com/index/introducing-the-codex-app/
- https://cursor.com/docs/configuration/worktrees
- https://code.claude.com/docs/en/agent-teams
- https://cognition.com/blog/devin-can-now-manage-devins
- https://cognition.com/blog/devin-2
- https://jules.google/docs/
- https://developers.googleblog.com/en/meet-jules-tools-a-command-line-companion-for-googles-async-coding-agent/
- https://kiro.dev/changelog/crew/0-5/
- https://www.vibekanban.com/
- https://continuumcode.ai/guides/what-is-conductor/
- https://www.producthunt.com/products/conductor-aa77ddef-e6d3-4805-a179-7b2e17b6e22e
- https://imbue.com/product/sculptor
- https://imbue.com/blog/sculptor-announce
- https://github.com/smtg-ai/claude-squad
- https://github.com/stravu/crystal
- https://ainativedev.io/news/amp-launches-thread-map-to-help-navigate-ai-coding-agent-work
- https://sidbharath.com/blog/factory-ai-guide/
- https://www.openhands.dev/blog/automating-massive-refactors-with-parallel-agents

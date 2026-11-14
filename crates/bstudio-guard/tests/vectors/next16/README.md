# Next.js 16 실제 응답 (이슈 #1207)

2026-11-14에 Next.js 16.4.3(React 19.2.8, `examples/orders/web` 복사본)을 이 컴퓨터에서 띄워 `curl`로 받은 HTML 원문입니다. `dev-*`는 `next dev`(샌드박스가 쓰는 방식), `prod-*`는 `next build` 뒤 `next start`입니다. `dev-*`의 스택 경로에 들어 있던 홈 폴더 경로는 `/app`·`/home/user`로 바꿨고, 그 밖에는 손대지 않았습니다.

| 이름 | page | 상태 코드 |
| --- | --- | --- |
| `home` | `Price` 컴포넌트를 쓰는 첫 화면 | 200 |
| `ok` | 정적 page | 200 |
| `order-1` | 동적 경로 `/o/[id]`를 `1`로 | 200 |
| `dyn` | `next/dynamic`의 `ssr: false` | 200 |
| `sp` | `Suspense` 안의 `useSearchParams` | 200 |
| `cerr` | 브라우저에서만 던지는 클라이언트 컴포넌트 | 200 |
| `rd` | `Suspense` 안에서 `redirect('/ok')` | 200 |
| `errs` | `Suspense` 안의 서버 컴포넌트가 던짐 | 200 |
| `nfs` | `Suspense` 안에서 `notFound()` | 200 |
| `err` | page가 바로 던짐 | 500 |
| `nf` | page가 바로 `notFound()` | 404 |
| `nope` | 없는 경로(기본 404 화면) | 404 |

모든 응답의 `<script>` 안 RSC 데이터에 기본 not-found 화면 글자(`This page could not be found`)가 들어 있습니다. 화면에 보이는 글자에는 `nope`에만 있습니다.

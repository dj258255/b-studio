/**
 * 로컬 토큰 교환 페이지(ADR-173 덧붙임). 토큰 없이 작은 페이지를 준다 —
 * 페이지의 스크립트가 주소의 `#` 뒤에서 토큰을 읽어 곧바로 주소에서 지우고(주소창·방문 기록에 남기지 않는다),
 * 본문으로 `/api/local-auth`에 보낸다. 토큰을 쿼리로 받지 않는다(쿼리는 개발 서버 로그에 그대로 남는다).
 * 인증을 켠 서버에서는 proxy가 이 경로를 404로 막는다
 */
export function GET(): Response {
  return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const PAGE = [
  '<!doctype html>',
  '<html lang="ko">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>b-studio</title>',
  '<style>body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#0d1117;background:#fbfdfc}main{max-width:32rem;padding:2rem;text-align:center}#note{line-height:1.7}</style>',
  '</head>',
  '<body>',
  '<main><p id="note">터미널을 여는 중…</p></main>',
  '<script>',
  '(function () {',
  "var note = document.getElementById('note');",
  "var token = window.location.hash.replace(/^#/, '');",
  "window.history.replaceState(null, '', window.location.pathname + window.location.search);",
  "var params = new URLSearchParams(window.location.search);",
  'function safeNext(value) {',
  "if (!value) return '/';",
  'var url;',
  "try { url = new URL(value, window.location.origin); } catch (error) { return '/'; }",
  "if (url.origin !== window.location.origin) return '/';",
  'return url.pathname + url.search + url.hash;',
  '}',
  "var next = safeNext(params.get('next'));",
  "function fail(text) { note.textContent = text; }",
  "if (!token) { fail('터미널을 쓰려면 `pnpm studio launch`가 찍은 주소로 여세요'); return; }",
  "window.fetch('/api/local-auth', {",
  "method: 'POST',",
  "headers: { 'content-type': 'application/json' },",
  'body: JSON.stringify({ token: token })',
  '}).then(function (response) {',
  "return response.json().catch(function () { return {}; }).then(function (data) {",
  "if (!response.ok) throw new Error((data && data.error) || '터미널을 열지 못했습니다');",
  '});',
  '}).then(function () {',
  'window.location.replace(next);',
  '}).catch(function (error) {',
  "fail((error && error.message) || '터미널을 쓰려면 `pnpm studio launch`가 찍은 주소로 여세요');",
  '});',
  '})();',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

# Wiki source

이 폴더는 [b-studio GitHub Wiki](https://github.com/dj258255/b-studio/wiki)에 게시할 원본입니다. GitHub Wiki의 페이지 파일명 규칙에 맞춰 `Home.md`, `_Sidebar.md`, `_Footer.md`와 주제별 페이지를 관리합니다.

제품 동작의 기준 문서는 저장소의 [`docs/`](../docs/README.md)입니다. 동작이나 설정을 바꿀 때는 `docs/`를 먼저 고치고 Wiki의 요약과 링크를 함께 갱신합니다.

Wiki 저장소가 활성화되어 있으면 다음 방식으로 게시할 수 있습니다.

```bash
git clone https://github.com/dj258255/b-studio.wiki.git /tmp/b-studio-wiki
cp wiki/*.md /tmp/b-studio-wiki/
cd /tmp/b-studio-wiki
git add .
git commit -m "docs: organize b-studio wiki"
git push origin master
```

Wiki 기본 브랜치 이름은 최초 생성 상태에 따라 다를 수 있으므로 push 전에 `git branch --show-current`로 확인합니다.

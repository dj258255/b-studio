# 세션 터미널 글꼴

`terminal-mono.woff2`는 세션 터미널(xterm)이 쓰는 글꼴입니다(`app/globals.css`의 `b-studio-terminal`, `lib/terminal.ts`의 `TERMINAL_FONT`, #867).

영문 글꼴에 한글이 없으면 다른 글꼴의 한글이 2칸 자리에 그려지고, xterm이 남는 폭을 글자 사이로 벌려 "주 문 모 듈"처럼 보입니다. 이 글꼴은 영문 한 글자가 500, 한글 한 글자가 1000(1000 단위 기준)이라 한글이 영문의 정확히 2칸에 맞습니다. 영문과 한글을 같은 글꼴로 그려야 xterm이 잰 칸 폭과 한글 폭이 맞으므로, 터미널 글꼴 목록의 맨 앞에 둡니다.

## 출처

- 원본: D2Coding 1.4.0(NAVER), https://github.com/naver/d2-coding-font/releases/tag/VER1.4.0
- 받은 파일: `D2Coding-Ver1.4.0-20261003.zip`, SHA-256 `17e2da5e2879006eb725b87943f7988736ef8b6c9f8b84bc8e3bdbcb8dd46744`
- 쓴 글꼴: 압축 안의 `D2Coding/D2Coding-Ver1.4.0-20261003.ttf`(보통 굵기만, 굵은 글자는 브라우저가 만든다)
- 결과: `terminal-mono.woff2` 285KB, 12110자

## 라이선스

SIL Open Font License 1.1입니다. 원문은 같은 폴더의 [OFL.txt](OFL.txt)이고, 글꼴 안의 이름 표(저작권 0번, 라이선스 13·14번)에도 들어 있습니다.

OFL은 고친 판(서브셋 포함)에 예약 글꼴 이름 "D2Coding"을 쓰지 못하게 합니다. 그래서 글꼴 이름을 `b-studio Terminal Mono`로 바꿨습니다. 저작권 표시는 그대로 둡니다.

## 남긴 글자

영문과 라틴 1, 문장 부호, 화살표, 기술 기호, 상자 그리기·도형, 한글(자모, 호환 자모, 음절 11172자, 확장 자모), CJK 문장 부호, 전각 영숫자입니다.

xterm(유니코드 6 폭)이 1칸으로 세는데 이 글꼴에서는 2칸 폭인 글자는 뺐습니다. 넣으면 옆 글자를 덮습니다. `U+25FD-25FE`, `U+2600-27BF`(그림 문자·딩뱃)가 그렇고, 이 글자들은 글꼴 목록의 다음 글꼴로 그려집니다. 남긴 글자는 모두 유니코드의 넓은 글자(W·F)이면 1000, 아니면 500 폭입니다.

## 다시 만들기

fonttools 4.66.1과 brotli 1.2.0을 씁니다(배포 2주가 지난 판).

```bash
python3 -m venv venv && venv/bin/pip install fonttools==4.66.1 brotli==1.2.0
unzip D2Coding-Ver1.4.0-20261003.zip
venv/bin/pyftsubset D2Coding/D2Coding-Ver1.4.0-20261003.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+2190-21FF,U+2300-23FF,U+2500-25FC,U+25FF,U+1100-11FF,U+3000-303F,U+3130-318F,U+A960-A97F,U+AC00-D7A3,U+D7B0-D7FF,U+FF01-FF60" \
  --layout-features='*' --no-hinting --desubroutinize --output-file=sub.ttf
venv/bin/python rename.py sub.ttf terminal-mono.woff2
```

`rename.py`는 이름 표를 바꾸고 라이선스 항목을 넣은 뒤 woff2로 저장합니다.

```python
import sys
from fontTools.ttLib import TTFont

src, dst = sys.argv[1], sys.argv[2]
f = TTFont(src)
name = f["name"]
family = "b-studio Terminal Mono"
ps = "bStudioTerminalMono-Regular"
for rec in list(name.names):
    if rec.nameID in (1, 16):
        rec.string = family
    elif rec.nameID == 4:
        rec.string = f"{family} Regular"
    elif rec.nameID == 6:
        rec.string = ps
    elif rec.nameID == 3:
        rec.string = f"{ps};1.4.0-subset"
    elif rec.nameID == 17:
        rec.string = "Regular"
name.setName("This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://openfontlicense.org", 13, 3, 1, 0x409)
name.setName("https://openfontlicense.org", 14, 3, 1, 0x409)
f.flavor = "woff2"
f.save(dst)
```

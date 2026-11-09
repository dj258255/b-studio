import { describe, expect, it } from 'vitest';
import {
  buildPrReviewComment,
  buildPrReviewExternalContext,
  buildPrReviewFixRequest,
  buildPrReviewResolvedContext,
  buildPrReviewUserPrompt,
  buildReviewResolutionComment,
  diffFilePaths,
  extractDiffReferencedNames,
  extractPrReviewFixTitles,
  hasBlockingFindings,
  isBlockingFinding,
  nextPrReviewStep,
  prReviewMarker,
  PR_REVIEW_FIX_MARKER,
  severityCounts,
  truncateDiff,
} from './pr-review';

/**
 * pr-review의 순수 판정·글 만들기 벡터 시험(ADR-191 3g). 기대값은 옮기기 전 TS가 낸 값이다(JSON 글자, 쉼표 묶음은 'en-US'로 고정).
 * 입력은 심각도 네 가지와 모르는 값, 라운드 == 최대 라운드 앞뒤, diff 상한 ±1, 파일 생략을 멈추는 합계 경계(`total <= maxChars`),
 * 같은 크기 파일의 생략 순서, 표 칸 500자 경계, 커밋 범위 7자 경계, 외부 미리보기 상한 경계, 식별자 길이 2·40 경계를 겨눈다.
 * 옛 TS를 이 시험의 `pr-review`로 바꿔 돌리면 의도한 차이(맨 아래 describe)만 실패한다.
 */
type Vector = [fn: string, args: unknown[], expected: string];
const VECTORS: Vector[] = [
  ["isBlockingFinding", [{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}], "true"],
  ["isBlockingFinding", [{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}], "true"],
  ["isBlockingFinding", [{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["isBlockingFinding", [{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["isBlockingFinding", [{"severity":"urgent","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["isBlockingFinding", [{"severity":"","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["isBlockingFinding", [{"severity":"Blocker","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["isBlockingFinding", [{"severity":"MAJOR","file":"a.ts","title":"제목","detail":"설명"}], "false"],
  ["hasBlockingFindings", [[]], "false"],
  ["hasBlockingFindings", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "false"],
  ["hasBlockingFindings", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"}]], "false"],
  ["hasBlockingFindings", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "false"],
  ["hasBlockingFindings", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}]], "true"],
  ["hasBlockingFindings", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}]], "true"],
  ["hasBlockingFindings", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}]], "true"],
  ["hasBlockingFindings", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}]], "true"],
  ["hasBlockingFindings", [[{"severity":"urgent","file":"a.ts","title":"제목","detail":"설명"}]], "false"],
  ["hasBlockingFindings", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"},{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "true"],
  ["severityCounts", [[]], "{\"blocker\":0,\"major\":0,\"minor\":0,\"nit\":0}"],
  ["severityCounts", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}]], "{\"blocker\":1,\"major\":0,\"minor\":0,\"nit\":0}"],
  ["severityCounts", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"},{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"},{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "{\"blocker\":2,\"major\":1,\"minor\":1,\"nit\":3}"],
  ["severityCounts", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "{\"blocker\":0,\"major\":0,\"minor\":0,\"nit\":1}"],
  ["severityCounts", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"}]], "{\"blocker\":0,\"major\":0,\"minor\":2,\"nit\":0}"],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],1,2], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,2], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],1,2], "\"pass\""],
  ["nextPrReviewStep", [[],1,2], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,2], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],2,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],2,2], "\"pass\""],
  ["nextPrReviewStep", [[],2,2], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],3,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],3,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],3,2], "\"pass\""],
  ["nextPrReviewStep", [[],3,2], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],3,2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],0,0], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],0,0], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],0,0], "\"pass\""],
  ["nextPrReviewStep", [[],0,0], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],0,0], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],1,1], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,1], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],1,1], "\"pass\""],
  ["nextPrReviewStep", [[],1,1], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,1], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],0,1], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],0,1], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],0,1], "\"pass\""],
  ["nextPrReviewStep", [[],0,1], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],0,1], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],5,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],5,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],5,3], "\"pass\""],
  ["nextPrReviewStep", [[],5,3], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],5,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],1,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],1,3], "\"pass\""],
  ["nextPrReviewStep", [[],1,3], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],2,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],2,3], "\"pass\""],
  ["nextPrReviewStep", [[],2,3], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,3], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],3,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],3,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],3,3], "\"pass\""],
  ["nextPrReviewStep", [[],3,3], "\"pass\""],
  ["nextPrReviewStep", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],3,3], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],"__NaN__",2], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,"__NaN__"], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],"__Infinity__",2], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,"__Infinity__"], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],-1,0], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],0.5,1], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1.5,1], "\"cap\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],1,1.5], "\"fix\""],
  ["nextPrReviewStep", [[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],2,1.5], "\"cap\""],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",122], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n+aaaaaaaaaa\\ndiff --git a/b.ts b/b.ts\\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\ndiff --git a/c.ts b/c.ts\\n+c\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",123], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n+aaaaaaaaaa\\ndiff --git a/b.ts b/b.ts\\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\ndiff --git a/c.ts b/c.ts\\n+c\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",121], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n+aaaaaaaaaa\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n+c\",\"truncated\":true,\"omittedFiles\":[\"b.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",120], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n+aaaaaaaaaa\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n+c\",\"truncated\":true,\"omittedFiles\":[\"b.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",0], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",1], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",57], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",64], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",100], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",60000], "{\"diff\":\"diff --git a/a.ts b/a.ts\\n+aaaaaaaaaa\\ndiff --git a/b.ts b/b.ts\\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\ndiff --git a/c.ts b/c.ts\\n+c\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",93], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n+eeeeeeeeeeeeeeeeeeee\\ndiff --git a/y.ts b/y.ts\\n+eeeeeeeeeeeeeeeeeeee\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",92], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\\ndiff --git a/y.ts b/y.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\",\"truncated\":true,\"omittedFiles\":[\"x.ts\",\"y.ts\"]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",94], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n+eeeeeeeeeeeeeeeeeeee\\ndiff --git a/y.ts b/y.ts\\n+eeeeeeeeeeeeeeeeeeee\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",93], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n+eeeeeeeeeeeeeeeeeeee\\ndiff --git a/y.ts b/y.ts\\n+eeeeeeeeeeeeeeeeeeee\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",246], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n+eeeeeeeeeeeeeeeeeeee\\ndiff --git a/y.ts b/y.ts\\n+eeeeeeeeeeeeeeeeeeee\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",60], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\\ndiff --git a/y.ts b/y.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\",\"truncated\":true,\"omittedFiles\":[\"x.ts\",\"y.ts\"]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",50], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\\ndiff --git a/y.ts b/y.ts\\n<!-- 파일이 커서 생략했습니다 (46자) -->\",\"truncated\":true,\"omittedFiles\":[\"x.ts\",\"y.ts\"]}"],
  ["truncateDiff", ["diff --git a/x.ts b/x.ts\n+eeeeeeeeeeeeeeeeeeee\ndiff --git a/y.ts b/y.ts\n+eeeeeeeeeeeeeeeeeeee",300], "{\"diff\":\"diff --git a/x.ts b/x.ts\\n+eeeeeeeeeeeeeeeeeeee\\ndiff --git a/y.ts b/y.ts\\n+eeeeeeeeeeeeeeeeeeee\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["diff --git a/s.ts b/s.ts\n+s\ndiff --git a/big.ts b/big.ts\n+gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",86], "{\"diff\":\"diff --git a/s.ts b/s.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\\ndiff --git a/big.ts b/big.ts\\n<!-- 파일이 커서 생략했습니다 (230자) -->\",\"truncated\":true,\"omittedFiles\":[\"big.ts\",\"s.ts\"]}"],
  ["truncateDiff", ["diff --git a/s.ts b/s.ts\n+s\ndiff --git a/big.ts b/big.ts\n+gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",87], "{\"diff\":\"diff --git a/s.ts b/s.ts\\n+s\\ndiff --git a/big.ts b/big.ts\\n<!-- 파일이 커서 생략했습니다 (230자) -->\",\"truncated\":true,\"omittedFiles\":[\"big.ts\"]}"],
  ["truncateDiff", ["diff --git a/s.ts b/s.ts\n+s\ndiff --git a/big.ts b/big.ts\n+gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",88], "{\"diff\":\"diff --git a/s.ts b/s.ts\\n+s\\ndiff --git a/big.ts b/big.ts\\n<!-- 파일이 커서 생략했습니다 (230자) -->\",\"truncated\":true,\"omittedFiles\":[\"big.ts\"]}"],
  ["truncateDiff", ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",100], "{\"diff\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n\\n<!-- 크기 제한(100자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",1000], "{\"diff\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",1000], "{\"diff\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n\\n<!-- 크기 제한(1,000자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxx",0], "{\"diff\":\"\\n\\n<!-- 크기 제한(0자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxx",1234567], "{\"diff\":\"xxxxx\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxx",-1], "{\"diff\":\"xxxxxxx\\n\\n<!-- 크기 제한(-1자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxx",-3], "{\"diff\":\"xxxxx\\n\\n<!-- 크기 제한(-3자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxx",0], "{\"diff\":\"\\n\\n<!-- 크기 제한(0자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["xxxxxxxx","__Infinity__"], "{\"diff\":\"xxxxxxxx\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["",0], "{\"diff\":\"\",\"truncated\":false,\"omittedFiles\":[]}"],
  ["truncateDiff", ["",-1], "{\"diff\":\"\\n\\n<!-- 크기 제한(-1자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂",25], "{\"diff\":\"한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한\\n\\n<!-- 크기 제한(25자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂",60], "{\"diff\":\"한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂한글🙂\\n\\n<!-- 크기 제한(60자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글",25], "{\"diff\":\"한글한글한글한글한글한글한글한글한글한글한글한글한\\n\\n<!-- 크기 제한(25자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["truncateDiff", ["prefix diff --git a/x b/x\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",20], "{\"diff\":\"diff --git a/ b/\\n<!-- 파일이 커서 생략했습니다 (76자) -->\",\"truncated\":true,\"omittedFiles\":[\"\"]}"],
  ["truncateDiff", ["head\ndiff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c",60], "{\"diff\":\"diff --git a/ b/\\n<!-- 파일이 커서 생략했습니다 (4자) -->\\ndiff --git a/a.ts b/a.ts\\n<!-- 파일이 커서 생략했습니다 (36자) -->\\ndiff --git a/b.ts b/b.ts\\n<!-- 파일이 커서 생략했습니다 (57자) -->\\ndiff --git a/c.ts b/c.ts\\n<!-- 파일이 커서 생략했습니다 (27자) -->\",\"truncated\":true,\"omittedFiles\":[\"b.ts\",\"a.ts\",\"c.ts\",\"\"]}"],
  ["truncateDiff", ["diff --git a/a.ts b/a.ts\r\n+aaaaaaaaaa\r\ndiff --git a/b.ts b/b.ts\r\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\r\ndiff --git a/c.ts b/c.ts\r\n+c",60], "{\"diff\":\"diff --git a/a/a.ts b/a.ts\\r b/a/a.ts b/a.ts\\r\\n<!-- 파일이 커서 생략했습니다 (38자) -->\\ndiff --git a/a/b.ts b/b.ts\\r b/a/b.ts b/b.ts\\r\\n<!-- 파일이 커서 생략했습니다 (59자) -->\\ndiff --git a/a/c.ts b/c.ts\\r b/a/c.ts b/c.ts\\r\\n<!-- 파일이 커서 생략했습니다 (28자) -->\",\"truncated\":true,\"omittedFiles\":[\"a/b.ts b/b.ts\\r\",\"a/a.ts b/a.ts\\r\",\"a/c.ts b/c.ts\\r\"]}"],
  ["truncateDiff", ["diff --git a/x b/y\r\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/a/x b/y\\r b/a/x b/y\\r\\n<!-- 파일이 커서 생략했습니다 (140자) -->\",\"truncated\":true,\"omittedFiles\":[\"a/x b/y\\r\"]}"],
  ["truncateDiff", ["diff --git a/p q b/p q\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/p q b/p q\\n<!-- 파일이 커서 생략했습니다 (143자) -->\",\"truncated\":true,\"omittedFiles\":[\"p q\"]}"],
  ["truncateDiff", ["diff --git a/a b/b b/c\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/b b/c b/b b/c\\n<!-- 파일이 커서 생략했습니다 (143자) -->\",\"truncated\":true,\"omittedFiles\":[\"b b/c\"]}"],
  ["truncateDiff", ["diff --git a/a\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/a/a b/a/a\\n<!-- 파일이 커서 생략했습니다 (135자) -->\",\"truncated\":true,\"omittedFiles\":[\"a/a\"]}"],
  ["truncateDiff", ["diff --git a/a b/\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/a/a b/ b/a/a b/\\n<!-- 파일이 커서 생략했습니다 (138자) -->\",\"truncated\":true,\"omittedFiles\":[\"a/a b/\"]}"],
  ["truncateDiff", ["diff --git \n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n",30], "{\"diff\":\"diff --git a/ b/\\n<!-- 파일이 커서 생략했습니다 (132자) -->\",\"truncated\":true,\"omittedFiles\":[\"\"]}"],
  ["truncateDiff", ["diff --git a/한글.ts b/한글.ts\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\n+z\ndiff --git a/s b/s\n+q",30], "{\"diff\":\"diff --git a/한글.ts b/한글.ts\\n<!-- 파일이 커서 생략했습니다 (1,226자) -->\\ndiff --git a/s b/s\\n<!-- 파일이 커서 생략했습니다 (21자) -->\",\"truncated\":true,\"omittedFiles\":[\"한글.ts\",\"s\"]}"],
  ["truncateDiff", ["diff --git a/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk b/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\n+x",100], "{\"diff\":\"diff --git a/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk b/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\\n<!-- 파일이 커서 생략했습니다 (3,019자) -->\",\"truncated\":true,\"omittedFiles\":[\"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\"]}"],
  ["diffFilePaths", [""], "[\"\"]"],
  ["diffFilePaths", ["diff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c"], "[\"a.ts\",\"b.ts\",\"c.ts\"]"],
  ["diffFilePaths", ["x\ndiff --git a/a.ts b/a.ts\n+aaaaaaaaaa\ndiff --git a/b.ts b/b.ts\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ndiff --git a/c.ts b/c.ts\n+c"], "[\"\",\"a.ts\",\"b.ts\",\"c.ts\"]"],
  ["diffFilePaths", ["no header"], "[\"\"]"],
  ["diffFilePaths", ["diff --git a/a b/b\n+x"], "[\"b\"]"],
  ["diffFilePaths", ["diff --git a/a b/b\r\n+x"], "[\"a/a b/b\\r\"]"],
  ["diffFilePaths", ["diff --git a/a b/b\u2028z"], "[\"a/a b/b\u2028z\"]"],
  ["diffFilePaths", ["diff --git a/a  b/b"], "[\"b\"]"],
  ["diffFilePaths", ["diff --git a/a b/b b/c"], "[\"b b/c\"]"],
  ["diffFilePaths", ["diff --git a/ b/x"], "[\"a/ b/x\"]"],
  ["diffFilePaths", ["diff --git a/x b/ y"], "[\" y\"]"],
  ["diffFilePaths", ["diff --git a/x b/y\ndiff --git a/x b/y"], "[\"y\",\"y\"]"],
  ["diffFilePaths", ["a\ndiff --git a/한 b/글\n\ndiff --git a/e b/e"], "[\"\",\"글\",\"e\"]"],
  ["extractDiffReferencedNames", ["+import { a } from './foo/bar.ts';"], "[\"bar\"]"],
  ["extractDiffReferencedNames", ["+import x from \"../baz.tsx\";"], "[\"baz\"]"],
  ["extractDiffReferencedNames", ["+const a = require('./q.js')"], "[\"q\"]"],
  ["extractDiffReferencedNames", ["+const b = require( './r' )"], "[\"r\"]"],
  ["extractDiffReferencedNames", ["+import y from './dir/'"], "[]"],
  ["extractDiffReferencedNames", ["+import z from '.'"], "[]"],
  ["extractDiffReferencedNames", ["+import w from './a.test.ts'"], "[\"a.test\"]"],
  ["extractDiffReferencedNames", ["+import v from './x.d.ts.jsx'"], "[\"x.d.ts\"]"],
  ["extractDiffReferencedNames", ["+import q from 'pkg'"], "[]"],
  ["extractDiffReferencedNames", ["+import q from '/abs/x'"], "[]"],
  ["extractDiffReferencedNames", ["+import q from './a.json'"], "[\"a.json\"]"],
  ["extractDiffReferencedNames", ["+from './a.tsx' x"], "[\"a\"]"],
  ["extractDiffReferencedNames", ["+x.from('./a')"], "[]"],
  ["extractDiffReferencedNames", ["+fromm './a'"], "[]"],
  ["extractDiffReferencedNames", ["+const f = from  \"./gap\""], "[\"gap\"]"],
  ["extractDiffReferencedNames", ["+require('./nope'"], "[]"],
  ["extractDiffReferencedNames", ["+require ('./nope')"], "[]"],
  ["extractDiffReferencedNames", ["+from pkg.mod import Name"], "[\"Name\"]"],
  ["extractDiffReferencedNames", ["+from . import thing"], "[\"thing\"]"],
  ["extractDiffReferencedNames", ["+from a.b import c, d"], "[\"c\"]"],
  ["extractDiffReferencedNames", ["+  from deep.mod import Inner"], "[\"Inner\"]"],
  ["extractDiffReferencedNames", ["+import os"], "[\"os\"]"],
  ["extractDiffReferencedNames", ["+import static org.junit.Assert.*;"], "[\"Assert\"]"],
  ["extractDiffReferencedNames", ["+import static org.junit.Assert.assertEquals;"], "[\"assertEquals\",\"Assert\"]"],
  ["extractDiffReferencedNames", ["+import java.util.List;"], "[\"List\"]"],
  ["extractDiffReferencedNames", ["+import java.util.*;"], "[]"],
  ["extractDiffReferencedNames", ["+import a.b.c.D"], "[\"D\"]"],
  ["extractDiffReferencedNames", ["+import static"], "[\"static\"]"],
  ["extractDiffReferencedNames", ["+import static  Foo"], "[\"Foo\"]"],
  ["extractDiffReferencedNames", ["+import  Foo  ;"], "[\"Foo\"]"],
  ["extractDiffReferencedNames", ["+\timport\tcom.x.Y;"], "[\"Y\"]"],
  ["extractDiffReferencedNames", ["+import a.b.c ; x"], "[]"],
  ["extractDiffReferencedNames", ["+import a.b.c;;"], "[]"],
  ["extractDiffReferencedNames", ["+import com.example.OrderService"], "[\"OrderService\"]"],
  ["extractDiffReferencedNames", ["+import . ;"], "[]"],
  ["extractDiffReferencedNames", ["+class SeedLoader extends BaseLoader {"], "[\"SeedLoader\",\"BaseLoader\"]"],
  ["extractDiffReferencedNames", ["+const url = new URL(HTTP_BASE)"], "[]"],
  ["extractDiffReferencedNames", ["+AbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopq"], "[]"],
  ["extractDiffReferencedNames", ["+Abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrs xxxxx"], "[]"],
  ["extractDiffReferencedNames", ["+Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], "[\"Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"]"],
  ["extractDiffReferencedNames", ["+Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], "[]"],
  ["extractDiffReferencedNames", ["+Abb"], "[\"Abb\"]"],
  ["extractDiffReferencedNames", ["+Ab"], "[]"],
  ["extractDiffReferencedNames", ["+Ab"], "[]"],
  ["extractDiffReferencedNames", ["+ABC"], "[]"],
  ["extractDiffReferencedNames", ["+AbC"], "[\"AbC\"]"],
  ["extractDiffReferencedNames", ["+A1B"], "[]"],
  ["extractDiffReferencedNames", ["+A12"], "[]"],
  ["extractDiffReferencedNames", ["+Abc_Def"], "[]"],
  ["extractDiffReferencedNames", ["+abcDef"], "[]"],
  ["extractDiffReferencedNames", ["+xAbc"], "[]"],
  ["extractDiffReferencedNames", ["+Abc9"], "[\"Abc9\"]"],
  ["extractDiffReferencedNames", ["+9Abc"], "[]"],
  ["extractDiffReferencedNames", ["+한Abc"], "[\"Abc\"]"],
  ["extractDiffReferencedNames", ["+Abc한"], "[\"Abc\"]"],
  ["extractDiffReferencedNames", ["+Abc😀Def"], "[\"Abc\",\"Def\"]"],
  ["extractDiffReferencedNames", ["+new MyClass(OrderService.of(Customer))"], "[\"MyClass\",\"OrderService\",\"Customer\"]"],
  ["extractDiffReferencedNames", ["+PostgreSQL SQL JSON API"], "[\"PostgreSQL\"]"],
  ["extractDiffReferencedNames", ["+URL"], "[]"],
  ["extractDiffReferencedNames", ["+Url"], "[\"Url\"]"],
  ["extractDiffReferencedNames", ["+HTTPServer"], "[\"HTTPServer\"]"],
  ["extractDiffReferencedNames", ["+x_Abc"], "[]"],
  ["extractDiffReferencedNames", ["+Abc-Def"], "[\"Abc\",\"Def\"]"],
  ["extractDiffReferencedNames", ["+Abc.Def"], "[\"Abc\",\"Def\"]"],
  ["extractDiffReferencedNames", ["++++ not a header"], "[]"],
  ["extractDiffReferencedNames", ["+++ x"], "[]"],
  ["extractDiffReferencedNames", ["+"], "[]"],
  ["extractDiffReferencedNames", ["++"], "[]"],
  ["extractDiffReferencedNames", ["+\r"], "[]"],
  ["extractDiffReferencedNames", ["+Foo\rBar"], "[\"Foo\",\"Bar\"]"],
  ["extractDiffReferencedNames", ["+Foo\u2028Bar"], "[\"Foo\",\"Bar\"]"],
  ["extractDiffReferencedNames", ["+++ b/Skip.ts\n+Keep\n-Removed\n context Ctx\n+++Foo\n++Bar\n+Baz"], "[\"Keep\",\"Bar\",\"Baz\"]"],
  ["extractDiffReferencedNames", ["+import { a } from './Shared';\n+import { b } from './Shared';\n+Shared Shared"], "[\"Shared\"]"],
  ["extractDiffReferencedNames", ["+from './m.ts' require('./n.tsx') Other\n+from pkg.a import Z"], "[\"m\",\"Other\",\"Z\"]"],
  ["extractDiffReferencedNames", [""], "[]"],
  ["extractDiffReferencedNames", ["no plus lines Here Alpha"], "[]"],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],70], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],69], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],93], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],94], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],95], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],127], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],128], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\\n\\n--- b.ts ---\\nyyyyyyyyyyyyyyyyyyyy\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],129], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\\n\\n--- b.ts ---\\nyyyyyyyyyyyyyyyyyyyy\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],0], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],8000], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\\n\\n--- b.ts ---\\nyyyyyyyyyyyyyyyyyyyy\\n\\n--- c.ts ---\\nz\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],"__NaN__"], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\\n\\n--- b.ts ---\\nyyyyyyyyyyyyyyyyyyyy\\n\\n--- c.ts ---\\nz\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],-1], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"a.ts","excerpt":"xxxxxxxxxx"},{"path":"b.ts","excerpt":"yyyyyyyyyyyyyyyyyyyy"},{"path":"c.ts","excerpt":"z"}],"__Infinity__"], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- a.ts ---\\nxxxxxxxxxx\\n\\n--- b.ts ---\\nyyyyyyyyyyyyyyyyyyyy\\n\\n--- c.ts ---\\nz\""],
  ["buildPrReviewExternalContext", [[],8000], "\"\""],
  ["buildPrReviewExternalContext", [[],0], "\"\""],
  ["buildPrReviewExternalContext", [[{"path":"한글🙂.ts","excerpt":"🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"}],100], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"한글🙂.ts","excerpt":"🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"}],106], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\""],
  ["buildPrReviewExternalContext", [[{"path":"p","excerpt":""},{"path":"q","excerpt":"\n\n"}],8000], "\"[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \\\"없다\\\"고 단정하지 마세요]\\n\\n--- p ---\\n\\n\\n--- q ---\\n\\n\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"d","requests":[],"round":1}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n(기록 없음)\\n\\nDiff (base...head):\\n```diff\\nd\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"d","requests":["첫째","둘째\n줄"],"round":2,"omittedFiles":["a.ts","b.ts"],"requirementsContext":" R1 ","externalContext":"\n ext \n","resolvedContext":"\u3000res\u3000"}], "\"Review round 2.\\n\\nUser's original requests for this session, in order:\\n1. 첫째\\n2. 둘째\\n줄\\n\\n(크기 제한으로 다음 파일은 diff에서 생략했습니다: a.ts, b.ts)\\n\\nR1\\n\\nres\\n\\nDiff (base...head):\\n```diff\\nd\\n```\\n\\next\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"","requests":[""],"round":0,"omittedFiles":[],"requirementsContext":"","externalContext":"  ","resolvedContext":"\n"}], "\"Review round 0.\\n\\nUser's original requests for this session, in order:\\n1. \\n\\nDiff (base...head):\\n```diff\\n\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["r"],"round":1.5}], "\"Review round 1.5.\\n\\nUser's original requests for this session, in order:\\n1. r\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["r"],"round":"__NaN__"}], "\"Review round NaN.\\n\\nUser's original requests for this session, in order:\\n1. r\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["r"],"round":1e+21}], "\"Review round 1e+21.\\n\\nUser's original requests for this session, in order:\\n1. r\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["r"],"round":1e-07}], "\"Review round 1e-7.\\n\\nUser's original requests for this session, in order:\\n1. r\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["r"],"round":0}], "\"Review round 0.\\n\\nUser's original requests for this session, in order:\\n1. r\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"```\nx\n```","requests":["a"],"round":1,"externalContext":"only external"}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n1. a\\n\\nDiff (base...head):\\n```diff\\n```\\nx\\n```\\n```\\n\\nonly external\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["a"],"round":1,"requirementsContext":"req","resolvedContext":"res"}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n1. a\\n\\nreq\\n\\nres\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["a"],"round":1,"omittedFiles":["only"]}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n1. a\\n\\n(크기 제한으로 다음 파일은 diff에서 생략했습니다: only)\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["a"],"round":1,"requirementsContext":"\ufeff\u00a0trim me\u2028"}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n1. a\\n\\ntrim me\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["buildPrReviewUserPrompt", [{"diff":"x","requests":["a"],"round":1,"requirementsContext":"\u0085nel\u0085"}], "\"Review round 1.\\n\\nUser's original requests for this session, in order:\\n1. a\\n\\n\u0085nel\u0085\\n\\nDiff (base...head):\\n```diff\\nx\\n```\\n\""],
  ["prReviewMarker", [1], "\"<!-- b-studio-review round=1 -->\""],
  ["prReviewMarker", [2], "\"<!-- b-studio-review round=2 -->\""],
  ["prReviewMarker", [10], "\"<!-- b-studio-review round=10 -->\""],
  ["prReviewMarker", [0], "\"<!-- b-studio-review round=0 -->\""],
  ["prReviewMarker", [1.5], "\"<!-- b-studio-review round=1.5 -->\""],
  ["prReviewMarker", ["__NaN__"], "\"<!-- b-studio-review round=NaN -->\""],
  ["prReviewMarker", ["__Infinity__"], "\"<!-- b-studio-review round=Infinity -->\""],
  ["prReviewMarker", [-1], "\"<!-- b-studio-review round=-1 -->\""],
  ["prReviewMarker", [1e+21], "\"<!-- b-studio-review round=1e+21 -->\""],
  ["prReviewMarker", [123456789012345680000], "\"<!-- b-studio-review round=123456789012345680000 -->\""],
  ["prReviewMarker", [1e-07], "\"<!-- b-studio-review round=1e-7 -->\""],
  ["prReviewMarker", [0.1], "\"<!-- b-studio-review round=0.1 -->\""],
  ["prReviewMarker", [0], "\"<!-- b-studio-review round=0 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":3,"maxRounds":3,"findings":[],"outcome":"cap"}], "\"## 🤖 AI 리뷰 — 라운드 3/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n라운드 상한(3)에 도달해 남은 지적은 사람이 검토합니다.\\n\\n<!-- b-studio-review round=3 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"blocker","file":"a.ts","line":12,"title":"제목","detail":"설명","suggestion":"제안"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 1 · 주요 0 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 차단 | `a.ts:12` | 제목 | 설명 (제안: 제안) |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":2,"maxRounds":2,"findings":[{"severity":"major","file":"a.ts","line":0,"title":"제목","detail":"설명"},{"severity":"minor","file":"a.ts","line":7,"title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명","suggestion":""}],"outcome":"cap"}], "\"## 🤖 AI 리뷰 — 라운드 2/2\\n\\n차단 0 · 주요 1 · 경미 1 · 사소 1\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `a.ts` | 제목 | 설명 |\\n| 경미 | `a.ts:7` | 제목 | 설명 |\\n| 사소 | `a.ts` | 제목 | 설명 |\\n\\n라운드 상한(2)에 도달해 남은 지적은 사람이 검토합니다.\\n\\n<!-- b-studio-review round=2 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"},{"severity":"major","file":"a.ts","title":"제목","detail":"설명"},{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}],"outcome":"pass"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 1 · 주요 1 · 경미 1 · 사소 2\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 차단 | `a.ts` | 제목 | 설명 |\\n| 주요 | `a.ts` | 제목 | 설명 |\\n| 경미 | `a.ts` | 제목 | 설명 |\\n| 사소 | `a.ts` | 제목 | 설명 |\\n| 사소 | `a.ts` | 제목 | 설명 |\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"urgent","file":"a.ts","title":"제목","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| undefined | `a.ts` | 제목 | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"blocker","file":"a.ts","title":"제목","detail":"설명"}],"outcome":"weird"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 1 · 주요 0 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 차단 | `a.ts` | 제목 | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 1\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 사소 | `a.ts` | 제목 | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"abcdef1","head":"abcdef1234"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n커밋 범위: `abcdef1`..`abcdef1`\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"abcdef12","head":"abcdef1234"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n커밋 범위: `abcdef1`..`abcdef1`\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"abcdef","head":"abcdef1234567"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n커밋 범위: `abcdef`..`abcdef1`\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"","head":"abc"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"abc","head":""}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n커밋 범위: `abc`..``\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"since":"1234567890","head":"fedcba9876"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n커밋 범위: `1234567`..`fedcba9`\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","commitRange":{"head":"abcdefghij"}}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","omittedFiles":["a.ts","b.ts"]}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n(참고: 크기 제한으로 다음 파일은 생략하고 리뷰했습니다: a.ts, b.ts)\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass","omittedFiles":[]}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt","detail":"d"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt | d |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"t","detail":"ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","suggestion":"s"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | t | ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt","detail":"d"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt | d |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"t","detail":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","suggestion":"s"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | t | dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt","detail":"d"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt | d |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"t","detail":"ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","suggestion":"s"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | t | dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt","detail":"d"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt | d |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"t","detail":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","suggestion":"s"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | t | dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가","title":"t","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가` | t | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가","title":"t","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가` | t | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가","title":"t","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가` | t | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가","title":"t","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가` | t | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"a|b|c","detail":"x\ny\r\nz\rw\u2028v|u"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | a\\\\|b\\\\|c | x y z\\rw\u2028v\\\\|u |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"f","title":"a\r\r\nb\n\nc","detail":"|"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `f` | a\\r b  c | \\\\| |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"p|q","line":3,"title":"t","detail":"d","suggestion":"s|t\nu"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `p\\\\|q:3` | t | d (제안: s\\\\|t u) |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"minor","file":"f","line":1.5,"title":"제목","detail":"설명"},{"severity":"minor","file":"f","line":1e+21,"title":"제목","detail":"설명"},{"severity":"minor","file":"f","line":-2,"title":"제목","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 3 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 경미 | `f:1.5` | 제목 | 설명 |\\n| 경미 | `f:1e+21` | 제목 | 설명 |\\n| 경미 | `f:-2` | 제목 | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1.5,"maxRounds":2.5,"findings":[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1.5/2.5\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `a.ts` | 제목 | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1.5 -->\""],
  ["buildPrReviewComment", [{"round":"__NaN__","maxRounds":"__Infinity__","findings":[{"severity":"major","file":"a.ts","title":"제목","detail":"설명"}],"outcome":"cap"}], "\"## 🤖 AI 리뷰 — 라운드 NaN/Infinity\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `a.ts` | 제목 | 설명 |\\n\\n라운드 상한(Infinity)에 도달해 남은 지적은 사람이 검토합니다.\\n\\n<!-- b-studio-review round=NaN -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[{"severity":"major","file":"a.ts","title":"🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂x🙂","detail":"설명"}],"outcome":"fix"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 1 · 경미 0 · 사소 0\\n\\n| 심각도 | 위치 | 제목 | 설명 |\\n|---|---|---|---|\\n| 주요 | `a.ts` | 🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂x� | 설명 |\\n\\n차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":1,"maxRounds":3,"findings":[],"outcome":"pass"}], "\"## 🤖 AI 리뷰 — 라운드 1/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=1 -->\""],
  ["buildPrReviewComment", [{"round":2,"maxRounds":3,"findings":[],"outcome":"pass"}], "\"## 🤖 AI 리뷰 — 라운드 2/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=2 -->\""],
  ["buildPrReviewComment", [{"round":3,"maxRounds":3,"findings":[],"outcome":"pass"}], "\"## 🤖 AI 리뷰 — 라운드 3/3\\n\\n차단 0 · 주요 0 · 경미 0 · 사소 0\\n\\n지적할 내용이 없습니다.\\n\\n차단·주요 지적이 없어 사람 검토를 기다립니다.\\n\\n<!-- b-studio-review round=3 -->\""],
  ["buildPrReviewResolvedContext", [[]], "\"\""],
  ["buildPrReviewResolvedContext", [[{"severity":"blocker","file":"a.ts","line":3,"title":"t","reason":"r"}]], "\"[이미 사람이 확인한 지적 — 새 근거 없이 되풀이하지 마세요]\\n- [차단] `a.ts:3` — t: 사람이 오탐으로 닫았습니다(r)\""],
  ["buildPrReviewResolvedContext", [[{"severity":"major","file":"a.ts","title":"t","reason":"r"},{"severity":"minor","file":"b.ts","line":0,"title":"u","reason":"s|t"},{"severity":"nit","file":"c","line":7,"title":"v","reason":""}]], "\"[이미 사람이 확인한 지적 — 새 근거 없이 되풀이하지 마세요]\\n- [주요] `a.ts` — t: 사람이 오탐으로 닫았습니다(r)\\n- [경미] `b.ts` — u: 사람이 오탐으로 닫았습니다(s|t)\\n- [사소] `c:7` — v: 사람이 오탐으로 닫았습니다()\""],
  ["buildPrReviewResolvedContext", [[{"severity":"zzz","file":"a.ts","title":"t","reason":"r"}]], "\"[이미 사람이 확인한 지적 — 새 근거 없이 되풀이하지 마세요]\\n- [undefined] `a.ts` — t: 사람이 오탐으로 닫았습니다(r)\""],
  ["buildReviewResolutionComment", [{"severity":"blocker","file":"a.ts","line":12,"title":"제목","detail":"설명","suggestion":"제안"},"이유"], "\"## 🙋 사람이 리뷰 지적을 확인했습니다\\n\\n> [차단] `a.ts:12` — 제목\\n\\n오탐으로 닫습니다: 이유\""],
  ["buildReviewResolutionComment", [{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"},""], "\"## 🙋 사람이 리뷰 지적을 확인했습니다\\n\\n> [사소] `a.ts` — 제목\\n\\n오탐으로 닫습니다: \""],
  ["buildReviewResolutionComment", [{"severity":"minor","file":"a.ts","line":0,"title":"제목","detail":"설명"},"r\nr"], "\"## 🙋 사람이 리뷰 지적을 확인했습니다\\n\\n> [경미] `a.ts` — 제목\\n\\n오탐으로 닫습니다: r\\nr\""],
  ["buildReviewResolutionComment", [{"severity":"major","file":"a.ts","line":1e+21,"title":"제목","detail":"설명"},"r"], "\"## 🙋 사람이 리뷰 지적을 확인했습니다\\n\\n> [주요] `a.ts:1e+21` — 제목\\n\\n오탐으로 닫습니다: r\""],
  ["buildReviewResolutionComment", [{"severity":"x","file":"a.ts","title":"제목","detail":"설명"},"r"], "\"## 🙋 사람이 리뷰 지적을 확인했습니다\\n\\n> [undefined] `a.ts` — 제목\\n\\n오탐으로 닫습니다: r\""],
  ["buildPrReviewFixRequest", [[]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n\""],
  ["buildPrReviewFixRequest", [[{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n\""],
  ["buildPrReviewFixRequest", [[{"severity":"minor","file":"a.ts","title":"제목","detail":"설명"},{"severity":"nit","file":"a.ts","title":"제목","detail":"설명"}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n\""],
  ["buildPrReviewFixRequest", [[{"severity":"blocker","file":"a.ts","line":5,"title":"굵은 **제목**","detail":"설명","suggestion":"제안"}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n1. [차단] `a.ts:5` — **굵은 **제목****: 설명 제안: 제안\""],
  ["buildPrReviewFixRequest", [[{"severity":"major","file":"a.ts","title":"첫째","detail":"d1"},{"severity":"nit","file":"b.ts","title":"건너뜀","detail":"d"},{"severity":"blocker","file":"c.ts","line":9,"title":"셋째","detail":"d3","suggestion":"s3"}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n1. [주요] `a.ts` — **첫째**: d1\\n2. [차단] `c.ts:9` — **셋째**: d3 제안: s3\""],
  ["buildPrReviewFixRequest", [[{"severity":"major","file":"a.ts","line":0,"title":"제목","detail":"설명","suggestion":""}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n1. [주요] `a.ts` — **제목**: 설명\""],
  ["buildPrReviewFixRequest", [[{"severity":"urgent","file":"a.ts","title":"제목","detail":"설명"}]], "\"[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\\n\\n\""],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] x **a** y **b**"], "[\"a\",\"b\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰]"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] ****"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] ** **"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **\u00a0t\u00a0**"], "[\"t\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] ***a***"], "[\"*a\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **a**b**c**d**"], "[\"a\",\"c\"]"],
  ["extractPrReviewFixTitles", ["x [b-studio AI 리뷰] **a**"], "undefined"],
  ["extractPrReviewFixTitles", [""], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰]\n**a**\n**b\n**c**"], "[\"a\",\"c\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **a\u2028b** **c\rd** **e**"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **한글🙂**"], "[\"한글🙂\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **a** **a**"], "[\"a\",\"a\"]"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰] **"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰 **a**"], "undefined"],
  ["extractPrReviewFixTitles", ["[B-studio AI 리뷰] **a**"], "undefined"],
  ["extractPrReviewFixTitles", ["[b-studio AI 리뷰]**x**"], "[\"x\"]"],
  ["diffFilePaths", ["diff --gitx a/p b/p\n+x"], "[\"\"]"],
  ["truncateDiff", ["diff --gitx a/p b/p\n+x\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n",20], "{\"diff\":\"diff --gitx a/p b/p\\n\\n\\n<!-- 크기 제한(20자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["diffFilePaths", ["diff --git\n+x"], "[\"\"]"],
  ["truncateDiff", ["diff --git\n+x\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n",20], "{\"diff\":\"diff --git\\n+x\\n+w\\n+w\\n\\n\\n<!-- 크기 제한(20자)으로 diff 뒷부분을 생략했습니다 -->\\n\",\"truncated\":true,\"omittedFiles\":[]}"],
  ["diffFilePaths", ["x\ndiff --gitx a/p b/p\n+y\ndiff --git a/q b/q\n+z"], "[\"\",\"q\"]"],
  ["truncateDiff", ["x\ndiff --gitx a/p b/p\n+y\ndiff --git a/q b/q\n+z\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n+w\n",20], "{\"diff\":\"diff --git a/ b/\\n<!-- 파일이 커서 생략했습니다 (24자) -->\\ndiff --git a/q b/q\\n<!-- 파일이 커서 생략했습니다 (112자) -->\",\"truncated\":true,\"omittedFiles\":[\"q\",\"\"]}"],
];

const revive = (x: unknown): unknown => {
  if (x === '__NaN__') return NaN;
  if (x === '__Infinity__') return Infinity;
  if (x === '__-Infinity__') return -Infinity;
  if (x === '__undefined__') return undefined;
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, revive(v)]));
  return x;
};
/** `String.prototype.toWellFormed`(짝 없는 서로게이트를 U+FFFD로) */
const toWellFormed = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
/** 결과를 글자로. 짝 없는 서로게이트는 U+FFFD로 바꾼다(napi 경계 규칙, 의도한 차이 1) */
const show = (value: unknown): string => (value === undefined ? 'undefined' : JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? toWellFormed(item) : item)));
function run(fn: (...args: any[]) => unknown, args: unknown[]): string {
  try {
    return show(fn(...(revive(args) as unknown[])));
  } catch {
    return 'throws';
  }
}

const impl: Record<string, (...args: any[]) => unknown> = {
  isBlockingFinding,
  hasBlockingFindings,
  severityCounts,
  nextPrReviewStep,
  truncateDiff,
  diffFilePaths,
  extractDiffReferencedNames,
  buildPrReviewExternalContext,
  buildPrReviewUserPrompt,
  prReviewMarker,
  buildPrReviewComment,
  buildPrReviewResolvedContext,
  buildReviewResolutionComment,
  buildPrReviewFixRequest,
  extractPrReviewFixTitles,
};

describe('pr-review 벡터(옛 TS가 낸 값)', () => {
  it('벡터 개수', () => {
    expect(VECTORS.length).toBe(339);
  });

  for (const name of Object.keys(impl)) {
    it(`${name}: 모든 벡터가 옛 TS가 낸 값과 같다`, () => {
      const mine = VECTORS.filter(([fn]) => fn === name);
      expect(mine.length).toBeGreaterThan(0);
      const failures = mine.map(([, args, expected], index) => ({ index, args, expected, actual: run(impl[name]!, args) })).filter((r) => r.actual !== r.expected);
      expect(failures).toEqual([]);
    });
  }
});

describe('pr-review 의도한 차이(옛 TS와 다른 곳)', () => {
  it('서로게이트 쌍을 가르는 자르기는 짝 없는 절반 대신 U+FFFD가 된다', () => {
    // 구분 없는 diff를 5단위에서 자르면 🙂 두 개 반
    expect(truncateDiff('\u{1F642}'.repeat(10), 5).diff.startsWith('\u{1F642}\u{1F642}\uFFFD\n\n<!--')).toBe(true);
    // 표 칸 500단위 끝이 쌍 가운데
    const comment = buildPrReviewComment({ round: 1, maxRounds: 3, outcome: 'fix', findings: [{ severity: 'major', file: 'f', title: 'x' + '\u{1F642}'.repeat(300), detail: 'd' }] });
    expect(comment).toContain(`x${'\u{1F642}'.repeat(249)}\uFFFD |`);
    // 커밋 범위 7자 끝이 쌍 가운데
    const ranged = buildPrReviewComment({ round: 1, maxRounds: 3, outcome: 'pass', findings: [], commitRange: { since: 'abcdef\u{1F642}', head: 'h' } });
    expect(ranged).toContain('`abcdef\uFFFD`..`h`');
  });

  it('입력의 짝 없는 서로게이트는 U+FFFD로 읽는다', () => {
    expect(buildPrReviewUserPrompt({ diff: 'a\uD83Db', requests: [], round: 1 })).toContain('a\uFFFDb');
    expect(diffFilePaths('diff --git a/x\uDE00 b/y\uDE00\n+z')).toEqual(['y\uFFFD']);
  });

  it('severityCounts는 모르는 심각도를 세지 않는다(옛 TS는 그 이름의 키를 NaN으로 만들었다)', () => {
    const odd = { severity: 'urgent', file: 'a', title: 't', detail: 'd' } as never;
    expect(severityCounts([odd, { severity: 'nit', file: 'a', title: 't', detail: 'd' }])).toEqual({ blocker: 0, major: 0, minor: 0, nit: 1 });
    expect(Object.keys(severityCounts([odd]))).toEqual(['blocker', 'major', 'minor', 'nit']);
  });

  it('truncateDiff의 상한은 구분 없는 diff를 자를 때 노트에 쉼표로 적으므로 정수여야 한다(옛 TS는 소수·NaN도 글자로 찍었다)', () => {
    const plain = 'x'.repeat(50);
    expect(() => truncateDiff(plain, 10.5)).toThrow();
    expect(() => truncateDiff(plain, Number.NaN)).toThrow();
    // 구분이 있는 diff, 상한 이내인 diff는 소수·NaN도 견줌만 하므로 그대로 돌아간다
    expect(truncateDiff(plain, 100.5)).toEqual({ diff: plain, truncated: false, omittedFiles: [] });
    expect(truncateDiff(`diff --git a/a b/a\n+${'y'.repeat(60)}`, 10.5).omittedFiles).toEqual(['a']);
  });

  it('쉼표 묶음은 로케일과 상관없이 천 단위 쉼표다', () => {
    expect(truncateDiff('x'.repeat(70_000), 60_000).diff).toContain('(60,000자)');
    expect(truncateDiff('diff --git a/a b/a\n+' + 'y'.repeat(2_000), 100).diff).toContain('(2,020자)');
  });

  it('고침 요청 표시는 Rust가 정한 값 하나를 읽는다', () => {
    expect(PR_REVIEW_FIX_MARKER).toBe('[b-studio AI 리뷰]');
    expect(buildPrReviewFixRequest([{ severity: 'major', file: 'a', title: 'T', detail: 'd' }]).startsWith(`${PR_REVIEW_FIX_MARKER} `)).toBe(true);
  });

  it('지적에 null이 끼거나 문자열이어야 하는 칸이 문자열이 아니면 던진다(옛 TS도 TypeError를 던졌다)', () => {
    expect(() => buildPrReviewComment({ round: 1, maxRounds: 3, outcome: 'fix', findings: [null as never] })).toThrow();
    expect(() => buildPrReviewComment({ round: 1, maxRounds: 3, outcome: 'fix', findings: [{ severity: 'major', file: 'a', title: 5 as never, detail: 'd' }] })).toThrow();
    expect(() => buildPrReviewResolvedContext(null as never)).toThrow();
  });
});

import { createHash } from 'node:crypto';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { buildContractSystem, buildContractUser } from './lane-contracts';
import { appendPlanToRequest, buildPlanBriefSystem, planWordLimit, shouldPlanBrief } from './plan-brief';
import type { TaskLane } from './task-plan';

/**
 * plan-brief·lane-contracts의 벡터 시험(ADR-191 3m). 기대값은 옮기기 전 TS가 낸 값이다(JSON 글자). 1000자가 넘는 값은 JSON 글자의 sha256이다
 * (시스템 프롬프트 전문·3000자 경계). 입력의 `{"$rep": [[글자, 횟수]]}`는 그 글자를 횟수만큼 이은 문자열이다. 경계는 800토큰(ASCII 3200자·한글 1200자),
 * 12줄(11·12·13), 문장 수 2·3(구분자 22종), 계획 상한 3000(UTF-16, ±1)을 밟고, 복잡 단어마다 거의 같은 거부 입력(접두·덧붙임·대소문자·다른 구분자)을 넣었다.
 * 옛 TS(plan-brief.ts·lane-contracts.ts)에 돌리면 의도한 차이(맨 아래 describe)만 실패한다.
 */
type Vector = [fn: string, args: unknown[], expected: string];
const VECTORS: Vector[] = [
  ["shouldPlanBrief", [""], "false"],
  ["shouldPlanBrief", [" "], "false"],
  ["shouldPlanBrief", ["\n"], "false"],
  ["shouldPlanBrief", ["﻿"], "false"],
  ["shouldPlanBrief", [""], "false"],
  ["shouldPlanBrief", ["\t\n "], "false"],
  ["shouldPlanBrief", ["버튼 색을 파란색으로 바꿔줘"], "false"],
  ["shouldPlanBrief", ["결제 서비스를 마이그레이션하면서 동시성 문제도 함께 리팩터링해줘"], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3199]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3200]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3201]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3196]]}], "false"],
  ["shouldPlanBrief", [{"$rep":[["a",3197]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3204]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["가",1199]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["가",1200]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["가",1201]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["가",1198]]}], "false"],
  ["shouldPlanBrief", [{"$rep":[["a",1600],["가",600]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",1596],["가",601]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",1600],["가",599]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[[" ",1],["a",3200],[" ",1]]}], "true"],
  ["shouldPlanBrief", ["[object Object]    "], "false"],
  ["shouldPlanBrief", [{"$rep":[["a",3199],["",1]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["a",3196],["",1]]}], "true"],
  ["shouldPlanBrief", [{"$rep":[["﻿",1],["a",3196]]}], "false"],
  ["shouldPlanBrief", [{"$rep":[["a",3196],["﻿",1]]}], "false"],
  ["shouldPlanBrief", [{"$rep":[["",1],["a",3196]]}], "true"],
  ["shouldPlanBrief", ["a\n\n\n\n\n\n\n\n\n\n\nb"], "false"],
  ["shouldPlanBrief", ["a\n\n\n\n\n\n\n\n\n\n\n\nb"], "true"],
  ["shouldPlanBrief", ["a\n\n\n\n\n\n\n\n\n\n\n\n\nb"], "true"],
  ["shouldPlanBrief", ["\n\n\n\n\n\n\n\n\n\n\n\na"], "false"],
  ["shouldPlanBrief", ["a\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\ra\r"], "false"],
  ["shouldPlanBrief", ["a a a a a a a a a a a a a a a a a a a a "], "false"],
  ["shouldPlanBrief", ["a\na\na\na\na\na\na\na\na\na\na\na\na"], "true"],
  ["shouldPlanBrief", ["a\na\na\na\na\na\na\na\na\na\na\na"], "false"],
  ["shouldPlanBrief", ["아키텍처를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["architecture를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["ARCHITECTURE를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["Architecture를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["archite를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["migration를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["MIGRATION를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["migrat1on를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["마이그레이션를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["distributed를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["distribute를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["분산를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["concurren를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["concurrency를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["concurre를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["동시성를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["security를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["SECURITY를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["보안를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["refactor를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["refactoring를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["refacto를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["리팩터를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["리팩토링를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["multiservice를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["multi-service를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["multi service를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["multi_service를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["multi  service를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["multi\nservice를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["Multi-Service를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["multi를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["멀티를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["성능를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["performance를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["perform를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["incident를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["incidents를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["장애를 고쳐줘"], "true"],
  ["shouldPlanBrief", ["장 애를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["ＳＥＣＵＲＩＴＹ를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["ſecurity를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["İncident를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["KK를 고쳐줘"], "false"],
  ["shouldPlanBrief", ["x 아키텍처아키텍처"], "true"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0 문장1"], "150"],
  ["planWordLimit", ["문장0 문장1 문장2"], "150"],
  ["planWordLimit", ["문장0 문장1 문장2 문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0. 문장1"], "150"],
  ["planWordLimit", ["문장0. 문장1. 문장2"], "400"],
  ["planWordLimit", ["문장0. 문장1. 문장2. 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0! 문장1"], "150"],
  ["planWordLimit", ["문장0! 문장1! 문장2"], "400"],
  ["planWordLimit", ["문장0! 문장1! 문장2! 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0? 문장1"], "150"],
  ["planWordLimit", ["문장0? 문장1? 문장2"], "400"],
  ["planWordLimit", ["문장0? 문장1? 문장2? 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.문장1"], "150"],
  ["planWordLimit", ["문장0.문장1.문장2"], "150"],
  ["planWordLimit", ["문장0.문장1.문장2.문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.x문장1"], "150"],
  ["planWordLimit", ["문장0.x문장1.x문장2"], "150"],
  ["planWordLimit", ["문장0.x문장1.x문장2.x문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.\n문장1"], "150"],
  ["planWordLimit", ["문장0.\n문장1.\n문장2"], "400"],
  ["planWordLimit", ["문장0.\n문장1.\n문장2.\n문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0\n문장1"], "150"],
  ["planWordLimit", ["문장0\n문장1\n문장2"], "400"],
  ["planWordLimit", ["문장0\n문장1\n문장2\n문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0\n\n문장1"], "150"],
  ["planWordLimit", ["문장0\n\n문장1\n\n문장2"], "400"],
  ["planWordLimit", ["문장0\n\n문장1\n\n문장2\n\n문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.  문장1"], "150"],
  ["planWordLimit", ["문장0.  문장1.  문장2"], "400"],
  ["planWordLimit", ["문장0.  문장1.  문장2.  문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0. 문장1"], "150"],
  ["planWordLimit", ["문장0. 문장1. 문장2"], "400"],
  ["planWordLimit", ["문장0. 문장1. 문장2. 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.﻿문장1"], "150"],
  ["planWordLimit", ["문장0.﻿문장1.﻿문장2"], "400"],
  ["planWordLimit", ["문장0.﻿문장1.﻿문장2.﻿문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0. 문장1"], "150"],
  ["planWordLimit", ["문장0. 문장1. 문장2"], "400"],
  ["planWordLimit", ["문장0. 문장1. 문장2. 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.　문장1"], "150"],
  ["planWordLimit", ["문장0.　문장1.　문장2"], "400"],
  ["planWordLimit", ["문장0.　문장1.　문장2.　문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.문장1"], "150"],
  ["planWordLimit", ["문장0.문장1.문장2"], "150"],
  ["planWordLimit", ["문장0.문장1.문장2.문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0\r\n문장1"], "150"],
  ["planWordLimit", ["문장0\r\n문장1\r\n문장2"], "400"],
  ["planWordLimit", ["문장0\r\n문장1\r\n문장2\r\n문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0。 문장1"], "150"],
  ["planWordLimit", ["문장0。 문장1。 문장2"], "150"],
  ["planWordLimit", ["문장0。 문장1。 문장2。 문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0. \n 문장1"], "150"],
  ["planWordLimit", ["문장0. \n 문장1. \n 문장2"], "400"],
  ["planWordLimit", ["문장0. \n 문장1. \n 문장2. \n 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0 . 문장1"], "150"],
  ["planWordLimit", ["문장0 . 문장1 . 문장2"], "400"],
  ["planWordLimit", ["문장0 . 문장1 . 문장2 . 문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0?!문장1"], "150"],
  ["planWordLimit", ["문장0?!문장1?!문장2"], "150"],
  ["planWordLimit", ["문장0?!문장1?!문장2?!문장3"], "150"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0,\n문장1"], "150"],
  ["planWordLimit", ["문장0,\n문장1,\n문장2"], "400"],
  ["planWordLimit", ["문장0,\n문장1,\n문장2,\n문장3"], "400"],
  ["planWordLimit", ["문장0"], "150"],
  ["planWordLimit", ["문장0.\t문장1"], "150"],
  ["planWordLimit", ["문장0.\t문장1.\t문장2"], "400"],
  ["planWordLimit", ["문장0.\t문장1.\t문장2.\t문장3"], "400"],
  ["planWordLimit", [""], "150"],
  ["planWordLimit", [" "], "150"],
  ["planWordLimit", ["\n"], "150"],
  ["planWordLimit", ["."], "150"],
  ["planWordLimit", [". ."], "150"],
  ["planWordLimit", [".."], "150"],
  ["planWordLimit", ["!?"], "150"],
  ["planWordLimit", ["\n\n.\n\n"], "150"],
  ["planWordLimit", ["a. b. "], "150"],
  ["planWordLimit", ["a. b. c"], "400"],
  ["planWordLimit", ["a. b.\n"], "150"],
  ["planWordLimit", ["a. b.\nc"], "400"],
  ["planWordLimit", [" a. b. c "], "400"],
  ["planWordLimit", ["\n\na\n\nb\n\nc\n\n"], "400"],
  ["planWordLimit", ["a\n\n\nb"], "150"],
  ["planWordLimit", ["a.\n\nb"], "150"],
  ["planWordLimit", ["a. \n\n b. c"], "400"],
  ["planWordLimit", ["a.b.c"], "150"],
  ["planWordLimit", ["a . b . c"], "400"],
  ["planWordLimit", ["a.  b.  c"], "400"],
  ["planWordLimit", ["a. b. c"], "400"],
  ["planWordLimit", ["a.﻿b.﻿c"], "400"],
  ["planWordLimit", ["a.b.c"], "150"],
  ["planWordLimit", ["a。b。c"], "150"],
  ["planWordLimit", ["a. b\rc"], "150"],
  ["planWordLimit", ["a b c"], "150"],
  ["planWordLimit", ["a? b? c"], "400"],
  ["planWordLimit", ["a!\tb!\tc"], "400"],
  ["planWordLimit", ["버튼 색을 파란색으로 바꿔줘"], "150"],
  ["planWordLimit", ["a\n \nb"], "150"],
  ["planWordLimit", ["a\n \nb"], "150"],
  ["planWordLimit", ["a\n﻿\nb"], "150"],
  ["planWordLimit", ["a\n\nb"], "400"],
  ["planWordLimit", ["a\n　\nb"], "150"],
  ["planWordLimit", ["a\n\t\nb"], "150"],
  ["planWordLimit", ["a\n\r\nb"], "150"],
  ["planWordLimit", ["a\n \nb"], "150"],
  ["planWordLimit", ["a\n \t \nb"], "150"],
  ["planWordLimit", ["a, b, c"], "150"],
  ["planWordLimit", ["a, b, c"], "150"],
  ["planWordLimit", ["a; b; c"], "150"],
  ["planWordLimit", ["a: b: c"], "150"],
  ["planWordLimit", ["a… b… c"], "150"],
  ["planWordLimit", ["a。 b。 c"], "150"],
  ["planWordLimit", ["a) b) c"], "150"],
  ["planWordLimit", ["a.b. c. d"], "400"],
  ["planWordLimit", ["a　b.　c.　d"], "400"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]},"버튼 색을 바꿔줘"], "sha256:c3731f895a484fb37b6cb1895529489db0e6929b3ed7a0c843c4995b08d4c386"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[]},"버튼 색을 바꿔줘"], "sha256:91abd86db9d25140b4adb03dd202d9ba787f7554fe7f3070530664e81b06d1a8"],
  ["buildPlanBriefSystem", [{"spec":{"name":""},"managed":[["api",{"template":"spring-boot","path":"services/api"}],["web",{"template":"nextjs","path":"web"}]]},"버튼 색을 바꿔줘"], "sha256:0a704b66e0885b1b7ad208b90569977479c912ccf9f05ff6888714b1eff1c11c"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{}]]},"버튼 색을 바꿔줘"], "sha256:1a1cfe0d921c0d9b6a018ab5e2751bafd1ca50c02c8b3f6a1db28f1b833b238a"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"template":"nextjs"}]]},"버튼 색을 바꿔줘"], "sha256:d4bedaabd5bdc88fd40324f6d06c4783a85b90c25f686de15f52263d8745802f"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"path":"web"}]]},"버튼 색을 바꿔줘"], "sha256:8462ef05be19342dcd01f4e524d17cb801103d690ac40463f715ff97967e83e9"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"template":"","path":""}]]},"버튼 색을 바꿔줘"], "sha256:0eb277a7a850c03ba32d69da9551e5fd1c28f07e3d74b029da6907f4bf788c27"],
  ["buildPlanBriefSystem", [{"spec":{"name":"a\"b ${x}\n한글😀"},"managed":[["a\"b",{"template":"${t}","path":"a\nb"}]]},"버튼 색을 바꿔줘"], "sha256:e5b6e039bddfc633f054b4c6371e3f6fc3e7c6e469dffc45c181005c63bb8d39"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]},"a. b. c"], "sha256:b481f4456f4184e29b45a1d6cdd229ecfa006d20d47905e9bc54d800be428c50"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[]},"a. b. c"], "sha256:859b8368e003e4f3d0e2c696fd017450adc6288be34181adba5c39ac57a90d38"],
  ["buildPlanBriefSystem", [{"spec":{"name":""},"managed":[["api",{"template":"spring-boot","path":"services/api"}],["web",{"template":"nextjs","path":"web"}]]},"a. b. c"], "sha256:2ba7605ff21f59e5df3dcd9d5dd1273afa3f117b9302831c33ce67d4fa6b8cab"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{}]]},"a. b. c"], "sha256:5906ea237109d43ba56caefb7fada44681d3e74cd6dbac617d9a2f99aa879270"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"template":"nextjs"}]]},"a. b. c"], "sha256:52b0eb4f1510872852eee372bc03c900ce8fab9691a61b7b1a8cff0afeecbce2"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"path":"web"}]]},"a. b. c"], "sha256:561c2c2c42507a96c3421dc2bea9626d3684310488eecf62e927c19cb5f53cf0"],
  ["buildPlanBriefSystem", [{"spec":{"name":"x"},"managed":[["web",{"template":"","path":""}]]},"a. b. c"], "sha256:210c6e15abbad387163146e97e17c1e6f461ef098abb30ade5df4bc0c780a2a5"],
  ["buildPlanBriefSystem", [{"spec":{"name":"a\"b ${x}\n한글😀"},"managed":[["a\"b",{"template":"${t}","path":"a\nb"}]]},"a. b. c"], "sha256:63138bd0ab66f2fb369ab34c4658e8a64c64975fafeab0102ca4937fb2f1147d"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]}," a. b.\n"], "sha256:c3731f895a484fb37b6cb1895529489db0e6929b3ed7a0c843c4995b08d4c386"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]},"a. b. c"], "sha256:b481f4456f4184e29b45a1d6cdd229ecfa006d20d47905e9bc54d800be428c50"],
  ["buildPlanBriefSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]},"a\nb\nc"], "sha256:b481f4456f4184e29b45a1d6cdd229ecfa006d20d47905e9bc54d800be428c50"],
  ["appendPlanToRequest", ["요청",""], "\"요청\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청","   "], "\"요청\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청","\n\t﻿"], "\"요청\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청",""], "\"요청\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청\n","계획"], "\"요청\\n\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n계획\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청\n\n"," 계획\n"], "\"요청\\n\\n\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n계획\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["","계획"], "\"\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n계획\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["",""], "\"\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청","계획"], "\"요청\\n\\n---\\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\\n계획\\n[계획 끝]\\n---\""],
  ["appendPlanToRequest", ["요청",{"$rep":[["a",2999]]}], "sha256:b7a58cf31e9a819fea4f28efc58b91b3a3677d732b59be79ab42c4d96ad357fa"],
  ["appendPlanToRequest", ["요청",{"$rep":[["a",3000]]}], "sha256:99a65ea3ea527df5fe7ac40fb98bda1ec425a63ca4cc1ba66559f8b5646fb44e"],
  ["appendPlanToRequest", ["요청",{"$rep":[["a",3001]]}], "sha256:78f4d8bd0bc5e6936ee763a4be255533c266a26b5e4c3b28512e0e5a37bc8718"],
  ["appendPlanToRequest", ["요청",{"$rep":[[" ",1],["a",3000],[" ",1]]}], "sha256:99a65ea3ea527df5fe7ac40fb98bda1ec425a63ca4cc1ba66559f8b5646fb44e"],
  ["appendPlanToRequest", ["요청",{"$rep":[[" ",1],["a",3001],[" ",1]]}], "sha256:78f4d8bd0bc5e6936ee763a4be255533c266a26b5e4c3b28512e0e5a37bc8718"],
  ["appendPlanToRequest", ["요청",{"$rep":[["",1],["a",3000]]}], "sha256:53f6805a73ab1c0345aedce4523c722ec6b42338f13b972fd1293276a0ec1e78"],
  ["appendPlanToRequest", ["요청",{"$rep":[["가",3000]]}], "sha256:77664c0c2ba89612f1c0e90833d79200dfa424b7e1b4c73ed87af15fe02987a1"],
  ["appendPlanToRequest", ["요청",{"$rep":[["가",3001]]}], "sha256:b41d6eb65259e407f820e3ab19d79dbda51a76f18f11ce7a7b49f0e2cd1ecf8f"],
  ["appendPlanToRequest", ["요청",{"$rep":[["😀",1500]]}], "sha256:1fdaa2138c16b9210327a5247f85ddd8dd89d474f4999d39810427c45ffd00c6"],
  ["appendPlanToRequest", ["요청",{"$rep":[["😀",1501]]}], "sha256:1456b62322c30c8f37407bfa84ea8c98af646b72714ce6b53a97f5635609bd41"],
  ["appendPlanToRequest", ["요청",{"$rep":[["a",1],["😀",1499],["b",1]]}], "sha256:17d079eed46aaa3db1a7a932c519d8c507fbc98b5bf185c775c2df813f262984"],
  ["appendPlanToRequest", ["요청",{"$rep":[["x",2998],["😀",1],["y",1]]}], "sha256:24f3b4dbbe26e03ae43076bad89e223bb68cc2bfb71947a7c402fd9507d84588"],
  ["appendPlanToRequest", ["요청",{"$rep":[["a\n",1600]]}], "sha256:eb090f0de1fde0d7fe02631aa1b900c0be4ce45b215051df010a8f4f27073334"],
  ["buildContractSystem", [{"spec":{"name":"orders"},"managed":[["web",{"template":"nextjs","path":"web"}]]}], "sha256:07d1d5bbee53874dbca7ddc0296f5a5ffaaa618cac8b976735d01290dbdd518c"],
  ["buildContractSystem", [{"spec":{"name":""},"managed":[]}], "sha256:a9753f097884c4313d0032c51f3048e5e61c7b391d9352f07731fe74d76afcaf"],
  ["buildContractSystem", [{"spec":{"name":"shop"},"managed":[["api",{"template":"spring-boot","path":"api"}],["web",{"template":"nextjs","path":"web"}]]}], "sha256:96be970f6d1202afda8a192459a9109a8c70a0be935d8f8d0b8b12f570cec70d"],
  ["buildContractSystem", [{"spec":{"name":"x"},"managed":[["web",{}]]}], "sha256:0df01229b76ddb38f4ae2fa3d0c54d18f0cb3f904be47360a47bace85f0d317a"],
  ["buildContractSystem", [{"spec":{"name":"a\"b ${x}\n한글😀"},"managed":[["a\"b",{"template":"${t}","path":"a\nb"}]]}], "sha256:ef4e2f5bc6d236106efaf23f91011c1593bfaacc9b0ca2dea53e925b3425c25e"],
  ["buildContractUser", ["요청",[]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n\""],
  ["buildContractUser", ["",[]], "\"전체 요청: \\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n\""],
  ["buildContractUser", ["전체 요청",[{"id":"api","paths":["api/"],"tasks":[{"id":"t1","title":"제목","request":"요청 문장"}]},{"id":"web","paths":["web/src/","web/public"],"tasks":[{"id":"t2","title":"Title","request":"do it"},{"id":"t3","title":"다음","request":"또"}]}]], "\"전체 요청: 전체 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: api/\\n  · t1 (제목): 요청 문장\\n- web · 쓰기 경로: web/src/, web/public\\n  · t2 (Title): do it\\n  · t3 (다음): 또\""],
  ["buildContractUser", ["요청",[{"id":"api","paths":[],"tasks":[]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: \\n\""],
  ["buildContractUser", ["요청",[{"id":"api","paths":["a"],"tasks":[]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: a\\n\""],
  ["buildContractUser", ["요청",[{"id":"api","paths":["a",null,"b"],"tasks":[]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: a, , b\\n\""],
  ["buildContractUser", ["요청",[{"id":"api","paths":[null],"tasks":[]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: \\n\""],
  ["buildContractUser", ["요청",[{"id":"","paths":[""],"tasks":[{"id":"","title":"","request":""}]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n-  · 쓰기 경로: \\n  ·  (): \""],
  ["buildContractUser", ["요청",[{"id":"api","paths":["a","","b"],"tasks":[{"id":"t1","title":"a(b)","request":"줄1\n줄2"}]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- api · 쓰기 경로: a, , b\\n  · t1 (a(b)): 줄1\\n줄2\""],
  ["buildContractUser", ["요청\n끝\n",[{"id":"l","paths":["한글/","😀"],"tasks":[{"id":"t1","title":"😀","request":"😀"}]}]], "\"전체 요청: 요청\\n끝\\n\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- l · 쓰기 경로: 한글/, 😀\\n  · t1 (😀): 😀\""],
  ["buildContractUser", ["요청",[{"id":"a","paths":["x"],"tasks":[{"id":"1","title":"t","request":"r"}]},{"id":"b","paths":["y"],"tasks":[]},{"id":"c","paths":[],"tasks":[{"id":"2","title":"t","request":"r"}]}]], "\"전체 요청: 요청\\n\\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\\n- a · 쓰기 경로: x\\n  · 1 (t): r\\n- b · 쓰기 경로: y\\n\\n- c · 쓰기 경로: \\n  · 2 (t): r\""],
];

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    const rep = (value as { $rep?: Array<[string, number]> }).$rep;
    if (rep) return rep.map(([unit, count]) => unit.repeat(count)).join('');
  }
  return value;
}

const asProject = (value: unknown): LoadedProject => value as LoadedProject;
const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  shouldPlanBrief: (request) => shouldPlanBrief(request as string),
  planWordLimit: (request) => planWordLimit(request as string),
  buildPlanBriefSystem: (project, request) => buildPlanBriefSystem(asProject(project), request as string),
  appendPlanToRequest: (request, plan) => appendPlanToRequest(request as string, plan as string),
  buildContractSystem: (project) => buildContractSystem(asProject(project)),
  buildContractUser: (request, lanes) => buildContractUser(request as string, lanes as TaskLane[]),
};

function show(text: string): string {
  return text.length > 700 ? `sha256:${createHash('sha256').update(text).digest('hex')}` : text;
}

describe('plan-brief·lane-contracts 벡터(옛 TS가 낸 값)', () => {
  it('벡터가 충분하고 함수마다 있다', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(200);
    for (const name of Object.keys(FUNCTIONS)) expect(VECTORS.filter(([fn]) => fn === name).length, name).toBeGreaterThanOrEqual(5);
  });

  it('모든 벡터가 옛 TS의 값과 같다', () => {
    const bad: string[] = [];
    VECTORS.forEach(([fn, args, expected], index) => {
      const actual = show(JSON.stringify(FUNCTIONS[fn]!(...(args.map(decode) as unknown[]))));
      if (actual !== expected) bad.push(`#${index} ${fn}(${JSON.stringify(args).slice(0, 120)})\n  기대 ${expected.slice(0, 160)}\n  실제 ${actual.slice(0, 160)}`);
    });
    expect(bad).toEqual([]);
  });

  it('판정 경계: 참·거짓이 모두 나오고 경계에서 갈린다', () => {
    expect(shouldPlanBrief('a'.repeat(3196))).toBe(false);
    expect(shouldPlanBrief('a'.repeat(3197))).toBe(true);
    expect(shouldPlanBrief('가'.repeat(1198))).toBe(false);
    expect(shouldPlanBrief('가'.repeat(1199))).toBe(true);
    expect(shouldPlanBrief(`a${'\n'.repeat(11)}b`)).toBe(false);
    expect(shouldPlanBrief(`a${'\n'.repeat(12)}b`)).toBe(true);
    expect(shouldPlanBrief('')).toBe(false);
    expect(shouldPlanBrief('  \n\t ')).toBe(false);
    expect(planWordLimit('a. b.')).toBe(150);
    expect(planWordLimit('a. b. c')).toBe(400);
  });
});

describe('의도한 차이: 짝 없는 서로게이트는 Rust 경계에서 U+FFFD가 된다(옛 TS에서는 이 시험이 실패한다)', () => {
  it('계획 글의 짝 없는 서로게이트', () => {
    expect(appendPlanToRequest('요청', '앞\ud800뒤')).toBe('요청\n\n---\n[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]\n앞\ufffd뒤\n[계획 끝]\n---');
  });

  it('요청의 짝 없는 서로게이트(레인 계약 입력)', () => {
    expect(buildContractUser('a\udc00b', [])).toContain('전체 요청: a\ufffdb');
  });

  it('상한에서 서로게이트 쌍을 가르면 U+FFFD가 된다', () => {
    const plan = `${'x'.repeat(2999)}😀`;
    const result = appendPlanToRequest('r', plan);
    expect(result).toContain(`${'x'.repeat(2999)}\ufffd\n…(계획이 상한 3,000자`);
    expect(appendPlanToRequest('r', `a${'😀'.repeat(1500)}`)).toContain(`a${'😀'.repeat(1499)}\ufffd\n…(계획이 상한 3,000자`);
  });
});

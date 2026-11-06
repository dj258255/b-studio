import { describe, expect, it } from 'vitest';
import { crashLogExcerpt, decideReadiness } from './readiness';
import type { ProbeResult } from './types';

// 옛 TS(#1034 전)가 같은 입력에 낸 값. 옛 TS에 돌리면 의도한 차이만 실패해야 한다(이 묶음은 의도한 차이 없음)
interface DecideCase { title: string; history: ProbeResult[]; policy: { successThreshold: number; timeoutMs: number; intervalMs: number }; elapsed: number; decision: unknown }
interface CrashCase { title: string; lines: string[]; max: number; excerpt: string[] }

const DECIDE: DecideCase[] = [
  { title: "decide 0", history: [{"at":216915845,"ok":false,"error":"ECONNREFUSED","containerState":"running"},{"at":417353272,"ok":false,"status":404,"error":"TIMEOUT","containerState":"unknown"},{"at":716249108,"ok":true,"status":200,"error":"ECONNREFUSED","containerState":"dead"}], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 0, decision: {"kind":"failed","reason":"앱이 켜지다가 종료됐습니다 (컨테이너 dead)"} },
  { title: "decide 1", history: [{"at":129109144,"ok":false,"containerState":"unknown"},{"at":884421825,"ok":true,"status":404,"error":"TIMEOUT","containerState":"created"},{"at":598380591,"ok":true,"status":200,"error":"ECONNREFUSED","containerState":"dead"},{"at":416878104,"ok":true,"error":"TIMEOUT","containerState":"running"}], policy: {"successThreshold":2,"timeoutMs":0,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"ready"} },
  { title: "decide 2", history: [], policy: {"successThreshold":3,"timeoutMs":0,"intervalMs":1000}, elapsed: 200000, decision: {"kind":"waiting"} },
  { title: "decide 3", history: [], policy: {"successThreshold":1,"timeoutMs":0,"intervalMs":1000}, elapsed: 0, decision: {"kind":"waiting"} },
  { title: "decide 4", history: [{"at":674150347,"ok":true,"error":"ECONNREFUSED","containerState":"created"}], policy: {"successThreshold":3,"timeoutMs":0,"intervalMs":1000}, elapsed: 0, decision: {"kind":"failed","reason":"0초 안에 준비되지 않았습니다 (마지막 확인: ECONNREFUSED, 컨테이너 created)"} },
  { title: "decide 5", history: [], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 200000, decision: {"kind":"waiting"} },
  { title: "decide 6", history: [{"at":869597911,"ok":false,"status":0,"error":"ECONNREFUSED","containerState":"running"},{"at":749022960,"ok":false,"status":0,"error":"ECONNREFUSED","containerState":"exited"}], policy: {"successThreshold":1,"timeoutMs":0,"intervalMs":1000}, elapsed: 0, decision: {"kind":"failed","reason":"앱이 켜지다가 종료됐습니다 (컨테이너 exited)"} },
  { title: "decide 7", history: [{"at":125811457,"ok":false,"status":200,"containerState":"created"},{"at":236840754,"ok":false,"error":"ECONNREFUSED","containerState":"created"}], policy: {"successThreshold":3,"timeoutMs":180000,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"failed","reason":"180초 안에 준비되지 않았습니다 (마지막 확인: ECONNREFUSED, 컨테이너 created)"} },
  { title: "decide 8", history: [], policy: {"successThreshold":1,"timeoutMs":180000,"intervalMs":1000}, elapsed: 0, decision: {"kind":"waiting"} },
  { title: "decide 9", history: [{"at":613658070,"ok":true,"status":404,"error":"","containerState":"created"},{"at":338715583,"ok":false,"status":200,"error":"ECONNREFUSED","containerState":"unknown"},{"at":515921235,"ok":true,"status":503,"error":"","containerState":"exited"},{"at":332443714,"ok":false,"status":404,"error":"TIMEOUT","containerState":"unknown"},{"at":249336719,"ok":true,"status":0,"error":"","containerState":"running"}], policy: {"successThreshold":2,"timeoutMs":0,"intervalMs":1000}, elapsed: 200000, decision: {"kind":"failed","reason":"0초 안에 준비되지 않았습니다 (마지막 확인: , 컨테이너 running)"} },
  { title: "decide 10", history: [{"at":841233491,"ok":false,"status":404,"error":"ECONNREFUSED","containerState":"unknown"}], policy: {"successThreshold":3,"timeoutMs":180000,"intervalMs":1000}, elapsed: 0, decision: {"kind":"waiting"} },
  { title: "decide 11", history: [], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"waiting"} },
  { title: "decide 12", history: [{"at":257015,"ok":true,"status":200,"containerState":"unknown"},{"at":180241346,"ok":false,"status":200,"containerState":"unknown"},{"at":190109729,"ok":true,"status":404,"error":"TIMEOUT","containerState":"unknown"},{"at":532684445,"ok":true,"status":0,"containerState":"exited"},{"at":529908061,"ok":false,"error":"TIMEOUT","containerState":"created"}], policy: {"successThreshold":1,"timeoutMs":0,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"failed","reason":"0초 안에 준비되지 않았습니다 (마지막 확인: TIMEOUT, 컨테이너 created)"} },
  { title: "decide 13", history: [{"at":411518335,"ok":false,"status":503,"error":"ECONNREFUSED","containerState":"unknown"},{"at":651380777,"ok":true,"status":200,"error":"","containerState":"dead"},{"at":556607365,"ok":false,"status":200,"error":"ECONNREFUSED","containerState":"created"},{"at":940140873,"ok":true,"status":200,"error":"ECONNREFUSED","containerState":"created"},{"at":244662195,"ok":false,"status":200,"error":"","containerState":"exited"}], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"failed","reason":"앱이 켜지다가 종료됐습니다 (컨테이너 exited)"} },
  { title: "decide 14", history: [{"at":840672969,"ok":true,"status":404,"error":"TIMEOUT","containerState":"exited"},{"at":868776798,"ok":true,"status":503,"error":"","containerState":"running"},{"at":506723880,"ok":false,"error":"TIMEOUT","containerState":"dead"},{"at":429609775,"ok":false,"status":503,"error":"TIMEOUT","containerState":"created"}], policy: {"successThreshold":3,"timeoutMs":0,"intervalMs":1000}, elapsed: 1000, decision: {"kind":"failed","reason":"0초 안에 준비되지 않았습니다 (마지막 확인: TIMEOUT, 컨테이너 created)"} },
  { title: "decide 15", history: [], policy: {"successThreshold":1,"timeoutMs":180000,"intervalMs":1000}, elapsed: 180000, decision: {"kind":"waiting"} },
  { title: "decide 16", history: [{"at":303402543,"ok":false,"status":200,"error":"TIMEOUT","containerState":"dead"},{"at":362140178,"ok":true,"error":"TIMEOUT","containerState":"created"},{"at":503906518,"ok":false,"status":404,"error":"","containerState":"unknown"}], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 0, decision: {"kind":"waiting"} },
  { title: "decide 17", history: [{"at":890826582,"ok":false,"status":503,"containerState":"dead"},{"at":46864271,"ok":false,"error":"","containerState":"dead"},{"at":153582215,"ok":false,"error":"TIMEOUT","containerState":"running"},{"at":305710792,"ok":true,"error":"TIMEOUT","containerState":"dead"}], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 1000, decision: {"kind":"failed","reason":"앱이 켜지다가 종료됐습니다 (컨테이너 dead)"} },
  { title: "decide 18", history: [{"at":439250349,"ok":false,"status":0,"containerState":"exited"},{"at":60149908,"ok":false,"status":503,"error":"","containerState":"exited"}], policy: {"successThreshold":2,"timeoutMs":180000,"intervalMs":1000}, elapsed: 0, decision: {"kind":"failed","reason":"앱이 켜지다가 종료됐습니다 (컨테이너 exited)"} },
  { title: "decide 19", history: [{"at":201618671,"ok":false,"status":0,"error":"TIMEOUT","containerState":"exited"},{"at":740865588,"ok":true,"status":503,"error":"TIMEOUT","containerState":"unknown"}], policy: {"successThreshold":3,"timeoutMs":180000,"intervalMs":1000}, elapsed: 1000, decision: {"kind":"waiting"} },
];

const CRASH: CrashCase[] = [
  { title: "crash 0", lines: ["  at Module (node:x)","HTTP 503"], max: 6, excerpt: ["HTTP 503"] },
  { title: "crash 1", lines: [], max: 3, excerpt: [] },
  { title: "crash 2", lines: [], max: 1, excerpt: [] },
  { title: "crash 3", lines: ["denied","... 3 more","... 3 more","info","denied"], max: 1, excerpt: ["denied"] },
  { title: "crash 4", lines: ["  at Module (node:x)","info","HTTP 503","info","ETXTBSY","info"], max: 6, excerpt: ["HTTP 503"] },
  { title: "crash 5", lines: ["info","HTTP 503","denied","ETXTBSY"], max: 6, excerpt: ["HTTP 503","denied"] },
  { title: "crash 6", lines: [], max: 1, excerpt: [] },
  { title: "crash 7", lines: ["panic!","ETXTBSY","Error: boom","panic!","TypeError: x","Error: boom","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","TypeError: x"], max: 6, excerpt: ["panic!","Error: boom","panic!","TypeError: x","Error: boom","TypeError: x"] },
];

describe('decideReadiness 벡터: 옛 TS가 낸 값과 같다', () => {
  it.each(DECIDE)('$title', ({ history, policy, elapsed, decision }) => {
    expect(decideReadiness(history, policy, elapsed)).toEqual(decision);
  });
});

describe('crashLogExcerpt 벡터: 옛 TS가 낸 값과 같다', () => {
  it.each(CRASH)('$title', ({ lines, max, excerpt }) => {
    expect(crashLogExcerpt(lines, max)).toEqual(excerpt);
  });
});

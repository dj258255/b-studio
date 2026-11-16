# B4d 고치기 전 코드의 시험 출력 (2026-11-17)

`sessions-terminal-usage.test.ts` 14개를 ADR-213 이전 코드(6026bd5)에서 돌린 결과다. 5개가 실패했다. 실제 모델 호출은 없고 가짜 샌드박스와 직접 보낸 OTLP·훅이다. 세션 터미널 실제 세션 실측은 세션의 주인이 한다(이 기록에는 없다).

```

 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts (14 tests | 5 failed) 2949ms
   ❯ U1: 사람 몫을 기록하지 못한 요청이 끝내 세지지 않는다 (2)
     × 기록 파일을 쓰지 못한 요청은 파일이 돌아온 뒤 다음 기록에 함께 더해지고, 같은 묶음을 다시 받아도 두 번 세지 않는다 226ms
   ❯ U2: 텔레메트리가 오지 않으면 한도를 볼 수 없다 (6)
     × 텔레메트리 없이 시간이 지나고 쓰기 훅이 이어지면 쓰기를 막는다(턴 상한을 볼 수 없다) 225ms
     × 막힌 뒤 텔레메트리가 오면 다시 풀린다 216ms
   ❯ U5: 열린 실행 안의 요청이 시작 시각보다 조금 앞서 찍혔다 (3)
     × 도구 호출이 연 실행에는 그 도구를 정한 모델 요청(열기 직전에 끝난)이 턴으로 붙는다 208ms
   ❯ U6: 정체 알림이 정체 시간의 두 배까지 늦지 않는다 (1)
     × 마지막 움직임 뒤 정체 시간의 1.25배 안에 알린다 190ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  apps/studio/lib/server/sessions-terminal-usage.test.ts > U1: 사람 몫을 기록하지 못한 요청이 끝내 세지지 않는다 > 기록 파일을 쓰지 못한 요청은 파일이 돌아온 뒤 다음 기록에 함께 더해지고, 같은 묶음을 다시 받아도 두 번 세지 않는다
AssertionError: expected 21 to be 32 // Object.is equality

- Expected
+ Received

- 32
+ 21

 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts:266:38
    264|     // 파일이 돌아왔다. 내보내기가 같은 묶음(r1)을 다시 보내고 새 요청(r2)도 온다
    265|     await session.gateway.telemetry(otlp([rec('r1'), rec('r2', { input…
    266|     expect(userTokens('kim', 'day')).toBe(11 + 21);
       |                                      ^
    267|     // 더 다시 와도 늘지 않는다
    268|     await session.gateway.telemetry(otlp([rec('r1'), rec('r2', { input…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  apps/studio/lib/server/sessions-terminal-usage.test.ts > U2: 텔레메트리가 오지 않으면 한도를 볼 수 없다 > 텔레메트리 없이 시간이 지나고 쓰기 훅이 이어지면 쓰기를 막는다(턴 상한을 볼 수 없다)
AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts:302:18
    300|     vi.setSystemTime(Date.now() + 40_000);
    301|     const deny = await writes(session, 12);
    302|     expect(deny).toContain('사용량');
       |                  ^
    303|   }, 30_000);
    304|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯

 FAIL  apps/studio/lib/server/sessions-terminal-usage.test.ts > U2: 텔레메트리가 오지 않으면 한도를 볼 수 없다 > 막힌 뒤 텔레메트리가 오면 다시 풀린다
AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts:333:39
    331|     vi.useFakeTimers({ toFake: ['Date'] });
    332|     vi.setSystemTime(Date.now() + 40_000);
    333|     expect(await writes(session, 12)).toContain('사용량');
       |                                       ^
    334|     await session.gateway.telemetry(otlp([rec('r1')]));
    335|     expect(await writes(session, 1)).toBeUndefined();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/5]⎯

 FAIL  apps/studio/lib/server/sessions-terminal-usage.test.ts > U5: 열린 실행 안의 요청이 시작 시각보다 조금 앞서 찍혔다 > 도구 호출이 연 실행에는 그 도구를 정한 모델 요청(열기 직전에 끝난)이 턴으로 붙는다
AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts:381:57
    379|     expect(await session.gateway.preTool(WRITE)).toEqual({});
    380|     await session.gateway.telemetry(otlp([rec('r1', { at: Date.now() -…
    381|     expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상…
       |                                                         ^
    382|   }, 30_000);
    383|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/5]⎯

 FAIL  apps/studio/lib/server/sessions-terminal-usage.test.ts > U6: 정체 알림이 정체 시간의 두 배까지 늦지 않는다 > 마지막 움직임 뒤 정체 시간의 1.25배 안에 알린다
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ apps/studio/lib/server/sessions-terminal-usage.test.ts:410:22
    408|     vi.advanceTimersByTime(10_000);
    409|     const warnings = session.events.filter((event) => event.type === '…
    410|     expect(warnings).toHaveLength(1);
       |                      ^
    411|   }, 30_000);
    412| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/5]⎯


 Test Files  1 failed (1)
      Tests  5 failed | 9 passed (14)
   Start at  01:43:43
   Duration  4.95s (tests 61%, import 23%, transform 16%)

```

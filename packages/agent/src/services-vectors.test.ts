import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { cliPreflightFailure, describeCliError } from './cli-failure';
import { isComposeFile, ownsFile, servicesForFiles } from './services';

/**
 * 서비스 소유 판정(services)과 CLI 실패 설명(cli-failure)을 Rust로 옮기면서(ADR-191 3l) 옛 TS 구현이 낸 값을 고정한다(JSON 글자).
 * 이 판정은 게이트가 다시 띄우고 확인할 서비스를 고르는 데 쓰이므로 "바뀐 파일이 어느 서비스에도 속하지 않는 쪽"으로 틀어지면 안 된다.
 * 입력은 경계를 정확히 밟는다: 접두지만 폴더가 아닌 경로(`a` 대 `ab/x`), 폴더와 같은 이름, 대소문자, NFC·NFD, `.hidden`(첫 점이 지워짐),
 * `./a`·`a//b`·끝 `/` 여러 개, 루트 `''`·`.`·`./`·`/`, `..`, compose가 root 밖·같은 경로, root·composePath가 빈 값·없는 최소 fixture.
 * 옛 코드의 비대칭(루트·compose·projectWide에는 normalize를 쓰고 `ownsFile`의 file에는 쓰지 않음)도 그대로 고정했다.
 * 보이지 않는 글자는 \\u 이스케이프로 적었다. 이 시험의 기대값은 옛 구현에서 그대로 나온 값이라 의도한 차이가 없다.
 * (짝 없는 서로게이트가 napi 경계에서 U+FFFD가 되는 것은 아래 따로 확인한다.)
 */

interface Vector {
  fn: 'ownsFile' | 'isComposeFile' | 'servicesForFiles' | 'describeCliError' | 'cliPreflightFailure';
  note: string;
  args: unknown[];
  expected: unknown;
}

/** 오류 값의 글자 만들기는 JS 객체 판정이라 시험에서 만든다(키는 벡터의 note) */
const ERRORS: Record<string, () => unknown> = {
  '색 코드': () => new Error('\u001b[31m✖\u001b[39m Not authenticated'),
  '앞뒤 공백·줄바꿈': () => new Error('  \n x \n '),
  '빈 메시지': () => new Error(''),
  '공백뿐': () => new Error(' \t\n'),
  'NEL(U+0085)는 안 자름': () => new Error('\u0085x\u0085'),
  'BOM·NBSP·줄 구분자': () => new Error('﻿ x  '),
  'OSC 링크': () => new Error('\u001b]8;;http://x\u0007link\u001b]8;;\u0007'),
  'OSC ST 끝': () => new Error('\u001b]0;title\u001b\\x'),
  '끝나지 않은 OSC': () => new Error('\u001b]0;title'),
  'CSI 끝 글자 없음': () => new Error('\u001b['),
  '8비트 CSI': () => new Error('\u009b31mred'),
  '커서': () => new Error('\u001b[?25lx\u001b[?25h'),
  '두 글자 이스케이프': () => new Error('\u001b7x\u001bc'),
  'ESC 뒤 소문자': () => new Error('\u001bax'),
  'ESC만': () => new Error('\u001b'),
  'ESC 둘': () => new Error('\u001b\u001b[0mx'),
  '색 코드 속 공백': () => new Error('\u001b[1 mx'),
  '색 코드 뒤 공백만': () => new Error(' \u001b[2K '),
  '문자열': () => 'Command failed: codex\n\u001b[1mx\u001b[0m',
  '빈 문자열': () => '',
  'null': () => null,
  'undefined': () => undefined,
  '숫자': () => 42,
  '객체': () => ({}),
  'message만 있는 객체': () => ({ message: 'm' }),
  'toString이 있는 객체': () => ({ toString: () => '  \u001b[31mobj\u001b[0m ' }),
  '배열': () => [1, [2, '\u001b[0m']],
  'TypeError': () => new TypeError('boom'),
  'cause는 안 봄': () => Object.assign(new Error('outer'), { cause: 'inner' }),
  'Symbol.toPrimitive': () => ({ [Symbol.toPrimitive]: () => ' p ' }),
  'true': () => true,
  '한글': () => new Error(' 로그인 필요 '),
  '긴 줄': () => new Error('x'.repeat(40)),
};

const VECTORS: Vector[] = [
  {"fn":"ownsFile","note":"폴더 아래","args":["a",[],"a/x"],"expected":true},
  {"fn":"ownsFile","note":"같은 이름","args":["a",[],"a"],"expected":true},
  {"fn":"ownsFile","note":"접두지만 폴더 아님 a 대 ab/x","args":["a",[],"ab/x"],"expected":false},
  {"fn":"ownsFile","note":"접두 ab","args":["a",[],"ab"],"expected":false},
  {"fn":"ownsFile","note":"접두 a. ","args":["a",[],"a.b"],"expected":false},
  {"fn":"ownsFile","note":"대소문자 다른 파일","args":["a",[],"A/x"],"expected":false},
  {"fn":"ownsFile","note":"대소문자 다른 루트","args":["A",[],"a/x"],"expected":false},
  {"fn":"ownsFile","note":"대소문자만 다른 같은 이름","args":["A",[],"a"],"expected":false},
  {"fn":"ownsFile","note":"대소문자만 다른 같은 이름 2","args":["web",[],"WEB"],"expected":false},
  {"fn":"ownsFile","note":"includes 대소문자만 다른 같은 이름","args":["x",["Media"],"media"],"expected":false},
  {"fn":"ownsFile","note":"file의 ./는 안 지움","args":["a",[],"./a/x"],"expected":false},
  {"fn":"ownsFile","note":"루트의 ./는 지움","args":["./a",[],"a/x"],"expected":true},
  {"fn":"ownsFile","note":"루트의 끝 / 하나","args":["a/",[],"a/x"],"expected":true},
  {"fn":"ownsFile","note":"루트의 끝 / 여럿","args":["a///",[],"a/x"],"expected":true},
  {"fn":"ownsFile","note":"루트 끝 / 여럿, 같은 이름","args":["a///",[],"a"],"expected":true},
  {"fn":"ownsFile","note":"file 끝 / 는 안 지움","args":["a",[],"a/"],"expected":true},
  {"fn":"ownsFile","note":"file 끝 / 여럿","args":["a",[],"a//"],"expected":true},
  {"fn":"ownsFile","note":"루트 a//b 겹친 구분자","args":["a//b",[],"a/b/x"],"expected":false},
  {"fn":"ownsFile","note":"file a//b 겹친 구분자","args":["a/b",[],"a//b/x"],"expected":false},
  {"fn":"ownsFile","note":"루트 a//b와 같은 file","args":["a//b",[],"a//b"],"expected":true},
  {"fn":"ownsFile","note":"file a//b 대 루트 a//b 아래","args":["a//b",[],"a//b/c"],"expected":true},
  {"fn":"ownsFile","note":".hidden 루트: 첫 점이 지워져 hidden","args":[".hidden",[],"hidden/x"],"expected":true},
  {"fn":"ownsFile","note":".hidden 루트에 .hidden/x","args":[".hidden",[],".hidden/x"],"expected":false},
  {"fn":"ownsFile","note":".hidden 루트에 hidden","args":[".hidden",[],"hidden"],"expected":true},
  {"fn":"ownsFile","note":"루트 .","args":[".",[],"anything/x"],"expected":true},
  {"fn":"ownsFile","note":"루트 ./","args":["./",[],"anything"],"expected":true},
  {"fn":"ownsFile","note":"루트 빈","args":["",[],"anything"],"expected":true},
  {"fn":"ownsFile","note":"루트 /","args":["/",[],"anything"],"expected":true},
  {"fn":"ownsFile","note":"루트 //","args":["//",[],"x/y"],"expected":true},
  {"fn":"ownsFile","note":"루트 ..","args":["..",[],"x"],"expected":false},
  {"fn":"ownsFile","note":"루트 .. 는 .로 접힘","args":["..",[],"./x"],"expected":true},
  {"fn":"ownsFile","note":"루트 .. 와 같은 파일","args":["..",[],"."],"expected":true},
  {"fn":"ownsFile","note":"루트 ../a","args":["../a",[],"/a/x"],"expected":false},
  {"fn":"ownsFile","note":"루트 ../a 정확히","args":["../a",[],"./a"],"expected":true},
  {"fn":"ownsFile","note":"file에 ..","args":["a",[],"a/../b"],"expected":true},
  {"fn":"ownsFile","note":"file 이 ../a","args":["a",[],"../a/x"],"expected":false},
  {"fn":"ownsFile","note":"루트 a/../b","args":["a/../b",[],"a/../b/x"],"expected":true},
  {"fn":"ownsFile","note":"루트 a/../b 대 b/x","args":["a/../b",[],"b/x"],"expected":false},
  {"fn":"ownsFile","note":"NFC 루트·NFC 파일","args":["é",[],"é/x"],"expected":true},
  {"fn":"ownsFile","note":"NFC 루트·NFD 파일","args":["é",[],"e\u0301/x"],"expected":false},
  {"fn":"ownsFile","note":"NFD 루트·NFC 파일","args":["e\u0301",[],"é/x"],"expected":false},
  {"fn":"ownsFile","note":"NFD 루트·NFD 파일","args":["e\u0301",[],"e\u0301/x"],"expected":true},
  {"fn":"ownsFile","note":"전각 Ａ","args":["a",[],"Ａ/x"],"expected":false},
  {"fn":"ownsFile","note":"보이지 않는 글자","args":["a",[],"a\u200b/x"],"expected":false},
  {"fn":"ownsFile","note":"끝 점","args":["a",[],"a./x"],"expected":false},
  {"fn":"ownsFile","note":"역슬래시","args":["a",[],"a\\x"],"expected":false},
  {"fn":"ownsFile","note":"공백","args":["a",[],"a /x"],"expected":false},
  {"fn":"ownsFile","note":"includes 아래","args":["web",["media"],"media/x"],"expected":true},
  {"fn":"ownsFile","note":"includes 접두","args":["web",["media"],"mediax/x"],"expected":false},
  {"fn":"ownsFile","note":"includes 같은 이름","args":["web",["media"],"media"],"expected":true},
  {"fn":"ownsFile","note":"includes ./","args":["web",["./media/"],"media/x"],"expected":true},
  {"fn":"ownsFile","note":"includes 빈 항목은 전부 소유","args":["web",[""],"zzz"],"expected":true},
  {"fn":"ownsFile","note":"includes .","args":["web",["."],"zzz"],"expected":true},
  {"fn":"ownsFile","note":"includes 대소문자","args":["web",["media"],"Media/x"],"expected":false},
  {"fn":"ownsFile","note":"includes 없음 vs 빈 배열","args":["web",[],"media/x"],"expected":false},
  {"fn":"ownsFile","note":"path 정확히+includes 둘 다 틀림","args":["web",["media"],"other/x"],"expected":false},
  {"fn":"ownsFile","note":"includes 필드 없음","args":["web",null,"media/x"],"expected":false},
  {"fn":"ownsFile","note":"includes 필드 없음, path 아래","args":["web",null,"web/x"],"expected":true},
  {"fn":"isComposeFile","note":"기본","args":["/p","/p/compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"file ./","args":["/p","/p/compose.yaml","./compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"file 끝 /","args":["/p","/p/compose.yaml","compose.yaml/"],"expected":true},
  {"fn":"isComposeFile","note":"file 끝 // ","args":["/p","/p/compose.yaml","compose.yaml//"],"expected":true},
  {"fn":"isComposeFile","note":"대소문자","args":["/p","/p/compose.yaml","Compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"접두","args":["/p","/p/compose.yaml","compose.yaml.bak"],"expected":false},
  {"fn":"isComposeFile","note":"다른 파일","args":["/p","/p/compose.yaml","docker-compose.yml"],"expected":false},
  {"fn":"isComposeFile","note":"root 끝 /","args":["/p/","/p/compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"root 끝 //","args":["/p//","/p/compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose가 root 밖","args":["/p/app","/p/compose.yaml","../compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose가 root 밖, 접힌 file","args":["/p/app","/p/compose.yaml","./compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"compose가 root 밖 다른 폴더","args":["/p/app","/q/compose.yaml","../../q/compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose가 root 밖 file ../ 시작 점 하나가 지워짐","args":["/p/app","/p/compose.yaml","/compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"같은 경로","args":["/p","/p",""],"expected":true},
  {"fn":"isComposeFile","note":"같은 경로 file .","args":["/p","/p","."],"expected":true},
  {"fn":"isComposeFile","note":"같은 경로 file ./","args":["/p","/p","./"],"expected":true},
  {"fn":"isComposeFile","note":"같은 경로 file /","args":["/p","/p","/"],"expected":true},
  {"fn":"isComposeFile","note":"root 안쪽 하위","args":["/p","/p/sub/compose.yml","sub/compose.yml"],"expected":true},
  {"fn":"isComposeFile","note":"root 안쪽 하위 .hidden","args":["/p","/p/.hidden/c.yml",".hidden/c.yml"],"expected":true},
  {"fn":"isComposeFile","note":"root 안쪽 하위 .hidden, 점 지운 file","args":["/p","/p/.hidden/c.yml","hidden/c.yml"],"expected":true},
  {"fn":"isComposeFile","note":"compose가 .hidden 파일","args":["/p","/p/.compose.yaml",".compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose가 .hidden 파일, 점 뺀 file","args":["/p","/p/.compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"root 빈","args":["","/p/compose.yaml","compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"composePath 빈","args":["/p","","compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"둘 다 빈","args":["","",""],"expected":false},
  {"fn":"isComposeFile","note":"root 빈이고 file 빈","args":["","/p/c",""],"expected":false},
  {"fn":"isComposeFile","note":"NFC compose·NFD file","args":["/p","/p/é.yml","e\u0301.yml"],"expected":false},
  {"fn":"isComposeFile","note":"NFC compose·NFC file","args":["/p","/p/é.yml","é.yml"],"expected":true},
  {"fn":"isComposeFile","note":"compose 겹친 구분자","args":["/p","/p//compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose에 ..","args":["/p","/p/x/../compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"compose에 .. 접히지 않은 file","args":["/p","/p/x/../compose.yaml","x/../compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"상대 root·compose","args":["p","p/compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"상대 root 밖 compose","args":["p","q/compose.yaml","../q/compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"root /","args":["/","/compose.yaml","compose.yaml"],"expected":true},
  {"fn":"isComposeFile","note":"root 아래가 아닌 접두 폴더","args":["/p/app","/p/application/c.yml","../application/c.yml"],"expected":true},
  {"fn":"isComposeFile","note":"root 빈·상대 compose(cwd 기준으로 맞아 보여도 root가 비면 false)","args":["","compose.yaml","compose.yaml"],"expected":false},
  {"fn":"isComposeFile","note":"composePath 빈·상대 root","args":["p","",".."],"expected":false},
  {"fn":"isComposeFile","note":"composePath 빈·root 상대 file .","args":["p","","."],"expected":false},
  {"fn":"servicesForFiles","note":"기본","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["api/src/A.java","web/app/page.tsx","apiary.txt"]],"expected":{"services":["web","api"],"unmatched":["apiary.txt"]}},
  {"fn":"servicesForFiles","note":"studio.yaml","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["studio.yaml"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"./studio.yaml","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["./studio.yaml"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"studio.yaml/","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["studio.yaml/"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"Studio.yaml 대소문자","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["Studio.yaml"]],"expected":{"services":[],"unmatched":["Studio.yaml"]}},
  {"fn":"servicesForFiles","note":"studio.yaml.bak 접두","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["studio.yaml.bak"]],"expected":{"services":[],"unmatched":["studio.yaml.bak"]}},
  {"fn":"servicesForFiles","note":"sub/studio.yaml","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["sub/studio.yaml"]],"expected":{"services":[],"unmatched":["sub/studio.yaml"]}},
  {"fn":"servicesForFiles","note":"compose","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["compose.yaml"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"compose ./","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["./compose.yaml"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"compose 대소문자","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["COMPOSE.yaml"]],"expected":{"services":[],"unmatched":["COMPOSE.yaml"]}},
  {"fn":"servicesForFiles","note":"compose 아님 접두","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",["compose.yaml2"]],"expected":{"services":[],"unmatched":["compose.yaml2"]}},
  {"fn":"servicesForFiles","note":"compose가 하위","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/infra/compose.yaml",["infra/compose.yaml","compose.yaml"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"compose가 root 밖","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p/app","/p/compose.yaml",["../compose.yaml","compose.yaml"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"root 끝 /","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p/","/p/compose.yaml",["compose.yaml"]],"expected":{"services":["web","api"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"서비스 없음 + project wide","args":[[],"/p","/p/compose.yaml",["compose.yaml","studio.yaml","x"]],"expected":{"services":[],"unmatched":["compose.yaml","studio.yaml","x"]}},
  {"fn":"servicesForFiles","note":"서비스 없음 + 파일 없음","args":[[],"/p","/p/compose.yaml",[]],"expected":{"services":[],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"root 빈 문자열·상대 composePath","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"","compose.yaml",["compose.yaml"]],"expected":{"services":[],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"파일 없음","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/compose.yaml",[]],"expected":{"services":[],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"root 없음(최소 fixture): compose는 건너뜀","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],null,null,["compose.yaml","studio.yaml","web/x"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"root만 있음","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p",null,["compose.yaml","studio.yaml"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"composePath만 있음","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],null,"/p/compose.yaml",["compose.yaml","studio.yaml"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"root 빈 문자열","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"","/p/compose.yaml",["compose.yaml","studio.yaml"]],"expected":{"services":["web","api"],"unmatched":["compose.yaml"]}},
  {"fn":"servicesForFiles","note":"composePath 빈 문자열","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","",["compose.yaml",""]],"expected":{"services":[],"unmatched":["compose.yaml",""]}},
  {"fn":"servicesForFiles","note":"같은 경로(compose가 root): 빈 file은 project wide","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p",["",".","x"]],"expected":{"services":["web","api"],"unmatched":["x"]}},
  {"fn":"servicesForFiles","note":"겹치는 소유자 둘 다","args":[[["commerce",{"path":"commerce","includes":["shared"]}],["web",{"path":"web","includes":["shared"]}]],"/p","/p/compose.yaml",["shared/types.ts"]],"expected":{"services":["commerce","web"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"겹치는 소유자: path가 같음","args":[[["a",{"path":"lib"}],["b",{"path":"lib/core"}]],"/p","/p/c.yaml",["lib/core/x","lib/y"]],"expected":{"services":["a","b"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"결과는 managed 순서(파일 순서 아님)","args":[[["a",{"path":"a"}],["b",{"path":"b"}],["c",{"path":"c"}]],"/p","/p/c.yaml",["c/x","a/x"]],"expected":{"services":["a","c"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"중복 파일","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/c.yaml",["web/x","web/x","zz","zz"]],"expected":{"services":["web"],"unmatched":["zz","zz"]}},
  {"fn":"servicesForFiles","note":"같은 이름의 서비스 둘","args":[[["s",{"path":"a"}],["s",{"path":"b"}],["t",{"path":"c"}]],"/p","/p/c.yaml",["a/x"]],"expected":{"services":["s","s"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"루트 .인 서비스는 전부 소유","args":[[["all",{"path":"."}],["web",{"path":"web"}]],"/p","/p/c.yaml",["x","web/y","./z"]],"expected":{"services":["all","web"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"빈 path 서비스","args":[[["all",{"path":""}]],"/p","/p/c.yaml",["x"]],"expected":{"services":["all"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"접두지만 폴더 아님","args":[[["a",{"path":"a"}]],"/p","/p/c.yaml",["ab/x","a/x","a","a.b"]],"expected":{"services":["a"],"unmatched":["ab/x","a.b"]}},
  {"fn":"servicesForFiles","note":".hidden 서비스","args":[[["h",{"path":".hidden"}]],"/p","/p/c.yaml",[".hidden/x","hidden/x","hidden",".hidden"]],"expected":{"services":["h"],"unmatched":[".hidden/x",".hidden"]}},
  {"fn":"servicesForFiles","note":"./a 서비스","args":[[["a",{"path":"./a"}]],"/p","/p/c.yaml",["a/x","./a/x"]],"expected":{"services":["a"],"unmatched":["./a/x"]}},
  {"fn":"servicesForFiles","note":"a/ 서비스 끝 / 여럿","args":[[["a",{"path":"a///"}]],"/p","/p/c.yaml",["a/x","a","a/"]],"expected":{"services":["a"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"a//b 서비스","args":[[["a",{"path":"a//b"}]],"/p","/p/c.yaml",["a/b/x","a//b/x","a//b"]],"expected":{"services":["a"],"unmatched":["a/b/x"]}},
  {"fn":"servicesForFiles","note":"대소문자 다른 서비스 경로","args":[[["a",{"path":"Web"}]],"/p","/p/c.yaml",["web/x","Web/x","WEB/x"]],"expected":{"services":["a"],"unmatched":["web/x","WEB/x"]}},
  {"fn":"servicesForFiles","note":".. 가 든 파일","args":[[["a",{"path":"a"}],["b",{"path":"b"}]],"/p","/p/c.yaml",["a/../b/x","../a/x","a/.."]],"expected":{"services":["a"],"unmatched":["../a/x"]}},
  {"fn":"servicesForFiles","note":"NFC/NFD","args":[[["n",{"path":"é"}]],"/p","/p/c.yaml",["é/x","e\u0301/x"]],"expected":{"services":["n"],"unmatched":["e\u0301/x"]}},
  {"fn":"servicesForFiles","note":"includes로만 소유","args":[[["c",{"path":"commerce","includes":["media","libs/core"]}]],"/p","/p/c.yaml",["media/a","libs/core/b","libs/other","libs"]],"expected":{"services":["c"],"unmatched":["libs/other","libs"]}},
  {"fn":"servicesForFiles","note":"includes 빈 문자열은 전부 소유","args":[[["c",{"path":"commerce","includes":[""]}]],"/p","/p/c.yaml",["x","y/z"]],"expected":{"services":["c"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"includes 한 서비스만 전부","args":[[["c",{"path":"commerce","includes":["."]}],["w",{"path":"web"}]],"/p","/p/c.yaml",["x"]],"expected":{"services":["c"],"unmatched":[]}},
  {"fn":"servicesForFiles","note":"study: unmatched 순서","args":[[["web",{"path":"web"}],["api",{"path":"api"}]],"/p","/p/c.yaml",["z2","web/a","z1","api/b","z0"]],"expected":{"services":["web","api"],"unmatched":["z2","z1","z0"]}},
  {"fn":"servicesForFiles","note":"project wide 뒤 일반 파일","args":[[["a",{"path":"a"}]],"/p","/p/compose.yaml",["studio.yaml","q"]],"expected":{"services":["a"],"unmatched":["q"]}},
  {"fn":"servicesForFiles","note":"서비스 없음·일반 파일","args":[[],"/p","/p/compose.yaml",["q"]],"expected":{"services":[],"unmatched":["q"]}},
  {"fn":"describeCliError","note":"색 코드","args":["색 코드"],"expected":"✖ Not authenticated"},
  {"fn":"cliPreflightFailure","note":"색 코드 / 요약 \"요약\"","args":["요약","색 코드"],"expected":{"ok":false,"reason":"요약 (✖ Not authenticated)","summary":"요약","detail":"✖ Not authenticated"}},
  {"fn":"cliPreflightFailure","note":"색 코드 / 요약 \"\"","args":["","색 코드"],"expected":{"ok":false,"reason":" (✖ Not authenticated)","summary":"","detail":"✖ Not authenticated"}},
  {"fn":"describeCliError","note":"앞뒤 공백·줄바꿈","args":["앞뒤 공백·줄바꿈"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"앞뒤 공백·줄바꿈 / 요약 \"요약\"","args":["요약","앞뒤 공백·줄바꿈"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"앞뒤 공백·줄바꿈 / 요약 \"\"","args":["","앞뒤 공백·줄바꿈"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"빈 메시지","args":["빈 메시지"],"expected":""},
  {"fn":"cliPreflightFailure","note":"빈 메시지 / 요약 \"요약\"","args":["요약","빈 메시지"],"expected":{"ok":false,"reason":"요약","summary":"요약","detail":""}},
  {"fn":"cliPreflightFailure","note":"빈 메시지 / 요약 \"\"","args":["","빈 메시지"],"expected":{"ok":false,"reason":"","summary":"","detail":""}},
  {"fn":"describeCliError","note":"공백뿐","args":["공백뿐"],"expected":""},
  {"fn":"cliPreflightFailure","note":"공백뿐 / 요약 \"요약\"","args":["요약","공백뿐"],"expected":{"ok":false,"reason":"요약","summary":"요약","detail":""}},
  {"fn":"cliPreflightFailure","note":"공백뿐 / 요약 \"\"","args":["","공백뿐"],"expected":{"ok":false,"reason":"","summary":"","detail":""}},
  {"fn":"describeCliError","note":"NEL(U+0085)는 안 자름","args":["NEL(U+0085)는 안 자름"],"expected":"\u0085x\u0085"},
  {"fn":"cliPreflightFailure","note":"NEL(U+0085)는 안 자름 / 요약 \"요약\"","args":["요약","NEL(U+0085)는 안 자름"],"expected":{"ok":false,"reason":"요약 (\u0085x\u0085)","summary":"요약","detail":"\u0085x\u0085"}},
  {"fn":"cliPreflightFailure","note":"NEL(U+0085)는 안 자름 / 요약 \"\"","args":["","NEL(U+0085)는 안 자름"],"expected":{"ok":false,"reason":" (\u0085x\u0085)","summary":"","detail":"\u0085x\u0085"}},
  {"fn":"describeCliError","note":"BOM·NBSP·줄 구분자","args":["BOM·NBSP·줄 구분자"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"BOM·NBSP·줄 구분자 / 요약 \"요약\"","args":["요약","BOM·NBSP·줄 구분자"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"BOM·NBSP·줄 구분자 / 요약 \"\"","args":["","BOM·NBSP·줄 구분자"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"OSC 링크","args":["OSC 링크"],"expected":"link"},
  {"fn":"cliPreflightFailure","note":"OSC 링크 / 요약 \"요약\"","args":["요약","OSC 링크"],"expected":{"ok":false,"reason":"요약 (link)","summary":"요약","detail":"link"}},
  {"fn":"cliPreflightFailure","note":"OSC 링크 / 요약 \"\"","args":["","OSC 링크"],"expected":{"ok":false,"reason":" (link)","summary":"","detail":"link"}},
  {"fn":"describeCliError","note":"OSC ST 끝","args":["OSC ST 끝"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"OSC ST 끝 / 요약 \"요약\"","args":["요약","OSC ST 끝"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"OSC ST 끝 / 요약 \"\"","args":["","OSC ST 끝"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"끝나지 않은 OSC","args":["끝나지 않은 OSC"],"expected":"0;title"},
  {"fn":"cliPreflightFailure","note":"끝나지 않은 OSC / 요약 \"요약\"","args":["요약","끝나지 않은 OSC"],"expected":{"ok":false,"reason":"요약 (0;title)","summary":"요약","detail":"0;title"}},
  {"fn":"cliPreflightFailure","note":"끝나지 않은 OSC / 요약 \"\"","args":["","끝나지 않은 OSC"],"expected":{"ok":false,"reason":" (0;title)","summary":"","detail":"0;title"}},
  {"fn":"describeCliError","note":"CSI 끝 글자 없음","args":["CSI 끝 글자 없음"],"expected":"\u001b["},
  {"fn":"cliPreflightFailure","note":"CSI 끝 글자 없음 / 요약 \"요약\"","args":["요약","CSI 끝 글자 없음"],"expected":{"ok":false,"reason":"요약 (\u001b[)","summary":"요약","detail":"\u001b["}},
  {"fn":"cliPreflightFailure","note":"CSI 끝 글자 없음 / 요약 \"\"","args":["","CSI 끝 글자 없음"],"expected":{"ok":false,"reason":" (\u001b[)","summary":"","detail":"\u001b["}},
  {"fn":"describeCliError","note":"8비트 CSI","args":["8비트 CSI"],"expected":"red"},
  {"fn":"cliPreflightFailure","note":"8비트 CSI / 요약 \"요약\"","args":["요약","8비트 CSI"],"expected":{"ok":false,"reason":"요약 (red)","summary":"요약","detail":"red"}},
  {"fn":"cliPreflightFailure","note":"8비트 CSI / 요약 \"\"","args":["","8비트 CSI"],"expected":{"ok":false,"reason":" (red)","summary":"","detail":"red"}},
  {"fn":"describeCliError","note":"커서","args":["커서"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"커서 / 요약 \"요약\"","args":["요약","커서"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"커서 / 요약 \"\"","args":["","커서"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"두 글자 이스케이프","args":["두 글자 이스케이프"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"두 글자 이스케이프 / 요약 \"요약\"","args":["요약","두 글자 이스케이프"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"두 글자 이스케이프 / 요약 \"\"","args":["","두 글자 이스케이프"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"ESC 뒤 소문자","args":["ESC 뒤 소문자"],"expected":"\u001bax"},
  {"fn":"cliPreflightFailure","note":"ESC 뒤 소문자 / 요약 \"요약\"","args":["요약","ESC 뒤 소문자"],"expected":{"ok":false,"reason":"요약 (\u001bax)","summary":"요약","detail":"\u001bax"}},
  {"fn":"cliPreflightFailure","note":"ESC 뒤 소문자 / 요약 \"\"","args":["","ESC 뒤 소문자"],"expected":{"ok":false,"reason":" (\u001bax)","summary":"","detail":"\u001bax"}},
  {"fn":"describeCliError","note":"ESC만","args":["ESC만"],"expected":"\u001b"},
  {"fn":"cliPreflightFailure","note":"ESC만 / 요약 \"요약\"","args":["요약","ESC만"],"expected":{"ok":false,"reason":"요약 (\u001b)","summary":"요약","detail":"\u001b"}},
  {"fn":"cliPreflightFailure","note":"ESC만 / 요약 \"\"","args":["","ESC만"],"expected":{"ok":false,"reason":" (\u001b)","summary":"","detail":"\u001b"}},
  {"fn":"describeCliError","note":"ESC 둘","args":["ESC 둘"],"expected":"\u001bx"},
  {"fn":"cliPreflightFailure","note":"ESC 둘 / 요약 \"요약\"","args":["요약","ESC 둘"],"expected":{"ok":false,"reason":"요약 (\u001bx)","summary":"요약","detail":"\u001bx"}},
  {"fn":"cliPreflightFailure","note":"ESC 둘 / 요약 \"\"","args":["","ESC 둘"],"expected":{"ok":false,"reason":" (\u001bx)","summary":"","detail":"\u001bx"}},
  {"fn":"describeCliError","note":"색 코드 속 공백","args":["색 코드 속 공백"],"expected":"x"},
  {"fn":"cliPreflightFailure","note":"색 코드 속 공백 / 요약 \"요약\"","args":["요약","색 코드 속 공백"],"expected":{"ok":false,"reason":"요약 (x)","summary":"요약","detail":"x"}},
  {"fn":"cliPreflightFailure","note":"색 코드 속 공백 / 요약 \"\"","args":["","색 코드 속 공백"],"expected":{"ok":false,"reason":" (x)","summary":"","detail":"x"}},
  {"fn":"describeCliError","note":"색 코드 뒤 공백만","args":["색 코드 뒤 공백만"],"expected":""},
  {"fn":"cliPreflightFailure","note":"색 코드 뒤 공백만 / 요약 \"요약\"","args":["요약","색 코드 뒤 공백만"],"expected":{"ok":false,"reason":"요약","summary":"요약","detail":""}},
  {"fn":"cliPreflightFailure","note":"색 코드 뒤 공백만 / 요약 \"\"","args":["","색 코드 뒤 공백만"],"expected":{"ok":false,"reason":"","summary":"","detail":""}},
  {"fn":"describeCliError","note":"문자열","args":["문자열"],"expected":"Command failed: codex\nx"},
  {"fn":"cliPreflightFailure","note":"문자열 / 요약 \"요약\"","args":["요약","문자열"],"expected":{"ok":false,"reason":"요약 (Command failed: codex\nx)","summary":"요약","detail":"Command failed: codex\nx"}},
  {"fn":"cliPreflightFailure","note":"문자열 / 요약 \"\"","args":["","문자열"],"expected":{"ok":false,"reason":" (Command failed: codex\nx)","summary":"","detail":"Command failed: codex\nx"}},
  {"fn":"describeCliError","note":"빈 문자열","args":["빈 문자열"],"expected":""},
  {"fn":"cliPreflightFailure","note":"빈 문자열 / 요약 \"요약\"","args":["요약","빈 문자열"],"expected":{"ok":false,"reason":"요약","summary":"요약","detail":""}},
  {"fn":"cliPreflightFailure","note":"빈 문자열 / 요약 \"\"","args":["","빈 문자열"],"expected":{"ok":false,"reason":"","summary":"","detail":""}},
  {"fn":"describeCliError","note":"null","args":["null"],"expected":"null"},
  {"fn":"cliPreflightFailure","note":"null / 요약 \"요약\"","args":["요약","null"],"expected":{"ok":false,"reason":"요약 (null)","summary":"요약","detail":"null"}},
  {"fn":"cliPreflightFailure","note":"null / 요약 \"\"","args":["","null"],"expected":{"ok":false,"reason":" (null)","summary":"","detail":"null"}},
  {"fn":"describeCliError","note":"undefined","args":["undefined"],"expected":"undefined"},
  {"fn":"cliPreflightFailure","note":"undefined / 요약 \"요약\"","args":["요약","undefined"],"expected":{"ok":false,"reason":"요약 (undefined)","summary":"요약","detail":"undefined"}},
  {"fn":"cliPreflightFailure","note":"undefined / 요약 \"\"","args":["","undefined"],"expected":{"ok":false,"reason":" (undefined)","summary":"","detail":"undefined"}},
  {"fn":"describeCliError","note":"숫자","args":["숫자"],"expected":"42"},
  {"fn":"cliPreflightFailure","note":"숫자 / 요약 \"요약\"","args":["요약","숫자"],"expected":{"ok":false,"reason":"요약 (42)","summary":"요약","detail":"42"}},
  {"fn":"cliPreflightFailure","note":"숫자 / 요약 \"\"","args":["","숫자"],"expected":{"ok":false,"reason":" (42)","summary":"","detail":"42"}},
  {"fn":"describeCliError","note":"객체","args":["객체"],"expected":"[object Object]"},
  {"fn":"cliPreflightFailure","note":"객체 / 요약 \"요약\"","args":["요약","객체"],"expected":{"ok":false,"reason":"요약 ([object Object])","summary":"요약","detail":"[object Object]"}},
  {"fn":"cliPreflightFailure","note":"객체 / 요약 \"\"","args":["","객체"],"expected":{"ok":false,"reason":" ([object Object])","summary":"","detail":"[object Object]"}},
  {"fn":"describeCliError","note":"message만 있는 객체","args":["message만 있는 객체"],"expected":"[object Object]"},
  {"fn":"cliPreflightFailure","note":"message만 있는 객체 / 요약 \"요약\"","args":["요약","message만 있는 객체"],"expected":{"ok":false,"reason":"요약 ([object Object])","summary":"요약","detail":"[object Object]"}},
  {"fn":"cliPreflightFailure","note":"message만 있는 객체 / 요약 \"\"","args":["","message만 있는 객체"],"expected":{"ok":false,"reason":" ([object Object])","summary":"","detail":"[object Object]"}},
  {"fn":"describeCliError","note":"toString이 있는 객체","args":["toString이 있는 객체"],"expected":"obj"},
  {"fn":"cliPreflightFailure","note":"toString이 있는 객체 / 요약 \"요약\"","args":["요약","toString이 있는 객체"],"expected":{"ok":false,"reason":"요약 (obj)","summary":"요약","detail":"obj"}},
  {"fn":"cliPreflightFailure","note":"toString이 있는 객체 / 요약 \"\"","args":["","toString이 있는 객체"],"expected":{"ok":false,"reason":" (obj)","summary":"","detail":"obj"}},
  {"fn":"describeCliError","note":"배열","args":["배열"],"expected":"1,2,"},
  {"fn":"cliPreflightFailure","note":"배열 / 요약 \"요약\"","args":["요약","배열"],"expected":{"ok":false,"reason":"요약 (1,2,)","summary":"요약","detail":"1,2,"}},
  {"fn":"cliPreflightFailure","note":"배열 / 요약 \"\"","args":["","배열"],"expected":{"ok":false,"reason":" (1,2,)","summary":"","detail":"1,2,"}},
  {"fn":"describeCliError","note":"TypeError","args":["TypeError"],"expected":"boom"},
  {"fn":"cliPreflightFailure","note":"TypeError / 요약 \"요약\"","args":["요약","TypeError"],"expected":{"ok":false,"reason":"요약 (boom)","summary":"요약","detail":"boom"}},
  {"fn":"cliPreflightFailure","note":"TypeError / 요약 \"\"","args":["","TypeError"],"expected":{"ok":false,"reason":" (boom)","summary":"","detail":"boom"}},
  {"fn":"describeCliError","note":"cause는 안 봄","args":["cause는 안 봄"],"expected":"outer"},
  {"fn":"cliPreflightFailure","note":"cause는 안 봄 / 요약 \"요약\"","args":["요약","cause는 안 봄"],"expected":{"ok":false,"reason":"요약 (outer)","summary":"요약","detail":"outer"}},
  {"fn":"cliPreflightFailure","note":"cause는 안 봄 / 요약 \"\"","args":["","cause는 안 봄"],"expected":{"ok":false,"reason":" (outer)","summary":"","detail":"outer"}},
  {"fn":"describeCliError","note":"Symbol.toPrimitive","args":["Symbol.toPrimitive"],"expected":"p"},
  {"fn":"cliPreflightFailure","note":"Symbol.toPrimitive / 요약 \"요약\"","args":["요약","Symbol.toPrimitive"],"expected":{"ok":false,"reason":"요약 (p)","summary":"요약","detail":"p"}},
  {"fn":"cliPreflightFailure","note":"Symbol.toPrimitive / 요약 \"\"","args":["","Symbol.toPrimitive"],"expected":{"ok":false,"reason":" (p)","summary":"","detail":"p"}},
  {"fn":"describeCliError","note":"true","args":["true"],"expected":"true"},
  {"fn":"cliPreflightFailure","note":"true / 요약 \"요약\"","args":["요약","true"],"expected":{"ok":false,"reason":"요약 (true)","summary":"요약","detail":"true"}},
  {"fn":"cliPreflightFailure","note":"true / 요약 \"\"","args":["","true"],"expected":{"ok":false,"reason":" (true)","summary":"","detail":"true"}},
  {"fn":"describeCliError","note":"한글","args":["한글"],"expected":"로그인 필요"},
  {"fn":"cliPreflightFailure","note":"한글 / 요약 \"요약\"","args":["요약","한글"],"expected":{"ok":false,"reason":"요약 (로그인 필요)","summary":"요약","detail":"로그인 필요"}},
  {"fn":"cliPreflightFailure","note":"한글 / 요약 \"\"","args":["","한글"],"expected":{"ok":false,"reason":" (로그인 필요)","summary":"","detail":"로그인 필요"}},
  {"fn":"describeCliError","note":"긴 줄","args":["긴 줄"],"expected":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},
  {"fn":"cliPreflightFailure","note":"긴 줄 / 요약 \"요약\"","args":["요약","긴 줄"],"expected":{"ok":false,"reason":"요약 (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)","summary":"요약","detail":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}},
  {"fn":"cliPreflightFailure","note":"긴 줄 / 요약 \"\"","args":["","긴 줄"],"expected":{"ok":false,"reason":" (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)","summary":"","detail":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}},
];

type Managed = Array<[string, { path: string; includes?: string[] }]>;

function project(managed: Managed, root: string | null, composePath: string | null): LoadedProject {
  return { managed, ...(root === null ? {} : { root }), ...(composePath === null ? {} : { composePath }) } as unknown as LoadedProject;
}

function run(vector: Vector): unknown {
  const a = vector.args;
  switch (vector.fn) {
    case 'ownsFile':
      return ownsFile({ path: a[0] as string, ...(a[1] === null ? {} : { includes: a[1] as string[] }) }, a[2] as string);
    case 'isComposeFile':
      return isComposeFile({ root: a[0] as string, composePath: a[1] as string }, a[2] as string);
    case 'servicesForFiles':
      return servicesForFiles(project(a[0] as Managed, a[1] as string | null, a[2] as string | null), a[3] as string[]);
    case 'describeCliError':
      return describeCliError(ERRORS[a[0] as string]!());
    case 'cliPreflightFailure':
      return cliPreflightFailure(a[0] as string, ERRORS[a[1] as string]!());
  }
}

describe('서비스 소유 판정·CLI 실패 설명 벡터(옛 TS 구현의 값)', () => {
  it('벡터 수와 종류', () => {
    const counts: Record<string, number> = {};
    for (const v of VECTORS) counts[v.fn] = (counts[v.fn] ?? 0) + 1;
    expect(counts['ownsFile']).toBeGreaterThanOrEqual(50);
    expect(counts['isComposeFile']).toBeGreaterThanOrEqual(30);
    expect(counts['servicesForFiles']).toBeGreaterThanOrEqual(40);
    expect(counts['describeCliError']).toBeGreaterThanOrEqual(30);
    expect(counts['cliPreflightFailure']).toBeGreaterThanOrEqual(60);
    for (const key of Object.keys(ERRORS)) expect(VECTORS.some((v) => v.fn === 'describeCliError' && v.args[0] === key), key).toBe(true);
  });

  it('참과 거짓이 모두 있다(한쪽으로 몰린 벡터로 통과하지 않게)', () => {
    for (const fn of ['ownsFile', 'isComposeFile'] as const) {
      const values = VECTORS.filter((v) => v.fn === fn).map((v) => v.expected);
      expect(values).toContain(true);
      expect(values).toContain(false);
    }
    const mapped = VECTORS.filter((v) => v.fn === 'servicesForFiles').map((v) => v.expected as { services: string[]; unmatched: string[] });
    expect(mapped.some((m) => m.services.length === 0)).toBe(true);
    expect(mapped.some((m) => m.unmatched.length === 0)).toBe(true);
    expect(mapped.some((m) => m.services.length > 1)).toBe(true);
  });

  for (const [index, vector] of VECTORS.entries()) {
    it(`#${index} ${vector.fn}: ${vector.note}`, () => {
      expect(JSON.stringify(run(vector))).toBe(JSON.stringify(vector.expected));
    });
  }

  it('의도한 차이: 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(오류 글·요약)', () => {
    expect(describeCliError(new Error('a\ud800b'))).toBe('a�b');
    expect(cliPreflightFailure('요\udc00약', new Error('x')).reason).toBe('요�약 (x)');
  });

  it('짝 없는 서로게이트가 든 파일 이름도 unmatched에는 입력 그대로 돌려준다', () => {
    const lone = 'zz/\ud800';
    const p = project([['s', { path: 'a' }]], '/p', '/p/compose.yaml');
    expect(servicesForFiles(p, [lone, 'a/x'])).toEqual({ services: ['s'], unmatched: [lone] });
  });

  it('모양이 어긋난 입력은 던진다(path가 문자열이 아님)', () => {
    const p = { managed: [['s', {}]], root: '/p', composePath: '/p/c.yaml' } as unknown as LoadedProject;
    expect(() => servicesForFiles(p, ['a'])).toThrow();
  });
});

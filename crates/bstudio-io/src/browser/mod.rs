//! 화면 확인 러너를 Rust로(ADR-199, ADR-195 4f A6a). 게이트가 부르는 `runInBrowser`(Playwright)와 같은 결과를 내는 CDP 러너.
//!
//! - [`cdp`]: `--remote-debugging-pipe`(NUL로 끝나는 JSON 틀) 위의 CDP 연결
//! - [`launch`]: Chromium 실행(Playwright와 같은 인자, 임시 프로필 폴더)
//! - [`frames`]: Playwright의 프레임·생명주기·networkidle 규칙의 옮김
//! - [`console_text`]: console 인자·예외를 Playwright와 같은 글로
//! - [`origin`]·[`proxy`]: 출처 제한 두 층(요청 가로채기의 판정, 로컬 전달 프록시)
//! - [`run`]: 위를 묶어 페이지를 열고 결과를 모은다
//!
//! 단계(`click`·`fill`·`press`·`waitFor`)와 스크린샷, 격리된 실행 환경(utility world)은 A6b에서 더했다([`keyboard`]·`run/steps`·`run/utility`).
//! 화면 중계와 게이트 기본값 전환은 A6c다.

pub mod cdp;
pub mod console_text;
pub mod frames;
pub mod keyboard;
pub mod launch;
pub mod origin;
pub mod proxy;
pub mod run;

pub use run::{run_in_browser, BrowserRunInput, BrowserRunOutput, BrowserStepAction, BrowserStepInput, BrowserStepRecord, RunError};

//! 격리된 실행 환경(utility world)과 그 안의 주입 스크립트(ADR-199 A6b).
//!
//! Playwright는 선택자 판정과 보임·활성·안정 확인을 `Page.createIsolatedWorld`로 만든 실행 환경에서 한다(소스: `FrameExecutionContext`의
//! `injectedScript()`, `world === "utility"`). DOM은 페이지와 같지만 전역(`Array.prototype`, `Math`, `HTMLElement.prototype`의 접근자 등)은
//! 따로라서, 모델이 만든 페이지가 전역을 바꿔도 이 환경에서 읽은 값은 영향을 받지 않는다. 화면 글자·가로 넘침·`viewportTexts`·로드 시간의 측정도
//! 같은 환경에서 읽는다(옛 러너는 페이지와 같은 환경에서 읽어 위조된 값을 받을 수 있었다. 의도한 차이).
//!
//! 새 문서가 열리면 실행 환경이 사라진다. 새 문서마다(`Page.frameNavigated`), 실행 환경이 사라졌다는 알림(`executionContextDestroyed`·
//! `executionContextsCleared`)마다 지금 것을 버리고 다음에 쓸 때 다시 만든다. 옛 id로 평가하면 "없음"으로 읽히거나 오류가 나므로, 쓰기 전에 항상
//! 지금 것이 유효한지 본다([`UtilityWorld::current`]).

use super::{send_ok_raw, Shared, StepError};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

/// 격리된 실행 환경의 이름
pub(super) const WORLD_NAME: &str = "b_studio_utility";

/// 주입 스크립트(Playwright 1.63.0 `injectedScriptSource`, Apache-2.0. `third_party/playwright/SOURCES`)
const INJECTED_SOURCE: &str = include_str!("../third_party/playwright/injected_script_source.js");

/// Playwright가 크로미움의 utility world에 넘기는 옵션(`FrameExecutionContext.injectedScript()`)
const INJECTED_OPTIONS: &str = r#"{"isUnderTest":false,"sdkLanguage":"javascript","frameSeq":0,"testIdAttributeName":"data-testid","stableRafCount":1,"browserName":"chromium","shouldPrependErrorPrefix":false,"isUtilityWorld":true,"customEngines":[]}"#;

/// 주입 스크립트를 만들어 `InjectedScript` 객체를 돌려주는 식
pub(super) fn injected_expression() -> String {
    format!("(() => {{\nconst module = {{}};\n{INJECTED_SOURCE}\nreturn new (module.exports.InjectedScript())(globalThis, {INJECTED_OPTIONS});\n}})()")
}

/// 만들어 둔 실행 환경: 컨텍스트 id와 그 안의 `InjectedScript` 객체
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UtilityHandle {
    pub context_id: i64,
    pub injected: String,
    generation: u64,
}

/// 실행 환경의 유효성 기록. 순수한 상태라 브라우저 없이 시험한다
#[derive(Debug, Default)]
pub(super) struct UtilityWorld {
    generation: u64,
    handle: Option<UtilityHandle>,
}

impl UtilityWorld {
    /// 지금 쓸 수 있는 실행 환경. 새 문서·사라짐 알림이 있었으면 없다(다시 만들어야 한다)
    pub fn current(&self) -> Option<UtilityHandle> {
        self.handle.clone().filter(|handle| handle.generation == self.generation)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 새 문서가 열렸거나 실행 환경이 모두 사라졌다
    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.handle = None;
    }

    /// 실행 환경 하나가 사라졌다는 알림. 우리 것이면 버린다
    pub fn context_destroyed(&mut self, context_id: i64) {
        if self.handle.as_ref().is_some_and(|handle| handle.context_id == context_id) {
            self.invalidate();
        }
    }

    /// 만든 것을 저장한다. 만드는 도중에 새 문서가 열렸으면(`generation`이 달라졌으면) 저장하지 않는다
    pub fn store(&mut self, context_id: i64, injected: String, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        self.handle = Some(UtilityHandle { context_id, injected, generation });
        true
    }
}

/// 실행 환경이 사라져 평가가 실패한 오류 글인가(다시 만들어 다시 시도할 수 있는 실패)
pub(super) fn is_context_gone(message: &str) -> bool {
    [
        "Cannot find context with specified id",
        "Execution context was destroyed",
        "Could not find object with given id",
        "Cannot find object with id",
        "Inspected target navigated or closed",
        "No frame for given id found",
        "Target closed",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// 지금 문서의 격리된 실행 환경을 돌려준다. 없으면(새 문서가 열렸으면) 만들어 주입 스크립트를 올린다
pub(super) async fn ensure(shared: &Arc<Shared>, session: &str, deadline: Instant) -> Result<UtilityHandle, StepError> {
    let (generation, frame) = {
        let mut state = shared.state.lock().unwrap();
        if let Some(reason) = state.fatal() {
            return Err(StepError::Fatal(reason));
        }
        if let Some(handle) = state.utility.current() {
            return Ok(handle);
        }
        (state.utility.generation(), state.frames().main_frame_id().unwrap_or_default().to_owned())
    };
    // 문서 안에서 실행 환경을 만들 때 쓰는 매개변수 이름은 CDP의 철자(`grantUniveralAccess`)를 따른다
    let world = send_ok_raw(shared, Some(session), "Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": WORLD_NAME, "grantUniveralAccess": true }), deadline).await?;
    let context_id = world.get("executionContextId").and_then(Value::as_i64).ok_or_else(|| StepError::NonRetriable("격리된 실행 환경의 id를 받지 못했습니다".to_owned()))?;
    let injected = send_ok_raw(shared, Some(session), "Runtime.evaluate", json!({ "expression": injected_expression(), "contextId": context_id, "returnByValue": false }), deadline).await?;
    if let Some(details) = injected.get("exceptionDetails") {
        let text = details.pointer("/exception/description").and_then(Value::as_str).or_else(|| details.get("text").and_then(Value::as_str)).unwrap_or("");
        let first = text.lines().next().unwrap_or("");
        return Err(if is_context_gone(first) { StepError::ContextGone } else { StepError::NonRetriable(format!("주입 스크립트를 올리지 못했습니다: {first}")) });
    }
    let object_id = injected.pointer("/result/objectId").and_then(Value::as_str).ok_or_else(|| StepError::NonRetriable("주입 스크립트의 객체를 받지 못했습니다".to_owned()))?.to_owned();
    let stored = shared.state.lock().unwrap().utility.store(context_id, object_id.clone(), generation);
    if !stored {
        // 만드는 도중에 새 문서가 열렸다. 이 환경은 이미 사라진 문서의 것이다
        return Err(StepError::ContextGone);
    }
    Ok(UtilityHandle { context_id, injected: object_id, generation })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_current_until_one_is_stored() {
        let world = UtilityWorld::default();
        assert_eq!(world.current(), None);
    }

    #[test]
    fn a_new_document_discards_the_world_and_the_next_use_recreates_it() {
        let mut world = UtilityWorld::default();
        assert!(world.store(7, "obj-1".to_owned(), world.generation()));
        assert_eq!(world.current().map(|handle| (handle.context_id, handle.injected)), Some((7, "obj-1".to_owned())));
        // 새 문서(`Page.frameNavigated`): 옛 id로 평가하지 않는다
        world.invalidate();
        assert_eq!(world.current(), None);
        assert!(world.store(9, "obj-2".to_owned(), world.generation()));
        assert_eq!(world.current().unwrap().context_id, 9);
    }

    #[test]
    fn a_world_built_while_the_document_changed_is_not_kept() {
        let mut world = UtilityWorld::default();
        let started = world.generation();
        // 만드는 도중에 새 문서가 열렸다
        world.invalidate();
        assert!(!world.store(7, "stale".to_owned(), started));
        assert_eq!(world.current(), None);
    }

    #[test]
    fn only_the_destruction_of_our_own_context_discards_it() {
        let mut world = UtilityWorld::default();
        world.store(7, "obj".to_owned(), 0);
        world.context_destroyed(8);
        assert!(world.current().is_some());
        world.context_destroyed(7);
        assert_eq!(world.current(), None);
    }

    #[test]
    fn evaluation_errors_that_mean_the_world_is_gone_are_told_apart() {
        for message in ["Cannot find context with specified id", "Execution context was destroyed, most likely because of a navigation.", "Could not find object with given id", "Inspected target navigated or closed"] {
            assert!(is_context_gone(message), "{message}");
        }
        for message in ["Error: Element is not an <input>", "Unexpected token", ""] {
            assert!(!is_context_gone(message), "{message}");
        }
    }

    #[test]
    fn the_injected_expression_wraps_the_pinned_source_with_chromiums_utility_options() {
        let expression = injected_expression();
        assert!(expression.contains("Playwright 1.63.0"));
        assert!(expression.contains("\"isUtilityWorld\":true") && expression.contains("\"browserName\":\"chromium\"") && expression.contains("\"stableRafCount\":1"));
        assert!(expression.contains("module.exports.InjectedScript()"));
    }
}

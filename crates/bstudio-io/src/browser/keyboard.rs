//! `press` 단계의 키 해석(ADR-199 A6b). Playwright의 `Keyboard.press`·`_keyDescriptionForString`·`buildLayoutClosure`와 크로미움의
//! `RawKeyboardImpl`(`crInput.ts`)을 옮겼다. 키 표(`us_keyboard_layout.json`)와 맥 편집 명령 표(`mac_editing_commands.json`)는
//! `third_party/playwright/extract.mjs`가 원본에서 그대로 떼어 낸 것이다(손으로 줄이지 않았다).
//!
//! 순서는 Playwright와 같다: `Control+Shift+A`는 앞 토큰을 차례로 누르고, 마지막 키를 누르고 떼고, 앞 토큰을 거꾸로 뗀다.
//! 모르는 키는 그 키를 누르기 전에 오류가 되지만 앞서 누른 수정 키의 눌림은 이미 브라우저로 나갔다(`press`가 둘을 함께 돌려준다).

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const KEYPAD_LOCATION: i64 = 3;
const MODIFIERS: [&str; 4] = ["Alt", "Control", "Meta", "Shift"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDescription {
    pub key: String,
    pub key_code: i64,
    pub key_code_without_location: i64,
    pub code: String,
    pub text: String,
    pub location: i64,
    pub shifted: Option<Box<KeyDescription>>,
}

pub struct Layout {
    map: HashMap<String, KeyDescription>,
}

fn as_i64(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

fn as_str<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

/// 별칭: `buildLayoutClosure`의 `aliases`와 같다
fn aliases(code: &str) -> &'static [&'static str] {
    match code {
        "ShiftLeft" => &["Shift"],
        "ControlLeft" => &["Control"],
        "AltLeft" => &["Alt"],
        "MetaLeft" => &["Meta"],
        "Enter" => &["\n", "\r"],
        _ => &[],
    }
}

/// `buildLayoutClosure`: 코드 하나에서 코드 이름·글자·시프트 글자로도 찾을 수 있는 표를 만든다
pub fn build_layout(layout: &Map<String, Value>) -> Layout {
    let mut map = HashMap::new();
    for (code, definition) in layout {
        let key = as_str(definition, "key").to_owned();
        let key_code = as_i64(definition, "keyCode");
        let without_location = match as_i64(definition, "keyCodeWithoutLocation") {
            0 => key_code,
            other => other,
        };
        let mut description = KeyDescription { key: key.clone(), key_code, key_code_without_location: without_location, code: code.clone(), text: as_str(definition, "text").to_owned(), location: as_i64(definition, "location"), shifted: None };
        if key.chars().count() == 1 {
            description.text = key.clone();
        }
        let shift_key = as_str(definition, "shiftKey");
        let shifted = (!shift_key.is_empty()).then(|| {
            let mut shifted = description.clone();
            shifted.key = shift_key.to_owned();
            shifted.text = shift_key.to_owned();
            if let Some(code) = definition.get("shiftKeyCode").and_then(Value::as_i64).filter(|code| *code != 0) {
                shifted.key_code = code;
            }
            shifted
        });
        map.insert(code.clone(), KeyDescription { shifted: shifted.clone().map(Box::new), ..description.clone() });
        for alias in aliases(code) {
            map.insert((*alias).to_owned(), description.clone());
        }
        if description.location != 0 {
            continue;
        }
        if description.key.chars().count() == 1 {
            map.insert(description.key.clone(), description.clone());
        }
        if let Some(shifted) = shifted {
            map.insert(shifted.key.clone(), KeyDescription { shifted: None, ..shifted });
        }
    }
    Layout { map }
}

fn us_layout() -> &'static Layout {
    static LAYOUT: OnceLock<Layout> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        let json: Value = serde_json::from_str(include_str!("third_party/playwright/us_keyboard_layout.json")).expect("키 표는 올바른 JSON이다");
        build_layout(json.as_object().expect("키 표는 객체다"))
    })
}

fn mac_editing_commands() -> &'static Map<String, Value> {
    static COMMANDS: OnceLock<Map<String, Value>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        let json: Value = serde_json::from_str(include_str!("third_party/playwright/mac_editing_commands.json")).expect("맥 명령 표는 올바른 JSON이다");
        json.as_object().cloned().expect("맥 명령 표는 객체다")
    })
}

/// `ControlOrMeta`는 호스트가 맥이면 Meta, 아니면 Control이다(Playwright `resolveSmartModifierString`은 `process.platform`을 본다)
fn resolve_smart_modifier(key: &str, mac: bool) -> String {
    if key == "ControlOrMeta" {
        return if mac { "Meta" } else { "Control" }.to_owned();
    }
    key.to_owned()
}

/// `Keyboard.press`의 `split`: `+`가 앞에 글자가 있을 때만 구분자다(`Control++`는 `Control`과 `+`, 맨 앞의 `+`는 글자)
pub fn split_key(key: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut building = String::new();
    for ch in key.chars() {
        if ch == '+' && !building.is_empty() {
            keys.push(std::mem::take(&mut building));
        } else {
            building.push(ch);
        }
    }
    keys.push(building);
    keys
}

fn modifiers_mask(modifiers: &HashSet<String>) -> i64 {
    let mut mask = 0;
    if modifiers.contains("Alt") {
        mask |= 1;
    }
    if modifiers.contains("Control") {
        mask |= 2;
    }
    if modifiers.contains("Meta") {
        mask |= 4;
    }
    if modifiers.contains("Shift") {
        mask |= 8;
    }
    mask
}

/// 키보드가 기억하는 눌림(`Keyboard._pressedModifiers`·`_pressedKeys`). `press`는 늘 짝을 맞춰 떼므로 한 단계가 끝나면 비어 있다
pub struct Keyboard {
    layout: &'static Layout,
    mac: bool,
    pressed_modifiers: HashSet<String>,
    pressed_keys: HashSet<String>,
}

impl Keyboard {
    /// 호스트 플랫폼의 키보드
    pub fn new() -> Self {
        Self::with(us_layout(), cfg!(target_os = "macos"))
    }

    pub fn with(layout: &'static Layout, mac: bool) -> Self {
        Self { layout, mac, pressed_modifiers: HashSet::new(), pressed_keys: HashSet::new() }
    }

    /// `_keyDescriptionForString`
    fn describe(&self, key: &str) -> Result<KeyDescription, String> {
        let key_string = resolve_smart_modifier(key, self.mac);
        let description = self.layout.map.get(&key_string).ok_or_else(|| format!("Unknown key: \"{key_string}\""))?;
        let shift = self.pressed_modifiers.contains("Shift");
        let description = match (&description.shifted, shift) {
            (Some(shifted), true) => (**shifted).clone(),
            _ => description.clone(),
        };
        if self.pressed_modifiers.len() > 1 || (!shift && self.pressed_modifiers.len() == 1) {
            return Ok(KeyDescription { text: String::new(), ..description });
        }
        Ok(description)
    }

    /// `RawKeyboardImpl._commandsForCode`: 맥에서만 편집 명령을 붙인다(`insert…`는 뺀다)
    fn commands_for_code(&self, code: &str) -> Vec<String> {
        if !self.mac {
            return Vec::new();
        }
        let mut parts: Vec<&str> = ["Shift", "Control", "Alt", "Meta"].into_iter().filter(|modifier| self.pressed_modifiers.contains(*modifier)).collect();
        parts.push(code);
        let shortcut = parts.join("+");
        let commands: Vec<String> = match mac_editing_commands().get(&shortcut) {
            Some(Value::String(command)) => vec![command.clone()],
            Some(Value::Array(commands)) => commands.iter().filter_map(|command| command.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        commands.into_iter().filter(|command| !command.starts_with("insert")).map(|command| command[..command.len() - 1].to_owned()).collect()
    }

    /// `Keyboard.down`: 눌린 키를 기억하고 `Input.dispatchKeyEvent` 매개변수를 돌려준다
    fn down(&mut self, key: &str) -> Result<Value, String> {
        let description = self.describe(key)?;
        let auto_repeat = self.pressed_keys.contains(&description.code);
        self.pressed_keys.insert(description.code.clone());
        if MODIFIERS.contains(&description.key.as_str()) {
            self.pressed_modifiers.insert(description.key.clone());
        }
        let commands = self.commands_for_code(&description.code);
        Ok(json!({
            "type": if description.text.is_empty() { "rawKeyDown" } else { "keyDown" },
            "modifiers": modifiers_mask(&self.pressed_modifiers),
            "windowsVirtualKeyCode": description.key_code_without_location,
            "code": description.code,
            "commands": commands,
            "key": description.key,
            "text": description.text,
            "unmodifiedText": description.text,
            "autoRepeat": auto_repeat,
            "location": description.location,
            "isKeypad": description.location == KEYPAD_LOCATION,
        }))
    }

    /// `Keyboard.up`
    fn up(&mut self, key: &str) -> Result<Value, String> {
        let description = self.describe(key)?;
        if MODIFIERS.contains(&description.key.as_str()) {
            self.pressed_modifiers.remove(&description.key);
        }
        self.pressed_keys.remove(&description.code);
        Ok(json!({
            "type": "keyUp",
            "modifiers": modifiers_mask(&self.pressed_modifiers),
            "key": description.key,
            "windowsVirtualKeyCode": description.key_code_without_location,
            "code": description.code,
            "location": description.location,
        }))
    }

    /// `Keyboard.press(key)`: 브라우저로 보낼 `Input.dispatchKeyEvent` 매개변수를 순서대로, 그리고 도중에 난 오류를 함께 돌려준다.
    /// 오류가 나도 그 앞의 이벤트는 이미 보낸 것으로 친다(수정 키가 눌린 채 남는 것까지 Playwright와 같다)
    pub fn press(&mut self, key: &str) -> (Vec<Value>, Option<String>) {
        let tokens = split_key(key);
        let last = tokens.last().cloned().unwrap_or_default();
        let modifiers = &tokens[..tokens.len() - 1];
        let mut events = Vec::new();
        for token in modifiers {
            match self.down(token) {
                Ok(event) => events.push(event),
                Err(error) => return (events, Some(error)),
            }
        }
        match self.down(&last) {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
        match self.up(&last) {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
        for token in modifiers.iter().rev() {
            match self.up(token) {
                Ok(event) => events.push(event),
                Err(error) => return (events, Some(error)),
            }
        }
        (events, None)
    }
}

impl Default for Keyboard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyboard(mac: bool) -> Keyboard {
        Keyboard::with(us_layout(), mac)
    }

    fn summary(events: &[Value]) -> Vec<String> {
        events.iter().map(|event| format!("{}:{}:{}", event["type"].as_str().unwrap(), event["key"].as_str().unwrap(), event["modifiers"])).collect()
    }

    #[test]
    fn split_follows_playwright_rules_for_plus_signs() {
        assert_eq!(split_key("Enter"), vec!["Enter"]);
        assert_eq!(split_key("Control+A"), vec!["Control", "A"]);
        assert_eq!(split_key("Control+Shift+A"), vec!["Control", "Shift", "A"]);
        // 맨 앞의 `+`는 글자, `Control++`는 Control과 `+`
        assert_eq!(split_key("+"), vec!["+"]);
        assert_eq!(split_key("Control++"), vec!["Control", "+"]);
        assert_eq!(split_key("A+"), vec!["A", ""]);
        assert_eq!(split_key(""), vec![""]);
    }

    #[test]
    fn a_modifier_combination_presses_in_order_and_releases_in_reverse() {
        let (events, error) = keyboard(false).press("Control+Shift+KeyB");
        assert_eq!(error, None);
        assert_eq!(
            summary(&events),
            vec!["rawKeyDown:Control:2", "rawKeyDown:Shift:10", "rawKeyDown:B:10", "keyUp:B:10", "keyUp:Shift:2", "keyUp:Control:0"].into_iter().map(str::to_owned).collect::<Vec<_>>()
        );
    }

    #[test]
    fn modifier_only_events_have_no_text_and_a_plain_letter_has() {
        let (events, _) = keyboard(false).press("a");
        assert_eq!(events[0]["type"], "keyDown");
        assert_eq!(events[0]["text"], "a");
        assert_eq!(events[0]["code"], "KeyA");
        assert_eq!(events[0]["windowsVirtualKeyCode"], 65);
        assert_eq!(events[1]["type"], "keyUp");
        // 시프트가 눌려 있으면 시프트 글자, 시프트만 눌렸을 때는 text가 남는다
        let (events, _) = keyboard(false).press("Shift+KeyA");
        assert_eq!(events[1]["key"], "A");
        assert_eq!(events[1]["text"], "A");
        // 글자 `a`로 찾은 키에는 시프트 글자가 없다: Playwright도 `Shift+a`는 소문자다
        assert_eq!(keyboard(false).press("Shift+a").0[1]["key"], "a");
        assert_eq!(events[0]["type"], "rawKeyDown");
        assert_eq!(events[0]["key"], "Shift");
        // 수정 키가 둘 이상이거나 시프트가 아닌 하나면 text가 비어 rawKeyDown이 된다
        let (events, _) = keyboard(false).press("Control+a");
        assert_eq!(events[1]["type"], "rawKeyDown");
        assert_eq!(events[1]["text"], "");
    }

    #[test]
    fn enter_has_a_return_text_and_the_numpad_is_a_keypad_key() {
        let (events, _) = keyboard(false).press("Enter");
        assert_eq!(events[0]["text"], "\r");
        assert_eq!(events[0]["windowsVirtualKeyCode"], 13);
        assert_eq!(events[0]["isKeypad"], false);
        let (events, _) = keyboard(false).press("NumpadEnter");
        assert_eq!(events[0]["location"], 3);
        assert_eq!(events[0]["isKeypad"], true);
        // `\n`·`\r`도 Enter의 별칭이다
        assert_eq!(keyboard(false).press("\n").0[0]["code"], "Enter");
    }

    #[test]
    fn control_or_meta_resolves_by_host_platform() {
        let (mac, _) = keyboard(true).press("ControlOrMeta+A");
        assert_eq!(mac[0]["key"], "Meta");
        let (other, _) = keyboard(false).press("ControlOrMeta+A");
        assert_eq!(other[0]["key"], "Control");
    }

    #[test]
    fn mac_editing_commands_come_only_on_a_mac_and_never_the_insert_ones() {
        let (mac, _) = keyboard(true).press("Meta+KeyZ");
        assert_eq!(mac[1]["commands"], json!(["undo"]));
        let (other, _) = keyboard(false).press("Meta+KeyZ");
        assert_eq!(other[1]["commands"], json!([]));
        let (mac, _) = keyboard(true).press("ArrowDown");
        assert_eq!(mac[0]["commands"], json!(["moveDown"]));
        // `Enter`의 `insertNewline:`처럼 insert로 시작하는 명령은 뺀다(글자 입력은 text로 간다)
        let (mac, _) = keyboard(true).press("Enter");
        assert_eq!(mac[0]["commands"], json!([]));
    }

    #[test]
    fn an_unknown_key_is_an_error_after_the_modifiers_already_went_out() {
        let (events, error) = keyboard(false).press("NoSuchKey");
        assert!(events.is_empty());
        assert_eq!(error.as_deref(), Some("Unknown key: \"NoSuchKey\""));
        let (events, error) = keyboard(false).press("Control+NoSuchKey");
        assert_eq!(summary(&events), vec!["rawKeyDown:Control:2".to_owned()]);
        assert_eq!(error.as_deref(), Some("Unknown key: \"NoSuchKey\""));
        // 알 수 없는 수정 키 토큰도 같다
        let (events, error) = keyboard(false).press("Nope+A");
        assert!(events.is_empty());
        assert_eq!(error.as_deref(), Some("Unknown key: \"Nope\""));
        // 빈 키
        assert_eq!(keyboard(false).press("").1.as_deref(), Some("Unknown key: \"\""));
    }

    #[test]
    fn a_repeated_down_of_the_same_code_is_an_auto_repeat() {
        let mut board = keyboard(false);
        let first = board.down("a").unwrap();
        let second = board.down("a").unwrap();
        assert_eq!(first["autoRepeat"], false);
        assert_eq!(second["autoRepeat"], true);
        board.up("a").unwrap();
        assert_eq!(board.down("a").unwrap()["autoRepeat"], false);
    }

    #[test]
    fn the_layout_closure_finds_keys_by_code_character_and_shifted_character() {
        let layout = &us_layout().map;
        assert_eq!(layout["KeyA"].key, "a");
        assert_eq!(layout["a"].code, "KeyA");
        assert_eq!(layout["A"].key, "A");
        assert_eq!(layout["A"].shifted, None);
        assert_eq!(layout["Digit1"].shifted.as_ref().unwrap().key, "!");
        assert_eq!(layout["!"].code, "Digit1");
        // 키패드 키는 location이 있어 글자(`7`)로 찾으면 위쪽 숫자 줄의 키가 나온다
        assert_eq!(layout["Numpad7"].location, 3);
        assert_eq!(layout["7"].code, "Digit7");
        assert_eq!(layout["Backspace"].key, "Backspace");
        assert!(layout.len() > 200);
    }
}

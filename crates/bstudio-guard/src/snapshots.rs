//! 기동 가속용 스냅샷 볼륨의 이름과 정리 대상(옛 TS: `packages/sandbox/src/docker/snapshots.ts`).

use crate::js::{self, to_fixed};
use crate::js_json::JsValue;

/// 같은 자리(프로젝트·서비스·볼륨)에 남길 스냅샷 수
pub const SNAPSHOTS_TO_KEEP: f64 = 2.0;

/// SHA-256(FIPS 180-4). 바깥 의존성 없이 스냅샷 이름의 해시만 계산한다
pub struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.length += data.len() as u64;
        while !data.is_empty() {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.length * 8;
        self.update(&[0x80]);
        while self.filled != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, add) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(add);
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 스냅샷 볼륨 이름. 같은 프로젝트·서비스·볼륨에서 키 파일 내용이 모두 같을 때만 같은 이름이 된다.
/// 파일은 (경로, 내용) 쌍이고 내용이 없으면(`None`) 파일이 없는 것이다. 경로는 UTF-16 순서로 정렬한다(같은 경로는 넘긴 순서를 지킨다)
pub fn snapshot_name(
    project: &str,
    service: &str,
    volume: &str,
    files: &[(String, Option<Vec<u8>>)],
) -> String {
    let mut hash = Sha256::new();
    hash.update(format!("b-studio-snapshot-v1\0{project}\0{service}\0{volume}\0").as_bytes());
    let sorted = js::stable_sort_by(files.to_vec(), &|a, b| match js::cmp_utf16(&a.0, &b.0) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    });
    for (path, content) in &sorted {
        // 경로와 길이를 함께 넣어 파일 경계가 달라도 같은 해시가 나오지 않게 한다
        let size = content
            .as_ref()
            .map_or_else(|| "MISSING".to_owned(), |c| c.len().to_string());
        hash.update(format!("{path}\0{size}\0").as_bytes());
        if let Some(content) = content {
            hash.update(content);
        }
    }
    format!("b-studio-snapshot-{}", &hex(&hash.finish())[..24])
}

pub fn snapshot_slot(project: &str, service: &str, volume: &str) -> String {
    format!("{project}/{service}/{volume}")
}

/// compose가 만드는 이름 있는 볼륨의 실제 이름: <프로젝트 이름>_<볼륨 키>
pub fn compose_volume_name(compose_project: &str, volume: &str) -> String {
    format!("{compose_project}_{volume}")
}

/// `docker volume inspect --format '{{.Name}} {{.CreatedAt}}'` 출력에서 오래된 스냅샷을 골라 지울 이름을 돌려준다.
/// 시각은 JS `Date.parse`로 읽어야 하므로(옛 TS와 같은 해석) 읽는 함수를 받는다
pub fn snapshots_to_prune(
    inspect_output: &str,
    keep: f64,
    parse_date: &dyn Fn(&str) -> f64,
) -> Vec<String> {
    let mut volumes: Vec<(String, f64)> = Vec::new();
    for line in inspect_output.split('\n') {
        let parts = js::split_ws(line);
        if parts.len() < 2 || parts[0].is_empty() {
            continue;
        }
        let created = parse_date(parts[1]);
        volumes.push((
            parts[0].to_owned(),
            if created.is_nan() || created == 0.0 {
                0.0
            } else {
                created
            },
        ));
    }
    let sorted = js::stable_sort_by(volumes, &|a, b| b.1 - a.1);
    let start = js::relative_start(sorted.len(), keep);
    sorted
        .into_iter()
        .skip(start)
        .map(|(name, _)| name)
        .collect()
}

/// `(ms / 1_000).toFixed(1)초`. `ms`가 없으면 `undefined / 1000`이 NaN이라 "NaN"이 된다
fn seconds(ms: Option<&JsValue>) -> String {
    format!(
        "{}초",
        to_fixed(ms.map_or(f64::NAN, JsValue::to_number) / 1_000.0, 1)
    )
}

/// 스냅샷 사건 한 줄 문구. 알 수 없는 `action`이면 `None`(옛 TS는 `undefined`)
pub fn describe_snapshot_event(event: &JsValue) -> Result<Option<String>, String> {
    if matches!(event, JsValue::Null) {
        return Err("null의 속성을 읽을 수 없습니다".into());
    }
    let text = |k: &str| {
        event
            .prop(k)
            .map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
    };
    let volume = text("volume");
    Ok(match event.prop("action") {
        Some(JsValue::Str(a)) if a == "seeded" => Some(format!(
            "{volume} 볼륨을 스냅샷에서 채웠습니다 ({})",
            seconds(event.prop("elapsedMs"))
        )),
        Some(JsValue::Str(a)) if a == "missing" => {
            Some(format!("{volume} 스냅샷이 없어 처음부터 설치합니다"))
        }
        Some(JsValue::Str(a)) if a == "captured" => Some(format!(
            "{volume} 볼륨을 다음 기동용 스냅샷으로 저장했습니다 ({})",
            seconds(event.prop("elapsedMs"))
        )),
        Some(JsValue::Str(a)) if a == "failed" => {
            let stage = if matches!(event.prop("stage"), Some(JsValue::Str(s)) if s == "seed") {
                "복사"
            } else {
                "저장"
            };
            Some(format!(
                "{volume} 스냅샷 {stage}에 실패해 스냅샷 없이 진행합니다: {}",
                text("reason")
            ))
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256은_표준_값과_같다() {
        let digest = |data: &[u8]| {
            let mut h = Sha256::new();
            h.update(data);
            hex(&h.finish())
        };
        assert_eq!(
            digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(
            digest(&million),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        // 블록 경계(55, 56, 63, 64바이트)
        for n in [55usize, 56, 63, 64, 65, 119, 120] {
            let data = vec![b'x'; n];
            let mut h = Sha256::new();
            for chunk in data.chunks(7) {
                h.update(chunk);
            }
            assert_eq!(hex(&h.finish()), digest(&data), "{n}");
        }
    }

    #[test]
    fn 스냅샷_이름은_내용과_경로_순서에_묶인다() {
        let a = snapshot_name(
            "p",
            "api",
            "node_modules",
            &[
                ("package.json".into(), Some(b"{}".to_vec())),
                ("lock".into(), None),
            ],
        );
        let b = snapshot_name(
            "p",
            "api",
            "node_modules",
            &[
                ("lock".into(), None),
                ("package.json".into(), Some(b"{}".to_vec())),
            ],
        );
        assert_eq!(a, b);
        assert!(a.starts_with("b-studio-snapshot-") && a.len() == "b-studio-snapshot-".len() + 24);
        // 없는 파일과 빈 파일은 다르다
        let empty = snapshot_name("p", "api", "v", &[("f".into(), Some(Vec::new()))]);
        let missing = snapshot_name("p", "api", "v", &[("f".into(), None)]);
        assert_ne!(empty, missing);
    }

    #[test]
    fn 오래된_스냅샷을_고른다() {
        let iso = |s: &str| {
            let n: f64 = s.parse().unwrap_or(f64::NAN);
            n
        };
        let out = "a 3\nb 1\nc 2\n  \nlone\nd 4\ne x\n";
        assert_eq!(snapshots_to_prune(out, 2.0, &iso), vec!["c", "b", "e"]);
        assert_eq!(snapshots_to_prune(out, -1.0, &iso), vec!["e"]);
        assert_eq!(snapshots_to_prune(out, 0.0, &iso).len(), 5);
        assert_eq!(snapshots_to_prune(out, f64::NAN, &iso).len(), 5);
    }

    #[test]
    fn 사건_문구는_초를_한_자리로_쓴다() {
        let ev =
            crate::js_json::parse(r#"{"action":"seeded","volume":"nm","elapsedMs":1250}"#).unwrap();
        assert_eq!(
            describe_snapshot_event(&ev).unwrap().unwrap(),
            "nm 볼륨을 스냅샷에서 채웠습니다 (1.3초)"
        );
        let ev = crate::js_json::parse(
            r#"{"action":"failed","volume":"nm","stage":"capture","reason":"x"}"#,
        )
        .unwrap();
        assert_eq!(
            describe_snapshot_event(&ev).unwrap().unwrap(),
            "nm 스냅샷 저장에 실패해 스냅샷 없이 진행합니다: x"
        );
        let ev = crate::js_json::parse(r#"{"action":"nope"}"#).unwrap();
        assert_eq!(describe_snapshot_event(&ev).unwrap(), None);
        let ev = crate::js_json::parse(r#"{"action":"seeded","volume":"nm"}"#).unwrap();
        assert_eq!(
            describe_snapshot_event(&ev).unwrap().unwrap(),
            "nm 볼륨을 스냅샷에서 채웠습니다 (NaN초)"
        );
    }
}

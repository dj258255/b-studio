//! 모델 선택 판정(ADR-191 3단계 3f). 옛 `packages/agent/src/model-router.ts`의 판정: 후보 점수 계산·정렬·선택, 비용 추정,
//! 토큰 추정, 복잡도·위험도 분류, 실측 통계 모으기, 모델 설정 검증.
//!
//! 점수·비용은 모두 f64이고 JS와 같은 연산 순서로 계산한다(순서가 바뀌면 부동소수 결과와 동점 판정이 달라진다).
//! 모델 목록은 JSON으로 읽기만 하고, 고른 모델은 **원본 배열의 위치**로 돌려준다. TS 껍데기가 그 위치로 원래 객체(참조)를 꺼낸다.
//!
//! 의도한 차이:
//! - 실측 통계는 자기 속성만 본다. 옛 구현은 `stats[model.id]`가 `constructor`·`toString` 같은 `Object.prototype`의 이름이면
//!   그 함수를 통계로 읽었고, `aggregateModelStats`는 `__proto__`·`constructor` id에서 `Object.prototype`에 `runs`를 써 넣었다(버그).
//! - 같은 점수의 모델을 id로 가르는 `localeCompare`는 ASCII 글자만 ICU 기본 정렬과 같다(`js_locale`). 검증된 id는 ASCII뿐이다.
//! - 토큰 수 안내의 천 단위 쉼표는 프로세스 로캘과 상관없이 쉼표다.

use crate::js;
use crate::js_json::{self, JsObject, JsValue};
use crate::js_locale::{locale_compare, to_locale_string};

const PROVIDERS: [&str; 3] = ["anthropic", "openai", "google"];
const CAPABILITIES: [&str; 4] = ["tools", "reasoning", "long-context", "json"];

/// 소문자로 접은 ASCII 글자(JS 비유니코드 `/i`는 ASCII만 접는다)
fn ascii_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// `COMPLEX` 정규식: 아키텍처|architecture|migration|마이그레이션|distributed|분산|concurren|동시성|security|보안|refactor|리팩터|multi[- ]?service|멀티|성능|performance|incident|장애
fn matches_complex(prompt: &str) -> bool {
    let lower = ascii_lower(prompt);
    const WORDS: [&str; 17] = [
        "아키텍처",
        "architecture",
        "migration",
        "마이그레이션",
        "distributed",
        "분산",
        "concurren",
        "동시성",
        "security",
        "보안",
        "refactor",
        "리팩터",
        "멀티",
        "성능",
        "performance",
        "incident",
        "장애",
    ];
    WORDS.iter().any(|w| lower.contains(w))
        || lower.contains("multiservice")
        || lower.contains("multi-service")
        || lower.contains("multi service")
}

/// `HIGH_RISK` 정규식: 결제|payment|정산|권한|인증|authorization|authentication|secret|credential|삭제|delete|drop\s|truncate|production|운영|배포|deploy|migration|마이그레이션
fn matches_high_risk(prompt: &str) -> bool {
    let lower = ascii_lower(prompt);
    const WORDS: [&str; 17] = [
        "결제",
        "payment",
        "정산",
        "권한",
        "인증",
        "authorization",
        "authentication",
        "secret",
        "credential",
        "삭제",
        "delete",
        "truncate",
        "production",
        "운영",
        "배포",
        "deploy",
        "migration",
    ];
    if WORDS.iter().any(|w| lower.contains(w)) || lower.contains("마이그레이션") {
        return true;
    }
    let mut from = 0;
    while let Some(p) = lower[from..].find("drop") {
        let after = from + p + 4;
        if lower[after..]
            .chars()
            .next()
            .is_some_and(js::is_js_whitespace)
        {
            return true;
        }
        from += p + 1;
    }
    false
}

/// 요청 글자에서 토큰을 대충 잡는다. `[...text]`의 코드 포인트 중 ASCII 수와 UTF-16 길이를 쓴다
pub fn estimate_tokens(text: &str) -> f64 {
    let ascii = text.chars().filter(|c| (*c as u32) <= 0x7f).count() as f64;
    let length = js::utf16_len(text) as f64;
    (1.0_f64).max((ascii / 4.0 + (length - ascii) / 1.5).ceil())
}

pub fn classify_complexity(prompt: &str, input_tokens: f64) -> &'static str {
    let newlines = prompt.chars().filter(|c| *c == '\n').count();
    let signals = u8::from(matches_complex(prompt))
        + u8::from(input_tokens >= 800.0)
        + u8::from(newlines >= 12);
    match signals {
        0 => "simple",
        1 => "normal",
        _ => "complex",
    }
}

pub fn classify_risk(prompt: &str) -> &'static str {
    if matches_high_risk(prompt) {
        "high"
    } else {
        "normal"
    }
}

/// `{complexity, risk}` JSON
pub fn classify_task(prompt: &str) -> String {
    js_json::to_native(&js_json::object(vec![
        (
            "complexity",
            Some(JsValue::str(classify_complexity(
                prompt,
                estimate_tokens(prompt),
            ))),
        ),
        ("risk", Some(JsValue::str(classify_risk(prompt)))),
    ]))
}

struct Pricing {
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

fn num_prop(v: &JsValue, key: &str) -> f64 {
    v.prop(key).map_or(f64::NAN, JsValue::to_number)
}

/// `a ?? b`의 앞: undefined·null이면 None
fn opt_num(v: &JsValue, key: &str) -> Option<f64> {
    match v.prop(key) {
        None | Some(JsValue::Null) => None,
        Some(x) => Some(x.to_number()),
    }
}

fn pricing_of(v: Option<&JsValue>) -> Pricing {
    let empty = JsValue::Null;
    let v = v.unwrap_or(&empty);
    Pricing {
        input: num_prop(v, "inputPerMillion"),
        output: num_prop(v, "outputPerMillion"),
        cache_read: opt_num(v, "cacheReadPerMillion"),
        cache_write: opt_num(v, "cacheWritePerMillion"),
    }
}

fn compute_cost(
    p: &Pricing,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
) -> Option<f64> {
    if p.input == 0.0 && p.output == 0.0 {
        return None;
    }
    Some(
        (input * p.input
            + output * p.output
            + cache_read * p.cache_read.unwrap_or(p.input)
            + cache_write * p.cache_write.unwrap_or(p.input))
            / 1_000_000.0,
    )
}

/// `estimateCost`. 가격이 입력·출력 모두 0이면 None(알 수 없는 비용)
pub fn estimate_cost(pricing_json: &str, usage_json: &str) -> Result<Option<f64>, String> {
    let pricing = js_json::parse_native(pricing_json)?;
    let usage = js_json::parse_native(usage_json)?;
    let token = |key: &str| opt_num(&usage, key).unwrap_or(0.0);
    Ok(compute_cost(
        &pricing_of(Some(&pricing)),
        num_prop(&usage, "inputTokens"),
        num_prop(&usage, "outputTokens"),
        token("cacheReadTokens"),
        token("cacheWriteTokens"),
    ))
}

struct Profile {
    id: String,
    label: String,
    enabled: bool,
    capabilities: Vec<String>,
    context_window: f64,
    pricing: Pricing,
    baseline_quality: f64,
    baseline_latency_ms: f64,
}

fn profile_of(v: &JsValue) -> Profile {
    Profile {
        id: v
            .prop("id")
            .and_then(JsValue::as_str)
            .unwrap_or("")
            .to_owned(),
        label: v
            .prop("label")
            .and_then(JsValue::as_str)
            .unwrap_or("")
            .to_owned(),
        enabled: !matches!(v.prop("enabled"), Some(JsValue::Bool(false))),
        capabilities: match v.prop("capabilities") {
            Some(JsValue::Arr(items)) => items
                .iter()
                .filter_map(|c| c.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        },
        context_window: num_prop(v, "contextWindow"),
        pricing: pricing_of(v.prop("pricing")),
        baseline_quality: num_prop(v, "baselineQuality"),
        baseline_latency_ms: num_prop(v, "baselineLatencyMs"),
    }
}

struct Stats {
    runs: f64,
    passes: f64,
    total_latency_ms: f64,
    total_cost_usd: f64,
    priced_runs: f64,
}

fn truthy_num(x: f64) -> bool {
    !(x == 0.0 || x.is_nan())
}

fn stats_of(v: &JsValue) -> Stats {
    Stats {
        runs: num_prop(v, "runs"),
        passes: num_prop(v, "passes"),
        total_latency_ms: num_prop(v, "totalLatencyMs"),
        total_cost_usd: num_prop(v, "totalCostUsd"),
        priced_runs: num_prop(v, "pricedRuns"),
    }
}

#[derive(Clone)]
struct Candidate {
    index: usize,
    id: String,
    label: String,
    eligible: bool,
    score: f64,
    estimated_cost_usd: Option<f64>,
    quality: f64,
    latency_ms: f64,
    reasons: Vec<String>,
}

struct RankContext<'a> {
    max_cost_usd: Option<f64>,
    stats: Option<&'a Stats>,
    required: &'a [String],
    input_tokens: f64,
    output_tokens: f64,
    complexity: &'static str,
    risk: &'static str,
}

fn rank(index: usize, model: &Profile, ctx: &RankContext) -> Candidate {
    let mut reasons: Vec<String> = Vec::new();
    let missing: Vec<&str> = ctx
        .required
        .iter()
        .filter(|c| !model.capabilities.contains(c))
        .map(String::as_str)
        .collect();
    let needed_context = ctx.input_tokens + ctx.output_tokens;
    let estimated = compute_cost(
        &model.pricing,
        ctx.input_tokens,
        ctx.output_tokens,
        0.0,
        0.0,
    );
    let observed_cost = ctx
        .stats
        .filter(|s| truthy_num(s.priced_runs))
        .map(|s| s.total_cost_usd / s.priced_runs);
    // 실측 비용이 있으면 이 모델의 실제 평균 소비를 우선하고, 없으면 요청 길이와 가격표로 추정한다
    let ranked_cost = observed_cost.or(estimated);
    let mut eligible = true;
    if !missing.is_empty() {
        eligible = false;
        reasons.push(format!("제외: {} 기능이 없습니다", missing.join(", ")));
    }
    if model.context_window < needed_context {
        eligible = false;
        reasons.push(format!(
            "제외: 예상 {}토큰이 컨텍스트 한도를 넘습니다",
            to_locale_string(needed_context)
        ));
    }
    if let (Some(max), Some(cost)) = (ctx.max_cost_usd, estimated) {
        if cost > max {
            eligible = false;
            reasons.push(format!(
                "제외: 예상 비용 ${}가 한도를 넘습니다",
                js::to_fixed(cost, 4)
            ));
        }
    }

    let prior_runs = 5.0;
    let quality = match ctx.stats {
        Some(s) => (model.baseline_quality * prior_runs + s.passes) / (prior_runs + s.runs),
        None => model.baseline_quality,
    };
    let latency_ms = match ctx.stats {
        Some(s) if truthy_num(s.runs) => s.total_latency_ms / s.runs,
        _ => model.baseline_latency_ms,
    };
    let latency_score = 1.0 / (1.0 + latency_ms / 10_000.0);
    let cost_score = match ranked_cost {
        None => 0.35,
        Some(c) => 1.0 / (1.0 + c * 20.0),
    };
    let heavy = ctx.risk == "high" || ctx.complexity == "complex";
    let quality_weight = if heavy {
        0.65
    } else if ctx.complexity == "simple" {
        0.35
    } else {
        0.5
    };
    let cost_weight = if heavy {
        0.15
    } else if ctx.complexity == "simple" {
        0.45
    } else {
        0.3
    };
    let score = quality * quality_weight + cost_score * cost_weight + latency_score * 0.2;

    match ctx.stats {
        Some(s) if truthy_num(s.runs) => reasons.push(format!(
            "실측 통과율 {}% ({}건)",
            js::number_to_string(js::math_round((s.passes / s.runs) * 100.0)),
            js::number_to_string(s.runs)
        )),
        _ => reasons.push(format!(
            "초기 품질 기준 {}%",
            js::number_to_string(js::math_round(model.baseline_quality * 100.0))
        )),
    }
    reasons.push(format!(
        "예상 지연 {}ms",
        to_locale_string(js::math_round(latency_ms))
    ));
    reasons.push(match (observed_cost, estimated) {
        (Some(c), _) => format!("실측 평균 비용 ${}", js::to_fixed(c, 4)),
        (None, None) => "가격 미설정".to_owned(),
        (None, Some(e)) => format!("예상 비용 ${}", js::to_fixed(e, 4)),
    });
    if ctx.risk == "high" {
        reasons.push("고위험 요청은 품질 가중치를 높임".to_owned());
    } else if ctx.complexity == "simple" {
        reasons.push("단순 요청은 비용 가중치를 높임".to_owned());
    }

    Candidate {
        index,
        id: model.id.clone(),
        label: model.label.clone(),
        eligible,
        score: if eligible { score } else { -1.0 },
        estimated_cost_usd: estimated,
        quality,
        latency_ms,
        reasons,
    }
}

/// JS `a || b`의 앞이 거짓(0·NaN)인지
fn falsy(x: f64) -> bool {
    x == 0.0 || x.is_nan()
}

/// V8의 `Array.prototype.sort`(TimSort). 비교 함수가 NaN 점수 때문에 앞뒤가 맞지 않아도(a<b, b<c인데 a와 c가 같다) 옛 구현과 같은 순서가 나오게
/// 64개 미만에서는 V8의 순서(처음 오름·내림 구간을 찾고 나머지를 이진 삽입)를 그대로 따른다. 64개 이상은 비교가 일관될 때만 같은 병합 정렬이다
/// (후보가 63개를 넘는 모델 목록은 쓰지 않는다)
fn js_sort<T: Clone>(items: Vec<T>, cmp: &dyn Fn(&T, &T) -> f64) -> Vec<T> {
    let n = items.len();
    if n < 2 {
        return items;
    }
    if n >= 64 {
        return js::stable_sort_by(items, cmp);
    }
    let less = |a: &T, b: &T| cmp(a, b) < 0.0; // NaN은 0으로 본다(`< 0`이 거짓)
    let mut a = items;
    // 처음 구간: 오름(내림이 아닌) 또는 엄격한 내림
    let descending = less(&a[1], &a[0]);
    let mut run = 2;
    while run < n {
        let order_less = less(&a[run], &a[run - 1]);
        if descending {
            if !order_less {
                break;
            }
        } else if order_less {
            break;
        }
        run += 1;
    }
    if descending {
        a[..run].reverse();
    }
    // 나머지는 이진 삽입
    for start in run..n {
        let pivot = a[start].clone();
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if less(&pivot, &a[mid]) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        for p in (left + 1..=start).rev() {
            a[p] = a[p - 1].clone();
        }
        a[left] = pivot;
    }
    a
}

fn candidate_json(c: &Candidate) -> JsValue {
    js_json::object(vec![
        ("index", Some(JsValue::Num(c.index as f64))),
        ("eligible", Some(JsValue::Bool(c.eligible))),
        ("score", Some(JsValue::Num(c.score))),
        ("estimatedCostUsd", c.estimated_cost_usd.map(JsValue::Num)),
        ("quality", Some(JsValue::Num(c.quality))),
        ("latencyMs", Some(JsValue::Num(c.latency_ms))),
        (
            "reasons",
            Some(JsValue::Arr(
                c.reasons.iter().map(|r| JsValue::str(r.clone())).collect(),
            )),
        ),
    ])
}

/// `routeModel`. 고른 모델과 후보의 `model`은 `profiles` 배열의 위치(`index`·`selected`)로 돌려준다
pub fn route_model(
    profiles_json: &str,
    request_json: &str,
    stats_json: &str,
) -> Result<String, String> {
    let profiles_v = js_json::parse_native(profiles_json)?;
    let request = js_json::parse_native(request_json)?;
    let stats_v = js_json::parse_native(stats_json)?;
    let empty: Vec<JsValue> = Vec::new();
    let profiles: &[JsValue] = match &profiles_v {
        JsValue::Arr(items) => items,
        _ => &empty,
    };

    let prompt = js::trim(
        request
            .prop("prompt")
            .and_then(JsValue::as_str)
            .unwrap_or(""),
    );
    if prompt.is_empty() {
        return Err("라우팅할 요청을 입력하세요".into());
    }
    let enabled: Vec<(usize, Profile)> = profiles
        .iter()
        .enumerate()
        .map(|(i, p)| (i, profile_of(p)))
        .filter(|(_, p)| p.enabled)
        .collect();
    if enabled.is_empty() {
        return Err("사용할 수 있는 모델이 없습니다".into());
    }

    let input_tokens = estimate_tokens(prompt);
    let complexity = classify_complexity(prompt, input_tokens);
    let risk = classify_risk(prompt);
    let build = request.prop("intent").and_then(JsValue::as_str) == Some("build");
    let output_tokens = if build {
        match complexity {
            "complex" => 4_000.0,
            "normal" => 2_000.0,
            _ => 1_000.0,
        }
    } else if complexity == "complex" {
        1_500.0
    } else {
        700.0
    };
    // 필요한 기능은 처음 나온 순서로 한 번씩(`new Set`)
    let mut required: Vec<String> = Vec::new();
    let given: Vec<String> = match request.prop("requiredCapabilities") {
        None | Some(JsValue::Null) => {
            if build {
                vec!["tools".to_owned()]
            } else {
                Vec::new()
            }
        }
        Some(JsValue::Arr(items)) => items.iter().map(JsValue::to_js_string).collect(),
        Some(_) => Vec::new(),
    };
    for c in given {
        if !required.contains(&c) {
            required.push(c);
        }
    }
    let max_cost_usd = match request.prop("maxCostUsd") {
        None => None,
        Some(v) => Some(v.to_number()),
    };

    let stats_of_model = |id: &str| -> Option<Stats> {
        match &stats_v {
            JsValue::Obj(o) => match o.get(id) {
                Some(v @ JsValue::Obj(_)) => Some(stats_of(v)),
                _ => None,
            },
            _ => None,
        }
    };
    let mut candidates: Vec<Candidate> = enabled
        .iter()
        .map(|(index, model)| {
            let stats = stats_of_model(&model.id);
            rank(
                *index,
                model,
                &RankContext {
                    max_cost_usd,
                    stats: stats.as_ref(),
                    required: &required,
                    input_tokens,
                    output_tokens,
                    complexity,
                    risk,
                },
            )
        })
        .collect();
    candidates = js_sort(candidates, &|a, b| {
        let by_eligible = f64::from(u8::from(b.eligible)) - f64::from(u8::from(a.eligible));
        if !falsy(by_eligible) {
            return by_eligible;
        }
        let by_score = b.score - a.score;
        if !falsy(by_score) {
            return by_score;
        }
        locale_compare(&a.id, &b.id)
    });

    let preferred_id = request.prop("preferredModelId").filter(|v| v.truthy());
    let preferred = preferred_id.and_then(|p| {
        candidates
            .iter()
            .position(|c| p.as_str() == Some(c.id.as_str()))
    });
    let chosen = match preferred.filter(|i| candidates[*i].eligible) {
        Some(i) => Some(i),
        None => candidates.iter().position(|c| c.eligible),
    };
    let Some(chosen) = chosen else {
        let reasons: Vec<String> = candidates
            .iter()
            .flat_map(|c| {
                c.reasons
                    .iter()
                    .filter(|r| r.starts_with("제외:"))
                    .map(|r| format!("{}: {r}", c.label))
            })
            .collect();
        let tail = if reasons.is_empty() {
            String::new()
        } else {
            format!(" ({})", reasons.join("; "))
        };
        return Err(format!("요청 조건을 만족하는 모델이 없습니다{tail}"));
    };
    let reason = if preferred_id.is_some() && preferred == Some(chosen) {
        format!(
            "사용자가 지정한 {}을 선택했습니다",
            candidates[chosen].label
        )
    } else {
        candidates[chosen].reasons.join(", ")
    };

    let out = js_json::object(vec![
        (
            "selected",
            Some(JsValue::Num(candidates[chosen].index as f64)),
        ),
        ("complexity", Some(JsValue::str(complexity))),
        ("risk", Some(JsValue::str(risk))),
        ("inputTokens", Some(JsValue::Num(input_tokens))),
        ("outputTokens", Some(JsValue::Num(output_tokens))),
        (
            "candidates",
            Some(JsValue::Arr(
                candidates.iter().map(candidate_json).collect(),
            )),
        ),
        ("reason", Some(JsValue::str(reason))),
    ]);
    Ok(js_json::to_native(&out))
}

fn finite_num(v: Option<&JsValue>) -> Option<f64> {
    match v {
        Some(JsValue::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `aggregateModelStats`: 모델 id별 실측을 모은다
pub fn aggregate_model_stats(observations_json: &str) -> Result<String, String> {
    let observations = js_json::parse_native(observations_json)?;
    let JsValue::Arr(observations) = observations else {
        return Err("observations는 배열이어야 합니다".into());
    };
    let mut ids: Vec<String> = Vec::new();
    let mut rows: Vec<Stats> = Vec::new();
    for observation in &observations {
        let latency = match finite_num(observation.prop("latencyMs")) {
            Some(l) if l >= 0.0 => l,
            _ => continue,
        };
        let cost = match observation.prop("costUsd") {
            None => None,
            Some(v) => match finite_num(Some(v)) {
                Some(c) if c >= 0.0 => Some(c),
                _ => continue,
            },
        };
        let id = observation
            .prop("modelId")
            .map_or_else(|| "undefined".to_owned(), JsValue::to_js_string);
        let pos = match ids.iter().position(|i| *i == id) {
            Some(p) => p,
            None => {
                ids.push(id);
                rows.push(Stats {
                    runs: 0.0,
                    passes: 0.0,
                    total_latency_ms: 0.0,
                    total_cost_usd: 0.0,
                    priced_runs: 0.0,
                });
                ids.len() - 1
            }
        };
        let row = &mut rows[pos];
        row.runs += 1.0;
        row.passes += if observation.prop("passed").is_some_and(JsValue::truthy) {
            1.0
        } else {
            0.0
        };
        row.total_latency_ms += latency;
        if let Some(c) = cost {
            row.total_cost_usd += c;
            row.priced_runs += 1.0;
        }
    }
    let mut out = JsObject::new();
    for (id, row) in ids.iter().zip(rows.iter()) {
        out.set(
            id,
            js_json::object(vec![
                ("runs", Some(JsValue::Num(row.runs))),
                ("passes", Some(JsValue::Num(row.passes))),
                ("totalLatencyMs", Some(JsValue::Num(row.total_latency_ms))),
                ("totalCostUsd", Some(JsValue::Num(row.total_cost_usd))),
                ("pricedRuns", Some(JsValue::Num(row.priced_runs))),
            ]),
        );
    }
    Ok(js_json::to_native(&JsValue::Obj(out)))
}

// ── 모델 설정 검증 ────────────────────────────────────────────────

/// `new URL(baseUrl)`의 결과. URL 파서는 JS 런타임(WHATWG)이 하고, 그 사실만 받아 판정한다
fn url_ok(facts: Option<&JsValue>) -> Option<(&str, &str, &str, &str)> {
    let f = facts?;
    if f.prop("ok") != Some(&JsValue::Bool(true)) {
        return None;
    }
    let s = |k: &str| f.prop(k).and_then(JsValue::as_str).unwrap_or("");
    Some((s("username"), s("password"), s("protocol"), s("hostname")))
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() <= 64
        && b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        && id.is_ascii()
}

fn valid_env(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() <= 128
        && b.first().is_some_and(u8::is_ascii_uppercase)
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
        && name.is_ascii()
}

fn positive(v: Option<&JsValue>, name: &str) -> Result<(), String> {
    match v {
        Some(JsValue::Num(n)) if n.is_finite() && *n > 0.0 => Ok(()),
        _ => Err(format!("{name}은 0보다 큰 숫자여야 합니다")),
    }
}

fn non_negative(v: Option<&JsValue>, name: &str) -> Result<(), String> {
    match v {
        Some(JsValue::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(()),
        _ => Err(format!("{name}은 0 이상의 숫자여야 합니다")),
    }
}

fn between(v: Option<&JsValue>, min: f64, max: f64, name: &str) -> Result<(), String> {
    match v {
        Some(JsValue::Num(n)) if n.is_finite() && *n >= min && *n <= max => Ok(()),
        _ => Err(format!(
            "{name}은 {}~{} 사이 숫자여야 합니다",
            js::number_to_string(min),
            js::number_to_string(max)
        )),
    }
}

/// `validateModelProfiles`. `url_facts_json`는 입력 배열과 같은 길이로, 항목의 `baseUrl`을 JS의 `new URL`로 읽은 사실이다
pub fn validate_model_profiles(input_json: &str, url_facts_json: &str) -> Result<String, String> {
    let input = js_json::parse_native(input_json)?;
    let facts = js_json::parse_native(url_facts_json)?;
    let items = match &input {
        JsValue::Arr(items) if !items.is_empty() => items,
        _ => return Err("모델 레지스트리는 한 개 이상의 모델 배열이어야 합니다".into()),
    };
    let facts: &[JsValue] = match &facts {
        JsValue::Arr(f) => f,
        _ => &[],
    };
    let mut ids: Vec<String> = Vec::new();
    let mut out: Vec<JsValue> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if !matches!(item, JsValue::Obj(_) | JsValue::Arr(_)) {
            return Err(format!("모델 {} 설정이 객체가 아닙니다", index + 1));
        }
        let id = match item.prop("id") {
            Some(JsValue::Str(s)) if valid_id(s) => s.clone(),
            _ => return Err(format!("모델 {}의 id가 올바르지 않습니다", index + 1)),
        };
        if ids.contains(&id) {
            return Err(format!("모델 id가 겹칩니다: {id}"));
        }
        ids.push(id.clone());
        let provider = match item.prop("provider") {
            Some(JsValue::Str(s)) if PROVIDERS.contains(&s.as_str()) => s.clone(),
            _ => {
                return Err(format!(
                    "{id}의 provider는 anthropic, openai, google 중 하나여야 합니다"
                ))
            }
        };
        let model = match item.prop("model") {
            Some(JsValue::Str(s)) if !js::trim(s).is_empty() => js::trim(s).to_owned(),
            _ => return Err(format!("{id}의 model이 필요합니다")),
        };
        let label = match item.prop("label") {
            Some(JsValue::Str(s)) if !js::trim(s).is_empty() => js::trim(s).to_owned(),
            _ => return Err(format!("{id}의 label이 필요합니다")),
        };
        let capabilities: Vec<String> = match item.prop("capabilities") {
            Some(JsValue::Arr(caps))
                if caps
                    .iter()
                    .all(|c| c.as_str().is_some_and(|s| CAPABILITIES.contains(&s))) =>
            {
                let mut unique: Vec<String> = Vec::new();
                for c in caps {
                    let s = c.as_str().unwrap_or("").to_owned();
                    if !unique.contains(&s) {
                        unique.push(s);
                    }
                }
                unique
            }
            _ => return Err(format!("{id}의 capabilities가 올바르지 않습니다")),
        };
        positive(item.prop("contextWindow"), &format!("{id}.contextWindow"))?;
        between(
            item.prop("baselineQuality"),
            0.0,
            1.0,
            &format!("{id}.baselineQuality"),
        )?;
        positive(
            item.prop("baselineLatencyMs"),
            &format!("{id}.baselineLatencyMs"),
        )?;
        let pricing = match item.prop("pricing") {
            Some(p @ (JsValue::Obj(_) | JsValue::Arr(_))) => p,
            _ => return Err(format!("{id}.pricing이 필요합니다")),
        };
        non_negative(
            pricing.prop("inputPerMillion"),
            &format!("{id}.pricing.inputPerMillion"),
        )?;
        non_negative(
            pricing.prop("outputPerMillion"),
            &format!("{id}.pricing.outputPerMillion"),
        )?;
        if let Some(v) = pricing.prop("cacheReadPerMillion") {
            non_negative(Some(v), &format!("{id}.pricing.cacheReadPerMillion"))?;
        }
        if let Some(v) = pricing.prop("cacheWritePerMillion") {
            non_negative(Some(v), &format!("{id}.pricing.cacheWritePerMillion"))?;
        }
        let api_key_env = item.prop("apiKeyEnv");
        if let Some(v) = api_key_env {
            if !valid_env(&v.to_js_string()) {
                return Err(format!("{id}.apiKeyEnv가 올바른 환경 변수 이름이 아닙니다"));
            }
        }
        let base_url = item.prop("baseUrl");
        if base_url.is_some() {
            let Some((username, password, protocol, hostname)) = url_ok(facts.get(index)) else {
                return Err(format!("{id}.baseUrl이 올바른 URL이 아닙니다"));
            };
            if !username.is_empty()
                || !password.is_empty()
                || !["https:", "http:"].contains(&protocol)
            {
                return Err(format!("{id}.baseUrl에는 http(s) 주소만 쓸 수 있습니다"));
            }
            if protocol == "http:"
                && hostname != "127.0.0.1"
                && hostname != "localhost"
                && hostname != "::1"
            {
                return Err(format!(
                    "{id}.baseUrl의 원격 주소에는 https를 사용해야 합니다"
                ));
            }
        }
        let base_url_value = match base_url {
            Some(v) if v.truthy() => match v.as_str() {
                Some(s) => Some(JsValue::str(s.strip_suffix('/').unwrap_or(s))),
                None => return Err(format!("{id}.baseUrl이 올바른 URL이 아닙니다")),
            },
            _ => None,
        };
        let pricing_copy = match pricing {
            JsValue::Obj(o) => {
                let mut copy = JsObject::new();
                for (k, v) in o.entries() {
                    copy.set(k, v.clone());
                }
                JsValue::Obj(copy)
            }
            _ => JsValue::Obj(JsObject::new()),
        };
        out.push(js_json::object(vec![
            ("id", Some(JsValue::str(id))),
            ("provider", Some(JsValue::str(provider))),
            ("model", Some(JsValue::str(model))),
            ("label", Some(JsValue::str(label))),
            (
                "enabled",
                Some(JsValue::Bool(!matches!(
                    item.prop("enabled"),
                    Some(JsValue::Bool(false))
                ))),
            ),
            (
                "capabilities",
                Some(JsValue::Arr(
                    capabilities.into_iter().map(JsValue::str).collect(),
                )),
            ),
            ("contextWindow", item.prop("contextWindow").cloned()),
            ("pricing", Some(pricing_copy)),
            ("baselineQuality", item.prop("baselineQuality").cloned()),
            ("baselineLatencyMs", item.prop("baselineLatencyMs").cloned()),
            ("apiKeyEnv", api_key_env.filter(|v| v.truthy()).cloned()),
            ("baseUrl", base_url_value),
        ]));
    }
    Ok(js_json::to_native(&JsValue::Arr(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify() {
        assert_eq!(classify_risk("please DROP\ttable"), "high");
        assert_eq!(classify_risk("drop"), "normal");
        assert_eq!(classify_risk("결제 연동"), "high");
        assert_eq!(classify_complexity("Multi-Service 성능", 800.0), "complex");
        assert_eq!(classify_complexity("hello", 800.0), "normal");
        assert_eq!(estimate_tokens("abcd"), 1.0);
        assert_eq!(estimate_tokens("가나"), 2.0);
    }

    #[test]
    fn cost() {
        let c = estimate_cost(
            r#"{"inputPerMillion":3,"outputPerMillion":15}"#,
            r#"{"inputTokens":1000,"outputTokens":500}"#,
        )
        .unwrap();
        assert_eq!(
            c,
            Some((1000.0 * 3.0 + 500.0 * 15.0 + 0.0 * 3.0 + 0.0 * 3.0) / 1_000_000.0)
        );
        assert_eq!(
            estimate_cost(
                r#"{"inputPerMillion":0,"outputPerMillion":0}"#,
                r#"{"inputTokens":1,"outputTokens":1}"#
            )
            .unwrap(),
            None
        );
    }
}

//! The native arm of `memphis_brave_search`.
//!
//! WHY THIS MODULE EXISTS
//! -----------------------
//! The gateway has had this tool since 2026-05-08 (`src/mcp/tools/brave-search.ts`).
//! The native cockpit had none — a search for "brave" in `crates/` returned
//! zero hits — so the authoritative operator surface could fetch a URL it
//! already knew but could not search the web at all.
//!
//! TWO CONTRACTS, ON PURPOSE
//! -------------------------
//! 1. BEHAVIOUR is shared with the TypeScript arm through
//!    `tests/fixtures/brave-search-contract.json`, which a Rust test
//!    (`tests/brave_search_contract.rs`) and a TypeScript test
//!    (`tests/unit/mcp-brave-search-contract.test.ts`) both run. The
//!    limit clamping, the refusals and the response parsing must not
//!    drift apart: the model sees the same words on both surfaces.
//!
//! 2. The CREDENTIAL is resolved by the arm that needs it. The
//!    TypeScript provider already does this for provider keys
//!    (`*_VAULT_KEY` -> vault, plaintext as fallback), because the
//!    daemon's environment is not guaranteed to carry a resolved
//!    secret: the running daemon holds `BRAVE_API_KEY=VAULT:brave_api_key`
//!    and the tool refused to work on the surface that serves Telegram
//!    and HTTP, while the CLI (which resolves the vault at startup)
//!    worked. Trusting the environment made the tool work on one
//!    surface and fail on another.
//!
//! The endpoint is fixed by the vendor and the query travels as a query
//! parameter, so there is no user-controlled URL here and no SSRF guard
//! is needed — unlike `memphis_web_fetch`, which takes a URL from the
//! model and does need one.

use serde::Serialize;
use serde_json::Value;

use crate::OperatorConfig;

/// The Brave Search endpoint. Fixed by the vendor.
pub const ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";

/// The cap the tool schema advertises and the vendor accepts.
pub const MAX_RESULTS: usize = 20;

/// The count used when the caller does not ask for one.
pub const DEFAULT_LIMIT: usize = 10;

/// The environment variable holding the subscription token. Its value may
/// be a `VAULT:<entry>` reference.
pub const KEY_ENV: &str = "BRAVE_API_KEY";

/// The vault entry the reference points at by default.
pub const DEFAULT_VAULT_ENTRY: &str = "brave_api_key";

/// What the model asks for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BraveSearchInput {
    pub query: String,
    /// The requested count. Fractional values are floored — a fractional
    /// count reached the vendor as `count=2.5` and was rejected.
    pub limit: Option<f64>,
    /// ISO 3166-1 alpha-2, e.g. `PL`.
    pub country: Option<String>,
    /// ISO 639-1, e.g. `pl`.
    pub search_lang: Option<String>,
}

/// One result. `source` is `web` or `news` — Brave returns two lists and
/// the TypeScript arm merges web first, then news.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BraveSearchResult {
    pub title: String,
    pub url: String,
    pub description: String,
    pub source: &'static str,
}

/// What the model gets back. The shape is the TypeScript arm's shape:
/// `query`, `results`, `count`, and `error` only when something failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BraveSearchOutput {
    pub query: String,
    pub results: Vec<BraveSearchResult>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BraveSearchOutput {
    fn failure(query: &str, error: impl Into<String>) -> Self {
        Self {
            query: query.to_string(),
            results: Vec::new(),
            count: 0,
            error: Some(error.into()),
        }
    }
}

/// Clamp the requested count to what Brave accepts.
///
/// The TypeScript arm clamps with `Math.min(Math.max(limit ?? 10, 1), 20)`.
/// The count is floored first, in both arms: a fractional count reached
/// the vendor as `count=2.5` and was rejected there.
pub fn resolve_limit(limit: Option<f64>) -> usize {
    let Some(value) = limit else {
        return DEFAULT_LIMIT;
    };
    if !value.is_finite() {
        return DEFAULT_LIMIT;
    }
    let truncated = value.trunc();
    if truncated < 1.0 {
        return 1;
    }
    if truncated >= MAX_RESULTS as f64 {
        return MAX_RESULTS;
    }
    truncated as usize
}

/// The refusal for a missing or unresolved credential, or `None` when the
/// key is usable. The wording is the TypeScript arm's wording.
pub fn key_error(key: Option<&str>) -> Option<String> {
    let trimmed = key.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return Some(format!(
            "{KEY_ENV} not set. Get a key at https://api.search.brave.com/ (free 2000 queries/month), then run `memphis brave configure --key <token>`."
        ));
    }
    if let Some(name) = trimmed.strip_prefix("VAULT:") {
        return Some(format!(
            "{KEY_ENV} references vault entry \"{name}\" but vault didn't resolve it. Run `memphis brave configure --key <token>` or set {KEY_ENV} directly."
        ));
    }
    None
}

/// Percent-encode a query component the way `URLSearchParams` does.
///
/// The WHATWG urlencoded serializer keeps ASCII alphanumerics and
/// `* - . _`, turns a space into `+`, and percent-encodes everything
/// else with upper-case hex. The TypeScript arm builds its URL with
/// `URLSearchParams`, so the native arm must encode identically — a
/// different encoding would make the two arms ask the vendor for
/// different things.
fn encode_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let c = *byte;
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(c as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(HEX[(c >> 4) as usize] as char);
                out.push(HEX[(c & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// Build the request URL: same endpoint, same parameter order, same
/// encoding as the TypeScript arm.
pub fn build_url(
    query: &str,
    limit: usize,
    country: Option<&str>,
    search_lang: Option<&str>,
) -> String {
    let mut url = format!("{ENDPOINT}?q={}&count={}", encode_component(query), limit);
    if let Some(country) = country.filter(|value| !value.is_empty()) {
        url.push_str(&format!("&country={}", encode_component(country)));
    }
    if let Some(lang) = search_lang.filter(|value| !value.is_empty()) {
        url.push_str(&format!("&search_lang={}", encode_component(lang)));
    }
    url
}

/// Remove HTML tags from a description, the way the TypeScript arm's
/// `/<[^>]*>/g` does, and trim the result.
fn strip_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for c in value.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn pick_results(items: &[Value], source: &'static str) -> Vec<BraveSearchResult> {
    items
        .iter()
        .filter_map(|item| {
            let url = item.get("url").and_then(Value::as_str)?;
            if url.is_empty() {
                return None;
            }
            Some(BraveSearchResult {
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                url: url.to_string(),
                description: strip_html(
                    item.get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                source,
            })
        })
        .collect()
}

/// Parse a Brave payload: web results first, then news.
pub fn parse_payload(payload: &Value) -> Vec<BraveSearchResult> {
    let mut merged = Vec::new();
    if let Some(items) = payload
        .get("web")
        .and_then(|web| web.get("results"))
        .and_then(Value::as_array)
    {
        merged.extend(pick_results(items, "web"));
    }
    if let Some(items) = payload
        .get("news")
        .and_then(|news| news.get("results"))
        .and_then(Value::as_array)
    {
        merged.extend(pick_results(items, "news"));
    }
    merged
}

/// The refusal for a rejected request, identical in wording to the
/// TypeScript arm.
pub fn http_error(status: u16, body: &str) -> String {
    let hint = match status {
        401 => " (BRAVE_API_KEY rejected — check it)",
        429 => " (rate limit hit — Brave free tier is 1 query/sec)",
        _ => "",
    };
    let head: String = body.chars().take(200).collect();
    format!("Brave Search API error: HTTP {status}{hint} {head}")
}

/// The transport. Injectable so the contract test can drive the whole arm
/// — URL, status mapping, parsing — without a network.
pub type Fetcher<'a> = &'a dyn Fn(&str, &str) -> Result<(u16, String), String>;

/// Run the search with an already-resolved credential.
///
/// This is the shared contract: the TypeScript arm's tool function and
/// this function must answer the same way for the same input and the
/// same response.
pub fn search_with(
    input: &BraveSearchInput,
    key: &str,
    fetcher: Fetcher<'_>,
) -> BraveSearchOutput {
    let limit = resolve_limit(input.limit);

    // The order of the refusals is the TypeScript arm's order: the query
    // is checked before the credential.
    if input.query.trim().is_empty() {
        return BraveSearchOutput::failure(&input.query, "Query is empty");
    }
    if let Some(message) = key_error(Some(key)) {
        return BraveSearchOutput::failure(&input.query, message);
    }

    let url = build_url(
        &input.query,
        limit,
        input.country.as_deref(),
        input.search_lang.as_deref(),
    );

    let (status, body) = match fetcher(&url, key) {
        Ok(response) => response,
        Err(message) => {
            return BraveSearchOutput::failure(&input.query, format!("Brave Search failed: {message}"))
        }
    };

    if !(200..300).contains(&status) {
        return BraveSearchOutput::failure(&input.query, http_error(status, &body));
    }

    let payload: Value = match serde_json::from_str(&body) {
        Ok(payload) => payload,
        Err(error) => {
            return BraveSearchOutput::failure(
                &input.query,
                format!("Brave Search failed: {error}"),
            )
        }
    };

    let mut results = parse_payload(&payload);
    results.truncate(limit);
    BraveSearchOutput {
        query: input.query.clone(),
        count: results.len(),
        results,
        error: None,
    }
}

/// Resolve the credential, then run the search.
///
/// A `VAULT:<entry>` reference is resolved through the vault here, the
/// same way the TypeScript provider resolves `*_VAULT_KEY`. When the
/// reference cannot be resolved, the reference itself is passed on, so
/// the refusal names the entry the operator has to fix.
pub fn search(config: &OperatorConfig, input: &BraveSearchInput) -> BraveSearchOutput {
    let raw = config.env(KEY_ENV).unwrap_or_default().trim().to_string();
    let effective = resolve_credential(config, &raw);
    let timeout_ms = brave_timeout_ms();
    search_with(input, &effective, &|url, key| {
        fetch(url, key, timeout_ms)
    })
}

/// Turn a configured value into a usable credential.
fn resolve_credential(config: &OperatorConfig, raw: &str) -> String {
    let Some(name) = raw.strip_prefix("VAULT:") else {
        return raw.to_string();
    };
    let name = name.trim();
    match crate::runtime::try_read_vault_secret_plaintext(config, name) {
        Ok(Some(plaintext)) => plaintext.trim().to_string(),
        _ => raw.to_string(),
    }
}

/// The timeout, from the same environment variable the TypeScript arm
/// reads.
fn brave_timeout_ms() -> u64 {
    std::env::var("MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.clamp(1_000, 600_000))
        .unwrap_or(60_000)
}

/// One request against the vendor.
fn fetch(url: &str, key: &str, timeout_ms: u64) -> Result<(u16, String), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build();
    let request = agent
        .get(url)
        .set("Accept", "application/json")
        .set("Accept-Encoding", "gzip")
        .set("X-Subscription-Token", key)
        .set("User-Agent", "Memphis-Agent/1.0 (sovereign-runtime)");
    match request.call() {
        Ok(response) => {
            let status = response.status();
            let body = response.into_string().map_err(|error| error.to_string())?;
            Ok((status, body))
        }
        // A rejected request is not a transport failure: the status and
        // the body are both part of the answer the model has to see.
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_clamped_like_the_typescript_arm() {
        assert_eq!(resolve_limit(None), 10);
        assert_eq!(resolve_limit(Some(0.0)), 1);
        assert_eq!(resolve_limit(Some(-3.0)), 1);
        assert_eq!(resolve_limit(Some(7.0)), 7);
        assert_eq!(resolve_limit(Some(99.0)), 20);
        assert_eq!(resolve_limit(Some(2.7)), 2);
        assert_eq!(resolve_limit(Some(f64::NAN)), 10);
    }

    #[test]
    fn the_query_is_encoded_the_way_urlsearchparams_encodes_it() {
        assert_eq!(encode_component("a b"), "a+b");
        assert_eq!(encode_component("ó"), "%C3%B3");
        assert_eq!(encode_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_component("a*b-c.d_e"), "a*b-c.d_e");
    }

    #[test]
    fn a_missing_or_unresolved_key_is_refused_with_the_same_words() {
        assert_eq!(
            key_error(None),
            Some(
                "BRAVE_API_KEY not set. Get a key at https://api.search.brave.com/ (free 2000 queries/month), then run `memphis brave configure --key <token>`."
                    .to_string()
            )
        );
        assert_eq!(
            key_error(Some("   ")),
            key_error(None),
            "an empty value and a missing one are the same situation"
        );
        assert_eq!(
            key_error(Some("VAULT:brave_api_key")),
            Some(
                "BRAVE_API_KEY references vault entry \"brave_api_key\" but vault didn't resolve it. Run `memphis brave configure --key <token>` or set BRAVE_API_KEY directly."
                    .to_string()
            )
        );
        assert_eq!(key_error(Some("BSAabc")), None);
    }

    #[test]
    fn html_is_stripped_from_the_description() {
        assert_eq!(strip_html("<b>tekst</b>"), "tekst");
        assert_eq!(strip_html("a <b>b</b> c"), "a b c");
        assert_eq!(strip_html("a <b"), "a", "an unclosed tag swallows the rest");
    }

    #[test]
    fn web_results_come_before_news_results() {
        let payload = serde_json::json!({
            "web": { "results": [{ "title": "W", "url": "https://w.example", "description": "d" }] },
            "news": { "results": [{ "title": "N", "url": "https://n.example", "description": "d" }] }
        });
        let results = parse_payload(&payload);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].source, "web");
        assert_eq!(results[1].source, "news");
    }

    #[test]
    fn a_result_without_a_url_is_dropped() {
        let payload = serde_json::json!({
            "web": { "results": [{ "title": "Bez URL" }, { "url": "", "title": "Pusty" }] }
        });
        assert!(parse_payload(&payload).is_empty());
    }

    #[test]
    fn the_merged_results_are_capped_by_the_limit() {
        let payload = serde_json::json!({
            "web": { "results": [
                { "url": "https://a.example" }, { "url": "https://b.example" }, { "url": "https://c.example" }
            ] }
        });
        let input = BraveSearchInput {
            query: "x".to_string(),
            limit: Some(2.0),
            ..Default::default()
        };
        let fetcher = |_: &str, _: &str| Ok((200u16, payload.to_string()));
        let output = search_with(&input, "BSAtest", &fetcher);
        assert_eq!(output.count, 2);
        assert!(output.error.is_none());
    }

    #[test]
    fn an_empty_query_is_refused_before_the_credential_is_looked_at() {
        let input = BraveSearchInput {
            query: "   ".to_string(),
            ..Default::default()
        };
        let fetcher = |_: &str, _: &str| panic!("the transport must not be called");
        let output = search_with(&input, "BSAtest", &fetcher);
        assert_eq!(output.error.as_deref(), Some("Query is empty"));
    }

    #[test]
    fn a_rejected_request_reports_the_status() {
        let input = BraveSearchInput {
            query: "x".to_string(),
            ..Default::default()
        };
        let fetcher = |_: &str, _: &str| Ok((401u16, "bad key".to_string()));
        let output = search_with(&input, "BSAtest", &fetcher);
        assert_eq!(
            output.error.as_deref(),
            Some("Brave Search API error: HTTP 401 (BRAVE_API_KEY rejected — check it) bad key")
        );
    }
}

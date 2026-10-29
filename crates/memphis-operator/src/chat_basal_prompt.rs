//! Automatic Basal intent classification for every natural-language user turn.
//!
//! The operator asked for *active* classification of every prompt, not a
//! manual `classify` command. This module performs one bounded, loopback-only
//! classification per turn and hands the model an explicitly fallible hint.
//!
//! Rules that are not negotiable here:
//!
//! * The hint is advisory. It never grants a permission, never widens a tool
//!   gate and never overrides an input-risk verdict.
//! * The prompt text goes to the local Basal service only. Identity, surface
//!   and time are deliberately *not* part of the request, so the same prompt
//!   hits the same server-side cache entry from every surface.
//! * No prompt text, reply body or backend error string may leave this module
//!   inside metadata. Only hashes, byte counts and static reason codes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::chat_basal::{
    classify_reply_to_json, parse_basal_threshold, read_basal_json, BASAL_DEFAULT_URL,
};
use crate::chat_guards::{emit_runtime_security_event, sha256_hex};
use crate::chat_streaming::ensure_chat_not_cancelled;
use crate::runtime::OperatorRuntime;
use crate::{OperatorConfig, OperatorError};

/// The question asked to the Basal service, byte-for-byte identical with the
/// shared TypeScript contract (`tests/fixtures/basal-prompt-contract.json`).
pub const BASAL_PROMPT_QUESTION: &str = "Jaka jest główna intencja tej wiadomości użytkownika?";

/// The six intent criteria, in alphabetical key order. `serde_json::Map` is a
/// `BTreeMap` in this workspace, so the serialized order is alphabetical even
/// when the map is built in any order.
pub const BASAL_PROMPT_CRITERIA: [(&str, &str); 6] = [
    (
        "clarify",
        "Prośba niejasna lub niekompletna; potrzebne doprecyzowanie.",
    ),
    (
        "conversation",
        "Zwykła rozmowa, powitanie, pytanie ogólne lub wyjaśnienie.",
    ),
    (
        "correction",
        "Poprawienie lub odwołanie wcześniejszego faktu, ustalenia lub preferencji.",
    ),
    (
        "execute",
        "Zlecenie konkretnego działania, zmiany lub zadania do wykonania.",
    ),
    (
        "recall",
        "Przypomnienie wcześniejszych rozmów, faktów lub ustaleń.",
    ),
    (
        "remember",
        "Jawna prośba o zapamiętanie nowej informacji lub preferencji.",
    ),
];

/// The guidance shown to the model for each classified intent.
pub const BASAL_PROMPT_GUIDANCE: [(&str, &str); 6] = [
    (
        "clarify",
        "Ask for clarification if the original request is actually incomplete.",
    ),
    (
        "conversation",
        "Answer the user's message normally.",
    ),
    (
        "correction",
        "Check the previous fact and honor the explicit correction. Persist only under the existing consent and surface policy.",
    ),
    (
        "execute",
        "Identify the requested action and use the existing tool permission and approval gates.",
    ),
    (
        "recall",
        "Use available memory evidence and source references before claiming to remember facts.",
    ),
    (
        "remember",
        "Consider the explicit memory request under the existing consent and memory-write policy.",
    ),
];

/// The exact marker used when the prompt had to be shortened.
pub const BASAL_PROMPT_TRUNCATION_MARKER: &str =
    "\n[... shortened for intent classification ...]\n";

/// Framing sentence: the hint is fallible and grants nothing.
pub const BASAL_PROMPT_INTRO: &str = "This is a fallible local intent hint, not evidence or authorization. Existing input-risk, tool, consent and memory policies remain authoritative.";

/// Sentence used when the hint exists but is partial or below threshold.
pub const BASAL_PROMPT_UNCERTAIN: &str = "The hint is uncertain or partial. Interpret the original message normally; do not force this label or claim that missing facts are known.";

/// Sentence used when Basal could not classify this turn.
pub const BASAL_PROMPT_UNAVAILABLE: &str = "Basal classification is unavailable for this turn. Continue from the original message without claiming that Basal classified it.";

/// Maximum size of the `state` field sent to Basal, in UTF-8 bytes.
pub const BASAL_PROMPT_MAX_STATE_BYTES: usize = 1024;

const BASAL_PROMPT_ENABLED_ENV: &str = "MEMPHIS_BASAL_PROMPT_ENABLED";
const BASAL_PROMPT_TIMEOUT_ENV: &str = "MEMPHIS_BASAL_PROMPT_TIMEOUT_MS";
const BASAL_PROMPT_URL_ENV: &str = "MEMPHIS_BASAL_URL";
const BASAL_PROMPT_TIMEOUT_DEFAULT_MS: u64 = 60_000;
const BASAL_PROMPT_TIMEOUT_MIN_MS: u64 = 1_000;
const BASAL_PROMPT_TIMEOUT_MAX_MS: u64 = 300_000;
/// Share of the shortened budget kept from the head of the prompt.
const BASAL_PROMPT_HEAD_PERCENT: usize = 70;
/// How often the cancellation flag is polled while the HTTP worker runs.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Static failure reasons. These are the *only* strings allowed to appear in
/// result or audit metadata — never a backend message, never a prompt.
pub mod reason {
    pub const TIMEOUT: &str = "timeout";
    pub const UNREACHABLE: &str = "unreachable";
    pub const HTTP_ERROR: &str = "http_error";
    pub const INVALID_RESPONSE: &str = "invalid_response";
    pub const SERVICE_BUSY: &str = "service_busy";
    pub const OUT_OF_DOMAIN: &str = "out_of_domain";
    pub const NON_LOOPBACK_ENDPOINT: &str = "non_loopback_endpoint";
    pub const ENDPOINT_CREDENTIALS: &str = "endpoint_credentials";
    pub const ENDPOINT_QUERY: &str = "endpoint_query";
    pub const ENDPOINT_FRAGMENT: &str = "endpoint_fragment";
    pub const INVALID_ENDPOINT: &str = "invalid_endpoint";
    pub const TRUNCATED: &str = "truncated";
    pub const DEFERRED: &str = "deferred";
    pub const UNVALIDATED_CALIBRATION: &str = "unvalidated_calibration";
    pub const CONFIDENCE_BELOW_THRESHOLD: &str = "confidence_below_threshold";
}

/// One classification result for one user turn.
///
/// `camelCase` JSON: the TypeScript surface reads the same keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasalPromptClassification {
    /// `classified` or `unavailable`.
    pub status: String,
    /// SHA-256 of the full trimmed original prompt.
    pub content_hash: String,
    /// Byte length of the full trimmed original prompt.
    pub input_bytes: usize,
    /// Byte length of the state actually sent to Basal.
    pub classified_bytes: usize,
    /// Whether the prompt had to be shortened.
    pub truncated: bool,
    /// Wall-clock duration of the classification attempt.
    pub latency_ms: u64,
    /// The hint must not be trusted as a decision.
    pub uncertain: bool,
    /// The classified intent, only present for a validated `classified` result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// Backend confidence, only present for a validated `classified` result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Threshold the confidence was compared against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    /// Static reason code only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

impl BasalPromptClassification {
    fn unavailable(
        content_hash: String,
        input_bytes: usize,
        classified_bytes: usize,
        truncated: bool,
        latency_ms: u64,
        reason: &'static str,
    ) -> Self {
        Self {
            status: "unavailable".to_string(),
            content_hash,
            input_bytes,
            classified_bytes,
            truncated,
            latency_ms,
            uncertain: true,
            intent: None,
            confidence: None,
            threshold: None,
            failure_reason: Some(reason.to_string()),
        }
    }
}

/// Internal worker outcome. Kept separate from the public struct so the
/// worker thread never has to construct user-facing metadata.
enum BasalPromptOutcome {
    Classified {
        intent: String,
        confidence: f64,
        threshold: f64,
        uncertain: bool,
        failure_reason: Option<&'static str>,
        latency_ms: u64,
    },
    Unavailable {
        reason: &'static str,
        latency_ms: u64,
    },
}

/// The feature flag. Off by default; `true`/`1` turns it on.
pub fn basal_prompt_enabled(config: &OperatorConfig) -> bool {
    match config.env(BASAL_PROMPT_ENABLED_ENV) {
        Some(value) => {
            let value = value.trim();
            value.eq_ignore_ascii_case("true") || value == "1"
        }
        None => false,
    }
}

/// The per-turn deadline. Invalid values fall back to the default.
pub fn basal_prompt_timeout(config: &OperatorConfig) -> Duration {
    let millis = config
        .env(BASAL_PROMPT_TIMEOUT_ENV)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| (BASAL_PROMPT_TIMEOUT_MIN_MS..=BASAL_PROMPT_TIMEOUT_MAX_MS).contains(value))
        .unwrap_or(BASAL_PROMPT_TIMEOUT_DEFAULT_MS);
    Duration::from_millis(millis)
}

/// The Basal endpoint. Never used unless it passes the loopback check.
pub fn basal_prompt_endpoint(config: &OperatorConfig) -> String {
    config
        .env(BASAL_PROMPT_URL_ENV)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(BASAL_DEFAULT_URL)
        .to_string()
}

/// The six criteria keys, alphabetically.
pub fn basal_prompt_criteria_keys() -> Vec<String> {
    BASAL_PROMPT_CRITERIA
        .iter()
        .map(|(key, _)| (*key).to_string())
        .collect()
}

/// The criteria map sent to Basal. `serde_json::Map` keeps it alphabetical.
fn basal_prompt_criteria_map() -> Map<String, Value> {
    let mut map = Map::new();
    for (key, description) in BASAL_PROMPT_CRITERIA.iter() {
        map.insert(
            (*key).to_string(),
            Value::String((*description).to_string()),
        );
    }
    map
}

/// The exact request body sent to Basal.
///
/// Deliberately free of identity, surface and time: the same prompt must
/// map to the same server-side cache entry on every surface.
pub fn basal_prompt_request_body(state: &str) -> Value {
    json!({
        "state": state,
        "orders": 1,
        "questions": {
            "k": {
                "type": "choice",
                "instructions": BASAL_PROMPT_QUESTION,
                "criteria": Value::Object(basal_prompt_criteria_map()),
            }
        }
    })
}

/// Shorten a prompt to at most [`BASAL_PROMPT_MAX_STATE_BYTES`] UTF-8 bytes.
///
/// 70% of the budget (after reserving the exact marker) is kept from the head,
/// the remainder from the tail. Cuts land on character boundaries, so the
/// result is always valid UTF-8.
pub fn shorten_for_classification(prompt: &str) -> (String, bool) {
    if prompt.len() <= BASAL_PROMPT_MAX_STATE_BYTES {
        return (prompt.to_string(), false);
    }
    let marker = BASAL_PROMPT_TRUNCATION_MARKER;
    let budget = BASAL_PROMPT_MAX_STATE_BYTES.saturating_sub(marker.len());
    let head_budget = budget * BASAL_PROMPT_HEAD_PERCENT / 100;
    let tail_budget = budget - head_budget;
    let head = take_head(prompt, head_budget);
    let tail = take_tail(prompt, tail_budget);
    let mut state = String::with_capacity(head.len() + marker.len() + tail.len());
    state.push_str(head);
    state.push_str(marker);
    state.push_str(tail);
    (state, true)
}

/// The first `budget` bytes, cut back to a character boundary.
fn take_head(text: &str, budget: usize) -> &str {
    let mut end = budget.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The last `budget` bytes, moved forward to a character boundary.
fn take_tail(text: &str, budget: usize) -> &str {
    let mut start = text.len().saturating_sub(budget);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The HTTP agent used for every automatic classification.
///
/// Redirects are disabled: a redirect could carry the prompt to another
/// host. Proxy detection from the environment is disabled too, so a loopback
/// endpoint can never be steered through a remote proxy.
fn basal_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .build()
    })
}

/// Reject anything that is not a plain loopback endpoint.
///
/// No credentials, no query string, no fragment: the classification request
/// carries the prompt and must not be steerable into a remote target.
fn validate_endpoint(request: &ureq::Request) -> Result<(), &'static str> {
    let parsed = request
        .request_url()
        .map_err(|_| reason::INVALID_ENDPOINT)?;
    let url = parsed.as_url();
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(reason::NON_LOOPBACK_ENDPOINT);
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if !(host == "localhost" || host == "127.0.0.1" || host == "::1") {
        return Err(reason::NON_LOOPBACK_ENDPOINT);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(reason::ENDPOINT_CREDENTIALS);
    }
    if url.query().is_some() {
        return Err(reason::ENDPOINT_QUERY);
    }
    if url.fragment().is_some() {
        return Err(reason::ENDPOINT_FRAGMENT);
    }
    Ok(())
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

/// Classify one user prompt.
///
/// * `Ok(None)` — the feature is disabled; no HTTP request was made.
/// * `Err(OperatorError::Cancelled)` — the turn was cancelled.
/// * `Ok(Some(..))` — a classification or an explicit `unavailable` verdict.
pub fn classify_prompt_for_turn(
    config: &OperatorConfig,
    prompt: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Option<BasalPromptClassification>, OperatorError> {
    if !basal_prompt_enabled(config) {
        return Ok(None);
    }
    ensure_chat_not_cancelled(cancel_flag)?;

    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let input_bytes = trimmed.len();
    let content_hash = sha256_hex(trimmed.as_bytes());
    let (state, truncated) = shorten_for_classification(trimmed);
    let classified_bytes = state.len();
    let endpoint = basal_prompt_endpoint(config);
    let deadline = Instant::now() + basal_prompt_timeout(config);

    // The endpoint is validated before any byte of the prompt leaves the
    // process. A non-loopback endpoint is an `unavailable` turn, never an
    // outbound request.
    let request = basal_agent().post(&endpoint);
    if let Err(why) = validate_endpoint(&request) {
        return Ok(Some(BasalPromptClassification::unavailable(
            content_hash,
            input_bytes,
            classified_bytes,
            truncated,
            0,
            why,
        )));
    }

    let endpoint_for_worker = endpoint.clone();
    let state_for_worker = state.clone();
    let outcome = run_cancellable(cancel_flag, move || {
        perform_classification(&endpoint_for_worker, &state_for_worker, deadline)
    })?;

    ensure_chat_not_cancelled(cancel_flag)?;

    let classification = match outcome {
        BasalPromptOutcome::Classified {
            intent,
            confidence,
            threshold,
            uncertain,
            failure_reason,
            latency_ms,
        } => BasalPromptClassification {
            status: "classified".to_string(),
            content_hash,
            input_bytes,
            classified_bytes,
            truncated,
            latency_ms,
            uncertain: uncertain || truncated,
            intent: Some(intent),
            confidence: Some(confidence),
            threshold: Some(threshold),
            failure_reason: failure_reason
                .or(if truncated {
                    Some(reason::TRUNCATED)
                } else {
                    None
                })
                .map(str::to_string),
        },
        BasalPromptOutcome::Unavailable { reason, latency_ms } => {
            BasalPromptClassification::unavailable(
                content_hash,
                input_bytes,
                classified_bytes,
                truncated,
                latency_ms,
                reason,
            )
        }
    };
    Ok(Some(classification))
}

/// Run the HTTP work on a worker thread so the UI cancellation stays
/// responsive. The worker keeps its own finite timeout and never retries.
fn run_cancellable<F>(
    cancel_flag: Option<&AtomicBool>,
    work: F,
) -> Result<BasalPromptOutcome, OperatorError>
where
    F: FnOnce() -> BasalPromptOutcome + Send + 'static,
{
    let (sender, receiver) = mpsc::channel::<BasalPromptOutcome>();
    let worker = std::thread::spawn(move || {
        let outcome = work();
        let _ = sender.send(outcome);
    });
    loop {
        match receiver.recv_timeout(CANCEL_POLL_INTERVAL) {
            Ok(outcome) => {
                let _ = worker.join();
                return Ok(outcome);
            }
            Err(RecvTimeoutError::Timeout) => {
                if cancel_flag
                    .map(|flag| flag.load(Ordering::Relaxed))
                    .unwrap_or(false)
                {
                    // The worker still owns a finite timeout; it ends on its
                    // own. The turn aborts now, through the normal cancel path.
                    return Err(OperatorError::Cancelled);
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                return Ok(BasalPromptOutcome::Unavailable {
                    reason: reason::UNREACHABLE,
                    latency_ms: 0,
                });
            }
        }
    }
}

/// The actual Basal exchange: threshold and classification under one deadline.
fn perform_classification(endpoint: &str, state: &str, deadline: Instant) -> BasalPromptOutcome {
    let started = Instant::now();
    let elapsed_ms = || started.elapsed().as_millis() as u64;

    let remaining = match deadline.checked_duration_since(Instant::now()) {
        Some(remaining) if !remaining.is_zero() => remaining,
        _ => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::TIMEOUT,
                latency_ms: elapsed_ms(),
            }
        }
    };

    let request = basal_agent().post(endpoint);
    let response = match request
        .timeout(remaining)
        .send_json(basal_prompt_request_body(state))
    {
        Ok(response) if (200..300).contains(&response.status()) => response,
        Ok(_) => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::HTTP_ERROR,
                latency_ms: elapsed_ms(),
            }
        }
        Err(ureq::Error::Status(_, _)) => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::HTTP_ERROR,
                latency_ms: elapsed_ms(),
            }
        }
        Err(ureq::Error::Transport(_)) => {
            // ureq does not separate a read timeout from a refused
            // connection, so the deadline decides which one it was.
            let reason = if Instant::now() >= deadline {
                reason::TIMEOUT
            } else {
                reason::UNREACHABLE
            };
            return BasalPromptOutcome::Unavailable {
                reason,
                latency_ms: elapsed_ms(),
            };
        }
    };

    let body = match read_basal_json(response) {
        Ok(body) => body,
        Err(error) => {
            // These are our own static strings, never a backend message.
            let message = error.to_string();
            let reason = if message.contains("timed out") {
                reason::TIMEOUT
            } else if message.contains("cannot read") {
                reason::UNREACHABLE
            } else {
                reason::INVALID_RESPONSE
            };
            return BasalPromptOutcome::Unavailable {
                reason,
                latency_ms: elapsed_ms(),
            };
        }
    };

    if body.get("error").filter(|error| is_truthy(error)).is_some() {
        return BasalPromptOutcome::Unavailable {
            reason: reason::SERVICE_BUSY,
            latency_ms: elapsed_ms(),
        };
    }

    let threshold = match discover_prompt_threshold(
        endpoint,
        body.get("model").and_then(Value::as_str),
        deadline,
    ) {
        Ok(value) => value,
        Err(_) => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::TIMEOUT,
                latency_ms: elapsed_ms(),
            }
        }
    };

    let keys = basal_prompt_criteria_keys();
    let reported_choice = body
        .get("answers")
        .and_then(|answers| answers.get("k"))
        .and_then(|answer| answer.get("choice"))
        .and_then(Value::as_str);
    if let Some(choice) = reported_choice {
        if !keys.iter().any(|key| key == choice) {
            // An out-of-domain label is never rewritten into one of ours.
            return BasalPromptOutcome::Unavailable {
                reason: reason::OUT_OF_DOMAIN,
                latency_ms: elapsed_ms(),
            };
        }
    }

    let validated = match classify_reply_to_json(
        &body,
        "choice",
        BASAL_PROMPT_QUESTION,
        state,
        Some(threshold),
        1,
        &keys,
    ) {
        Ok(validated) => validated,
        Err(_) => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::INVALID_RESPONSE,
                latency_ms: elapsed_ms(),
            }
        }
    };

    let intent = match validated.get("choice").and_then(Value::as_str) {
        Some(intent) => intent.to_string(),
        None => {
            return BasalPromptOutcome::Unavailable {
                reason: reason::INVALID_RESPONSE,
                latency_ms: elapsed_ms(),
            }
        }
    };
    let confidence = validated
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let resolved_threshold = validated
        .get("threshold")
        .and_then(Value::as_f64)
        .unwrap_or(threshold);
    let deferred = validated
        .get("deferred")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let calibration = validated
        .get("calibration")
        .and_then(Value::as_str)
        .unwrap_or("unreported");

    let below_threshold = confidence < resolved_threshold;
    let uncertain = deferred || calibration == "unvalidated" || below_threshold;
    let failure_reason = if deferred {
        Some(reason::DEFERRED)
    } else if calibration == "unvalidated" {
        Some(reason::UNVALIDATED_CALIBRATION)
    } else if below_threshold {
        Some(reason::CONFIDENCE_BELOW_THRESHOLD)
    } else {
        None
    };

    BasalPromptOutcome::Classified {
        intent,
        confidence,
        threshold: resolved_threshold,
        uncertain,
        failure_reason,
        latency_ms: elapsed_ms(),
    }
}

// Threshold discovery uses the same non-redirecting, no-proxy agent and
// the remaining overall deadline. Check the model identity after the POST.
fn discover_prompt_threshold(
    endpoint: &str,
    expected_model: Option<&str>,
    deadline: Instant,
) -> Result<f64, &'static str> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(reason::TIMEOUT)?;
    let health = if let Some((prefix, _)) = endpoint.split_once("/v1/") {
        format!("{prefix}/health")
    } else {
        let parsed = basal_agent()
            .get(endpoint)
            .request_url()
            .map_err(|_| reason::INVALID_ENDPOINT)?;
        let mut url = parsed.as_url().clone();
        url.set_path("/health");
        url.to_string()
    };
    let body = basal_agent()
        .get(&health)
        .timeout(remaining.min(Duration::from_secs(5)))
        .call()
        .ok()
        .and_then(|response| read_basal_json(response).ok());
    if Instant::now() >= deadline {
        return Err(reason::TIMEOUT);
    }
    let threshold = body.as_ref().and_then(|body| {
        if let (Some(expected), Some(reported)) =
            (expected_model, body.get("model").and_then(Value::as_str))
        {
            if expected != reported {
                return None;
            }
        }
        parse_basal_threshold(body)
    });
    Ok(threshold.unwrap_or(0.93))
}

/// Render the system-prompt annotation for one classification.
///
/// The metadata block carries only safe classification fields. The prose
/// around it comes from the shared contract fixture.
pub fn render_basal_prompt_annotation(classification: &BasalPromptClassification) -> String {
    let metadata = serde_json::to_string(classification)
        .unwrap_or_else(|_| "{\"status\":\"unavailable\"}".to_string());
    let hint = if classification.status == "classified" {
        let guidance = if classification.uncertain {
            BASAL_PROMPT_UNCERTAIN
        } else {
            classification
                .intent
                .as_deref()
                .and_then(|intent| {
                    BASAL_PROMPT_GUIDANCE
                        .iter()
                        .find(|(key, _)| *key == intent)
                        .map(|(_, text)| *text)
                })
                .unwrap_or(BASAL_PROMPT_UNCERTAIN)
        };
        format!("{BASAL_PROMPT_INTRO}\n{guidance}")
    } else {
        BASAL_PROMPT_UNAVAILABLE.to_string()
    };
    format!("<basal_prompt_classification>\n{metadata}\n{hint}\n</basal_prompt_classification>")
}

/// Record the classification in the audit chain.
///
/// Uses the same canonical primitive as `chat_guards::audit_input_classification`
/// (`emit_runtime_security_event`), so the event lands through the regular
/// chain writer and never through a direct filesystem write. Only safe
/// metadata is recorded — no prompt, no reply body, no backend string.
pub fn audit_basal_prompt_classification(
    runtime: &OperatorRuntime,
    classification: &BasalPromptClassification,
) -> Result<(), OperatorError> {
    emit_runtime_security_event(
        runtime,
        "basal.prompt.classified",
        &classification.status,
        json!({
            "status": classification.status,
            "intent": classification.intent,
            "confidence": classification.confidence,
            "threshold": classification.threshold,
            "uncertain": classification.uncertain,
            "contentHash": classification.content_hash,
            "inputBytes": classification.input_bytes,
            "classifiedBytes": classification.classified_bytes,
            "truncated": classification.truncated,
            "latencyMs": classification.latency_ms,
            "failureReason": classification.failure_reason,
        }),
    )
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    /// A local fake Basal service. It never binds the real port 8000.
    pub struct FakeBasal {
        pub url: String,
        posts: Arc<AtomicUsize>,
        last_post_body: Arc<Mutex<String>>,
    }

    impl FakeBasal {
        pub fn posts(&self) -> usize {
            self.posts.load(Ordering::SeqCst)
        }

        pub fn last_post_body(&self) -> String {
            self.last_post_body
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }
    }

    /// What the fake service answers with.
    pub enum FakeReply {
        /// `200` with this JSON body.
        Body(String),
        /// `302` with this `Location` header.
        Redirect(String),
        /// `200` with this body, but only after `delay`.
        Slow(String, Duration),
    }

    const HEALTH_BODY: &str = r#"{"model":"synthetic","thresholds":{"0.01":{"confidence":0.95}}}"#;

    pub fn spawn_fake_basal(reply: FakeReply) -> FakeBasal {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake basal");
        let address = listener.local_addr().expect("fake basal address");
        let posts = Arc::new(AtomicUsize::new(0));
        let last_post_body = Arc::new(Mutex::new(String::new()));
        let counter = Arc::clone(&posts);
        let body_slot = Arc::clone(&last_post_body);
        let handle: JoinHandle<()> = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 2048];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            buffer.extend_from_slice(&chunk[..read]);
                            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let header_end = buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|p| p + 4)
                    .unwrap_or(buffer.len());
                let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let is_post = head.starts_with("POST");
                if is_post {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                let lower = head.to_ascii_lowercase();
                if let Some(index) = lower.find("content-length:") {
                    let length = head[index + "content-length:".len()..]
                        .lines()
                        .next()
                        .and_then(|line| line.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut body = buffer[header_end..].to_vec();
                    let already = body.len().min(length);
                    body.resize(length, 0);
                    if stream.read_exact(&mut body[already..]).is_ok() && is_post {
                        if let Ok(mut slot) = body_slot.lock() {
                            *slot = String::from_utf8_lossy(&body).to_string();
                        }
                    }
                }
                let response = match &reply {
                    FakeReply::Body(body) if is_post => body.clone(),
                    FakeReply::Slow(body, delay) if is_post => {
                        std::thread::sleep(*delay);
                        body.clone()
                    }
                    FakeReply::Redirect(location) if is_post => {
                        let payload = format!(
                            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(payload.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }
                    _ => HEALTH_BODY.to_string(),
                };
                let payload = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    response
                );
                let _ = stream.write_all(payload.as_bytes());
                let _ = stream.flush();
            }
        });
        // The listener stays open for the lifetime of the test binary; the
        // handle is intentionally detached.
        drop(handle);
        FakeBasal {
            url: format!("http://{address}/v1/systemone"),
            posts,
            last_post_body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{spawn_fake_basal, FakeReply};
    use super::*;
    use crate::config::OperatorConfig;
    use serde_json::Value;
    use std::sync::atomic::AtomicBool;

    const CONTRACT_FIXTURE: &str =
        include_str!("../../../tests/fixtures/basal-prompt-contract.json");

    fn contract() -> Value {
        serde_json::from_str(CONTRACT_FIXTURE).expect("contract fixture is JSON")
    }

    fn config_with(vars: &[(&str, &str)]) -> OperatorConfig {
        let mut pairs: Vec<(String, String)> = vec![
            ("HOME".to_string(), "/tmp".to_string()),
            ("DEFAULT_PROVIDER".to_string(), "local-fallback".to_string()),
        ];
        for (key, value) in vars {
            pairs.push(((*key).to_string(), (*value).to_string()));
        }
        OperatorConfig::from_iter(pairs)
    }

    fn valid_reply(choice: &str, confidence: f64) -> String {
        let other = 1.0 - confidence;
        json!({
            "model": "synthetic",
            "answers": {
                "k": {
                    "type": "choice",
                    "choice": choice,
                    "confidence": confidence,
                    "probabilities": {
                        "clarify": other / 5.0,
                        "conversation": other / 5.0,
                        "correction": other / 5.0,
                        "execute": confidence,
                        "recall": other / 5.0,
                        "remember": other / 5.0
                    },
                    "deferred": false,
                    "calibration": "validated"
                }
            }
        })
        .to_string()
    }

    #[test]
    fn contract_constants_match_the_shared_fixture() {
        let contract = contract();
        assert_eq!(
            contract["question"].as_str().unwrap(),
            BASAL_PROMPT_QUESTION,
            "question drifted from the shared contract"
        );
        assert_eq!(
            contract["maxStateBytes"].as_u64().unwrap() as usize,
            BASAL_PROMPT_MAX_STATE_BYTES
        );
        assert_eq!(
            contract["truncationMarker"].as_str().unwrap(),
            BASAL_PROMPT_TRUNCATION_MARKER
        );
        assert_eq!(contract["intro"].as_str().unwrap(), BASAL_PROMPT_INTRO);
        assert_eq!(
            contract["uncertain"].as_str().unwrap(),
            BASAL_PROMPT_UNCERTAIN
        );
        assert_eq!(
            contract["unavailable"].as_str().unwrap(),
            BASAL_PROMPT_UNAVAILABLE
        );
        let criteria = contract["criteria"].as_object().expect("criteria object");
        assert_eq!(criteria.len(), BASAL_PROMPT_CRITERIA.len());
        for (key, description) in BASAL_PROMPT_CRITERIA.iter() {
            assert_eq!(criteria[*key].as_str().unwrap(), *description, "{key}");
        }
        let guidance = contract["guidance"].as_object().expect("guidance object");
        assert_eq!(guidance.len(), BASAL_PROMPT_GUIDANCE.len());
        for (key, sentence) in BASAL_PROMPT_GUIDANCE.iter() {
            assert_eq!(guidance[*key].as_str().unwrap(), *sentence, "{key}");
        }
    }

    #[test]
    fn criteria_are_serialized_in_alphabetical_order() {
        let body = basal_prompt_request_body("state");
        let serialized = serde_json::to_string(&body["questions"]["k"]["criteria"]).unwrap();
        let keys: Vec<&str> = body["questions"]["k"]["criteria"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "clarify",
                "conversation",
                "correction",
                "execute",
                "recall",
                "remember"
            ]
        );
        assert!(serialized.starts_with("{\"clarify\":"));
    }

    #[test]
    fn request_body_carries_no_identity_surface_or_time() {
        let body = basal_prompt_request_body("hello");
        let object = body.as_object().expect("request body object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["orders", "questions", "state"]);
        assert_eq!(body["orders"].as_u64().unwrap(), 1);
        assert_eq!(body["questions"]["k"]["type"].as_str().unwrap(), "choice");
        assert_eq!(
            body["questions"]["k"]["instructions"].as_str().unwrap(),
            BASAL_PROMPT_QUESTION
        );
    }

    #[test]
    fn disabled_flag_performs_no_http() {
        let server = spawn_fake_basal(FakeReply::Body(valid_reply("execute", 0.99)));
        let config = config_with(&[("MEMPHIS_BASAL_URL", &server.url)]);
        let result =
            classify_prompt_for_turn(&config, "zrób mi kawę", None).expect("classification");
        assert!(result.is_none(), "disabled classification must return None");
        assert_eq!(
            server.posts(),
            0,
            "disabled classification must not talk to Basal"
        );
    }

    #[test]
    fn flag_accepts_only_true_or_one() {
        assert!(!basal_prompt_enabled(&config_with(&[])));
        assert!(basal_prompt_enabled(&config_with(&[(
            "MEMPHIS_BASAL_PROMPT_ENABLED",
            "true"
        )])));
        assert!(basal_prompt_enabled(&config_with(&[(
            "MEMPHIS_BASAL_PROMPT_ENABLED",
            "1"
        )])));
        assert!(basal_prompt_enabled(&config_with(&[(
            "MEMPHIS_BASAL_PROMPT_ENABLED",
            "TRUE"
        )])));
        assert!(!basal_prompt_enabled(&config_with(&[(
            "MEMPHIS_BASAL_PROMPT_ENABLED",
            "false"
        )])));
        assert!(!basal_prompt_enabled(&config_with(&[(
            "MEMPHIS_BASAL_PROMPT_ENABLED",
            "yes"
        )])));
    }

    #[test]
    fn timeout_defaults_and_rejects_out_of_range_values() {
        assert_eq!(
            basal_prompt_timeout(&config_with(&[])),
            Duration::from_millis(60_000)
        );
        assert_eq!(
            basal_prompt_timeout(&config_with(&[("MEMPHIS_BASAL_PROMPT_TIMEOUT_MS", "1500")])),
            Duration::from_millis(1_500)
        );
        for invalid in ["999", "300001", "abc", "-5", ""] {
            assert_eq!(
                basal_prompt_timeout(&config_with(&[(
                    "MEMPHIS_BASAL_PROMPT_TIMEOUT_MS",
                    invalid
                )])),
                Duration::from_millis(60_000),
                "invalid timeout {invalid} must fall back to the default"
            );
        }
    }

    #[test]
    fn endpoint_is_loopback_only_without_credentials_query_or_fragment() {
        let cases = [
            (
                "http://example.com:8000/v1/systemone",
                reason::NON_LOOPBACK_ENDPOINT,
            ),
            (
                "https://10.0.0.5/v1/systemone",
                reason::NON_LOOPBACK_ENDPOINT,
            ),
            (
                "http://user:pass@127.0.0.1:8000/v1/systemone",
                reason::ENDPOINT_CREDENTIALS,
            ),
            (
                "http://127.0.0.1:8000/v1/systemone?a=1",
                reason::ENDPOINT_QUERY,
            ),
            (
                "http://127.0.0.1:8000/v1/systemone#frag",
                reason::ENDPOINT_FRAGMENT,
            ),
        ];
        for (endpoint, expected) in cases {
            let request = ureq::post(endpoint);
            assert_eq!(
                validate_endpoint(&request),
                Err(expected),
                "endpoint {endpoint} must be refused"
            );
        }
        for endpoint in [
            "http://127.0.0.1:8000/v1/systemone",
            "http://localhost:8000/v1/systemone",
            "http://[::1]:8000/v1/systemone",
            "https://127.0.0.1/v1/systemone",
        ] {
            let request = ureq::post(endpoint);
            assert_eq!(
                validate_endpoint(&request),
                Ok(()),
                "endpoint {endpoint} must be allowed"
            );
        }
    }

    #[test]
    fn remote_endpoint_is_refused_without_contacting_it() {
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", "http://example.com:8000/v1/systemone"),
        ]);
        let classification = classify_prompt_for_turn(&config, "cześć", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "unavailable");
        assert_eq!(
            classification.failure_reason.as_deref(),
            Some(reason::NON_LOOPBACK_ENDPOINT)
        );
        assert!(classification.uncertain);
        assert!(classification.intent.is_none());
        assert!(classification.confidence.is_none());
    }

    #[test]
    fn redirects_are_not_followed() {
        let server = spawn_fake_basal(FakeReply::Redirect("http://example.com/".to_string()));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "cześć", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "unavailable");
        assert_eq!(
            classification.failure_reason.as_deref(),
            Some(reason::HTTP_ERROR)
        );
        assert_eq!(server.posts(), 1, "the redirect must not be replayed");
    }

    #[test]
    fn shortening_keeps_utf8_budget_and_hashes_the_whole_original() {
        let original = "zażółć gęślą jaźń ".repeat(200);
        let trimmed = original.trim();
        let (state, truncated) = shorten_for_classification(trimmed);
        assert!(truncated);
        assert!(
            state.len() <= BASAL_PROMPT_MAX_STATE_BYTES,
            "state is {} bytes",
            state.len()
        );
        assert!(state.contains(BASAL_PROMPT_TRUNCATION_MARKER));
        assert!(state.starts_with("zażółć"), "head was not kept");
        assert!(state.ends_with("jaźń"), "tail was not kept");
        let server = spawn_fake_basal(FakeReply::Body(valid_reply("execute", 0.97)));
        let classification = classify_prompt_for_turn(
            &config_with(&[
                ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
                ("MEMPHIS_BASAL_URL", &server.url),
            ]),
            trimmed,
            None,
        )
        .expect("classification")
        .expect("a classification verdict");
        assert_eq!(
            classification.content_hash,
            sha256_hex(trimmed.as_bytes()),
            "the hash must cover the whole original prompt"
        );
        assert_eq!(classification.input_bytes, trimmed.len());
        assert!(classification.classified_bytes <= BASAL_PROMPT_MAX_STATE_BYTES);
    }

    #[test]
    fn short_prompts_are_sent_unchanged() {
        let (state, truncated) = shorten_for_classification("krótki prompt");
        assert_eq!(state, "krótki prompt");
        assert!(!truncated);
    }

    #[test]
    fn valid_classification_is_reported_with_its_metadata() {
        let server = spawn_fake_basal(FakeReply::Body(valid_reply("execute", 0.97)));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "zrób mi kawę", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "classified");
        assert_eq!(classification.intent.as_deref(), Some("execute"));
        assert_eq!(classification.confidence, Some(0.97));
        assert!(classification.threshold.is_some());
        assert!(!classification.uncertain);
        assert!(classification.failure_reason.is_none());
        assert_eq!(server.posts(), 1);
        let body: Value =
            serde_json::from_str(&server.last_post_body()).expect("request body json");
        assert_eq!(body["state"].as_str().unwrap(), "zrób mi kawę");
        assert_eq!(body["orders"].as_u64().unwrap(), 1);
        assert_eq!(body["questions"]["k"]["type"].as_str().unwrap(), "choice");
        assert!(body["questions"]["k"]["criteria"]
            .as_object()
            .unwrap()
            .contains_key("execute"));
    }

    #[test]
    fn deferred_and_low_confidence_results_are_uncertain() {
        let mut deferred = valid_reply("execute", 0.97);
        deferred = deferred.replace("\"deferred\":false", "\"deferred\":true");
        let server = spawn_fake_basal(FakeReply::Body(deferred));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "zrób mi kawę", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "classified");
        assert!(classification.uncertain);
        assert_eq!(
            classification.failure_reason.as_deref(),
            Some(reason::DEFERRED)
        );
    }

    #[test]
    fn low_confidence_result_is_uncertain() {
        let server = spawn_fake_basal(FakeReply::Body(valid_reply("execute", 0.60)));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "zrób mi kawę", None)
            .expect("classification")
            .expect("a classification verdict");
        assert!(classification.uncertain);
        assert_eq!(
            classification.failure_reason.as_deref(),
            Some(reason::CONFIDENCE_BELOW_THRESHOLD)
        );
    }

    #[test]
    fn corrupt_and_out_of_domain_replies_fabricate_no_label() {
        let corrupt = spawn_fake_basal(FakeReply::Body("not json at all".to_string()));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &corrupt.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "zrób mi kawę", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "unavailable");
        assert!(classification.uncertain);
        assert!(classification.intent.is_none());
        assert!(classification.confidence.is_none());

        let mut out_of_domain = valid_reply("execute", 0.97);
        out_of_domain = out_of_domain.replace("\"choice\":\"execute\"", "\"choice\":\"sell\"");
        let server = spawn_fake_basal(FakeReply::Body(out_of_domain));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let classification = classify_prompt_for_turn(&config, "zrób mi kawę", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "unavailable");
        assert_eq!(
            classification.failure_reason.as_deref(),
            Some(reason::OUT_OF_DOMAIN)
        );
        assert!(classification.intent.is_none());
        assert!(classification.confidence.is_none());
    }

    #[test]
    fn unreachable_service_falls_back_to_unavailable() {
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", "http://127.0.0.1:9/v1/systemone"),
        ]);
        let classification = classify_prompt_for_turn(&config, "cześć", None)
            .expect("classification")
            .expect("a classification verdict");
        assert_eq!(classification.status, "unavailable");
        assert!(classification.uncertain);
        assert!(classification.intent.is_none());
        assert!(classification
            .failure_reason
            .is_some_and(|reason| reason == reason::UNREACHABLE || reason == reason::TIMEOUT));
    }

    #[test]
    fn slow_service_times_out_without_fabricating_a_label() {
        let server = spawn_fake_basal(FakeReply::Slow(
            valid_reply("execute", 0.97),
            Duration::from_secs(3),
        ));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
            ("MEMPHIS_BASAL_PROMPT_TIMEOUT_MS", "1000"),
        ]);
        let started = Instant::now();
        let classification = classify_prompt_for_turn(&config, "cześć", None)
            .expect("classification")
            .expect("a classification verdict");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the turn waited for the slow service"
        );
        assert_eq!(classification.status, "unavailable");
        assert!(classification.uncertain);
        assert!(classification.intent.is_none());
    }

    #[test]
    fn cancellation_aborts_the_turn() {
        let server = spawn_fake_basal(FakeReply::Slow(
            valid_reply("execute", 0.97),
            Duration::from_secs(5),
        ));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
            ("MEMPHIS_BASAL_PROMPT_TIMEOUT_MS", "5000"),
        ]);
        let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
        let setter_flag = std::sync::Arc::clone(&cancel_flag);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            setter_flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let result = classify_prompt_for_turn(&config, "cześć", Some(&cancel_flag));
        setter.join().expect("cancel setter");
        assert!(
            matches!(result, Err(OperatorError::Cancelled)),
            "cancellation must abort the turn"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "cancellation was not responsive"
        );
    }

    #[test]
    fn truncated_success_stays_uncertain_and_hashes_the_original() {
        let server = spawn_fake_basal(FakeReply::Body(valid_reply("execute", 0.97)));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let prompt = "Zażółć 🐾 ".repeat(300);
        let result = classify_prompt_for_turn(&config, &prompt, None)
            .unwrap()
            .unwrap();
        assert_eq!(result.status, "classified");
        assert!(result.truncated && result.uncertain);
        assert_eq!(result.content_hash, sha256_hex(prompt.trim().as_bytes()));
        assert!(result.classified_bytes <= 1024);
    }

    #[test]
    fn threshold_from_a_different_model_is_not_reused() {
        let body = valid_reply("execute", 0.97)
            .replace("\"model\":\"synthetic\"", "\"model\":\"different\"");
        let server = spawn_fake_basal(FakeReply::Body(body));
        let config = config_with(&[
            ("MEMPHIS_BASAL_PROMPT_ENABLED", "true"),
            ("MEMPHIS_BASAL_URL", &server.url),
        ]);
        let result = classify_prompt_for_turn(&config, "synthetic prompt", None)
            .unwrap()
            .unwrap();
        assert_eq!(result.status, "classified");
        assert_eq!(result.threshold, Some(0.93));
    }

    #[test]
    fn annotation_contains_metadata_intro_and_guidance() {
        let classification = BasalPromptClassification {
            status: "classified".to_string(),
            content_hash: "abc".to_string(),
            input_bytes: 10,
            classified_bytes: 10,
            truncated: false,
            latency_ms: 5,
            uncertain: false,
            intent: Some("execute".to_string()),
            confidence: Some(0.97),
            threshold: Some(0.93),
            failure_reason: None,
        };
        let rendered = render_basal_prompt_annotation(&classification);
        assert!(rendered.contains("<basal_prompt_classification>"));
        assert!(rendered.contains("\"intent\":\"execute\""));
        assert!(rendered.contains("\"status\":\"classified\""));
        assert!(rendered.contains(BASAL_PROMPT_INTRO));
        assert!(rendered.contains(
            "Identify the requested action and use the existing tool permission and approval gates."
        ));
        assert!(!rendered.contains(BASAL_PROMPT_UNCERTAIN));
        assert!(!rendered.contains(BASAL_PROMPT_UNAVAILABLE));
    }

    #[test]
    fn uncertain_and_unavailable_annotations_use_their_sentences() {
        let uncertain = BasalPromptClassification {
            status: "classified".to_string(),
            content_hash: "abc".to_string(),
            input_bytes: 10,
            classified_bytes: 10,
            truncated: true,
            latency_ms: 5,
            uncertain: true,
            intent: Some("execute".to_string()),
            confidence: Some(0.5),
            threshold: Some(0.93),
            failure_reason: Some(reason::TRUNCATED.to_string()),
        };
        let rendered = render_basal_prompt_annotation(&uncertain);
        assert!(rendered.contains(BASAL_PROMPT_UNCERTAIN));

        let unavailable = BasalPromptClassification::unavailable(
            "abc".to_string(),
            10,
            10,
            false,
            5,
            reason::TIMEOUT,
        );
        let rendered = render_basal_prompt_annotation(&unavailable);
        assert!(rendered.contains(BASAL_PROMPT_UNAVAILABLE));
        assert!(!rendered.contains("\"intent\""));
    }
}

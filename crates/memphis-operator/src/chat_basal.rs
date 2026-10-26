//! Client for the local BASAL-1.0 typed-decision service.
//!
//! `memphis_classify` asks BASAL one typed question about one piece of
//! state and returns calibrated probabilities per option. The service is
//! optional and slow (70-140s per call on the operator's host), so the
//! client is isolated here: its endpoint, timeout, threshold discovery
//! and reply parsing are one concern, separate from tool dispatch.
//!
//! Split out of `chat.rs` unchanged.

use serde_json::{json, Value};

use crate::OperatorError;

/// Default endpoint of the local BASAL typed-decision service.
pub(crate) const BASAL_DEFAULT_URL: &str = "http://127.0.0.1:8000/v1/systemone";
/// Endpoint that reports the loaded model's own calibration points.
const BASAL_HEALTH_URL: &str = "http://127.0.0.1:8000/health";
/// Fallback confidence when the service cannot be asked for its own
/// threshold. 0.93 is the ~1%-error point of basal-1.0, which is where
/// this constant came from; it is a floor for an unreachable service,
/// NOT a claim about whichever model happens to be loaded — see
/// `basal_threshold_from_service`.
const BASAL_DEFAULT_THRESHOLD: f64 = 0.93;
/// Ceiling for one call. The model needs 70-140s on this host; the bound
/// exists so a wedged service cannot hold a tool call open forever.
pub(crate) const BASAL_TIMEOUT_SECS: u64 = 300;

/// Pull the 1%-error confidence out of a BASAL `/health` body.
///
/// Split out of `basal_threshold_from_service` so the shape of the reply —
/// not just the fact that a service answered — is covered by tests that
/// need no daemon. The band check lives here too: a service that reports
/// 0.2 or 1.5 is not a calibration point, it is a broken reply, and both
/// callers must treat it as "no threshold" rather than propagating it.
pub(crate) fn parse_basal_threshold(body: &Value) -> Option<f64> {
    body.get("thresholds")?
        .get("0.01")?
        .get("confidence")?
        .as_f64()
        .filter(|value| (0.5..1.0).contains(value))
}

/// The calibration point the loaded model actually ships, cached after the
/// first successful read.
///
/// The threshold is not a property of BASAL, it is a property of the
/// weights: basal-1.0-1.5B calibrates at 0.930/0.742 and basal-1.5-mini at
/// 0.955/0.763 (both measured, `/health` of the same service). A hardcoded
/// 0.93 therefore means "1% error" on one release and "less than 1%" on the
/// next — and after the model was switched, the 1.5-mini run that scored
/// 0.9957 and 0.9706 was called AUTO at 0.93 while the model's own 1%-error
/// point says 0.955, so `auto` claimed more confidence than the calibration
/// supports.
///
/// Cached because `classify_input` runs on every operator message: a /health
/// probe per message would double the local HTTP traffic for a number that
/// changes only when the model is swapped. `OnceLock` gives a lock-free
/// read on the hot path. The cache is per-process and never invalidated —
/// a restarted TUI re-reads, which is exactly when a model swap happens
/// (the service is restarted by systemd, the TUI generally is not).
pub(crate) fn basal_threshold_from_service() -> f64 {
    static CACHE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        // Same env override as the decision call, so pointing
        // MEMPHIS_BASAL_URL at another service moves the threshold read
        // with it. Deriving from the systemone URL keeps the two in step
        // instead of leaving a hardcoded localhost behind.
        let base = std::env::var("MEMPHIS_BASAL_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| BASAL_DEFAULT_URL.to_string());
        let health = match base.split("/v1/").next() {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}/health"),
            _ => BASAL_HEALTH_URL.to_string(),
        };
        let parsed = ureq::get(&health)
            .timeout(std::time::Duration::from_secs(5))
            .call()
            .ok()
            .and_then(|response| response.into_json::<Value>().ok())
            .and_then(|body| parse_basal_threshold(&body));
        match parsed {
            Some(value) => value,
            None => {
                // Unreachable service, older reply without `thresholds`, or a
                // value outside the plausible band. The caller's own
                // `threshold` argument still wins; this is only the default.
                BASAL_DEFAULT_THRESHOLD
            }
        }
    })
}

/// Parse a BASAL reply into the tool's output shape. Split out from the
/// HTTP call so the decision semantics — `auto` above all — can be tested
/// against a recorded reply instead of a 3.2 GB model.
pub(crate) fn classify_reply_to_json(
    body: &Value,
    question_type: &str,
    question: &str,
    state: &str,
    threshold: Option<f64>,
    orders: u64,
) -> Result<Value, OperatorError> {
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        return Err(OperatorError::Message(match error {
            "loading" => {
                "memphis_classify: the BASAL model is still loading; retry in a few seconds"
                    .to_string()
            }
            other => format!("memphis_classify: BASAL returned an error: {other}"),
        }));
    }
    let answer = body
        .get("answers")
        .and_then(|answers| answers.get("k"))
        .ok_or_else(|| {
            OperatorError::Message(
                "memphis_classify: BASAL reply carried no answer for the question".to_string(),
            )
        })?;
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let effective_threshold = threshold.unwrap_or_else(basal_threshold_from_service);
    let latency_ms = body
        .get("usage")
        .and_then(|usage| usage.get("latency_ms"))
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    Ok(json!({
        "ok": true,
        "state": state,
        "question": question,
        "type": question_type,
        "choice": answer.get("choice").and_then(Value::as_str),
        "noul": answer.get("noul").and_then(Value::as_str),
        "score": answer.get("score").and_then(Value::as_f64),
        "probabilities": answer.get("probabilities").cloned().unwrap_or_else(|| json!({})),
        "confidence": confidence,
        "threshold": effective_threshold,
        "auto": confidence >= effective_threshold,
        "orders": orders,
        "latencyMs": latency_ms,
    }))
}

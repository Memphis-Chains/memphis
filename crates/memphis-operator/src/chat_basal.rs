//! Advisory typed decisions from a separately running local Basal service.
//! Confidence is not permission or a Memphis-domain error-rate guarantee.

use std::io::Read;
use std::time::{Duration, Instant};

use crate::OperatorError;
use serde_json::{json, Value};

pub(crate) const BASAL_DEFAULT_URL: &str = "http://127.0.0.1:8000/v1/systemone";
pub(crate) const BASAL_TIMEOUT_SECS: u64 = 300;
const DEFAULT_THRESHOLD: f64 = 0.93;
const MAX_BYTES: u64 = 64 * 1024;
const TOLERANCE: f64 = 1e-4;

fn failure(message: &str) -> OperatorError {
    OperatorError::Message(format!("memphis_classify: {message}"))
}

pub(crate) fn parse_basal_threshold(body: &Value) -> Option<f64> {
    body.get("thresholds")?
        .get("0.01")?
        .get("confidence")?
        .as_f64()
        .filter(|value| value.is_finite() && (0.5..1.0).contains(value))
}

/// ureq 2.12's request deadline remains active in its response reader.
/// Bound bytes before attempting UTF-8/JSON decoding; never quote the body.
pub(crate) fn read_basal_json(response: ureq::Response) -> Result<Value, OperatorError> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                failure("BASAL response timed out")
            }
            _ => failure("cannot read BASAL response"),
        })?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(failure("BASAL response exceeds 64 KiB"));
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("BASAL response is not valid JSON"))
}

/// A producer threshold is an advisory default, not a domain certificate.
/// Resolve on each decision, with the same endpoint and remaining deadline.
/// There is no process-global cache that survives model/endpoint changes.
pub(crate) fn basal_threshold_from_service(
    endpoint: &str,
    expected_model: Option<&str>,
    deadline: Instant,
) -> Result<f64, OperatorError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| failure("BASAL request timed out"))?;
    let health = match endpoint.split_once("/v1/") {
        Some((prefix, _)) => format!("{prefix}/health"),
        None => {
            // Endpoints without the conventional /v1/ suffix use origin /health.
            let scheme = endpoint.find("://").map(|i| i + 3).unwrap_or(0);
            let end = endpoint[scheme..]
                .find('/')
                .map(|i| scheme + i)
                .unwrap_or(endpoint.len());
            format!("{}/health", &endpoint[..end])
        }
    };
    let body = ureq::get(&health)
        .timeout(remaining.min(Duration::from_secs(5)))
        .call()
        .ok()
        .and_then(|response| read_basal_json(response).ok());
    if Instant::now() >= deadline {
        return Err(failure("BASAL request timed out"));
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
    Ok(threshold.unwrap_or(DEFAULT_THRESHOLD))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

/// Pure response validation: callers supply the request keys and resolved policy.
/// Missing calibration is reported as unreported; auto is advisory eligibility.
pub(crate) fn classify_reply_to_json(
    body: &Value,
    question_type: &str,
    question: &str,
    state: &str,
    threshold: Option<f64>,
    orders: u64,
    keys: &[String],
) -> Result<Value, OperatorError> {
    let threshold = threshold.unwrap_or(DEFAULT_THRESHOLD);
    if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
        return Err(failure("invalid caller threshold"));
    }
    if !matches!(question_type, "choice" | "noul" | "score")
        || !matches!(orders, 1 | 2)
        || !(2..=10).contains(&keys.len())
        || keys.iter().collect::<std::collections::BTreeSet<_>>().len() != keys.len()
    {
        return Err(failure("invalid classification policy"));
    }
    if let Some(error) = body.get("error").filter(|error| truthy(error)) {
        return Err(if error.as_str() == Some("loading") {
            failure("the BASAL model is still loading; retry in a few seconds")
        } else {
            failure("BASAL reported an inference error")
        });
    }
    let invalid =
        || failure("BASAL returned an invalid typed decision or probability distribution");
    let answer = body
        .get("answers")
        .and_then(Value::as_object)
        .and_then(|answers| answers.get("k"))
        .and_then(Value::as_object)
        .ok_or_else(|| failure("BASAL reply carried no answer for the question"))?;
    if answer.get("type").and_then(Value::as_str) != Some(question_type) {
        return Err(invalid());
    }
    let probabilities = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let same_keys = |expected: &[String]| {
        probabilities.len() == expected.len()
            && expected.iter().all(|key| probabilities.contains_key(key))
    };
    let boolean_keys = vec!["true".to_string(), "false".to_string()];
    let ordinal_keys: Vec<String> = (0..keys.len()).map(|i| i.to_string()).collect();
    if question_type == "score" && keys != ordinal_keys.as_slice() {
        return Err(invalid());
    }
    if !same_keys(keys)
        && !(question_type == "noul" && same_keys(&boolean_keys))
        && !(question_type == "score" && same_keys(&ordinal_keys))
    {
        return Err(invalid());
    }
    let values: Vec<f64> = probabilities
        .values()
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(invalid)?;
    let maximum = values.iter().copied().fold(0.0, f64::max);
    if (values.iter().sum::<f64>() - 1.0).abs() > TOLERANCE {
        return Err(invalid());
    }
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite() && (0.0..=1.0).contains(value) && (value - maximum).abs() <= TOLERANCE
        })
        .ok_or_else(invalid)?;
    let winner = |key: &str| {
        probabilities
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|probability| (probability - confidence).abs() <= TOLERANCE)
    };
    match question_type {
        "choice" => {
            let choice = answer
                .get("choice")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if !keys.iter().any(|key| key == choice) || !winner(choice) {
                return Err(invalid());
            }
        }
        "noul" => match answer.get("noul") {
            Some(Value::String(key)) if winner(key) => (),
            Some(value) => {
                let value = value
                    .as_f64()
                    .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                    .ok_or_else(invalid)?;
                if same_keys(&boolean_keys) {
                    let yes = probabilities
                        .get("true")
                        .and_then(Value::as_f64)
                        .ok_or_else(invalid)?;
                    if (value - yes).abs() > TOLERANCE {
                        return Err(invalid());
                    }
                } else if value.fract() != 0.0 || !winner(&keys[value as usize]) {
                    return Err(invalid());
                }
            }
            None => return Err(invalid()),
        },
        "score" => {
            let score_keys = if same_keys(keys) { keys } else { &ordinal_keys };
            let expected: f64 = score_keys
                .iter()
                .enumerate()
                .map(|(i, key)| {
                    i as f64
                        * probabilities
                            .get(key)
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                })
                .sum();
            let score = answer
                .get("score")
                .and_then(Value::as_f64)
                .filter(|score| score.is_finite())
                .ok_or_else(invalid)?;
            if (score - expected).abs() > TOLERANCE {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    let deferred = match answer.get("deferred") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(invalid()),
    };
    let calibration = match answer.get("calibration") {
        None => "unreported",
        Some(Value::String(value)) if matches!(value.as_str(), "validated" | "unvalidated") => {
            value
        }
        _ => return Err(invalid()),
    };
    let latency = body
        .get("usage")
        .and_then(|usage| usage.get("latency_ms"))
        .filter(|value| {
            value
                .as_f64()
                .is_some_and(|value| value.is_finite() && value >= 0.0)
        })
        .cloned()
        .unwrap_or(json!(-1));
    Ok(json!({
        "ok": true, "state": state, "question": question, "type": question_type,
        "choice": answer.get("choice").and_then(Value::as_str),
        "noul": answer.get("noul").filter(|value| value.is_string() || value.is_number()),
        "score": answer.get("score").and_then(Value::as_f64),
        "probabilities": probabilities, "confidence": confidence, "threshold": threshold,
        "auto": confidence >= threshold && !deferred && calibration != "unvalidated",
        "model": body.get("model").and_then(Value::as_str), "deferred": deferred,
        "calibration": calibration, "orders": orders, "latencyMs": latency,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_decision_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/basal-native-parity.json"
        ))
        .unwrap();
        for case in fixture.as_array().unwrap() {
            let keys: Vec<String> = case["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap().to_string())
                .collect();
            let result = classify_reply_to_json(
                &case["reply"],
                case["type"].as_str().unwrap(),
                "synthetic",
                "public fixture",
                Some(case["threshold"].as_f64().unwrap()),
                2,
                &keys,
            );
            assert_eq!(
                result.is_ok(),
                case["ok"].as_bool().unwrap(),
                "case {}",
                case["name"]
            );
            if let Ok(result) = result {
                assert_eq!(result["auto"], case["auto"], "case {}", case["name"]);
            } else {
                assert!(!result.unwrap_err().to_string().contains("private-sentinel"));
            }
        }
    }
    fn response(body: &str) -> ureq::Response {
        ureq::Response::new(200, "OK", body).unwrap()
    }
    #[test]
    fn rejects_oversized_and_malformed_bodies_without_echo() {
        assert!(read_basal_json(response(&"x".repeat(65537))).is_err());
        let error = read_basal_json(response("private-sentinel"))
            .unwrap_err()
            .to_string();
        assert!(!error.contains("private-sentinel"));
    }
    #[test]
    fn response_body_remains_subject_to_the_request_deadline() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0u8; 4096];
            stream.read(&mut buffer).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n")
                .unwrap();
            stream.flush().unwrap();
            std::thread::sleep(Duration::from_secs(1));
        });
        let response = ureq::get(&url)
            .timeout(Duration::from_millis(200))
            .call()
            .unwrap();
        let error = read_basal_json(response).unwrap_err().to_string();
        server.join().unwrap();
        assert!(error.contains("timed out"), "{error}");
    }
    #[test]
    fn model_identity_and_endpoint_are_not_process_cached() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for confidence in [0.9546, 0.97, 0.99] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /health "));
                let body =
                    json!({"model":"synthetic", "thresholds":{"0.01":{"confidence":confidence}}})
                        .to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        assert_eq!(
            basal_threshold_from_service(
                &endpoint,
                Some("synthetic"),
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap(),
            0.9546
        );
        assert_eq!(
            basal_threshold_from_service(
                &endpoint,
                Some("synthetic"),
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap(),
            0.97
        );
        assert_eq!(
            basal_threshold_from_service(
                &endpoint,
                Some("other"),
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap(),
            0.93
        );
        server.join().unwrap();
    }
}

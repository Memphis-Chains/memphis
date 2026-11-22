//! The native arm of `memphis_brave_search`, checked against the cases
//! where it and the TypeScript arm must answer the same way.
//!
//! `tests/fixtures/brave-search-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/mcp-brave-search-contract.test.ts`.
//! A change in one arm that the other does not share fails a test in
//! BOTH languages — that is the whole point of the table.

use std::cell::RefCell;
use std::collections::BTreeMap;

use memphis_operator::brave_search::{search_with, BraveSearchInput};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/brave-search-contract.json");

/// Decode one `application/x-www-form-urlencoded` component.
fn decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The decoded query parameters of a request URL.
fn query_params(url: &str) -> BTreeMap<String, String> {
    let query = url.split_once('?').map(|(_, rest)| rest).unwrap_or("");
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_component(key), decode_component(value))
        })
        .collect()
}

#[test]
fn the_native_arm_agrees_with_the_typescript_arm() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the fixture must carry cases");
    assert!(!cases.is_empty(), "the contract table must not be empty");

    let mut failures: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().unwrap_or("unnamed case");
        let call = &case["call"];
        let input = BraveSearchInput {
            query: call["query"].as_str().unwrap_or_default().to_string(),
            limit: call["limit"].as_f64(),
            country: call["country"].as_str().map(str::to_string),
            search_lang: call["search_lang"].as_str().map(str::to_string),
        };
        let key = call["key"].as_str().unwrap_or_default();

        let response = case.get("response");
        let captured = RefCell::new(None::<String>);
        let fetcher = |url: &str, _key: &str| -> Result<(u16, String), String> {
            *captured.borrow_mut() = Some(url.to_string());
            let Some(response) = response else {
                return Err("the arm must not make a request in this case".to_string());
            };
            let status = response["status"].as_u64().unwrap_or(200) as u16;
            let body = match response.get("bodyText").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => response["body"].to_string(),
            };
            Ok((status, body))
        };

        let output = search_with(&input, key, &fetcher);
        let expect = &case["expect"];

        if expect["ok"].as_bool().unwrap_or(false) {
            if let Some(error) = &output.error {
                failures.push(format!("{name}: expected a search, got {error:?}"));
                continue;
            }
            if let Some(expected_count) = expect["count"].as_u64() {
                if output.count as u64 != expected_count {
                    failures.push(format!(
                        "{name}: count was {}, expected {expected_count}",
                        output.count
                    ));
                }
            }

            let url = captured.borrow().clone().unwrap_or_default();
            if let Some(expected_url) = expect["url"].as_str() {
                if url != expected_url {
                    failures.push(format!(
                        "{name}: url was {url:?}, expected {expected_url:?}"
                    ));
                }
            }
            if let Some(expected_params) = expect["params"].as_object() {
                let params = query_params(&url);
                for (param, expected) in expected_params {
                    let actual = params.get(param).cloned().unwrap_or_default();
                    let expected = expected.as_str().unwrap_or_default();
                    if actual != expected {
                        failures.push(format!(
                            "{name}: param {param} was {actual:?}, expected {expected:?}"
                        ));
                    }
                }
            }
            if let Some(expected_results) = expect["results"].as_array() {
                if output.results.len() != expected_results.len() {
                    failures.push(format!(
                        "{name}: {} results, expected {}",
                        output.results.len(),
                        expected_results.len()
                    ));
                } else {
                    for (index, (actual, expected)) in
                        output.results.iter().zip(expected_results).enumerate()
                    {
                        let pairs = [
                            ("title", actual.title.as_str()),
                            ("url", actual.url.as_str()),
                            ("description", actual.description.as_str()),
                            ("source", actual.source),
                        ];
                        for (field, got) in pairs {
                            let want = expected[field].as_str().unwrap_or_default();
                            if got != want {
                                failures.push(format!(
                                    "{name}: result {index} {field} was {got:?}, expected {want:?}"
                                ));
                            }
                        }
                    }
                }
            }
        } else {
            match &output.error {
                Some(error) => {
                    let expected = expect["error"].as_str().unwrap_or_default();
                    if error != expected {
                        failures.push(format!(
                            "{name}: error was {error:?}, expected {expected:?}"
                        ));
                    }
                }
                None => failures.push(format!("{name}: expected a refusal, got none")),
            }
            if expect["noRequest"].as_bool().unwrap_or(false) && captured.borrow().is_some() {
                failures.push(format!("{name}: the arm made a request it must not make"));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "the native arm and the TypeScript arm disagree:\n{}",
        failures.join("\n")
    );
}

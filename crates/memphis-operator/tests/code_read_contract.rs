//! The native arm of `memphis_code_read`, checked against the cases
//! where it and the TypeScript arm used to disagree.
//!
//! `tests/fixtures/code-read-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/mcp-code-read-contract.test.ts`.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use memphis_operator::code_read::{assert_contained, assert_not_blocked, resolve_path, split_lines};
use memphis_operator::resolve_code_read_range;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/code-read-contract.json");

fn render(template: &str, home: &Path) -> String {
    template
        .replace("{ROOT}", &home.join("memphis").to_string_lossy())
        .replace("{HOME}", &home.to_string_lossy())
}

fn temp_home(index: usize) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "memphis-code-read-contract-{}-{index}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).expect("create the temporary home");
    base
}

#[test]
fn the_native_arm_agrees_with_the_typescript_arm() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"].as_array().expect("the fixture must carry cases");
    assert!(!cases.is_empty(), "the contract table must not be empty");

    let mut failures: Vec<String> = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap_or("unnamed case");
        let home = temp_home(index);

        if let Some(files) = case["files"].as_array() {
            for file in files {
                let path = render(file["path"].as_str().unwrap_or_default(), &home);
                let target = Path::new(&path);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).expect("create the fixture directory");
                }
                fs::write(target, file["content"].as_str().unwrap_or_default())
                    .expect("write the fixture file");
            }
        }
        if let Some(links) = case["symlinks"].as_array() {
            for link in links {
                let path = render(link["path"].as_str().unwrap_or_default(), &home);
                let target = render(link["target"].as_str().unwrap_or_default(), &home);
                let link_path = Path::new(&path);
                if let Some(parent) = link_path.parent() {
                    fs::create_dir_all(parent).expect("create the fixture directory");
                }
                symlink(&target, link_path).expect("create the fixture symlink");
            }
        }

        let call = &case["call"];
        let path = render(call["path"].as_str().unwrap_or_default(), &home);
        let resolved = resolve_path(&path, &home);

        // The arm's own order: block, then contain, then the range.
        let mut refusal = assert_not_blocked(&resolved)
            .err()
            .or_else(|| assert_contained(&resolved, &home).err());

        let content = refusal.is_none().then(|| fs::read_to_string(&resolved).ok()).flatten();
        let lines = content.as_deref().map(split_lines).unwrap_or_default();
        let total_lines = lines.len();
        let range = if refusal.is_none() {
            match resolve_code_read_range(
                total_lines,
                call["startLine"].as_u64().map(|v| v as usize),
                call["endLine"].as_u64().map(|v| v as usize),
                call["limit"].as_u64().map(|v| v as usize),
            ) {
                Ok(range) => Some(range),
                Err(message) => {
                    refusal = Some(message);
                    None
                }
            }
        } else {
            None
        };

        let expect = &case["expect"];
        let ok = expect["ok"].as_bool().unwrap_or(false);

        match (ok, refusal) {
            (false, Some(message)) => {
                let expected = render(expect["error"].as_str().unwrap_or_default(), &home);
                if message != expected {
                    failures.push(format!(
                        "{name}: error was {message:?}, expected {expected:?}"
                    ));
                }
            }
            (false, None) => failures.push(format!("{name}: expected a refusal, got none")),
            (true, Some(message)) => {
                failures.push(format!("{name}: expected a read, got {message:?}"))
            }
            (true, None) => {
                let range = range.expect("a valid range");
                let slice = &lines[range.start..range.slice_end()];
                let mut text = slice.join("\n");
                if range.is_truncated() {
                    // The same marker the TypeScript arm appends.
                    text.push_str("\n... (truncated)");
                }

                if let Some(expected) = expect["content"].as_str() {
                    if text != expected {
                        failures.push(format!(
                            "{name}: content was {text:?}, expected {expected:?}"
                        ));
                    }
                }
                if let Some(expected) = expect["lineCount"].as_u64() {
                    if slice.len() as u64 != expected {
                        failures.push(format!(
                            "{name}: lineCount was {}, expected {expected}",
                            slice.len()
                        ));
                    }
                }
                if let Some(expected) = expect["totalLines"].as_u64() {
                    if total_lines as u64 != expected {
                        failures.push(format!(
                            "{name}: totalLines was {total_lines}, expected {expected}"
                        ));
                    }
                }
                if let Some(expected) = expect["truncated"].as_bool() {
                    if range.is_truncated() != expected {
                        failures.push(format!(
                            "{name}: truncated was {}, expected {expected}",
                            range.is_truncated()
                        ));
                    }
                }
            }
        }

        let _ = fs::remove_dir_all(&home);
    }

    assert!(
        failures.is_empty(),
        "the native arm disagrees with the contract:\n{}",
        failures.join("\n")
    );
}

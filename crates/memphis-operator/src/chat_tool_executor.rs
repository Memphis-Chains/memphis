//! Execution of native operator tools.
//!
//! Each arm returns a pair: a short human-readable display string for the
//! TUI transcript, and the full payload wrapped for the model. The
//! dispatcher is the only place that decides which tools exist, and
//! `scripts/sync-native-tiers.mts` cross-checks the advertised catalog
//! against the executable arms so a new tool cannot be added to one side
//! only.
//!
//! Tier gating happens before dispatch: a tool above the surface's
//! ceiling is refused with the remedy, never silently downgraded.

use std::fs;
use std::io::Read as _;

use chrono::Utc;
use serde_json::{json, Value};

use crate::chat_basal::{
    basal_threshold_from_service, classify_reply_to_json, BASAL_DEFAULT_URL, BASAL_TIMEOUT_SECS,
};
use crate::chat_guards::{
    assert_path_not_secret_material, build_wrapped_segment, emit_runtime_security_event,
    scan_code_change_content, sha256_hex,
};
use crate::chat_memory::{
    append_case_entry, append_generic_block, read_chain_blocks, run_native_journal, run_soul_read,
    run_soul_write, search_result_to_json, validate_chain_name, value_string_array, value_usize,
};
use crate::chat_tool_catalog::tool_tier;
use memphis_case_index::CaseIndex;
use memphis_core::case_entry::{CaseEntry, CaseQuery};

use crate::provider::ChatToolCall;
use crate::OperatorError;
use crate::OperatorRuntime;

pub(crate) fn execute_native_tool(
    runtime: &OperatorRuntime,
    call: &ChatToolCall,
    max_tier: u8,
) -> Result<(String, String), OperatorError> {
    let tier = tool_tier(call.name.as_str());
    if tier == u8::MAX {
        return Err(OperatorError::Message(format!(
            "unsupported native rust chat tool: {}",
            call.name
        )));
    }
    if tier > max_tier {
        return Err(OperatorError::Message(format!(
            "tool '{}' requires tier {} but current surface allows max tier {}. \
             Use an authorized surface whose policy permits this operation.",
            call.name, tier, max_tier
        )));
    }
    match call.name.as_str() {
        "memphis_journal" => {
            let content = call
                .arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_journal requires content".to_string())
                })?;
            let tags = value_string_array(call.arguments.get("tags"));
            let result = run_native_journal(runtime, content, tags)?;
            let json = serde_json::to_string(&result)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                format!(
                    "journal memoryId={} indexed={}",
                    result.memory_id, result.indexed
                ),
                build_wrapped_segment("tool_output", json.as_str(), None, Some("memphis_journal")),
            ))
        }
        "memphis_recall" => {
            let query = call
                .arguments
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_recall requires query".to_string())
                })?;
            let limit = value_usize(call.arguments.get("limit")).unwrap_or(5);
            let result = runtime.search_semantic(query, limit)?;
            let json = serde_json::to_string(&search_result_to_json(&result))
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                format!("semantic recall hits={}", result.count),
                build_wrapped_segment("tool_output", json.as_str(), None, Some("memphis_recall")),
            ))
        }
        "memphis_search" => {
            let query = call
                .arguments
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_search requires query".to_string())
                })?;
            let limit = value_usize(call.arguments.get("limit")).unwrap_or(5);
            let chain = call.arguments.get("chain").and_then(Value::as_str);
            let result = runtime.search_exact(query, limit, chain)?;
            let json = serde_json::to_string(&search_result_to_json(&result))
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                format!("exact search hits={}", result.count),
                build_wrapped_segment("tool_output", json.as_str(), None, Some("memphis_search")),
            ))
        }
        "memphis_health" => {
            let snapshot = runtime.snapshot();
            let json = serde_json::to_string(&json!({
                "overview": snapshot.overview,
                "memory": snapshot.memory,
                "sessions": snapshot.sessions,
                "vault": snapshot.vault,
                "cases": snapshot.cases,
                "system": snapshot.system,
                "errors": {
                    "overview": snapshot.overview_error,
                    "memory": snapshot.memory_error,
                    "sessions": snapshot.sessions_error,
                    "vault": snapshot.vault_error,
                    "cases": snapshot.cases_error,
                    "system": snapshot.system_error,
                }
            }))
            .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                "runtime health snapshot".to_string(),
                build_wrapped_segment("tool_output", json.as_str(), None, Some("memphis_health")),
            ))
        }
        "memphis_soul_read" => {
            let section = call.arguments.get("section").and_then(Value::as_str);
            let result = run_soul_read(runtime, section)?;
            let json = serde_json::to_string(&result)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                "soul memory snapshot".to_string(),
                build_wrapped_segment(
                    "tool_output",
                    json.as_str(),
                    None,
                    Some("memphis_soul_read"),
                ),
            ))
        }
        "memphis_soul_write" => {
            let updates = call.arguments.get("updates").cloned().ok_or_else(|| {
                OperatorError::Message("memphis_soul_write requires updates".to_string())
            })?;
            let result = run_soul_write(runtime, updates)?;
            let json = serde_json::to_string(&result)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                "soul memory updated".to_string(),
                build_wrapped_segment(
                    "tool_output",
                    json.as_str(),
                    None,
                    Some("memphis_soul_write"),
                ),
            ))
        }
        "memphis_case_query" => {
            let query_value = call.arguments.get("query").cloned().ok_or_else(|| {
                OperatorError::Message("memphis_case_query requires query".to_string())
            })?;
            let query = serde_json::from_value::<CaseQuery>(query_value)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            let index = CaseIndex::open(&runtime.config.case_index_path)
                .map_err(|error| OperatorError::Message(error.to_string()))?;
            let rows = index
                .query(&query)
                .map_err(|error| OperatorError::Message(error.to_string()))?;
            let json = serde_json::to_string(&json!({ "count": rows.len(), "entries": rows }))
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                format!("case query rows={}", rows.len()),
                build_wrapped_segment(
                    "tool_output",
                    json.as_str(),
                    None,
                    Some("memphis_case_query"),
                ),
            ))
        }
        "memphis_case_append" => {
            let entry_value = call.arguments.get("entry").cloned().ok_or_else(|| {
                OperatorError::Message("memphis_case_append requires entry".to_string())
            })?;
            let entry = serde_json::from_value::<CaseEntry>(entry_value)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            let result = append_case_entry(runtime, &entry)?;
            let json = serde_json::to_string(&json!({
                "success": true,
                "index": result.index,
                "hash": result.hash,
                "timestamp": result.timestamp,
            }))
            .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                format!("case appended index={}", result.index),
                build_wrapped_segment(
                    "tool_output",
                    json.as_str(),
                    None,
                    Some("memphis_case_append"),
                ),
            ))
        }
        "memphis_vault_list" => {
            let snapshot = runtime.snapshot();
            let json = serde_json::to_string(&snapshot.vault)
                .map_err(|error| OperatorError::Json(error.to_string()))?;
            Ok((
                "vault metadata listed".to_string(),
                build_wrapped_segment(
                    "tool_output",
                    json.as_str(),
                    None,
                    Some("memphis_vault_list"),
                ),
            ))
        }
        "memphis_code_read" => {
            use std::fs;
            use std::path::Path;

            let path_str = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_code_read requires path".to_string())
                })?;
            let start_line = call
                .arguments
                .get("startLine")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let end_line = call
                .arguments
                .get("endLine")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let limit = call
                .arguments
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| v as usize);

            // Security: restrict to ~/memphis/
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = Path::new(&home).join("memphis");
            let resolved_path = path_str.replace("~/", &home);
            let resolved = Path::new(&resolved_path);
            if !resolved.starts_with(&memphis_dir) {
                return Err(OperatorError::Message(format!(
                    "Path '{}' is outside the allowed ~/memphis/ directory",
                    path_str
                )));
            }

            // Being under ~/memphis/ is not the same as safe to read: the
            // operator's own .env and vault state live in that directory.
            // The TypeScript surface has refused these since code_read
            // landed (ALWAYS_BLOCKED_READ_PATTERNS); without this the native
            // tool was a way around the boundary it was supposed to enforce.
            if let Err(reason) = assert_path_not_secret_material(&resolved_path) {
                return Err(OperatorError::Message(reason));
            }

            let content = fs::read_to_string(resolved)
                .map_err(|e| OperatorError::Message(format!("Failed to read file: {}", e)))?;

            let lines: Vec<&str> = content.lines().collect();
            let total_lines = lines.len();

            let start = start_line.unwrap_or(1).saturating_sub(1);
            let end = end_line.unwrap_or(total_lines).min(total_lines);
            let limit = limit.unwrap_or(2000).min(2000);

            let slice: Vec<&str> = lines
                .get(start..end.min(start + limit))
                .unwrap_or(&[])
                .to_vec();
            let result_content = slice.join("\n");
            let truncated = end - start > limit || total_lines > limit;

            let json = serde_json::json!({
                "path": path_str,
                "content": result_content,
                "lineCount": slice.len(),
                "totalLines": total_lines,
                "truncated": truncated
            });

            Ok((
                format!("read {} lines (of {})", slice.len(), total_lines),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_code_read"),
                ),
            ))
        }
        "memphis_grep" => {
            let pattern = call
                .arguments
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_grep requires pattern".to_string())
                })?;
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = std::path::Path::new(&home).join("memphis");
            let base_path = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .map(|p| p.replace("~/", &format!("{}/", home)))
                .unwrap_or_else(|| memphis_dir.to_string_lossy().to_string());
            let base = std::path::Path::new(&base_path);
            if !base.starts_with(&memphis_dir) {
                return Err(OperatorError::Message(format!(
                    "Path '{}' is outside ~/memphis/",
                    base_path
                )));
            }
            let max_results = value_usize(call.arguments.get("maxResults")).unwrap_or(50);
            let glob_filter = call
                .arguments
                .get("glob")
                .and_then(Value::as_str)
                .unwrap_or("");

            let mut args = vec!["grep", "-rn", "--max-count=1"];
            if !glob_filter.is_empty() {
                args.push("--include");
                args.push(glob_filter);
            }
            args.push(pattern);
            args.push(&base_path);

            let output = std::process::Command::new(args[0])
                .args(&args[1..])
                .output()
                .map_err(|e| OperatorError::Message(format!("grep failed: {}", e)))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<&str> = stdout.lines().take(max_results).collect();
            let json = serde_json::json!({
                "pattern": pattern,
                "matches": lines,
                "count": lines.len(),
                "truncated": stdout.lines().count() > max_results
            });
            Ok((
                format!("grep hits={}", lines.len()),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_grep"),
                ),
            ))
        }
        "memphis_glob" => {
            let pattern = call
                .arguments
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_glob requires pattern".to_string())
                })?;
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = std::path::Path::new(&home).join("memphis");
            let base_path = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .map(|p| p.replace("~/", &format!("{}/", home)))
                .unwrap_or_else(|| memphis_dir.to_string_lossy().to_string());
            let base = std::path::Path::new(&base_path);
            if !base.starts_with(&memphis_dir) {
                return Err(OperatorError::Message(format!(
                    "Path '{}' is outside ~/memphis/",
                    base_path
                )));
            }

            let output = std::process::Command::new("find")
                .arg(&base_path)
                .arg("-name")
                .arg(pattern)
                .arg("-type")
                .arg("f")
                .output()
                .map_err(|e| OperatorError::Message(format!("glob/find failed: {}", e)))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let files: Vec<&str> = stdout.lines().take(200).collect();
            let json = serde_json::json!({
                "pattern": pattern,
                "files": files,
                "count": files.len()
            });
            Ok((
                format!("glob files={}", files.len()),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_glob"),
                ),
            ))
        }
        "memphis_git" => {
            let command = call
                .arguments
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_git requires command".to_string())
                })?;
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = std::path::Path::new(&home).join("memphis");

            // Only allow read-only git subcommands
            let read_only = [
                "log",
                "status",
                "diff",
                "show",
                "branch",
                "tag",
                "blame",
                "shortlog",
                "describe",
                "rev-parse",
                "ls-files",
                "remote",
            ];
            let subcmd = command.split_whitespace().next().unwrap_or("");
            if !read_only.contains(&subcmd) {
                return Err(OperatorError::Message(format!(
                    "memphis_git: '{}' is not a read-only git subcommand",
                    subcmd
                )));
            }

            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&memphis_dir)
                .args(command.split_whitespace())
                .output()
                .map_err(|e| OperatorError::Message(format!("git failed: {}", e)))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let truncated = stdout.len() > 32000;
            let json = serde_json::json!({
                "command": format!("git {}", command),
                "stdout": &stdout[..stdout.len().min(32000)],
                "stderr": &stderr[..stderr.len().min(8000)],
                "exitCode": output.status.code().unwrap_or(1),
                "truncated": truncated
            });
            Ok((
                format!("git {} exit={}", subcmd, output.status.code().unwrap_or(1)),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_git"),
                ),
            ))
        }
        "memphis_web_fetch" => {
            let url = call
                .arguments
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_web_fetch requires url".to_string())
                })?;
            let max_bytes = call
                .arguments
                .get("maxBytes")
                .and_then(Value::as_u64)
                .unwrap_or(32000) as usize;

            let response = ureq::get(url)
                .timeout(std::time::Duration::from_secs(10))
                .call()
                .map_err(|e| OperatorError::Message(format!("web_fetch failed: {}", e)))?;

            let mut body = String::new();
            response
                .into_reader()
                .take(max_bytes as u64)
                .read_to_string(&mut body)
                .map_err(|e| OperatorError::Message(format!("web_fetch read failed: {}", e)))?;

            let json = serde_json::json!({
                "url": url,
                "content": body,
                "bytes": body.len(),
                "truncated": body.len() >= max_bytes
            });
            Ok((
                format!("fetched {} bytes", body.len()),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_web_fetch"),
                ),
            ))
        }
        "memphis_exec" => {
            let command = call
                .arguments
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_exec requires command".to_string())
                })?;

            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .output()
                .map_err(|e| OperatorError::Message(format!("exec failed: {}", e)))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let truncated = stdout.len() > 32000 || stderr.len() > 32000;

            let json = serde_json::json!({
                "command": command,
                "exitCode": output.status.code().unwrap_or(1),
                "stdout": &stdout[..stdout.len().min(32000)],
                "stderr": &stderr[..stderr.len().min(32000)],
                "truncated": truncated
            });

            Ok((
                format!("exit={}", output.status.code().unwrap_or(1)),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_exec"),
                ),
            ))
        }
        "memphis_test" => {
            let suite = call
                .arguments
                .get("suite")
                .and_then(Value::as_str)
                .unwrap_or("all");
            let filter = call.arguments.get("filter").and_then(Value::as_str);
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = std::path::Path::new(&home).join("memphis");

            let mut results = Vec::new();

            if suite == "rust" || suite == "all" {
                let mut cmd = std::process::Command::new("cargo");
                cmd.arg("test").current_dir(&memphis_dir);
                if let Some(f) = filter {
                    cmd.arg(f);
                }
                let output = cmd
                    .output()
                    .map_err(|e| OperatorError::Message(format!("cargo test failed: {}", e)))?;
                results.push(serde_json::json!({
                    "suite": "rust",
                    "exitCode": output.status.code().unwrap_or(1),
                    "stdout": &String::from_utf8_lossy(&output.stdout)[..output.stdout.len().min(16000)],
                    "stderr": &String::from_utf8_lossy(&output.stderr)[..output.stderr.len().min(16000)],
                }));
            }
            if suite == "ts" || suite == "all" {
                let mut cmd = std::process::Command::new("npm");
                cmd.arg("test").current_dir(&memphis_dir);
                let output = cmd
                    .output()
                    .map_err(|e| OperatorError::Message(format!("npm test failed: {}", e)))?;
                results.push(serde_json::json!({
                    "suite": "ts",
                    "exitCode": output.status.code().unwrap_or(1),
                    "stdout": &String::from_utf8_lossy(&output.stdout)[..output.stdout.len().min(16000)],
                    "stderr": &String::from_utf8_lossy(&output.stderr)[..output.stderr.len().min(16000)],
                }));
            }

            let json = serde_json::to_string(&serde_json::json!({ "results": results }))
                .map_err(|e| OperatorError::Json(e.to_string()))?;
            Ok((
                format!("test suite={}", suite),
                build_wrapped_segment("tool_output", &json, None, Some("memphis_test")),
            ))
        }
        "memphis_self_modify" => {
            use std::fs;

            let path_str = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_self_modify requires path".to_string())
                })?;
            let content = call
                .arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_self_modify requires content".to_string())
                })?;
            let mode = call
                .arguments
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("write");
            let run_tests = call
                .arguments
                .get("test")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            // Refuse before touching the filesystem. The MCP surface has
            // run this scan since the code-change profile landed; the native
            // tool did not, so content that gets refused over MCP would have
            // been written verbatim here -- on the authoritative surface.
            if let Err((pattern_id, reason)) = scan_code_change_content(content) {
                emit_runtime_security_event(
                    runtime,
                    "content_scan.self_modify.blocked",
                    "blocked",
                    json!({
                        "patternId": pattern_id,
                        "reason": reason,
                        "profile": "code-change",
                        "path": path_str,
                        "contentHash": sha256_hex(content.as_bytes()),
                    }),
                )?;
                return Err(OperatorError::Message(format!(
                    "Blocked self-modify content for {path_str}: {reason}"
                )));
            }

            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let memphis_dir = std::path::Path::new(&home).join("memphis");
            let resolved_path = path_str.replace("~/", &format!("{}/", home));
            let resolved = std::path::Path::new(&resolved_path);
            if !resolved.starts_with(&memphis_dir) {
                return Err(OperatorError::Message(format!(
                    "Path '{}' is outside ~/memphis/",
                    path_str
                )));
            }

            // Snapshot: save original content for rollback
            let original = if resolved.exists() {
                Some(fs::read_to_string(resolved).map_err(|e| {
                    OperatorError::Message(format!("Failed to read original: {}", e))
                })?)
            } else {
                None
            };

            // Git snapshot: stage current state before modification
            let _ = std::process::Command::new("git")
                .args(["add", "-A"])
                .current_dir(&memphis_dir)
                .output();
            let snapshot_sha = std::process::Command::new("git")
                .args(["stash", "create", "self-modify-snapshot"])
                .current_dir(&memphis_dir)
                .output()
                .ok()
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                });

            if let Some(parent) = resolved.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| OperatorError::Message(format!("Failed to create dirs: {}", e)))?;
            }

            // Write the file
            match mode {
                "append" => {
                    use std::io::Write;
                    let mut file = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(resolved)
                        .map_err(|e| {
                            OperatorError::Message(format!("Failed to open file: {}", e))
                        })?;
                    file.write_all(content.as_bytes())
                        .map_err(|e| OperatorError::Message(format!("Failed to append: {}", e)))?;
                }
                _ => {
                    fs::write(resolved, content)
                        .map_err(|e| OperatorError::Message(format!("Failed to write: {}", e)))?;
                }
            }

            // Test gate: if requested, run build and rollback on failure
            let mut test_result = None;
            if run_tests {
                let build_output = std::process::Command::new("npm")
                    .args(["run", "build"])
                    .current_dir(&memphis_dir)
                    .output();

                match build_output {
                    Ok(output) if output.status.success() => {
                        test_result = Some(serde_json::json!({
                            "passed": true,
                            "command": "npm run build"
                        }));
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // Rollback: restore original file
                        if let Some(ref orig) = original {
                            let _ = fs::write(resolved, orig);
                        } else {
                            let _ = fs::remove_file(resolved);
                        }
                        return Err(OperatorError::Message(format!(
                            "self_modify: build failed — rolled back {}. Error: {}",
                            path_str,
                            &stderr[..stderr.len().min(500)]
                        )));
                    }
                    Err(e) => {
                        // Rollback on build command failure
                        if let Some(ref orig) = original {
                            let _ = fs::write(resolved, orig);
                        } else {
                            let _ = fs::remove_file(resolved);
                        }
                        return Err(OperatorError::Message(format!(
                            "self_modify: build command failed — rolled back {}. Error: {}",
                            path_str, e
                        )));
                    }
                }
            }

            let json = serde_json::json!({
                "path": path_str,
                "mode": mode,
                "bytes": content.len(),
                "success": true,
                "snapshot": snapshot_sha,
                "hadOriginal": original.is_some(),
                "testGate": test_result,
            });
            Ok((
                format!("wrote {} bytes to {}", content.len(), path_str),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_self_modify"),
                ),
            ))
        }
        "memphis_classify" => {
            let state = call
                .arguments
                .get("state")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    OperatorError::Message(
                        "memphis_classify requires a non-empty state".to_string(),
                    )
                })?
                .to_string();
            let question = call
                .arguments
                .get("question")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    OperatorError::Message(
                        "memphis_classify requires a non-empty question".to_string(),
                    )
                })?
                .to_string();

            let criteria = call
                .arguments
                .get("criteria")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    OperatorError::Message(
                        "memphis_classify requires criteria as a {key: description} object"
                            .to_string(),
                    )
                })?;
            let options: Vec<(String, String)> = criteria
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|description| (key.clone(), description.to_string()))
                })
                .collect();
            if options.len() < 2 {
                return Err(OperatorError::Message(
                    "memphis_classify requires at least two criteria options; one option carries no decision".to_string(),
                ));
            }
            if options.len() > 10 {
                return Err(OperatorError::Message(format!(
                    "memphis_classify supports at most 10 options, got {}",
                    options.len()
                )));
            }

            let question_type = call
                .arguments
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("choice")
                .to_string();
            if !matches!(question_type.as_str(), "choice" | "noul" | "score") {
                return Err(OperatorError::Message(format!(
                    "memphis_classify type must be choice, noul or score; got {question_type}"
                )));
            }
            let threshold = call
                .arguments
                .get("threshold")
                .and_then(Value::as_f64)
                .map(|value| value.clamp(0.0, 1.0));
            let orders = match value_usize(call.arguments.get("orders")) {
                Some(1) => 1u64,
                Some(other) if other >= 2 => 2u64,
                Some(other) => {
                    return Err(OperatorError::Message(format!(
                        "memphis_classify orders must be 1 or 2; got {other}"
                    )))
                }
                None => 2u64,
            };

            let url = std::env::var("MEMPHIS_BASAL_URL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| BASAL_DEFAULT_URL.to_string());

            let mut criteria_map = serde_json::Map::new();
            for (key, description) in &options {
                criteria_map.insert(key.clone(), Value::String(description.clone()));
            }
            let mut question_spec = json!({
                "type": question_type,
                "instructions": question,
                "criteria": Value::Object(criteria_map),
            });
            if let Some(value) = threshold {
                question_spec["threshold"] = json!(value);
            }
            let payload = json!({
                "state": state,
                "orders": orders,
                "questions": { "k": question_spec },
            });

            // The model needs minutes on this host; the ceiling is here so a
            // wedged service cannot hold a tool call open forever.
            let response = ureq::post(&url)
                .timeout(std::time::Duration::from_secs(BASAL_TIMEOUT_SECS))
                .send_json(&payload)
                .map_err(|error| {
                    OperatorError::Message(format!(
                        "memphis_classify: BASAL did not answer at {url}: {error}. \
                         Start it with: systemctl --user start memphis-basal-td"
                    ))
                })?;

            let body: Value = response.into_json().map_err(|error| {
                OperatorError::Message(format!(
                    "memphis_classify: BASAL reply is not JSON: {error}"
                ))
            })?;
            let json = classify_reply_to_json(
                &body,
                &question_type,
                &question,
                &state,
                threshold,
                orders,
            )?;
            let confidence = json
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let effective_threshold = threshold.unwrap_or_else(basal_threshold_from_service);
            let latency_ms = json.get("latencyMs").and_then(Value::as_i64).unwrap_or(-1);
            let choice = json
                .get("choice")
                .and_then(Value::as_str)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "-".to_string());
            Ok((
                format!(
                    "classify {choice} confidence={:.3} auto={} latencyMs={}",
                    confidence,
                    confidence >= effective_threshold,
                    latency_ms
                ),
                build_wrapped_segment(
                    "tool_output",
                    &json.to_string(),
                    None,
                    Some("memphis_classify"),
                ),
            ))
        }
        "memphis_cron" => {
            let action = call
                .arguments
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("list");
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
            let cron_dir = std::path::Path::new(&home).join("memphis").join("crons");

            match action {
                "list" => {
                    use std::os::unix::fs::PermissionsExt;
                    let mut entries = Vec::new();
                    if cron_dir.is_dir() {
                        if let Ok(dir) = std::fs::read_dir(&cron_dir) {
                            for entry in dir.flatten() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if name.ends_with(".sh")
                                    || name.ends_with(".ts")
                                    || name.ends_with(".js")
                                {
                                    let meta = entry.metadata().ok();
                                    let executable = meta
                                        .as_ref()
                                        .map(|m| m.permissions().mode() & 0o111 != 0)
                                        .unwrap_or(false);
                                    entries.push(serde_json::json!({
                                        "name": name,
                                        "path": entry.path().to_string_lossy(),
                                        "enabled": executable,
                                        "size": meta.map(|m| m.len()).unwrap_or(0),
                                    }));
                                }
                            }
                        }
                    }
                    let json = serde_json::json!({
                        "action": "list",
                        "cronDir": cron_dir.to_string_lossy(),
                        "entries": entries,
                        "count": entries.len()
                    });
                    Ok((
                        format!("cron entries={}", entries.len()),
                        build_wrapped_segment(
                            "tool_output",
                            &serde_json::to_string(&json).unwrap(),
                            None,
                            Some("memphis_cron"),
                        ),
                    ))
                }
                "add" => {
                    let name = call
                        .arguments
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            OperatorError::Message("cron add requires name".to_string())
                        })?;
                    let schedule = call
                        .arguments
                        .get("schedule")
                        .and_then(Value::as_str)
                        .unwrap_or("0 * * * *");
                    let script = call
                        .arguments
                        .get("script")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            OperatorError::Message("cron add requires script".to_string())
                        })?;

                    std::fs::create_dir_all(&cron_dir).map_err(|e| {
                        OperatorError::Message(format!("Failed to create crons dir: {}", e))
                    })?;

                    // Create the script file
                    let filename = if name.ends_with(".sh") {
                        name.to_string()
                    } else {
                        format!("{}.sh", name)
                    };
                    let file_path = cron_dir.join(&filename);
                    let full_script = format!(
                        "#!/usr/bin/env bash\n# schedule: {}\nset -euo pipefail\n\n{}\n",
                        schedule, script
                    );
                    std::fs::write(&file_path, &full_script).map_err(|e| {
                        OperatorError::Message(format!("Failed to write cron script: {}", e))
                    })?;

                    // Make executable
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o755))
                        .map_err(|e| {
                            OperatorError::Message(format!("Failed to set permissions: {}", e))
                        })?;

                    let json = serde_json::json!({
                        "action": "add",
                        "name": filename,
                        "schedule": schedule,
                        "path": file_path.to_string_lossy(),
                        "success": true
                    });
                    Ok((
                        format!("cron added: {}", filename),
                        build_wrapped_segment(
                            "tool_output",
                            &serde_json::to_string(&json).unwrap(),
                            None,
                            Some("memphis_cron"),
                        ),
                    ))
                }
                "remove" => {
                    let name = call
                        .arguments
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            OperatorError::Message("cron remove requires name".to_string())
                        })?;
                    let file_path = cron_dir.join(name);
                    if file_path.exists() {
                        std::fs::remove_file(&file_path).map_err(|e| {
                            OperatorError::Message(format!("Failed to remove: {}", e))
                        })?;
                    }
                    let json = serde_json::json!({
                        "action": "remove",
                        "name": name,
                        "success": true
                    });
                    Ok((
                        format!("cron removed: {}", name),
                        build_wrapped_segment(
                            "tool_output",
                            &serde_json::to_string(&json).unwrap(),
                            None,
                            Some("memphis_cron"),
                        ),
                    ))
                }
                "enable" => {
                    use std::os::unix::fs::PermissionsExt;
                    let name = call
                        .arguments
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            OperatorError::Message("cron enable requires name".to_string())
                        })?;
                    let file_path = cron_dir.join(name);
                    if !file_path.exists() {
                        return Err(OperatorError::Message(format!(
                            "Cron script not found: {}",
                            name
                        )));
                    }
                    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o755))
                        .map_err(|e| OperatorError::Message(format!("Failed to enable: {}", e)))?;
                    let json =
                        serde_json::json!({ "action": "enable", "name": name, "success": true });
                    Ok((
                        format!("cron enabled: {}", name),
                        build_wrapped_segment(
                            "tool_output",
                            &serde_json::to_string(&json).unwrap(),
                            None,
                            Some("memphis_cron"),
                        ),
                    ))
                }
                "disable" => {
                    use std::os::unix::fs::PermissionsExt;
                    let name = call
                        .arguments
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            OperatorError::Message("cron disable requires name".to_string())
                        })?;
                    let file_path = cron_dir.join(name);
                    if !file_path.exists() {
                        return Err(OperatorError::Message(format!(
                            "Cron script not found: {}",
                            name
                        )));
                    }
                    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o644))
                        .map_err(|e| OperatorError::Message(format!("Failed to disable: {}", e)))?;
                    let json =
                        serde_json::json!({ "action": "disable", "name": name, "success": true });
                    Ok((
                        format!("cron disabled: {}", name),
                        build_wrapped_segment(
                            "tool_output",
                            &serde_json::to_string(&json).unwrap(),
                            None,
                            Some("memphis_cron"),
                        ),
                    ))
                }
                other => Err(OperatorError::Message(format!(
                    "memphis_cron: unknown action '{}'. Use list, add, remove, enable, disable.",
                    other
                ))),
            }
        }
        "memphis_chain_query" => {
            let chain_name = call
                .arguments
                .get("chain")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_chain_query requires chain".to_string())
                })?;
            let contains = call.arguments.get("contains").and_then(Value::as_str);
            let tag_filter = call.arguments.get("tag").and_then(Value::as_str);
            let limit = call
                .arguments
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20) as usize;

            validate_chain_name(chain_name)?;
            let chain_dir = runtime.config.data_dir.join("chains").join(chain_name);

            if !chain_dir.exists() {
                let json = serde_json::json!({
                    "chain": chain_name,
                    "blocks": [],
                    "total": 0,
                    "message": format!("chain '{}' not found", chain_name)
                });
                return Ok((
                    format!("chain_query: {} not found", chain_name),
                    build_wrapped_segment(
                        "tool_output",
                        &serde_json::to_string(&json).unwrap(),
                        None,
                        Some("memphis_chain_query"),
                    ),
                ));
            }

            let mut blocks: Vec<serde_json::Value> = read_chain_blocks(&chain_dir)?
                .into_iter()
                .map(|block| {
                    json!({
                        "index": block.index,
                        "timestamp": block.timestamp,
                        "chain": block.chain,
                        "data": block.data,
                        "prev_hash": block.prev_hash,
                        "hash": block.hash,
                    })
                })
                .collect();

            // Filter by contains
            if let Some(substr) = contains {
                let lower = substr.to_ascii_lowercase();
                blocks.retain(|b| {
                    b.pointer("/data/content")
                        .and_then(Value::as_str)
                        .map(|c| c.to_ascii_lowercase().contains(&lower))
                        .unwrap_or(false)
                });
            }

            // Filter by tag
            if let Some(tag) = tag_filter {
                let lower = tag.to_ascii_lowercase();
                blocks.retain(|b| {
                    b.pointer("/data/tags")
                        .and_then(Value::as_array)
                        .map(|tags| {
                            tags.iter().any(|t| {
                                t.as_str()
                                    .map(|s| s.to_ascii_lowercase() == lower)
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                });
            }

            let total = blocks.len();
            // Return last N blocks (most recent)
            if blocks.len() > limit {
                blocks = blocks.split_off(blocks.len() - limit);
            }

            let json = serde_json::json!({
                "chain": chain_name,
                "blocks": blocks,
                "total": total,
                "returned": blocks.len()
            });
            Ok((
                format!("chain_query: {} ({} blocks)", chain_name, total),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_chain_query"),
                ),
            ))
        }
        "memphis_chain_verify" => {
            let selected_chain = call.arguments.get("chain").and_then(Value::as_str);
            let chains_root = runtime.config.data_dir.join("chains");
            let chain_names = if let Some(chain_name) = selected_chain {
                validate_chain_name(chain_name)?;
                vec![chain_name.to_string()]
            } else {
                let mut names = fs::read_dir(&chains_root)
                    .map_err(|error| OperatorError::Io(error.to_string()))?
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().is_dir())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect::<Vec<_>>();
                names.sort();
                names
            };

            let mut chains_checked = 0usize;
            let mut block_count = 0usize;
            for chain_name in &chain_names {
                validate_chain_name(chain_name)?;
                match read_chain_blocks(&chains_root.join(chain_name)) {
                    Ok(blocks) => {
                        chains_checked += 1;
                        block_count += blocks.len();
                    }
                    Err(error) => {
                        let result = json!({
                            "ok": false,
                            "chain": chain_name,
                            "chainsChecked": chains_checked,
                            "blockCount": block_count,
                            "error": error.to_string(),
                            "verifiedAt": Utc::now().to_rfc3339(),
                        });
                        return Ok((
                            format!("chain_verify: {} failed", chain_name),
                            build_wrapped_segment(
                                "tool_output",
                                &serde_json::to_string(&result).unwrap(),
                                None,
                                Some("memphis_chain_verify"),
                            ),
                        ));
                    }
                }
            }

            let result = json!({
                "ok": true,
                "chain": selected_chain,
                "chainsChecked": chains_checked,
                "blockCount": block_count,
                "verifiedAt": Utc::now().to_rfc3339(),
            });
            Ok((
                format!(
                    "chain_verify: ok ({} chains, {} blocks)",
                    chains_checked, block_count
                ),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&result).unwrap(),
                    None,
                    Some("memphis_chain_verify"),
                ),
            ))
        }
        "memphis_decide" => {
            let title = call
                .arguments
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_decide requires title".to_string())
                })?;
            let choice = call
                .arguments
                .get("choice")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    OperatorError::Message("memphis_decide requires choice".to_string())
                })?;
            let context = call
                .arguments
                .get("context")
                .and_then(Value::as_str)
                .unwrap_or("");

            let decision_id = format!("tui-{}", chrono::Utc::now().timestamp_millis());
            let timestamp = chrono::Utc::now().to_rfc3339();
            let content = format!(
                "Decision: {} | Choice: {} | Context: {}",
                title, choice, context
            );
            let append = append_generic_block(
                &runtime.config.data_dir,
                "decisions",
                json!({
                "type": "decision",
                "source": "operator-tui",
                "content": content,
                "tags": ["decision", "operator"],
                "timestamp": timestamp,
                "decisionId": decision_id,
                "title": title,
                "choice": choice,
                "context": context,
                }),
            )?;

            let json = serde_json::json!({
                "success": true,
                "decisionId": decision_id,
                "title": title,
                "choice": choice,
                "index": append.index,
                "hash": append.hash
            });
            Ok((
                format!("decided: {}", title),
                build_wrapped_segment(
                    "tool_output",
                    &serde_json::to_string(&json).unwrap(),
                    None,
                    Some("memphis_decide"),
                ),
            ))
        }
        other => Err(OperatorError::Message(format!(
            "unsupported native rust chat tool: {other}"
        ))),
    }
}

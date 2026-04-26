//! Renderers for TS extension-host RPC results, plus the dispatcher that
//! routes a finished `ExtensionHostResult` to the right per-command renderer.
//!
//! Extracted from `app/mod.rs` (S4 PR 2). Pure presentation: each method
//! takes a `serde_json::Value` payload from the host and pushes styled
//! lines into the chat output via `self.append_line(...)`. No host RPC
//! happens here — that lives in `client.rs`.
//!
//! Visibility: only the four entry points the parent module needs
//! (`append_extension_host_result`, `append_host_command_error`,
//! `append_telegram_send_failure`, `append_telegram_send_cancelled`)
//! are `pub(super)`. The per-command renderers stay private to this module.

use memphis_operator::{MemoryQueryResult, SearchMode};

use crate::client::{CliBridgeResult, ExtensionHostResult};

use super::{
    dim, error_line, info, json_string_list, json_value_as_string, plain, section, styled,
    success, summarize_host_command_error, warning, yes_no, AppState, LineTone,
    TelegramSendOutcome, TelegramSendRecord,
};

use serde_json::Value;

impl AppState {
    pub(super) fn append_host_command_error(&mut self, label: &str, error: &str) {
        let (status, detail, stderr_lines, reset_hint) = summarize_host_command_error(error);
        self.append_line(section(label.to_string()));
        self.append_line(error_line(status));
        if let Some(detail) = detail {
            self.append_line(dim(detail));
        }
        if reset_hint {
            self.append_line(dim("Host session reset; rerun the command if needed."));
        }
        for line in stderr_lines.into_iter().take(3) {
            self.append_line(dim(format!("stderr: {line}")));
        }
    }

    pub(super) fn append_legacy_cli_error(&mut self, label: &str, error: &str) {
        let command = label
            .strip_prefix("legacy CLI: ")
            .unwrap_or(label)
            .trim()
            .to_string();
        self.append_line(section("Legacy CLI compatibility"));
        self.append_line(error_line("Status: compatibility command failed"));
        self.append_line(dim(format!("Command: {command}")));
        for line in error
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(3)
        {
            self.append_line(dim(line.to_string()));
        }
    }

    pub(super) fn append_memory_result(&mut self, result: &MemoryQueryResult) {
        self.append_line(section(match result.mode {
            SearchMode::Semantic => "Semantic memory search",
            SearchMode::Exact => "Exact memory search",
        }));
        self.append_line(info(format!("Query: {}", result.query)));
        self.append_line(info(format!("Hits: {}", result.count)));
        match result.mode {
            SearchMode::Semantic => {
                for hit in &result.semantic_hits {
                    self.append_line(plain(format!(
                        "- {} score={:.3} tags={} preview={}",
                        hit.id,
                        hit.score,
                        if hit.tags.is_empty() {
                            "-".to_string()
                        } else {
                            hit.tags.join(",")
                        },
                        hit.preview
                    )));
                }
            }
            SearchMode::Exact => {
                for hit in &result.exact_hits {
                    self.append_line(plain(format!(
                        "- {}:{} type={} score={:.3} {}",
                        hit.chain, hit.block_index, hit.block_type, hit.score, hit.snippet
                    )));
                }
            }
        }
    }

    pub(super) fn append_cli_result(&mut self, result: CliBridgeResult) {
        if self.is_telegram_send_result(&result) {
            self.append_telegram_send_result(result);
            return;
        }

        self.append_line(section(format!(
            "Legacy CLI compatibility: {}",
            result.command_label
        )));
        if let Some(json) = result.json {
            if let Ok(pretty) = serde_json::to_string_pretty(&json) {
                for line in pretty.lines() {
                    self.append_line(plain(line.to_string()));
                }
            } else {
                self.append_line(error_line("failed to pretty-print CLI JSON output"));
            }
            return;
        }

        if result.stdout.trim().is_empty() {
            self.append_line(dim("command produced no output"));
            return;
        }

        for line in result.stdout.lines() {
            self.append_line(plain(line.to_string()));
        }
    }

    pub(super) fn append_extension_host_result(&mut self, result: ExtensionHostResult) {
        match result.command.as_str() {
            "telegram.send" => self.append_telegram_send_host_result(result.data),
            "init.status" => self.append_init_status_host_result(result.data),
            "health.status" => self.append_health_host_result(result.data),
            "doctor.run" => self.append_doctor_host_result(result.data),
            "agents.list" | "agents.discover" => self.append_agents_host_result(result.data),
            "agents.show" => self.append_agent_show_host_result(result.data),
            "sync.status" => self.append_sync_status_host_result(result.data),
            "apps.list" => self.append_apps_list_host_result(result.data),
            "apps.show" => self.append_apps_show_host_result(result.data),
            "apps.plan" => self.append_apps_plan_host_result(result.data),
            "reflect.run" => self.append_reflect_host_result(result.data),
            "insights.run" => self.append_insights_host_result(result.data),
            "knowledge.status" => self.append_knowledge_status_host_result(result.data),
            "knowledge.query" => self.append_knowledge_query_host_result(result.data),
            "config.tools.list" => self.append_config_tools_list_host_result(result.data),
            "config.tools.check" => self.append_config_tools_check_host_result(result.data),
            "config.tools.pending" => self.append_config_tools_pending_host_result(result.data),
            "config.surfaces.list" => self.append_config_surfaces_list_host_result(result.data),
            "config.surfaces.check" => self.append_config_surfaces_check_host_result(result.data),
            "config.surfaces.set" => self.append_config_surfaces_set_host_result(result.data),
            "config.surfaces.reset" => self.append_config_surfaces_reset_host_result(result.data),
            "guide.show" => self.append_guide_host_result(result.data),
            "pulse.status" => self.append_pulse_status_host_result(result.data),
            "cognitive.mode" => self.append_cognitive_mode_host_result(result.data),
            "presence.snapshot" => self.append_presence_host_result(result.data),
            _ => self.append_generic_extension_host_result(result),
        }
    }

    fn append_generic_extension_host_result(&mut self, result: ExtensionHostResult) {
        self.append_line(section(format!("TS host: {}", result.command)));
        if let Ok(pretty) = serde_json::to_string_pretty(&result.data) {
            for line in pretty.lines() {
                self.append_line(plain(line.to_string()));
            }
        } else {
            self.append_line(error_line("failed to pretty-print extension host result"));
        }
    }

    fn append_doctor_host_result(&mut self, data: Value) {
        self.append_line(section("Doctor"));

        let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let summary = data.get("summary").and_then(Value::as_object);
        let pass = summary
            .and_then(|summary| summary.get("pass"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let warn = summary
            .and_then(|summary| summary.get("warn"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let fail = summary
            .and_then(|summary| summary.get("fail"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let required_failures = summary
            .and_then(|summary| summary.get("requiredFailures"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let repair_status =
            json_value_as_string(data.get("repairStatus")).unwrap_or_else(|| "unknown".to_string());
        let repairable = data
            .get("repairable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let recommended_action = json_value_as_string(data.get("recommendedAction"))
            .unwrap_or_else(|| "none".to_string());

        self.append_line(if ok {
            success("Status: ok")
        } else if fail > 0 || required_failures > 0 {
            error_line("Status: required checks need attention")
        } else {
            warning("Status: warnings detected")
        });
        self.append_line(info(format!(
            "Summary: pass={pass} warn={warn} fail={fail} required_failures={required_failures}"
        )));
        self.append_line(info(format!(
            "Repair: status={} repairable={} action={}",
            repair_status,
            if repairable { "yes" } else { "no" },
            recommended_action
        )));

        let mut highlighted = 0usize;
        if let Some(checks) = data.get("checks").and_then(Value::as_array) {
            for check in checks
                .iter()
                .filter(|check| check.get("level").and_then(Value::as_str) != Some("pass"))
                .take(8)
            {
                let id =
                    json_value_as_string(check.get("id")).unwrap_or_else(|| "unknown".to_string());
                let level =
                    json_value_as_string(check.get("level")).unwrap_or_else(|| "info".to_string());
                let detail = json_value_as_string(check.get("detail"))
                    .unwrap_or_else(|| "no detail".to_string());
                let tone = match level.as_str() {
                    "fail" => LineTone::Error,
                    "warn" => LineTone::Warning,
                    _ => LineTone::Plain,
                };
                self.append_line(styled(format!("- {} :: {}", id, detail), tone));
                highlighted += 1;
            }
        }

        if highlighted == 0 {
            self.append_line(dim("No failing or warning checks were reported."));
        }
    }

    fn append_init_status_host_result(&mut self, data: Value) {
        self.append_line(section("First run"));

        let state = data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let initialized = data
            .get("initialized")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let recommended_action = json_value_as_string(data.get("recommendedAction"))
            .unwrap_or_else(|| "none".to_string());
        let record_origin = data
            .get("record")
            .and_then(Value::as_object)
            .and_then(|record| record.get("origin"))
            .and_then(Value::as_str)
            .unwrap_or("none");

        let tone = if initialized && state == "initialized-clean" {
            LineTone::Success
        } else if state == "legacy-manual" {
            LineTone::Error
        } else {
            LineTone::Warning
        };

        self.append_line(styled(
            format!("State: {} (origin: {})", state, record_origin),
            tone,
        ));
        self.append_line(info(format!("Recommended action: {}", recommended_action)));

        if let Some(reasons) = data.get("reasons").and_then(Value::as_array) {
            if !reasons.is_empty() {
                self.append_line(info("Reasons:".to_string()));
                for reason in reasons {
                    if let Some(text) = reason.as_str() {
                        self.append_line(dim(format!("- {}", text)));
                    }
                }
            }
        }
    }

    fn append_health_host_result(&mut self, data: Value) {
        self.append_line(section("Health"));

        let status =
            json_value_as_string(data.get("status")).unwrap_or_else(|| "unknown".to_string());
        let runtime_status =
            json_value_as_string(data.get("runtimeStatus")).unwrap_or_else(|| status.clone());
        let runtime = data.get("runtime").and_then(Value::as_object);
        let memory = runtime
            .and_then(|runtime| runtime.get("memory"))
            .and_then(Value::as_object);
        let embeddings = runtime
            .and_then(|runtime| runtime.get("embeddings"))
            .and_then(Value::as_object);
        let exact_search = runtime
            .and_then(|runtime| runtime.get("exactSearch"))
            .and_then(Value::as_object);
        let cognition = runtime
            .and_then(|runtime| runtime.get("cognition"))
            .and_then(Value::as_object);
        let repair = runtime
            .and_then(|runtime| runtime.get("repair"))
            .and_then(Value::as_object);

        let recall_mode = memory
            .and_then(|memory| memory.get("recallMode"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let degraded = memory
            .and_then(|memory| memory.get("degraded"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let embeddings_status = embeddings
            .and_then(|embeddings| embeddings.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let exact_status = exact_search
            .and_then(|exact_search| exact_search.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let cognitive_persistence = cognition
            .and_then(|cognition| cognition.get("persistenceStatus"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let repair_status = repair
            .and_then(|repair| repair.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let repair_action = json_value_as_string(data.get("recommendedAction"))
            .or_else(|| {
                json_value_as_string(repair.and_then(|repair| repair.get("recommendedAction")))
            })
            .unwrap_or_else(|| "none".to_string());

        let tone = if (status == "ok" && runtime_status == "healthy") || status == "healthy" {
            LineTone::Success
        } else if degraded || recall_mode != "semantic" {
            LineTone::Warning
        } else {
            LineTone::Error
        };

        self.append_line(styled(
            format!("Status: {} / runtime {}", status, runtime_status),
            tone,
        ));
        self.append_line(info(format!(
            "Memory recall: {}{}",
            recall_mode,
            if degraded { " (degraded)" } else { "" }
        )));
        self.append_line(info(format!("Embeddings: {}", embeddings_status)));
        self.append_line(info(format!("Exact search: {}", exact_status)));
        self.append_line(info(format!(
            "Cognitive persistence: {}",
            cognitive_persistence
        )));
        self.append_line(info(format!(
            "Repair: {} -> {}",
            repair_status, repair_action
        )));

        if let Some(lines) = data.get("surfaceStatus").and_then(Value::as_array) {
            for line in lines {
                if let Some(text) = line.as_str() {
                    self.append_line(dim(text.to_string()));
                }
            }
        }
    }

    fn append_presence_host_result(&mut self, data: Value) {
        self.append_line(section("Active surfaces"));
        let total = data.get("total").and_then(Value::as_u64).unwrap_or(0);
        let active = data.get("active").and_then(Value::as_u64).unwrap_or(0);
        self.append_line(info(format!("Surfaces: {active} active / {total} tracked")));

        let Some(snapshots) = data.get("snapshots").and_then(Value::as_array) else {
            self.append_line(dim("No presence snapshots."));
            return;
        };
        if snapshots.is_empty() {
            self.append_line(dim("No presence snapshots."));
            return;
        }
        for snap in snapshots.iter().take(6) {
            let surface = snap
                .get("surface")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let age_ms = snap.get("ageMs").and_then(Value::as_u64).unwrap_or(0);
            let stale = snap.get("stale").and_then(Value::as_bool).unwrap_or(false);
            let tier = snap.get("tier").and_then(Value::as_u64);
            let count = snap
                .get("activityCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let tone = if stale {
                LineTone::Dim
            } else {
                LineTone::Success
            };
            let state = if stale {
                "idle".to_string()
            } else {
                format!("last turn {}ms ago", age_ms)
            };
            let tier_text = tier
                .map(|t| format!(" tier {t}"))
                .unwrap_or_else(|| String::new());
            self.append_line(styled(
                format!("- {surface:<10} {state}{tier_text} ({count} events)"),
                tone,
            ));
        }
    }

    fn append_agents_host_result(&mut self, data: Value) {
        let heading = match data.get("mode").and_then(Value::as_str) {
            Some("agents-discover") => "Agents discover",
            _ => "Agents list",
        };
        self.append_line(section(heading));

        let agents = data
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = data
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or(agents.len() as u64);
        self.append_line(info(format!("Count: {count}")));

        if agents.is_empty() {
            self.append_line(dim("No agents reported."));
            return;
        }

        for agent in agents.iter().take(10) {
            let did =
                json_value_as_string(agent.get("did")).unwrap_or_else(|| "unknown".to_string());
            let name = json_value_as_string(agent.get("name")).unwrap_or_else(|| did.clone());
            let status =
                json_value_as_string(agent.get("status")).unwrap_or_else(|| "unknown".to_string());
            let endpoint = json_value_as_string(agent.get("endpoint"))
                .unwrap_or_else(|| "missing endpoint".to_string());
            let tone = match status.as_str() {
                "online" => LineTone::Success,
                "offline" => LineTone::Error,
                _ => LineTone::Warning,
            };
            self.append_line(styled(
                format!("- {name} ({did}) :: {status} :: {endpoint}"),
                tone,
            ));

            let capabilities = json_string_list(agent.get("capabilities"));
            if !capabilities.is_empty() {
                self.append_line(dim(format!("  caps: {}", capabilities.join(", "))));
            }
        }
    }

    fn append_agent_show_host_result(&mut self, data: Value) {
        self.append_line(section("Agent"));
        let Some(agent) = data.get("agent") else {
            self.append_line(error_line(
                "Agent payload was missing the expected agent object.",
            ));
            return;
        };

        let did = json_value_as_string(agent.get("did")).unwrap_or_else(|| "unknown".to_string());
        let name = json_value_as_string(agent.get("name")).unwrap_or_else(|| did.clone());
        let reputation = json_value_as_string(agent.get("reputation"));
        let last_seen = json_value_as_string(agent.get("lastSeen"));

        self.append_line(plain(format!("DID: {did}")));
        self.append_line(info(format!("Name: {name}")));
        if let Some(reputation) = reputation {
            self.append_line(info(format!("Reputation: {reputation}")));
        }
        if let Some(last_seen) = last_seen {
            self.append_line(dim(format!("Last seen: {last_seen}")));
        }
    }

    fn append_sync_status_host_result(&mut self, data: Value) {
        self.append_line(section("Sync status"));
        let chain =
            json_value_as_string(data.get("chain")).unwrap_or_else(|| "journal".to_string());
        let local_blocks = data.get("localBlocks").and_then(Value::as_u64).unwrap_or(0);
        let agents_known = data.get("agentsKnown").and_then(Value::as_u64).unwrap_or(0);
        let agents_online = data
            .get("agentsOnline")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        self.append_line(plain(format!("Chain: {chain}")));
        self.append_line(info(format!("Local blocks: {local_blocks}")));
        self.append_line(info(format!(
            "Agents: known={agents_known} online={agents_online}"
        )));
        if let Some(updated_at) = json_value_as_string(data.get("updatedAt")) {
            self.append_line(dim(format!("Updated: {updated_at}")));
        }
    }

    fn append_apps_list_host_result(&mut self, data: Value) {
        self.append_line(section("Managed apps"));
        let manifests = data
            .get("manifests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Manifests: {}", manifests.len())));

        if manifests.is_empty() {
            self.append_line(dim("No managed app manifests discovered."));
        } else {
            for manifest in manifests.iter().take(10) {
                let id = json_value_as_string(manifest.get("id"))
                    .unwrap_or_else(|| "unknown".to_string());
                let name = json_value_as_string(manifest.get("name")).unwrap_or_else(|| id.clone());
                let source_kind = manifest
                    .get("source")
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let actions = json_string_list(manifest.get("actions"));
                let capabilities = json_string_list(manifest.get("capabilities"));
                self.append_line(plain(format!(
                    "- {id} :: {name} [{source_kind}] actions={} caps={}",
                    if actions.is_empty() {
                        "-".to_string()
                    } else {
                        actions.join(", ")
                    },
                    if capabilities.is_empty() {
                        "-".to_string()
                    } else {
                        capabilities.join(", ")
                    }
                )));
            }
        }

        let manifest_errors = data
            .get("manifestErrors")
            .and_then(Value::as_array)
            .map(|errors| errors.len())
            .unwrap_or(0);
        if manifest_errors > 0 {
            self.append_line(warning(format!(
                "Manifest errors: {manifest_errors} (inspect CLI JSON for full details)"
            )));
        }
    }

    fn append_apps_show_host_result(&mut self, data: Value) {
        self.append_line(section("Managed app"));
        let Some(manifest) = data.get("manifest") else {
            self.append_line(error_line(
                "Managed app payload was missing the manifest object.",
            ));
            return;
        };

        let id = json_value_as_string(manifest.get("id")).unwrap_or_else(|| "unknown".to_string());
        let name = json_value_as_string(manifest.get("name")).unwrap_or_else(|| id.clone());
        let description = json_value_as_string(manifest.get("description"));
        let actions = json_string_list(manifest.get("actions"));
        let capabilities = json_string_list(manifest.get("capabilities"));

        self.append_line(plain(format!("{name} ({id})")));
        if let Some(description) = description {
            self.append_line(dim(description));
        }
        self.append_line(info(format!(
            "Actions: {}",
            if actions.is_empty() {
                "-".to_string()
            } else {
                actions.join(", ")
            }
        )));
        self.append_line(info(format!(
            "Capabilities: {}",
            if capabilities.is_empty() {
                "-".to_string()
            } else {
                capabilities.join(", ")
            }
        )));
    }

    fn append_apps_plan_host_result(&mut self, data: Value) {
        self.append_line(section("Managed app plan"));
        let manifest = data.get("manifest");
        let app_name = manifest
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let app_id = manifest
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let action =
            json_value_as_string(data.get("action")).unwrap_or_else(|| "install".to_string());
        self.append_line(plain(format!("{app_name} ({app_id}) :: {action}")));

        if let Some(summary) = json_value_as_string(data.get("summary")) {
            self.append_line(dim(summary));
        }
        self.append_line(info(format!(
            "applyRequested={} willExecute={}",
            data.get("applyRequested")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            data.get("willExecute")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        )));

        if let Some(requirements) = data.get("requirements").and_then(Value::as_array) {
            for requirement in requirements.iter().take(8) {
                let status = json_value_as_string(requirement.get("status"))
                    .unwrap_or_else(|| "unknown".to_string());
                let id = json_value_as_string(requirement.get("id"))
                    .unwrap_or_else(|| "requirement".to_string());
                let detail = json_value_as_string(requirement.get("detail"))
                    .unwrap_or_else(|| "no detail".to_string());
                let tone = match status.as_str() {
                    "pass" => LineTone::Success,
                    "warn" => LineTone::Warning,
                    _ => LineTone::Error,
                };
                self.append_line(styled(format!("- {id} :: {detail}"), tone));
            }
        }

        if let Some(steps) = data.get("steps").and_then(Value::as_array) {
            for (index, step) in steps.iter().take(8).enumerate() {
                if let Some(step) = step.as_str() {
                    self.append_line(plain(format!("Step {}: {step}", index + 1)));
                }
            }
        }
    }

    fn append_reflect_host_result(&mut self, data: Value) {
        self.append_line(section("Reflect"));
        let count = data.get("count").and_then(Value::as_u64).unwrap_or(0);
        self.append_line(info(format!("Count: {count}")));
        self.append_line(dim(format!(
            "Saved: {}",
            yes_no(data.get("saved").and_then(Value::as_bool).unwrap_or(false))
        )));

        let reflections = data
            .get("reflections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if reflections.is_empty() {
            self.append_line(dim("No reflections generated."));
            return;
        }

        for reflection in reflections.iter().take(5) {
            let reflection_type = json_value_as_string(reflection.get("type"))
                .unwrap_or_else(|| "reflection".to_string());
            let subject = json_value_as_string(reflection.get("subject"))
                .unwrap_or_else(|| "untitled".to_string());
            let insight = reflection
                .get("insights")
                .and_then(Value::as_array)
                .and_then(|insights| insights.first())
                .and_then(Value::as_str)
                .unwrap_or("no insight");
            self.append_line(plain(format!(
                "- {reflection_type} :: {subject} :: {insight}"
            )));
        }
    }

    fn append_insights_host_result(&mut self, data: Value) {
        self.append_line(section("Insights"));
        let window =
            json_value_as_string(data.get("window")).unwrap_or_else(|| "daily".to_string());
        let count = data.get("count").and_then(Value::as_u64).unwrap_or(0);
        self.append_line(info(format!("Window: {window}")));
        self.append_line(info(format!("Count: {count}")));
        self.append_line(dim(format!(
            "Saved: {}",
            yes_no(data.get("saved").and_then(Value::as_bool).unwrap_or(false))
        )));

        let insights = data
            .get("insights")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if insights.is_empty() {
            self.append_line(dim("No insights generated."));
            return;
        }

        for insight in insights.iter().take(5) {
            let insight_type =
                json_value_as_string(insight.get("type")).unwrap_or_else(|| "insight".to_string());
            let title = json_value_as_string(insight.get("title"))
                .unwrap_or_else(|| "untitled".to_string());
            let description = json_value_as_string(insight.get("description"))
                .unwrap_or_else(|| "no description".to_string());
            self.append_line(plain(format!(
                "- {insight_type} :: {title} :: {description}"
            )));
        }
    }

    fn append_knowledge_status_host_result(&mut self, data: Value) {
        self.append_line(section("Knowledge sources"));
        let summary = data.get("summary").and_then(Value::as_object);
        let loaded = summary
            .and_then(|summary| summary.get("loaded"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let missing_optional = summary
            .and_then(|summary| summary.get("missingOptional"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let missing_required = summary
            .and_then(|summary| summary.get("missingRequired"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.append_line(info(format!(
            "Loaded: {loaded} :: missing_optional={missing_optional} :: missing_required={missing_required}"
        )));

        let sources = data
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if sources.is_empty() {
            self.append_line(dim("No knowledge sources registered."));
            return;
        }

        for source in sources.iter().take(6) {
            let source_id =
                json_value_as_string(source.get("id")).unwrap_or_else(|| "unknown".to_string());
            let available = source
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let optional = source
                .get("optional")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let state = if available { "loaded" } else { "missing" };
            self.append_line(plain(format!(
                "- {source_id} :: {state} :: optional={}",
                yes_no(optional)
            )));
            if let Some(path) = json_value_as_string(source.get("path")) {
                self.append_line(dim(format!("  {path}")));
            }
            if available {
                let section_count = source
                    .get("sectionCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.append_line(dim(format!("  sections: {section_count}")));
            } else if let Some(warning) = json_value_as_string(source.get("warning")) {
                self.append_line(dim(format!("  warning: {warning}")));
            }
        }
    }

    fn append_knowledge_query_host_result(&mut self, data: Value) {
        self.append_line(section("Knowledge"));
        let topic =
            json_value_as_string(data.get("topic")).unwrap_or_else(|| "unknown".to_string());
        let hit_count = data
            .get("hits")
            .and_then(Value::as_array)
            .map(|hits| hits.len())
            .unwrap_or(0);
        self.append_line(info(format!("Topic: {topic}")));
        self.append_line(info(format!("Hits: {hit_count}")));
        if let Some(source) = json_value_as_string(data.get("source")) {
            self.append_line(dim(format!("Source filter: {source}")));
        }

        let hits = data
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if hits.is_empty() {
            self.append_line(dim("No knowledge hits."));
            return;
        }

        for hit in hits.iter().take(5) {
            let source_id =
                json_value_as_string(hit.get("sourceId")).unwrap_or_else(|| "unknown".to_string());
            let section =
                json_value_as_string(hit.get("section")).unwrap_or_else(|| "untitled".to_string());
            let snippet = json_value_as_string(hit.get("snippet"))
                .unwrap_or_else(|| "no snippet".to_string());
            self.append_line(plain(format!("- {source_id} :: {section}")));
            self.append_line(dim(format!("  {snippet}")));
        }
    }

    fn append_config_tools_list_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools list"));
        let tools = data
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Rules: {}", tools.len())));

        if tools.is_empty() {
            self.append_line(dim(
                "No explicit tool permission rules. Default allow applies.",
            ));
            return;
        }

        for tool in tools.iter().take(10) {
            let name = json_value_as_string(tool.get("tool_name"))
                .unwrap_or_else(|| "unknown".to_string());
            let policy =
                json_value_as_string(tool.get("policy")).unwrap_or_else(|| "unknown".to_string());
            let updated_at = json_value_as_string(tool.get("updated_at"));
            self.append_line(plain(format!("- {name} :: {policy}")));
            if let Some(updated_at) = updated_at {
                self.append_line(dim(format!("  updated: {updated_at}")));
            }
        }
    }

    fn append_config_tools_check_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools check"));
        let tool = json_value_as_string(data.get("tool")).unwrap_or_else(|| "unknown".to_string());
        let policy =
            json_value_as_string(data.get("policy")).unwrap_or_else(|| "allow".to_string());
        let allowed = data
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.append_line(if allowed {
            success(format!("{tool} :: allowed ({policy})"))
        } else {
            warning(format!("{tool} :: blocked ({policy})"))
        });
        if let Some(reason) = json_value_as_string(data.get("reason")) {
            self.append_line(dim(format!("Reason: {reason}")));
        }
    }

    fn append_config_tools_pending_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools pending"));
        let pending = data
            .get("pending")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Pending approvals: {}", pending.len())));

        if pending.is_empty() {
            self.append_line(dim("No pending tool approvals."));
            return;
        }

        for item in pending.iter().take(10) {
            let request_id = json_value_as_string(item.get("requestId"))
                .unwrap_or_else(|| "unknown-request".to_string());
            let tool_name = json_value_as_string(item.get("toolName"))
                .unwrap_or_else(|| "unknown-tool".to_string());
            let state =
                json_value_as_string(item.get("state")).unwrap_or_else(|| "pending".to_string());
            self.append_line(plain(format!("- {tool_name} :: {state} :: {request_id}")));
        }
    }

    fn append_surface_policy_summary_line(&mut self, policy: &Value) {
        let surface =
            json_value_as_string(policy.get("surface")).unwrap_or_else(|| "unknown".to_string());
        let surface_class = json_value_as_string(policy.get("surfaceClass"))
            .unwrap_or_else(|| "unknown".to_string());
        let tier =
            json_value_as_string(policy.get("maxToolTier")).unwrap_or_else(|| "0".to_string());
        let allow_url_fetch = policy
            .get("allowUrlFetch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_unknown_tools = policy
            .get("allowUnknownTools")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_memory_recall = policy
            .get("allowMemoryRecall")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_memory_write = policy
            .get("allowMemoryWrite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_operator_override = policy
            .get("allowOperatorOverride")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let tone = if surface_class == "chat"
            && (tier != "0" || allow_url_fetch || allow_unknown_tools || allow_operator_override)
        {
            LineTone::Warning
        } else if surface_class == "operator" {
            LineTone::Success
        } else {
            LineTone::Plain
        };

        self.append_line(styled(
            format!(
                "- {surface} :: class={surface_class} tier={tier} fetch={} recall={} write={} unknown={} override={}",
                yes_no(allow_url_fetch),
                yes_no(allow_memory_recall),
                yes_no(allow_memory_write),
                yes_no(allow_unknown_tools),
                yes_no(allow_operator_override)
            ),
            tone,
        ));
    }

    fn append_surface_policy_overrides(&mut self, data: &Value) {
        let overrides = data
            .get("overrides")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if overrides.is_empty() {
            self.append_line(dim("Overrides: none"));
            return;
        }

        self.append_line(info(format!("Overrides: {}", overrides.len())));
        for override_item in overrides.iter().take(8) {
            let setting = json_value_as_string(override_item.get("setting"))
                .unwrap_or_else(|| "unknown".to_string());
            let raw_value = json_value_as_string(override_item.get("rawValue"))
                .unwrap_or_else(|| "unknown".to_string());
            self.append_line(dim(format!("- {setting}={raw_value}")));
        }
    }

    fn append_config_surfaces_list_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces list"));
        let surfaces = data
            .get("surfaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Surface policies: {}", surfaces.len())));

        if surfaces.is_empty() {
            self.append_line(dim("No surface policies were returned."));
            return;
        }

        for surface in surfaces.iter().take(10) {
            self.append_surface_policy_summary_line(surface);
            let override_count = surface
                .get("overrides")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            if override_count > 0 {
                self.append_line(dim(format!("  overrides: {override_count}")));
            }
        }
    }

    fn append_config_surfaces_check_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces check"));
        if let Some(policy) = data.get("policy") {
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        self.append_surface_policy_overrides(&data);
    }

    fn append_config_surfaces_set_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces set"));
        if let Some(policy) = data.get("policy") {
            self.append_line(success("Surface override applied"));
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        if let Some(env_path) = json_value_as_string(data.get("envPath")) {
            self.append_line(dim(format!("Env path: {env_path}")));
        }
        if let Some(updated_keys) = data.get("updatedKeys").and_then(Value::as_array) {
            if !updated_keys.is_empty() {
                let joined = updated_keys
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                self.append_line(info(format!("Updated keys: {joined}")));
            }
        }
    }

    fn append_config_surfaces_reset_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces reset"));
        if let Some(policy) = data.get("policy") {
            self.append_line(success("Surface override reset"));
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        if let Some(env_path) = json_value_as_string(data.get("envPath")) {
            self.append_line(dim(format!("Env path: {env_path}")));
        }
        let removed_keys = data
            .get("removedKeys")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if removed_keys.is_empty() {
            self.append_line(dim("Removed keys: none"));
        } else {
            let joined = removed_keys
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            self.append_line(info(format!("Removed keys: {joined}")));
        }
    }

    fn append_guide_host_result(&mut self, data: Value) {
        self.append_line(section("Operator guide"));

        let agent_name =
            json_value_as_string(data.get("agentName")).unwrap_or_else(|| "Memphis Agent".into());
        let owner_name =
            json_value_as_string(data.get("ownerName")).unwrap_or_else(|| "local operator".into());
        let profile_source =
            json_value_as_string(data.get("profileSource")).unwrap_or_else(|| "unknown".into());

        self.append_line(info(format!(
            "Identity: {} owned by {} (source={})",
            agent_name, owner_name, profile_source
        )));

        if let Some(sections) = data.get("sections").and_then(Value::as_array) {
            for section_value in sections {
                let heading = json_value_as_string(section_value.get("title"))
                    .unwrap_or_else(|| "Section".to_string());
                self.append_blank();
                self.append_line(info(heading));
                if let Some(lines) = section_value.get("lines").and_then(Value::as_array) {
                    for line in lines.iter().filter_map(Value::as_str) {
                        self.append_line(plain(format!("- {}", line)));
                    }
                } else {
                    self.append_line(dim("No guide lines returned for this section."));
                }
            }
        } else {
            self.append_line(error_line("Guide payload missing sections."));
        }
    }

    fn append_pulse_status_host_result(&mut self, data: Value) {
        self.append_line(section("PULSE"));

        let summary = data.get("summary").and_then(Value::as_object);
        let total_entries = summary
            .and_then(|summary| summary.get("totalEntries"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let last_event = json_value_as_string(summary.and_then(|summary| summary.get("lastEvent")))
            .unwrap_or_else(|| "none".to_string());
        let last_health =
            json_value_as_string(summary.and_then(|summary| summary.get("lastHealth")))
                .unwrap_or_else(|| "unknown".to_string());
        let uptime_seconds = summary
            .and_then(|summary| summary.get("uptimeSeconds"))
            .and_then(Value::as_u64);

        let tone = match last_health.as_str() {
            "healthy" => LineTone::Success,
            "degraded" => LineTone::Warning,
            "unhealthy" => LineTone::Error,
            _ if total_entries == 0 => LineTone::Warning,
            _ => LineTone::Plain,
        };
        self.append_line(styled(
            format!("Entries: {total_entries} :: last event={last_event} :: health={last_health}"),
            tone,
        ));
        if let Some(uptime_seconds) = uptime_seconds {
            self.append_line(info(format!("Uptime seconds: {uptime_seconds}")));
        }
        if let Some(last_timestamp) =
            json_value_as_string(summary.and_then(|summary| summary.get("lastTimestamp")))
        {
            self.append_line(dim(format!("Last timestamp: {last_timestamp}")));
        }

        let entries = data
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if entries.is_empty() {
            self.append_line(dim("No PULSE heartbeat entries recorded yet."));
            return;
        }

        for entry in entries.iter().rev().take(3) {
            let timestamp = json_value_as_string(entry.get("timestamp"))
                .unwrap_or_else(|| "unknown".to_string());
            let event =
                json_value_as_string(entry.get("event")).unwrap_or_else(|| "unknown".to_string());
            let health =
                json_value_as_string(entry.get("health")).unwrap_or_else(|| "unknown".to_string());
            self.append_line(plain(format!("- {timestamp} :: {event} :: {health}")));
            if let Some(detail) = json_value_as_string(entry.get("detail")) {
                self.append_line(dim(format!("  {detail}")));
            }
        }
    }

    fn append_cognitive_mode_host_result(&mut self, data: Value) {
        self.append_line(section("Cognitive mode"));

        let mode = json_value_as_string(data.get("mode")).unwrap_or_else(|| "unknown".to_string());
        let previous_mode = json_value_as_string(data.get("previousMode"));
        let config = data.get("config").and_then(Value::as_object);
        let mode_name = json_value_as_string(config.and_then(|config| config.get("name")))
            .unwrap_or_else(|| "unknown".to_string());
        let temperature = config
            .and_then(|config| config.get("temperature"))
            .and_then(Value::as_f64);
        let style = json_value_as_string(config.and_then(|config| config.get("style")));
        let pattern = json_value_as_string(config.and_then(|config| config.get("pattern")));
        let description = json_value_as_string(config.and_then(|config| config.get("description")));

        match previous_mode {
            Some(previous_mode) if previous_mode != mode => {
                self.append_line(success(format!(
                    "Mode: {previous_mode} -> {mode} ({mode_name})"
                )));
            }
            _ => {
                self.append_line(info(format!("Mode: {mode} ({mode_name})")));
            }
        }

        if let Some(temperature) = temperature {
            self.append_line(info(format!("Temperature: {:.1}", temperature)));
        }
        if let Some(style) = style.as_ref() {
            self.append_line(dim(format!("Style: {style}")));
        }
        if let Some(pattern) = pattern.as_ref() {
            self.append_line(dim(format!("Pattern: {pattern}")));
        }
        if let Some(description) = description {
            self.append_line(dim(description));
        }

        // S2.5 fix Bug 4: refresh cached overview so the status bar reflects
        // the new mode immediately. Pre-fix the status bar pulled cognitive_mode
        // from `self.snapshot.overview.cognitive_mode` which was populated at
        // session start and never refreshed — operator switched C → A and the
        // bar still showed [Mode:B] until the next full snapshot poll.
        if let Some(overview) = self.snapshot.overview.as_mut() {
            overview.cognitive_mode = mode.clone();
            overview.cognitive_mode_name = Some(mode_name.clone());
            overview.cognitive_mode_temperature = temperature;
            overview.cognitive_mode_style = style;
            overview.cognitive_mode_pattern = pattern;
            overview.cognitive_mode_last_modified = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    fn append_telegram_send_result(&mut self, result: CliBridgeResult) {
        self.append_line(section("Telegram send"));

        let Some(json) = result.json.as_ref() else {
            self.append_line(warning(
                "Telegram send returned no structured JSON payload.",
            ));
            if result.stdout.trim().is_empty() {
                self.append_line(dim("command produced no output"));
            } else {
                for line in result.stdout.lines() {
                    self.append_line(plain(line.to_string()));
                }
            }
            return;
        };

        let ok = json.get("ok").and_then(Value::as_bool);
        let message_id = json_value_as_string(json.get("messageId"));
        let target_chat = json_value_as_string(json.get("chatId"))
            .or_else(|| self.active_telegram_target().flatten());
        let error = json_value_as_string(json.get("error"));

        match ok {
            Some(true) => {
                let record = TelegramSendRecord {
                    outcome: TelegramSendOutcome::Delivered,
                    target_chat,
                    message_id,
                    error: None,
                };
                self.last_telegram_send = Some(record.clone());
                self.append_rendered_telegram_send(&record);
            }
            Some(false) => {
                let record = TelegramSendRecord {
                    outcome: TelegramSendOutcome::Failed,
                    target_chat,
                    message_id,
                    error: Some(
                        error.unwrap_or_else(|| "telegram send returned ok=false".to_string()),
                    ),
                };
                self.last_telegram_send = Some(record.clone());
                self.append_rendered_telegram_send(&record);
            }
            None => {
                self.append_line(warning(
                    "Telegram send JSON payload was missing the expected ok field.",
                ));
                if let Ok(pretty) = serde_json::to_string_pretty(json) {
                    for line in pretty.lines() {
                        self.append_line(plain(line.to_string()));
                    }
                }
            }
        }
    }

    fn append_telegram_send_host_result(&mut self, data: Value) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Delivered,
            target_chat: json_value_as_string(data.get("chatId")),
            message_id: json_value_as_string(data.get("messageId")),
            error: None,
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }

    fn append_rendered_telegram_send(&mut self, record: &TelegramSendRecord) {
        match record.outcome {
            TelegramSendOutcome::Delivered => {
                self.append_line(success("Status: delivered"));
                self.append_line(dim(
                    "Route: TypeScript host transport (Rust TUI does not call Telegram directly).",
                ));
            }
            TelegramSendOutcome::Failed => {
                self.append_line(error_line("Status: failed"));
            }
            TelegramSendOutcome::Cancelled => {
                self.append_line(warning("Status: cancelled"));
            }
        }

        if let Some(chat_id) = &record.target_chat {
            self.append_line(plain(format!("Target chat: {chat_id}")));
        }

        if let Some(message_id) = &record.message_id {
            self.append_line(info(format!("Message ID: {message_id}")));
        }

        if let Some(error) = &record.error {
            self.append_line(error_line(format!("Error: {error}")));
        }
    }

    pub(super) fn append_telegram_send_failure(&mut self, target_chat: Option<String>, error: String) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Failed,
            target_chat,
            message_id: None,
            error: Some(error),
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }

    pub(super) fn append_telegram_send_cancelled(&mut self, target_chat: Option<String>) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Cancelled,
            target_chat,
            message_id: None,
            error: None,
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }
}

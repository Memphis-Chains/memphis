//! Streaming output guards for the native operator runtime.
//!
//! The guard holds back a short tail of every chunk so a secret marker
//! that straddles a chunk boundary (`<memphis_` + `system>`) is still
//! detected before it reaches the operator's screen. It also strips
//! `<think>` blocks from reasoning models before the guard sees them.
//!
//! Split out of `chat.rs` unchanged: streaming safety rules must be
//! reviewable without reading session storage or tool execution.

use std::sync::atomic::AtomicBool;

use crate::chat_guards::guard_model_output;
use crate::OperatorError;
use crate::OperatorRuntime;

pub(crate) fn ensure_chat_not_cancelled(
    cancel_flag: Option<&AtomicBool>,
) -> Result<(), OperatorError> {
    if cancel_flag
        .map(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
    {
        Err(OperatorError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) struct StreamingOutputGuard {
    raw: String,
    pending: String,
    emitted: String,
    blocked: bool,
}

impl StreamingOutputGuard {
    pub(crate) fn new() -> Self {
        Self {
            raw: String::new(),
            pending: String::new(),
            emitted: String::new(),
            blocked: false,
        }
    }

    pub(crate) fn push<F>(&mut self, chunk: &str, emit: &mut F)
    where
        F: FnMut(&str),
    {
        if chunk.is_empty() {
            return;
        }

        self.raw.push_str(chunk);
        self.pending.push_str(chunk);
        if self.blocked {
            return;
        }

        if contains_sensitive_stream_marker(self.pending.as_str()) {
            self.blocked = true;
            return;
        }

        const STREAM_GUARD_TAIL: usize = 24;
        let pending_chars = self.pending.chars().count();
        if pending_chars <= STREAM_GUARD_TAIL {
            return;
        }

        let safe_len = pending_chars - STREAM_GUARD_TAIL;
        let emitted = self.pending.chars().take(safe_len).collect::<String>();
        if !emitted.is_empty() {
            emit(emitted.as_str());
            self.emitted.push_str(emitted.as_str());
            self.pending = self.pending.chars().skip(safe_len).collect();
        }
    }

    pub(crate) fn finish<F>(
        mut self,
        runtime: &OperatorRuntime,
        surface: &str,
        emit: &mut F,
    ) -> Result<String, OperatorError>
    where
        F: FnMut(&str),
    {
        let guarded = guard_model_output(runtime, self.raw.as_str(), surface)?;

        if !self.blocked && !self.pending.is_empty() {
            emit(self.pending.as_str());
            self.emitted.push_str(self.pending.as_str());
            self.pending.clear();
        }

        if let Some(suffix) = guarded.strip_prefix(self.emitted.as_str()) {
            if !suffix.is_empty() {
                emit(suffix);
            }
        } else if self.blocked && guarded != self.emitted {
            emit("\n");
            emit(guarded.as_str());
        }

        Ok(guarded)
    }
}

pub(crate) fn contains_sensitive_stream_marker(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    [
        "<memphis_system",
        "memphis_api_token",
        "memphis_vault_pepper",
        "\"plaintext\"",
        "plaintext:",
        "plaintext=",
        "developer message",
        "hidden instructions",
    ]
    .into_iter()
    .any(|marker| lowered.contains(marker))
}

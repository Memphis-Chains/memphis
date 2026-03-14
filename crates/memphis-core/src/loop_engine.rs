use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum LoopAction {
    ToolCall { tool: String },
    Wait { duration_ms: u64 },
    Complete { summary: String },
    Error { recoverable: bool, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoopLimits {
    pub max_steps: u32,
    pub max_tool_calls: u32,
    pub max_wait_ms: u64,
    pub max_errors: u32,
}

impl Default for LoopLimits {
    fn default() -> Self {
        Self {
            max_steps: 32,
            max_tool_calls: 16,
            max_wait_ms: 120_000,
            max_errors: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoopState {
    pub steps: u32,
    pub tool_calls: u32,
    pub wait_ms: u64,
    pub errors: u32,
    pub completed: bool,
    pub halt_reason: Option<String>,
}

impl Default for LoopState {
    fn default() -> Self {
        Self::new()
    }
}

impl LoopState {
    pub fn new() -> Self {
        Self {
            steps: 0,
            tool_calls: 0,
            wait_ms: 0,
            errors: 0,
            completed: false,
            halt_reason: None,
        }
    }

    pub fn should_halt(&self) -> bool {
        self.completed || self.halt_reason.is_some()
    }

    pub fn apply(&mut self, action: &LoopAction, limits: &LoopLimits) -> Result<(), String> {
        if self.should_halt() {
            return Err("loop_already_halted".to_string());
        }

        self.steps = self.steps.saturating_add(1);
        if self.steps > limits.max_steps {
            self.halt_reason = Some("max_steps_exceeded".to_string());
            return Err("max_steps_exceeded".to_string());
        }

        match action {
            LoopAction::ToolCall { .. } => {
                self.tool_calls = self.tool_calls.saturating_add(1);
                if self.tool_calls > limits.max_tool_calls {
                    self.halt_reason = Some("max_tool_calls_exceeded".to_string());
                    return Err("max_tool_calls_exceeded".to_string());
                }
            }
            LoopAction::Wait { duration_ms } => {
                self.wait_ms = self.wait_ms.saturating_add(*duration_ms);
                if self.wait_ms > limits.max_wait_ms {
                    self.halt_reason = Some("max_wait_exceeded".to_string());
                    return Err("max_wait_exceeded".to_string());
                }
            }
            LoopAction::Error { recoverable, .. } => {
                self.errors = self.errors.saturating_add(1);
                if self.errors > limits.max_errors {
                    self.halt_reason = Some("max_errors_exceeded".to_string());
                    return Err("max_errors_exceeded".to_string());
                }
                if !recoverable {
                    self.completed = true;
                    self.halt_reason = Some("non_recoverable_error".to_string());
                }
            }
            LoopAction::Complete { .. } => {
                self.completed = true;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{LoopAction, LoopLimits, LoopState};

    #[test]
    fn halts_when_max_tool_calls_exceeded() {
        let mut state = LoopState::new();
        let limits = LoopLimits {
            max_steps: 10,
            max_tool_calls: 1,
            max_wait_ms: 1000,
            max_errors: 1,
        };

        assert!(state
            .apply(
                &LoopAction::ToolCall {
                    tool: "web_search".to_string()
                },
                &limits
            )
            .is_ok());
        let err = state
            .apply(
                &LoopAction::ToolCall {
                    tool: "bash".to_string()
                },
                &limits,
            )
            .expect_err("second tool call should fail");
        assert_eq!(err, "max_tool_calls_exceeded");
        assert_eq!(state.halt_reason.as_deref(), Some("max_tool_calls_exceeded"));
    }

    #[test]
    fn marks_non_recoverable_error_as_halted() {
        let mut state = LoopState::new();
        let limits = LoopLimits::default();
        state
            .apply(
                &LoopAction::Error {
                    recoverable: false,
                    message: "critical".to_string(),
                },
                &limits,
            )
            .expect("non recoverable action can be applied");
        assert!(state.should_halt());
        assert_eq!(state.halt_reason.as_deref(), Some("non_recoverable_error"));
    }
}

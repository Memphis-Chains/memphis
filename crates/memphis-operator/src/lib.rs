mod chat;
mod chat_basal;
mod chain_write_lock;
mod chat_context_guard;
mod chat_guards;
mod chat_memory;
mod chat_operations;
mod chat_prompt;
mod chat_session;
mod chat_streaming;
mod chat_tool_catalog;
mod chat_tool_executor;
mod code_read_range;
mod config;
mod context;
mod openai_codex;
mod provider;
mod runtime;
mod text_truncation;
mod think_stripper;

pub use chat::{ChatExchange, ChatSessionView, ChatTranscriptEntry, JournalWriteResult};
pub use config::OperatorConfig;
pub use provider::{
    ChatMessage, ChatRequestOptions, ChatStreamEvent, ChatToolCall, ChatToolDefinition,
    ModelCapabilitySummary, ProviderStatus, TokenUsageSummary,
};
pub use runtime::{
    CaseItem, CaseSummary, ExactSearchHit, MatrixReadinessSummary, MemoryQueryResult,
    MemorySummary, OperatorError, OperatorRuntime, OperatorSnapshot, OverviewSummary, SearchMode,
    SemanticSearchHit, SessionItem, SessionSummary, SystemSummary, TelegramReadinessSummary,
    VaultEntryMetadata, VaultSecretView, VaultSummary,
};
pub use text_truncation::{truncate_on_char_boundary, truncate_with_ellipsis};
pub use code_read_range::{resolve_code_read_range, CodeReadRange};

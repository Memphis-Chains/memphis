use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    Journal,
    Ask,
    Decision,
    System,
    // Legacy aliases for chain blocks written before this codebase
    // standardised on `system_event`. Append-only chain means we can't
    // rewrite old blocks without invalidating hashes; alias them on
    // the read side instead. Counts as of 2026-05-05:
    //   - security_event       237 blocks  (system chain)
    //   - boot                   1 block   (system chain, bootstrap)
    //   - health_state_change    1 block   (system chain, watchdog)
    //   - memory.action         50 blocks  (soul chain, memory ops)
    //   - model-d-proposal      97 blocks  (collective chain)
    // New writes use system_event with the original semantic name in
    // the `kind` field of the data payload.
    #[serde(alias = "security_event",
            alias = "boot",
            alias = "health_state_change",
            alias = "memory.action",
            alias = "memory.burn",
            alias = "model-d-proposal",
            alias = "mode_change",
            alias = "consent.annotation",
            alias = "scheduler_task",
            alias = "chain.repair",
            alias = "config",
            alias = "reflection_report",
            alias = "categorize_report",
            alias = "unknown")]
    SystemEvent,
    Insight,
    ToolCall,
    ToolResult,
    Error,
    Case,
    WalletTxRequested,
    WalletTxSigned,
    WalletTxBroadcast,
    WalletTxConfirmed,
    WalletTxFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockData {
    #[serde(rename = "type")]
    pub block_type: BlockType,
    pub content: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub index: u64,
    pub timestamp: String,
    pub chain: String,
    pub data: BlockData,
    pub prev_hash: String,
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    Journal,
    Ask,
    Decision,
    System,
    // Legacy aliases (`security_event`, `boot`, `health_state_change`)
    // — deserialize cleanly as SystemEvent for chain blocks written
    // before 2026-05-05 when bootstrap.ts + runtime-security-events.ts
    // still used those names. Append-only chain means we can't rewrite
    // old blocks without invalidating hashes; alias them on the read
    // side instead. New writes always use system_event.
    #[serde(alias = "security_event", alias = "boot", alias = "health_state_change")]
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

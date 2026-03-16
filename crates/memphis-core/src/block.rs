use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    #[default]
    Journal,
    Ask,
    Decision,
    System,
    SystemEvent,
    ToolCall,
    ToolResult,
    Error,
    WalletTxRequested,
    WalletTxSigned,
    WalletTxBroadcast,
    WalletTxConfirmed,
    WalletTxFailed,
}

/// Block data payload. Uses `#[serde(deny_unknown_fields)]` is NOT set,
/// so legacy blocks with extra fields (e.g. `source`) deserialize without error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockData {
    #[serde(rename = "type", default)]
    pub block_type: BlockType,
    pub content: String,
    #[serde(default)]
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

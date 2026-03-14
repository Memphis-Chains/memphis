use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
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

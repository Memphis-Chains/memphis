//! One-shot live probe of the Rust chat path: context guard + provider call.
//!
//! Used to verify the operator's native surface end to end (prompt build,
//! context-window guard, provider turn, stream events) without attaching a
//! terminal to the TUI.
use memphis_operator::{ChatStreamEvent, OperatorRuntime};

fn main() {
    let runtime = OperatorRuntime::from_env();
    let session = std::env::var("MEMPHIS_PROBE_SESSION")
        .unwrap_or_else(|_| "fixture::context-guard".to_string());
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Odpowiedz jednym slowem: gotowe".to_string());
    let mut streamed = String::new();
    let exchange = runtime
        .chat_stream(
            Some(&session),
            &prompt,
            Some("minimax"),
            None,
            |event| {
                if let ChatStreamEvent::Text(chunk) = event {
                    streamed.push_str(&chunk);
                }
            },
        )
        .expect("probe turn failed");
    println!("provider={} model={}", exchange.provider, exchange.model);
    println!(
        "effective_context_window={:?}",
        exchange.effective_context_window
    );
    println!("token_usage={:?}", exchange.token_usage);
    println!("streamed={streamed}");
    println!("reply={}", exchange.reply);
}

//! Retry policy for the local span sinks (native arm).
//!
//! WHY THIS EXISTS
//! ---------------
//! The sink used to disable itself permanently after the FIRST write
//! failure. A single transient error — a directory that was momentarily
//! unwritable, a disk that was momentarily full — cost the process the
//! rest of its telemetry, silently: the report then said "no spans in
//! window", which is indistinguishable from an idle runtime.
//!
//! The policy here is the shared contract between the two arms:
//!
//!   - a failure does NOT disable the sink; it schedules the next attempt;
//!   - the delay grows exponentially with the number of consecutive
//!     failures, so a broken sink costs a bounded number of write attempts
//!     per minute instead of one per span;
//!   - a successful write resets the counter, so the sink recovers on its
//!     own as soon as the cause is gone;
//!   - the state is observable, because the report has to be able to say
//!     "the sink is degraded" instead of "there is no telemetry".
//!
//! The delay schedule is mirrored in TypeScript
//! (`src/infra/observability/sink-retry.ts`) and both arms are checked
//! against `tests/fixtures/telemetry-sink-status-contract.json`, so the
//! two implementations cannot drift apart silently.

/// First retry delay after a single failure.
pub const SINK_RETRY_BASE_MS: i64 = 1_000;

/// Upper bound of the retry delay.
pub const SINK_RETRY_MAX_MS: i64 = 60_000;

/// How much the delay grows per additional consecutive failure.
pub const SINK_RETRY_MULTIPLIER: i64 = 2;

/// The delay before the next attempt after `consecutive_failures`
/// failures.
///
/// One failure waits the base delay, each further failure doubles it,
/// and the wait is capped. The count is 1-based: the delay after the
/// first failure is the base delay.
pub fn sink_retry_delay_ms(consecutive_failures: u32) -> i64 {
    if consecutive_failures == 0 {
        return 0;
    }
    let exponent = (consecutive_failures - 1).min(32);
    let delay = SINK_RETRY_BASE_MS.saturating_mul(SINK_RETRY_MULTIPLIER.saturating_pow(exponent));
    delay.min(SINK_RETRY_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delay_grows_and_caps() {
        assert_eq!(sink_retry_delay_ms(0), 0);
        assert_eq!(sink_retry_delay_ms(1), 1_000);
        assert_eq!(sink_retry_delay_ms(2), 2_000);
        assert_eq!(sink_retry_delay_ms(3), 4_000);
        assert_eq!(sink_retry_delay_ms(4), 8_000);
        assert_eq!(sink_retry_delay_ms(7), 60_000);
        assert_eq!(sink_retry_delay_ms(50), 60_000);
    }
}

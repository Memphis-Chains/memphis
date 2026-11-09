//! Process-local native provider protection. Defaults and configuration names
//! match the Node gateway; state is deliberately reported as process-local.
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::{OperatorConfig, OperatorError};

#[derive(Default)]
struct Breaker {
    failures: VecDeque<Instant>,
    opened_at: Option<Instant>,
    half_open: bool,
    probe_in_flight: bool,
    probe_generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PermitKind {
    Normal,
    Probe(u64),
}

#[derive(Clone, Copy)]
struct Settings {
    threshold: usize,
    window: Duration,
    cooldown: Duration,
}

fn settings(config: &OperatorConfig, provider: &str) -> Settings {
    let prefix = provider.to_ascii_uppercase().replace('-', "_");
    let read = |suffix: &str, fallback: u64| {
        config
            .env(&format!("MEMPHIS_BREAKER_{prefix}_{suffix}"))
            .or_else(|| config.env(&format!("MEMPHIS_BREAKER_DEFAULT_{suffix}")))
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0 && *value <= 86_400_000)
            .unwrap_or(fallback)
    };
    Settings {
        threshold: read("FAILURES", 5).min(10_000) as usize,
        window: Duration::from_millis(read("WINDOW_MS", 60_000)),
        cooldown: Duration::from_millis(read("COOLDOWN_MS", 30_000)),
    }
}

impl Breaker {
    fn admit(&mut self, now: Instant, settings: Settings) -> Option<PermitKind> {
        if let Some(opened) = self.opened_at {
            if now.saturating_duration_since(opened) < settings.cooldown {
                return None;
            }
            self.opened_at = None;
            self.half_open = true;
            self.probe_in_flight = true;
            self.probe_generation = self.probe_generation.wrapping_add(1);
            return Some(PermitKind::Probe(self.probe_generation));
        }
        if self.half_open {
            if self.probe_in_flight {
                return None;
            }
            self.probe_in_flight = true;
            self.probe_generation = self.probe_generation.wrapping_add(1);
            return Some(PermitKind::Probe(self.probe_generation));
        }
        Some(PermitKind::Normal)
    }

    fn record(
        &mut self,
        now: Instant,
        settings: Settings,
        permit: PermitKind,
        ok: bool,
        transient: bool,
    ) {
        if self.half_open {
            if permit != PermitKind::Probe(self.probe_generation) {
                return;
            }
            self.probe_in_flight = false;
            if ok {
                self.half_open = false;
                self.failures.clear();
            } else if transient {
                self.half_open = false;
                self.opened_at = Some(now);
            }
            return;
        }
        if matches!(permit, PermitKind::Probe(_)) {
            return;
        }
        // A late result from an earlier in-flight call cannot close an open
        // circuit or extend its cooldown.
        if self.opened_at.is_some() {
            return;
        }
        self.failures
            .retain(|time| now.saturating_duration_since(*time) < settings.window);
        if !ok && transient {
            self.failures.push_back(now);
            if self.failures.len() >= settings.threshold {
                self.opened_at = Some(now);
            }
        }
    }
}

static BREAKERS: OnceLock<Mutex<HashMap<String, Breaker>>> = OnceLock::new();

pub(crate) struct ProviderPermit {
    provider: String,
    settings: Settings,
    kind: PermitKind,
    settled: bool,
}

pub(crate) fn admit(
    config: &OperatorConfig,
    provider: &str,
) -> Result<ProviderPermit, OperatorError> {
    let mut breakers = BREAKERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| OperatorError::Message("native provider breaker unavailable".into()))?;
    let breaker = breakers.entry(provider.to_string()).or_default();
    let settings = settings(config, provider);
    match breaker.admit(Instant::now(), settings) {
        Some(kind) => Ok(ProviderPermit {
            provider: provider.to_string(),
            settings,
            kind,
            settled: false,
        }),
        None => Err(OperatorError::Message(format!(
            "provider {provider} circuit is open or probing; wait before retrying"
        ))),
    }
}

impl ProviderPermit {
    pub(crate) fn record(
        mut self,
        result: &Result<crate::provider::ChatCompletion, OperatorError>,
    ) {
        let transient = match result {
            Err(OperatorError::ProviderStreamTimeout) => true,
            Err(OperatorError::ProviderHttp { status, .. }) => {
                *status == 429 || (500..=599).contains(status)
            }
            Err(OperatorError::ProviderTransport { transient, .. }) => *transient,
            _ => false,
        };
        if let Ok(mut breakers) = BREAKERS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
            breakers.entry(self.provider.clone()).or_default().record(
                Instant::now(),
                self.settings,
                self.kind,
                result.is_ok(),
                transient,
            );
        }
        self.settled = true;
    }
}

impl Drop for ProviderPermit {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        if let Ok(mut breakers) = BREAKERS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
            breakers.entry(self.provider.clone()).or_default().record(
                Instant::now(),
                self.settings,
                self.kind,
                false,
                false,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_then_allows_one_probe_and_recovers() {
        let mut breaker = Breaker::default();
        let start = Instant::now();
        let settings = Settings {
            threshold: 2,
            window: Duration::from_secs(60),
            cooldown: Duration::from_secs(30),
        };
        breaker.record(start, settings, PermitKind::Normal, false, true);
        breaker.record(start, settings, PermitKind::Normal, false, true);
        assert!(breaker
            .admit(start + Duration::from_secs(1), settings)
            .is_none());
        let probe = breaker
            .admit(start + Duration::from_secs(31), settings)
            .unwrap();
        assert!(breaker
            .admit(start + Duration::from_secs(31), settings)
            .is_none());
        // A late result from an older request cannot settle the probe.
        breaker.record(
            start + Duration::from_secs(31),
            settings,
            PermitKind::Normal,
            true,
            false,
        );
        assert!(breaker
            .admit(start + Duration::from_secs(31), settings)
            .is_none());
        breaker.record(
            start + Duration::from_secs(31),
            settings,
            probe,
            true,
            false,
        );
        assert!(breaker
            .admit(start + Duration::from_secs(32), settings)
            .is_some());
    }

    #[test]
    fn non_transient_probe_failure_does_not_strand_the_probe() {
        let mut breaker = Breaker::default();
        let now = Instant::now();
        let settings = Settings {
            threshold: 1,
            window: Duration::from_secs(60),
            cooldown: Duration::from_secs(1),
        };
        breaker.record(now, settings, PermitKind::Normal, false, true);
        let probe = breaker
            .admit(now + Duration::from_secs(2), settings)
            .unwrap();
        breaker.record(now + Duration::from_secs(2), settings, probe, false, false);
        assert!(breaker
            .admit(now + Duration::from_secs(3), settings)
            .is_some());
    }
}

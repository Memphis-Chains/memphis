//! SQLite token reservations shared with the Node runtime. Only metadata is stored.
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use std::time::Duration;

use crate::{OperatorConfig, OperatorError};

#[derive(Clone, Copy, Default)]
struct Caps { daily: Option<i64>, monthly: Option<i64> }

fn caps(config: &OperatorConfig, provider: &str) -> Result<Caps, OperatorError> {
    let upper = provider.to_ascii_uppercase().replace('-', "_");
    let read = |suffix: &str| -> Result<Option<i64>, OperatorError> {
        let key = format!("MEMPHIS_COST_CAP_{upper}_{suffix}");
        let Some(raw) = config.env(&key).map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
        if !raw.bytes().all(|byte| byte.is_ascii_digit()) { return Err(OperatorError::Message(format!("invalid {key}"))) }
        let parsed = raw.parse::<i64>().ok().filter(|v| *v > 0 && *v <= 9_007_199_254_740_991);
        parsed.map(Some).ok_or_else(|| OperatorError::Message(format!("invalid {key}")))
    };
    Ok(Caps { daily: read("DAILY_TOKENS")?, monthly: read("MONTHLY_TOKENS")? })
}

pub(crate) fn configured(config: &OperatorConfig, provider: &str) -> Result<bool, OperatorError> {
    let caps = caps(config, provider)?;
    Ok(caps.daily.is_some() || caps.monthly.is_some())
}

fn ensure(conn: &Connection) -> Result<(), OperatorError> {
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS provider_budget_reservations (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, started_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','settled','unknown')),
        reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens > 0),
        actual_tokens INTEGER CHECK(actual_tokens >= 0), settled_at TEXT
    ); CREATE INDEX IF NOT EXISTS idx_provider_budget_period ON provider_budget_reservations(provider,started_at);")
        .map_err(|e| OperatorError::Sqlite(e.to_string()))
}

fn reserve_inner(conn: &Connection, provider: &str, count: i64, caps: Caps, now: DateTime<Utc>) -> Result<String, OperatorError> {
    if count <= 0 || count > 9_007_199_254_740_991 || provider.is_empty() || provider.len() > 80 ||
        !provider.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(OperatorError::Message("invalid provider budget reservation".into()));
    }
    ensure(conn)?;
    let at = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    let (daily, monthly): (i64,i64) = tx.query_row("SELECT \
      COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,10)=?1 THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0), \
      COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,7)=?2 THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0) \
      FROM provider_budget_reservations WHERE provider=?3", params![&at[..10], &at[..7], provider], |row| Ok((row.get(0)?,row.get(1)?)))
      .map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    if caps.daily.is_some_and(|cap| daily.saturating_add(count) > cap) || caps.monthly.is_some_and(|cap| monthly.saturating_add(count) > cap) {
        return Err(OperatorError::Message(format!("provider {provider} token budget has insufficient room for the next reservation")));
    }
    let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0)).map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    tx.execute("INSERT INTO provider_budget_reservations(id,provider,started_at,status,reserved_tokens) VALUES (?,?,?,'reserved',?)", params![id,provider,at,count])
        .map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    tx.commit().map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    Ok(id)
}

pub(crate) fn reserve(conn: &Connection, config: &OperatorConfig, provider: &str, count: u64) -> Result<Option<String>, OperatorError> {
    let caps = caps(config, provider)?;
    if caps.daily.is_none() && caps.monthly.is_none() { return Ok(None) }
    let count = i64::try_from(count).map_err(|_| OperatorError::Message("provider budget reservation is too large".into()))?;
    reserve_inner(conn, provider, count, caps, Utc::now()).map(Some)
}

pub(crate) fn settle(conn: &Connection, id: &str, actual: Option<u32>, estimated: bool) -> Result<(), OperatorError> {
    let now = Utc::now().to_rfc3339();
    let changed = if let Some(actual) = actual.filter(|_| !estimated) {
        conn.execute("UPDATE provider_budget_reservations SET status='settled',actual_tokens=?,settled_at=? WHERE id=? AND status='reserved'", params![actual,now,id])
    } else {
        conn.execute("UPDATE provider_budget_reservations SET status='unknown',settled_at=? WHERE id=? AND status='reserved'", params![now,id])
    }.map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    if changed != 1 { return Err(OperatorError::Message("budget reservation is missing or already settled".into())) }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    #[test]
    fn reservation_survives_unknown_and_exact_settlement_releases_unused() {
        let conn = Connection::open_in_memory().unwrap();
        let cap = Caps { daily: Some(100), monthly: None };
        let first = reserve_inner(&conn,"minimax",80,cap,Utc::now()).unwrap();
        assert!(reserve_inner(&conn,"minimax",21,cap,Utc::now()).is_err());
        settle(&conn,&first,Some(20),false).unwrap();
        let second = reserve_inner(&conn,"minimax",80,cap,Utc::now()).unwrap();
        settle(&conn,&second,Some(10),true).unwrap();
        assert!(reserve_inner(&conn,"minimax",1,cap,Utc::now()).is_err());
        assert!(settle(&conn,&first,Some(1),false).is_err());
    }

    #[test]
    fn unresolved_reservation_survives_day_and_month_rollover() {
        let conn = Connection::open_in_memory().unwrap();
        let caps = Caps { daily: Some(100), monthly: Some(100) };
        let before = Utc.with_ymd_and_hms(2026, 4, 30, 23, 59, 59).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 5, 1, 0, 0, 0).unwrap();
        let first = reserve_inner(&conn, "minimax", 80, caps, before).unwrap();
        assert!(reserve_inner(&conn, "minimax", 21, caps, after).is_err());
        settle(&conn, &first, Some(80), false).unwrap();
        assert!(reserve_inner(&conn, "minimax", 100, caps, after).is_ok());
    }
}

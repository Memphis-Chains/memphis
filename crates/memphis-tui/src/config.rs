use std::{env, path::PathBuf, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiConfig {
    pub data_dir: PathBuf,
    pub refresh_interval: Duration,
}

impl TuiConfig {
    pub fn from_env() -> Self {
        Self::from_iter(env::vars())
    }

    pub fn from_iter<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let env_map = vars
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect::<std::collections::HashMap<String, String>>();

        let data_dir = env_map
            .get("MEMPHIS_DATA_DIR")
            .or_else(|| env_map.get("MEMPHIS_DIR"))
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(expand_home)
            .unwrap_or_else(|| expand_home("~/.memphis"));

        let refresh_interval = env_map
            .get("MEMPHIS_TUI_REFRESH_MS")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value >= 250)
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_millis(3000));

        Self {
            data_dir,
            refresh_interval,
        }
    }
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    }
    if let Some(suffix) = value.strip_prefix("~/") {
        return PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(suffix);
    }
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::TuiConfig;
    use std::time::Duration;

    #[test]
    fn derives_data_dir_from_env() {
        let config = TuiConfig::from_iter([
            ("HOME", "/tmp/home"),
            ("MEMPHIS_DATA_DIR", "~/memphis-data"),
        ]);

        assert!(config.data_dir.ends_with("memphis-data"));
    }

    #[test]
    fn explicit_refresh_value_overrides_default() {
        let config = TuiConfig::from_iter([
            ("HOME", "/tmp/home"),
            ("MEMPHIS_DIR", "~/scoped"),
            ("MEMPHIS_TUI_REFRESH_MS", "750"),
        ]);

        assert!(config.data_dir.ends_with("scoped"));
        assert_eq!(config.refresh_interval, Duration::from_millis(750));
    }
}

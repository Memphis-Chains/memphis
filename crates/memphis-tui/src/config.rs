use std::{env, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiConfig {
    pub base_url: String,
    pub api_token: Option<String>,
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

        let base_url = env_map
            .get("MEMPHIS_TUI_BASE_URL")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(normalize_base_url)
            .unwrap_or_else(|| {
                let host = env_map
                    .get("HOST")
                    .map(String::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("127.0.0.1");
                let port = env_map
                    .get("PORT")
                    .map(String::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("3000");
                normalize_base_url(&format!("http://{host}:{port}"))
            });

        let api_token = env_map
            .get("MEMPHIS_TUI_API_TOKEN")
            .or_else(|| env_map.get("MEMPHIS_API_TOKEN"))
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned);

        let refresh_interval = env_map
            .get("MEMPHIS_TUI_REFRESH_MS")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value >= 250)
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_millis(3000));

        Self {
            base_url,
            api_token,
            refresh_interval,
        }
    }
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::TuiConfig;
    use std::time::Duration;

    #[test]
    fn derives_base_url_from_host_and_port() {
        let config = TuiConfig::from_iter([
            ("HOST", "0.0.0.0"),
            ("PORT", "4123"),
            ("MEMPHIS_API_TOKEN", "token"),
        ]);

        assert_eq!(config.base_url, "http://0.0.0.0:4123");
        assert_eq!(config.api_token.as_deref(), Some("token"));
    }

    #[test]
    fn explicit_tui_values_override_shared_env() {
        let config = TuiConfig::from_iter([
            ("HOST", "127.0.0.1"),
            ("PORT", "3000"),
            ("MEMPHIS_API_TOKEN", "shared"),
            ("MEMPHIS_TUI_API_TOKEN", "scoped"),
            ("MEMPHIS_TUI_BASE_URL", "http://localhost:9999/"),
            ("MEMPHIS_TUI_REFRESH_MS", "750"),
        ]);

        assert_eq!(config.base_url, "http://localhost:9999");
        assert_eq!(config.api_token.as_deref(), Some("scoped"));
        assert_eq!(config.refresh_interval, Duration::from_millis(750));
    }
}

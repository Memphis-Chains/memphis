//! The SSRF guard for the native surface.
//!
//! The TypeScript surface has refused private and internal targets
//! since ADR-007 (`src/core/ssrf-guard.ts`): a public web fetch must
//! not be a way to read `127.0.0.1`, the LAN, or a cloud metadata
//! endpoint. The native arm called `ureq` directly, with no guard at
//! all -- so the same request was refused on the gateway and allowed
//! on the cockpit, where the model is talking.
//!
//! The rules and the words are the same as the TypeScript ones:
//!
//! * only `http` and `https`;
//! * a query string longer than 200 characters;
//! * `localhost`, and the `.local` / `.internal` suffixes;
//! * a literal address in a private, loopback, link-local, CGNAT,
//!   multicast or otherwise reserved range;
//! * a hostname that resolves to any such address -- the check that
//!   catches a public name pointed at an internal one.
//!
//! The operator can open the private network for local dashboards with
//! `MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK`, exactly as on the
//! TypeScript surface.

use std::net::{IpAddr, ToSocketAddrs};

/// Whether the operator opened the private network for this surface.
pub fn allow_private_network() -> bool {
    let value = std::env::var("MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK").unwrap_or_default();
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

/// Strip the brackets an IPv6 literal carries in a URL.
fn strip_ipv6_brackets(host: &str) -> &str {
    if host.starts_with('[') && host.ends_with(']') && host.len() >= 2 {
        &host[1..host.len() - 1]
    } else {
        host
    }
}

/// Whether an IPv4 address is private, loopback, link-local, CGNAT,
/// multicast or otherwise reserved.
pub fn is_private_ipv4(ip: &str) -> bool {
    let parsed: std::net::Ipv4Addr = match ip.parse() {
        Ok(value) => value,
        // Malformed is unsafe: fail closed.
        Err(_) => return true,
    };
    let octets = parsed.octets();
    if parsed.is_loopback() || parsed.is_unspecified() || parsed.is_broadcast() {
        return true;
    }
    if octets[0] == 10 {
        return true; // RFC1918
    }
    if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        return true; // RFC1918
    }
    if octets[0] == 192 && octets[1] == 168 {
        return true; // RFC1918
    }
    if octets[0] == 169 && octets[1] == 254 {
        return true; // link-local, cloud metadata
    }
    if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        return true; // CGNAT
    }
    if octets[0] == 0 {
        return true; // "this host"
    }
    if octets[0] >= 224 {
        return true; // multicast and reserved
    }
    false
}

/// Whether an IPv6 address is private, loopback, link-local, unique
/// local, multicast, or an IPv4 address in disguise.
pub fn is_private_ipv6(ip: &str) -> bool {
    let parsed: std::net::Ipv6Addr = match ip.parse() {
        Ok(value) => value,
        Err(_) => return true,
    };
    if parsed.is_loopback() || parsed.is_unspecified() {
        return true;
    }
    let segments = parsed.segments();
    if segments[0] & 0xfe00 == 0xfc00 {
        return true; // fc00::/7, unique local
    }
    if segments[0] & 0xffc0 == 0xfe80 {
        return true; // fe80::/10, link-local
    }
    if segments[0] & 0xff00 == 0xff00 {
        return true; // ff00::/8, multicast
    }
    // An IPv4 address in disguise is checked against the IPv4 list.
    if let Some(mapped) = parsed.to_ipv4_mapped() {
        return is_private_ipv4(&mapped.to_string());
    }
    false
}

/// Whether an address is one the tool must not reach. Anything that is
/// not an address at all is treated as unsafe.
pub fn is_private_ip(ip: &str) -> bool {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => is_private_ipv4(&v4.to_string()),
        Ok(IpAddr::V6(v6)) => is_private_ipv6(&v6.to_string()),
        Err(_) => true,
    }
}

/// The parts of a URL the guard needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlShape {
    pub scheme: String,
    /// The host, lowercased and without the brackets of an IPv6 literal.
    pub host: String,
    /// The authority as it was written, for resolving a relative redirect.
    pub authority: String,
    /// The path, without the query.
    pub path: String,
}

/// Split a URL into the parts the guard looks at.
///
/// This is not a general URL parser: it reads the scheme, the
/// authority and the query length, which is what the guard's rules
/// are about.
pub fn parse_url_shape(raw: &str) -> Result<UrlShape, String> {
    let trimmed = raw.trim();
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => return Err("URL blocked: invalid URL".to_string()),
    };
    if scheme != "http" && scheme != "https" {
        return Err("URL blocked: only http(s) is allowed".to_string());
    }

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let tail = &rest[authority_end..];

    let query = match tail.find('?') {
        Some(index) => {
            let query = &tail[index + 1..];
            match query.find('#') {
                Some(hash) => &query[..hash],
                None => query,
            }
        }
        None => "",
    };
    if query.len() > 200 {
        return Err("URL blocked: query string too long".to_string());
    }

    let path = match tail.find('?') {
        Some(index) => &tail[..index],
        None => tail,
    };
    let path = match path.find('#') {
        Some(hash) => &path[..hash],
        None => path,
    };

    // The userinfo is not part of the host.
    let host_port = match authority.rfind('@') {
        Some(index) => &authority[index + 1..],
        None => authority,
    };
    let host = if host_port.starts_with('[') {
        match host_port.find(']') {
            // The closing bracket is kept, so the strip below can take
            // both of them off.
            Some(index) => &host_port[..=index],
            None => return Err("URL blocked: invalid URL".to_string()),
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => host,
            _ => host_port,
        }
    };

    let host = strip_ipv6_brackets(host).to_ascii_lowercase();
    if host.is_empty() {
        return Err("URL blocked: empty host".to_string());
    }

    Ok(UrlShape {
        scheme,
        host,
        authority: host_port.to_string(),
        path: path.to_string(),
    })
}

/// The first-pass check: the shape of the URL, before any DNS.
pub fn assert_url_shape_safe(raw: &str) -> Result<UrlShape, String> {
    let shape = parse_url_shape(raw)?;
    if allow_private_network() {
        return Ok(shape);
    }
    if shape.host == "localhost" {
        return Err("URL blocked: localhost".to_string());
    }
    if shape.host.ends_with(".local") || shape.host.ends_with(".internal") {
        return Err("URL blocked: .local/.internal domain".to_string());
    }
    if shape.host.parse::<IpAddr>().is_ok() && is_private_ip(&shape.host) {
        return Err(format!(
            "URL blocked: private/internal IP literal ({})",
            shape.host
        ));
    }
    Ok(shape)
}

/// Resolve the host and refuse any address the tool must not reach.
///
/// A public name pointed at an internal address is the case this
/// catches; a literal address never gets this far.
pub fn assert_host_safe(host: &str) -> Result<(), String> {
    if allow_private_network() {
        return Ok(());
    }
    let host = strip_ipv6_brackets(host).to_ascii_lowercase();
    if host.is_empty() {
        return Err("URL blocked: empty host".to_string());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if is_private_ip(&address.to_string()) {
            return Err(format!(
                "URL blocked: host resolves to private/internal IP ({address})"
            ));
        }
        return Ok(());
    }
    let addresses: Vec<IpAddr> = match (host.as_str(), 0u16).to_socket_addrs() {
        Ok(iter) => iter.map(|address| address.ip()).collect(),
        Err(_) => return Err("URL blocked: host could not be resolved".to_string()),
    };
    if addresses.is_empty() {
        return Err("URL blocked: host resolved to no addresses".to_string());
    }
    for address in addresses {
        if is_private_ip(&address.to_string()) {
            return Err(format!(
                "URL blocked: host resolves to private/internal IP ({address})"
            ));
        }
    }
    Ok(())
}

/// The whole check: the shape of the URL, then the host behind it.
pub fn assert_url_safe(raw: &str) -> Result<UrlShape, String> {
    let shape = assert_url_shape_safe(raw)?;
    assert_host_safe(&shape.host)?;
    Ok(shape)
}

/// Resolve a `Location` header against the URL that produced it.
pub fn resolve_redirect(base: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("URL blocked: invalid redirect".to_string());
    }
    if location.contains("://") {
        return Ok(location.to_string());
    }
    let shape = parse_url_shape(base)?;
    let authority = format!("{}://{}", shape.scheme, shape.authority);
    if location.starts_with('/') {
        return Ok(format!("{authority}{location}"));
    }
    let directory = match shape.path.rfind('/') {
        Some(index) => &shape.path[..=index],
        None => "/",
    };
    Ok(format!("{authority}{directory}{location}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same table the TypeScript guard is tested against
    /// (`tests/unit/ssrf-guard.test.ts`), so both surfaces refuse the
    /// same addresses.
    #[test]
    fn private_ipv4_addresses_are_refused() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_private_ipv4(ip), "{ip} must be private");
            assert!(is_private_ip(ip), "{ip} must be private");
        }
    }

    #[test]
    fn public_ipv4_addresses_are_allowed() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.63.0.1",
            "192.169.1.1",
            "223.255.255.255",
        ] {
            assert!(!is_private_ipv4(ip), "{ip} must be public");
            assert!(!is_private_ip(ip), "{ip} must be public");
        }
    }

    /// Malformed is unsafe: the guard fails closed.
    #[test]
    fn a_malformed_address_is_treated_as_private() {
        for ip in ["999.1.1.1", "not-an-ip", "", "1.2.3"] {
            assert!(is_private_ipv4(ip), "{ip} must be treated as private");
            assert!(is_private_ip(ip), "{ip} must be treated as private");
        }
    }

    #[test]
    fn private_ipv6_addresses_are_refused() {
        for ip in [
            "::1",
            "::",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            // An IPv4 address in disguise is checked against the IPv4 list.
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
        ] {
            assert!(is_private_ipv6(ip), "{ip} must be private");
            assert!(is_private_ip(ip), "{ip} must be private");
        }
    }

    #[test]
    fn public_ipv6_addresses_are_allowed() {
        for ip in ["2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(!is_private_ipv6(ip), "{ip} must be public");
            assert!(!is_private_ip(ip), "{ip} must be public");
        }
    }

    #[test]
    fn only_http_and_https_are_allowed() {
        assert_eq!(
            assert_url_shape_safe("ftp://example.com/x").unwrap_err(),
            "URL blocked: only http(s) is allowed"
        );
        assert_eq!(
            assert_url_shape_safe("file:///etc/passwd").unwrap_err(),
            "URL blocked: only http(s) is allowed"
        );
        assert_eq!(
            assert_url_shape_safe("not a url").unwrap_err(),
            "URL blocked: invalid URL"
        );
    }

    #[test]
    fn a_long_query_string_is_refused() {
        let long = format!("https://example.com/?q={}", "a".repeat(201));
        assert_eq!(
            assert_url_shape_safe(&long).unwrap_err(),
            "URL blocked: query string too long"
        );
    }

    #[test]
    fn localhost_and_the_internal_suffixes_are_refused() {
        assert_eq!(
            assert_url_shape_safe("http://localhost:8080/x").unwrap_err(),
            "URL blocked: localhost"
        );
        assert_eq!(
            assert_url_shape_safe("http://printer.local/x").unwrap_err(),
            "URL blocked: .local/.internal domain"
        );
        assert_eq!(
            assert_url_shape_safe("http://db.internal/x").unwrap_err(),
            "URL blocked: .local/.internal domain"
        );
    }

    /// The case that made the old native arm a way to read anything: a
    /// literal address in the URL.
    #[test]
    fn a_private_ip_literal_is_refused() {
        assert_eq!(
            assert_url_shape_safe("http://169.254.169.254/latest/meta-data/").unwrap_err(),
            "URL blocked: private/internal IP literal (169.254.169.254)"
        );
        assert_eq!(
            assert_url_shape_safe("http://[::1]:8080/x").unwrap_err(),
            "URL blocked: private/internal IP literal (::1)"
        );
    }

    #[test]
    fn the_host_of_a_safe_url_is_parsed() {
        let shape = assert_url_shape_safe("https://example.com/docs?a=1").unwrap();
        assert_eq!(shape.scheme, "https");
        assert_eq!(shape.host, "example.com");
        assert_eq!(shape.path, "/docs");
    }

    /// A redirect may point anywhere, so it is resolved and then checked
    /// like any other URL.
    #[test]
    fn a_redirect_is_resolved_against_the_url_that_produced_it() {
        assert_eq!(
            resolve_redirect("https://example.com/a/b", "/c").unwrap(),
            "https://example.com/c"
        );
        assert_eq!(
            resolve_redirect("https://example.com/a/b", "c").unwrap(),
            "https://example.com/a/c"
        );
        assert_eq!(
            resolve_redirect("https://example.com/a/b", "https://other.example/d").unwrap(),
            "https://other.example/d"
        );
    }

    /// A host that cannot be resolved is refused, not fetched.
    #[test]
    fn an_unresolvable_host_is_refused() {
        let error = assert_host_safe("this-host-does-not-exist.invalid").unwrap_err();
        assert_eq!(error, "URL blocked: host could not be resolved");
    }
}

//! Read-only persistence diagnostics. Never constructs a provider or re-embeds.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMetadata {
    pub schema_version: u8,
    pub path: String,
    pub format_version: Option<u8>,
    pub state: String,
    pub documents: usize,
    pub invalid_records: usize,
    pub dimension: Option<usize>,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
struct Header { version: u8, dim: usize }
#[derive(Deserialize)]
struct Document { id: String, text: String, vector: Option<Vec<f32>> }
#[derive(Deserialize)]
struct Legacy { version: u8, dim: usize, docs: Vec<Document> }

pub fn inspect_index(configured_path: &Path) -> IndexMetadata {
    let sibling = configured_path.with_extension("ndjson");
    let path = if sibling.exists() { sibling.as_path() } else { configured_path };
    let mut result = IndexMetadata {
        schema_version: 1, path: path.display().to_string(), format_version: None,
        state: "missing".into(), documents: 0, invalid_records: 0,
        dimension: None, size_bytes: 0,
    };
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound { result.state = "unreadable".into(); }
            return result;
        }
    };
    result.size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    if result.size_bytes == 0 { result.state = "empty".into(); return result; }
    let mut ids = HashSet::new();
    let mut accept = |document: Document, dimension: usize| {
        if document.id.trim().is_empty() || document.text.trim().is_empty()
            || document.vector.as_ref().is_none_or(|v| v.len() != dimension || v.iter().any(|f| !f.is_finite())) {
            result.invalid_records += 1;
        } else { ids.insert(document.id); }
    };
    if path == sibling {
        let mut lines = BufReader::new(file).lines();
        let header = lines.next().and_then(Result::ok).and_then(|line| serde_json::from_str::<Header>(&line).ok());
        let Some(header) = header.filter(|h| h.version == 2 && h.dim > 0) else {
            result.state = "corrupt".into(); return result;
        };
        result.format_version = Some(2);
        result.dimension = Some(header.dim);
        for line in lines {
            let line = match line { Ok(line) => line, Err(_) => { result.state = "unreadable".into(); return result; } };
            if line.trim().is_empty() { continue; }
            match serde_json::from_str::<Document>(&line) {
                Ok(document) => accept(document, header.dim),
                Err(_) => { result.state = "corrupt".into(); return result; }
            }
        }
    } else {
        let parsed = serde_json::from_reader::<_, Legacy>(BufReader::new(file));
        let Ok(parsed) = parsed else { result.state = "corrupt".into(); return result; };
        if parsed.version != 1 || parsed.dim == 0 { result.state = "corrupt".into(); return result; }
        result.format_version = Some(1);
        result.dimension = Some(parsed.dim);
        for document in parsed.docs { accept(document, parsed.dim); }
    }
    result.documents = ids.len();
    result.state = if result.invalid_records > 0 { "degraded" } else if ids.is_empty() { "empty" } else { "loaded" }.into();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ndjson_takes_precedence_and_never_falls_back_after_corruption() {
        let root = std::env::temp_dir().join(format!("memphis-index-metadata-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("index.json");
        std::fs::write(&path, r#"{"version":1,"dim":2,"docs":[]}"#).unwrap();
        let ndjson = path.with_extension("ndjson");
        std::fs::write(&ndjson, "{\"version\":2,\"dim\":2}\n{\"id\":\"pl\",\"text\":\"pamięć\",\"vector\":[0.1,0.2]}\n").unwrap();
        let metadata = inspect_index(&path);
        assert_eq!(metadata.documents, 1);
        assert_eq!(metadata.state, "loaded");
        std::fs::write(&ndjson, "broken header").unwrap();
        assert_eq!(inspect_index(&path).state, "corrupt");
        std::fs::remove_dir_all(root).unwrap();
    }
}

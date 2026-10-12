//! File tools for bots: read, write, edit, list, find, grep, delete.
//! Relative paths resolve against the bot workspace. When `restricted` is set
//! (mobile app sandbox), every path must stay inside the workspace; otherwise
//! the approval flow in the app decides what is allowed.

use globset::GlobBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Lexically normalizes `.` and `..` so sandbox checks work for paths that do not exist yet.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

pub fn resolve(root: &str, path: &str, restricted: bool) -> Result<PathBuf, String> {
    let root = normalize(Path::new(root));
    let p = expand_home(path.trim());
    let full = normalize(&if p.is_absolute() { p } else { root.join(p) });
    if restricted && !full.starts_with(&root) {
        return Err(format!("{} is outside the bot workspace", full.display()));
    }
    Ok(full)
}

fn display(root: &str, p: &Path) -> String {
    p.strip_prefix(normalize(Path::new(root)))
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    pub content: String,
    pub start_line: usize,
    pub total_lines: usize,
    pub truncated: bool,
}

pub fn read(root: &str, path: &str, offset: Option<usize>, limit: Option<usize>, restricted: bool) -> Result<ReadResult, String> {
    let full = resolve(root, path, restricted)?;
    let meta = fs::metadata(&full).map_err(|e| format!("{}: {e}", full.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory; use list_dir", full.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{} is too large to read ({} bytes)", full.display(), meta.len()));
    }
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    if is_binary(&bytes) {
        return Err(format!("{} looks like a binary file", full.display()));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let start = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(2000);
    let end = (start - 1 + limit).min(lines.len());
    let content = if start - 1 < lines.len() { lines[start - 1..end].join("\n") } else { String::new() };
    Ok(ReadResult {
        path: display(root, &full),
        content,
        start_line: start,
        total_lines: lines.len(),
        truncated: end < lines.len(),
    })
}

pub fn write(root: &str, path: &str, content: &str, restricted: bool) -> Result<String, String> {
    let full = resolve(root, path, restricted)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full, content.as_bytes()).map_err(|e| format!("{}: {e}", full.display()))?;
    Ok(format!("Wrote {} bytes to {}", content.len(), display(root, &full)))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
    #[serde(default)]
    pub replace_all: bool,
}

/// Applies exact search/replace edits in order. Each `old_text` must match
/// exactly once unless `replace_all` is set, so edits are never ambiguous.
pub fn apply_edits(original: &str, edits: &[Edit]) -> Result<(String, usize), String> {
    let mut text = original.to_string();
    let mut total = 0;
    for (i, edit) in edits.iter().enumerate() {
        if edit.old_text.is_empty() {
            return Err(format!("edit {}: old_text is empty", i + 1));
        }
        let count = text.matches(&edit.old_text).count();
        match count {
            0 => return Err(format!("edit {}: old_text was not found in the file", i + 1)),
            1 => {
                text = text.replacen(&edit.old_text, &edit.new_text, 1);
                total += 1;
            }
            n if edit.replace_all => {
                text = text.replace(&edit.old_text, &edit.new_text);
                total += n;
            }
            n => {
                return Err(format!(
                    "edit {}: old_text matches {n} places; include more surrounding text or set replace_all",
                    i + 1
                ))
            }
        }
    }
    Ok((text, total))
}

pub fn edit(root: &str, path: &str, edits: &[Edit], restricted: bool) -> Result<String, String> {
    let full = resolve(root, path, restricted)?;
    let original = fs::read_to_string(&full).map_err(|e| format!("{}: {e}", full.display()))?;
    let (updated, n) = apply_edits(&original, edits)?;
    fs::write(&full, updated).map_err(|e| e.to_string())?;
    Ok(format!("Applied {n} replacement(s) to {}", display(root, &full)))
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

pub fn list(root: &str, path: Option<&str>, restricted: bool) -> Result<Vec<DirEntry>, String> {
    let full = resolve(root, path.unwrap_or("."), restricted)?;
    let mut entries: Vec<DirEntry> = fs::read_dir(&full)
        .map_err(|e| format!("{}: {e}", full.display()))?
        .filter_map(|e| e.ok())
        .map(|e| {
            let meta = e.metadata().ok();
            DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.map(|m| m.len()).unwrap_or(0),
            }
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

fn walker(base: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(base)
        .hidden(false)
        .git_ignore(true)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules")
        .build()
}

pub fn find(root: &str, pattern: &str, path: Option<&str>, limit: Option<usize>, restricted: bool) -> Result<Vec<String>, String> {
    let base = resolve(root, path.unwrap_or("."), restricted)?;
    let matcher = GlobBuilder::new(pattern)
        .case_insensitive(true)
        .literal_separator(pattern.contains('/'))
        .build()
        .map_err(|e| e.to_string())?
        .compile_matcher();
    let limit = limit.unwrap_or(200);
    let mut out = Vec::new();
    for entry in walker(&base).filter_map(|e| e.ok()) {
        let p = entry.path();
        let rel = p.strip_prefix(&base).unwrap_or(p);
        let candidate: &Path = if pattern.contains('/') { rel } else { Path::new(p.file_name().unwrap_or_default()) };
        if rel.as_os_str().is_empty() || !matcher.is_match(candidate) {
            continue;
        }
        out.push(display(root, p));
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepRequest {
    pub root: String,
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    #[serde(default)]
    pub ignore_case: bool,
    #[serde(default)]
    pub literal: bool,
    pub context: Option<usize>,
    pub limit: Option<usize>,
}

pub fn grep(request: &GrepRequest, restricted: bool) -> Result<String, String> {
    let base = resolve(&request.root, request.path.as_deref().unwrap_or("."), restricted)?;
    let pattern = if request.literal { regex::escape(&request.pattern) } else { request.pattern.clone() };
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(request.ignore_case)
        .build()
        .map_err(|e| e.to_string())?;
    let glob = match &request.glob {
        Some(g) => Some(GlobBuilder::new(g).literal_separator(false).build().map_err(|e| e.to_string())?.compile_matcher()),
        None => None,
    };
    let ctx = request.context.unwrap_or(0).min(10);
    let limit = request.limit.unwrap_or(100);
    let mut out = String::new();
    let mut matches = 0;

    let files: Box<dyn Iterator<Item = PathBuf>> = if base.is_file() {
        Box::new(std::iter::once(base.clone()))
    } else {
        Box::new(
            walker(&base)
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| e.into_path()),
        )
    };

    'files: for file in files {
        if let Some(g) = &glob {
            if !g.is_match(file.file_name().unwrap_or_default()) && !g.is_match(&file) {
                continue;
            }
        }
        let Ok(meta) = fs::metadata(&file) else { continue };
        if meta.len() > MAX_GREP_FILE_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        if fs::File::open(&file).and_then(|mut f| f.read_to_end(&mut bytes)).is_err() || is_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let name = display(&request.root, &file);
        let mut last_printed: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            let from = i.saturating_sub(ctx);
            let to = (i + ctx).min(lines.len().saturating_sub(1));
            if let Some(last) = last_printed {
                if from > last + 1 {
                    out.push_str("--\n");
                }
            }
            for j in from..=to {
                if last_printed.is_some_and(|l| j <= l) {
                    continue;
                }
                let sep = if j == i { ':' } else { '-' };
                let shown: String = lines[j].chars().take(400).collect();
                out.push_str(&format!("{name}{sep}{}{sep} {shown}\n", j + 1));
                last_printed = Some(j);
            }
            matches += 1;
            if matches >= limit {
                out.push_str(&format!("[stopped after {limit} matches]\n"));
                break 'files;
            }
        }
    }
    if matches == 0 {
        return Ok("No matches.".into());
    }
    Ok(out)
}

pub fn delete(root: &str, path: &str, restricted: bool) -> Result<String, String> {
    let full = resolve(root, path, restricted)?;
    if full == normalize(Path::new(root)) {
        return Err("refusing to delete the workspace root".into());
    }
    let meta = fs::metadata(&full).map_err(|e| format!("{}: {e}", full.display()))?;
    if meta.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&full).map_err(|e| e.to_string())?;
    }
    Ok(format!("Deleted {}", display(root, &full)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(old: &str, new: &str, all: bool) -> Edit {
        Edit { old_text: old.into(), new_text: new.into(), replace_all: all }
    }

    #[test]
    fn edits_apply_in_order() {
        let (out, n) = apply_edits("a b c", &[edit("b", "B", false), edit("c", "C", false)]).unwrap();
        assert_eq!(out, "a B C");
        assert_eq!(n, 2);
    }

    #[test]
    fn ambiguous_edit_is_rejected_unless_replace_all() {
        assert!(apply_edits("x x", &[edit("x", "y", false)]).is_err());
        assert_eq!(apply_edits("x x", &[edit("x", "y", true)]).unwrap().0, "y y");
    }

    #[test]
    fn missing_text_is_an_error() {
        assert!(apply_edits("abc", &[edit("zzz", "y", false)]).is_err());
    }

    #[test]
    fn normalize_strips_parent_dirs() {
        assert_eq!(normalize(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
    }

    #[test]
    fn restricted_paths_stay_in_the_workspace() {
        let root = if cfg!(windows) { "C:\\ws" } else { "/ws" };
        assert!(resolve(root, "../etc/passwd", true).is_err());
        assert!(resolve(root, "notes/a.md", true).is_ok());
        assert!(resolve(root, "../etc/passwd", false).is_ok());
    }
}

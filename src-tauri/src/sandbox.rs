//! Sandbox project filesystem + git backend.
//!
//! Persists multi-project workspaces under
//! `~/Documents/Libre Sandbox/<project-id>/`:
//!
//! ```text
//! Libre Sandbox/
//! ├── <project-id-1>/
//! │   ├── .libre-sandbox.json   ← metadata { id, name, language, ... }
//! │   ├── main.rs               ← workbench files at their literal paths
//! │   ├── tests.rs
//! │   └── .git/                 ← optional, present after `git init`
//! └── <project-id-2>/
//!     ├── .libre-sandbox.json
//!     └── ...
//! ```
//!
//! The frontend addresses projects by id (stable, never shown to the
//! user); the on-disk folder name uses the same id so a learner can
//! `cd ~/Documents/Libre\ Sandbox/<id>/` and open the project in any
//! editor without first looking it up.
//!
//! The metadata sidecar lives at `.libre-sandbox.json` rather than
//! `project.json` because the latter is a real filename in JS / TS
//! workspaces — we don't want to collide with the user's own
//! `package.json` semantics. Dotfile keeps it out of most file-tree
//! views by default.
//!
//! Git operations shell out to the system `git` binary. The frontend
//! never touches a real Git library directly — this keeps the install
//! footprint small (no `git2` crate) and matches what a learner would
//! actually type on the command line.
//!
//! Web build: this module is desktop-only. The frontend's storage
//! layer falls back to localStorage when `isWeb` is true so the
//! browser path keeps working without these commands present.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

// ── Path resolution ──────────────────────────────────────────────

/// Resolve `~/Documents/Libre Sandbox/`, creating it if absent. Uses
/// the platform's canonical "Documents" directory (XDG on Linux,
/// Documents on macOS / Windows) via `dirs::document_dir()`. Falls
/// back to the user's home dir if no Documents folder is set — that
/// case shouldn't fire on a standard OS install but it's better than
/// erroring out, since the path is still under the user's control.
fn sandbox_root() -> anyhow::Result<PathBuf> {
    let docs = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| anyhow::anyhow!("could not resolve Documents directory"))?;
    // Profile-scoped: `<Documents>/Libre Sandbox/<active-profile>/`.
    // `sandbox_root()` has no `AppHandle`, so the active id comes
    // from the process-global the profiles module owns.
    let root = crate::profiles::sandbox_profile_root(&docs);
    if !root.exists() {
        fs::create_dir_all(&root)?;
    }
    Ok(root)
}

fn project_dir(id: &str) -> anyhow::Result<PathBuf> {
    if !is_safe_id(id) {
        anyhow::bail!("invalid project id: {id}");
    }
    Ok(sandbox_root()?.join(id))
}

/// Whitelist id characters. The frontend mints ids from
/// `Date.now().toString(36) + Math.random().toString(36).slice(2, 8)`
/// so all real ids are `[a-z0-9]+`; we still validate defensively so
/// a hand-edited localStorage migration can't smuggle path
/// separators or `..` segments through.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whitelist file paths within a project. Same defense-in-depth idea
/// as `is_safe_id` — the frontend never produces a malicious path on
/// its own, but we reject anything that could escape the project
/// folder (absolute paths, `..` traversal, NUL bytes, drive letters).
fn is_safe_relpath(path: &str) -> bool {
    if path.is_empty() || path.len() > 512 {
        return false;
    }
    if path.contains('\0') {
        return false;
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return false;
    }
    for comp in p.components() {
        use std::path::Component;
        match comp {
            Component::Normal(_) => {}
            // Anything else (RootDir, Prefix, ParentDir, CurDir) is
            // rejected — those are how an attacker would climb out of
            // the project sandbox.
            _ => return false,
        }
    }
    true
}

// ── Metadata sidecar ─────────────────────────────────────────────

const META_FILENAME: &str = ".libre-sandbox.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    /// LanguageId enum on the frontend; passed through as a plain
    /// string here so we don't have to mirror the enum.
    pub language: String,
    /// ISO timestamps. Frontend mints them — Rust treats them as
    /// opaque strings.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    /// Relative path within the project folder (e.g. `main.rs`,
    /// `src/lib.rs`, `index.html`). Forward slashes on every
    /// platform — Rust's `Path` joins handle the conversion.
    pub name: String,
    /// Monaco language id for the file. Pass-through string; the
    /// frontend's `FileLanguage` union enumerates the valid values.
    pub language: String,
    pub content: String,
    /// Mirrors the WorkbenchFile field of the same name. When true
    /// the editor disables write affordances; we still write the
    /// file to disk normally (it's the frontend's policy, not a
    /// filesystem-level lock).
    #[serde(default, rename = "readOnly", skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFull {
    #[serde(flatten)]
    pub meta: ProjectMeta,
    pub files: Vec<ProjectFile>,
}

// ── Commands: project CRUD ───────────────────────────────────────

/// List every project on disk. Returns metadata only — file contents
/// are loaded lazily via `sandbox_load_project` when the user
/// actually switches into one. Keeps the initial load cheap even on
/// users with dozens of sandboxes.
#[tauri::command]
pub fn sandbox_list_projects() -> Result<Vec<ProjectMeta>, String> {
    let root = sandbox_root().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(it) => it,
        // Empty root is fine — return empty list rather than an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("read sandbox root: {e}")),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join(META_FILENAME);
        let Ok(raw) = fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<ProjectMeta>(&raw) else {
            continue;
        };
        out.push(meta);
    }
    // Stable listing order — sort by updatedAt descending so the
    // most-recently-touched project sits at the top. Falls back to
    // name when timestamps tie (e.g. two projects migrated from the
    // same legacy entry).
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn sandbox_load_project(id: String) -> Result<ProjectFull, String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    let meta_path = dir.join(META_FILENAME);
    let raw = fs::read_to_string(&meta_path)
        .map_err(|e| format!("read metadata for {id}: {e}"))?;
    let meta: ProjectMeta = serde_json::from_str(&raw)
        .map_err(|e| format!("parse metadata for {id}: {e}"))?;
    let mut files = Vec::new();
    collect_files(&dir, &dir, &mut files).map_err(|e| e.to_string())?;
    Ok(ProjectFull { meta, files })
}

/// Walk `dir` recursively, appending every file (other than the
/// metadata sidecar + the `.git/` worktree) as a ProjectFile. The
/// file's `language` defaults to the extension-derived hint —
/// callers normalise this on the JS side, so any reasonable value
/// is fine.
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip the metadata sidecar (not a workbench file) and any
        // dotfiles that aren't part of the project (notably `.git`).
        // We DON'T skip every dotfile because users can legitimately
        // have `.env`, `.gitignore`, etc. in their project — only
        // the metadata + git internals are filtered.
        if name_str == META_FILENAME {
            continue;
        }
        if path.is_dir() {
            if name_str == ".git" || name_str == "node_modules" || name_str == "target" {
                // Tool-managed directories — skip recursively. The
                // editor never wants to load these into the tree; on
                // a fresh `cargo new` Rust project, `target/` alone
                // can be hundreds of MB.
                continue;
            }
            collect_files(root, &path, out)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root)?
            .to_string_lossy()
            // Normalise to forward slashes for the frontend; Windows
            // would otherwise return `src\main.rs`.
            .replace('\\', "/");
        let content = match fs::read_to_string(&path) {
            Ok(s) => s,
            // Binary files (images, etc.) can't be UTF-8-decoded.
            // Skip them rather than failing the whole load — the
            // editor wouldn't render them anyway.
            Err(_) => continue,
        };
        let language = guess_language(&rel);
        out.push(ProjectFile {
            name: rel,
            language,
            content,
            read_only: None,
        });
    }
    Ok(())
}

fn guess_language(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "jsx" => "javascript",
        "tsx" => "typescript",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "swift" => "swift",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "sol" => "solidity",
        "vy" => "vyper",
        "svelte" => "svelte",
        "html" | "htm" => "html",
        "css" => "css",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" => "shell",
        _ => "plaintext",
    }
    .to_string()
}

#[tauri::command]
pub fn sandbox_save_project(project: ProjectFull) -> Result<(), String> {
    let dir = project_dir(&project.meta.id).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("create project dir: {e}"))?;

    // Build the set of expected file paths so we can prune deletes
    // — any file currently on disk that isn't in the new set gets
    // removed. (Without this, deleting a file in the editor would
    // leave the stale copy on disk.)
    let mut expected: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for f in &project.files {
        if !is_safe_relpath(&f.name) {
            return Err(format!("unsafe file path: {}", f.name));
        }
        let abs = dir.join(&f.name);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create parent for {}: {e}", f.name))?;
        }
        fs::write(&abs, &f.content)
            .map_err(|e| format!("write {}: {e}", f.name))?;
        expected.insert(abs);
    }
    prune_stale(&dir, &dir, &expected).map_err(|e| e.to_string())?;

    // Write metadata last so an incomplete save still leaves a
    // recoverable project (file contents present; metadata is the
    // index, written atomically at the end).
    let meta_path = dir.join(META_FILENAME);
    let serialized = serde_json::to_string_pretty(&project.meta)
        .map_err(|e| format!("serialize metadata: {e}"))?;
    fs::write(&meta_path, serialized).map_err(|e| format!("write metadata: {e}"))?;
    Ok(())
}

fn prune_stale(
    root: &Path,
    dir: &Path,
    expected: &std::collections::HashSet<PathBuf>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == META_FILENAME {
            continue;
        }
        if path.is_dir() {
            // Skip tool dirs the same way `collect_files` does — we
            // don't own those.
            if name_str == ".git" || name_str == "node_modules" || name_str == "target" {
                continue;
            }
            prune_stale(root, &path, expected)?;
            // Remove empty intermediate folders after pruning. This
            // keeps the tree tidy when a user deletes the last file
            // out of a subfolder.
            if fs::read_dir(&path)?.next().is_none() {
                let _ = fs::remove_dir(&path);
            }
            continue;
        }
        if !expected.contains(&path) {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn sandbox_delete_project(id: String) -> Result<(), String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("remove project dir: {e}"))?;
    Ok(())
}

// ── Commands: git ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct GitFileStatus {
    pub path: String,
    /// Porcelain XY status code — first char is the index state,
    /// second is the worktree state. Examples:
    ///   "??"  — untracked
    ///   "A "  — added (staged)
    ///   " M"  — modified (unstaged)
    ///   "M "  — modified + staged
    ///   "MM"  — modified, then modified again after staging
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    /// `true` when the project directory contains a `.git/` folder.
    /// Frontend keys the "Init repo" CTA off this — when false, the
    /// sidebar shows the init button; when true it shows the status
    /// + commit panel.
    pub has_repo: bool,
    /// Current branch name. Empty string when the repo has no
    /// commits yet (HEAD is unborn) — `git rev-parse --abbrev-ref
    /// HEAD` returns "HEAD" in that state, which we normalize.
    pub branch: String,
    /// Parsed lines from `git status --porcelain`.
    pub files: Vec<GitFileStatus>,
}

fn run_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "`git` not found on PATH. Install Git to use sandbox version control.".to_string()
            }
            _ => format!("launch git: {e}"),
        })
}

#[tauri::command]
pub fn sandbox_git_status(id: String) -> Result<GitStatus, String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    if !dir.exists() {
        return Err(format!("project not found: {id}"));
    }
    let has_repo = dir.join(".git").exists();
    if !has_repo {
        return Ok(GitStatus {
            has_repo: false,
            branch: String::new(),
            files: Vec::new(),
        });
    }

    // Branch name. `--abbrev-ref HEAD` returns "HEAD" on an unborn
    // branch (no commits yet); we normalise that to empty so the
    // frontend can pick between "main" (assumed default before any
    // commit) and the real name once a commit lands.
    let branch_out = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = if branch_out.status.success() {
        let s = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
        if s == "HEAD" { String::new() } else { s }
    } else {
        String::new()
    };

    // Porcelain status. `-z` would give us NUL-separated entries
    // (safer for paths with spaces / newlines), but the regular
    // line-oriented output is easier to parse and our sandbox paths
    // don't contain newlines.
    let status_out = run_git(&dir, &["status", "--porcelain"])?;
    if !status_out.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&status_out.stderr)
        ));
    }
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&status_out.stdout).lines() {
        if line.len() < 3 {
            continue;
        }
        let status = line[..2].to_string();
        let path = line[3..].to_string();
        files.push(GitFileStatus { path, status });
    }

    Ok(GitStatus {
        has_repo: true,
        branch,
        files,
    })
}

#[tauri::command]
pub fn sandbox_git_init(id: String) -> Result<(), String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    if !dir.exists() {
        return Err(format!("project not found: {id}"));
    }
    // -b main → set the initial branch to `main` rather than the
    // global git default (which is still `master` on stock Git
    // installs from 2020 and earlier). Matches what every modern
    // host (GitHub / GitLab / Codeberg) defaults to.
    let out = run_git(&dir, &["init", "-b", "main"])?;
    if !out.status.success() {
        return Err(format!(
            "git init failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn sandbox_git_add_all(id: String) -> Result<(), String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    // -A → stage every change including deletes. Skipped the
    // pathspec form because Phase 3's commit flow is a "stage
    // everything + commit" one-button affordance; per-file staging
    // is a Phase 4 follow-up.
    let out = run_git(&dir, &["add", "-A"])?;
    if !out.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct CommitInput {
    pub id: String,
    pub message: String,
    /// Optional author override. When None, git uses its global
    /// `user.name` / `user.email` config. Sandbox commits don't
    /// usually want a custom author — this is here for future
    /// "commit as <signed-in libre.academy user>" flows.
    pub author_name: Option<String>,
    pub author_email: Option<String>,
}

#[tauri::command]
pub fn sandbox_git_commit(input: CommitInput) -> Result<String, String> {
    let dir = project_dir(&input.id).map_err(|e| e.to_string())?;
    let message = input.message.trim();
    if message.is_empty() {
        return Err("commit message is required".to_string());
    }

    // Stage everything first — the Phase 3 commit UI is a single
    // "Commit changes" button, so staging + committing happen as
    // one atomic action. Phase 4 will add a per-file staging panel
    // and split these back out.
    let add_out = run_git(&dir, &["add", "-A"])?;
    if !add_out.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&add_out.stderr)
        ));
    }

    let mut args = vec!["commit", "-m", message];
    let author = match (&input.author_name, &input.author_email) {
        (Some(n), Some(e)) => Some(format!("{n} <{e}>")),
        _ => None,
    };
    if let Some(a) = author.as_deref() {
        args.push("--author");
        args.push(a);
    }

    let out = run_git(&dir, &args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Friendlier message for the "no identity configured" case
        // — `git commit` errors with a multi-line stderr explaining
        // how to run `git config --global user.email`. The frontend
        // surfaces stderr verbatim, so a short prefix helps.
        if stderr.contains("Please tell me who you are") {
            return Err(format!(
                "git is not configured with a user identity. Run `git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com` then retry."
            ));
        }
        return Err(format!("git commit failed: {stderr}"));
    }

    // Resolve the new commit's short hash to feed back to the
    // frontend (the commit panel echoes it as a tag next to the
    // most recent commit row).
    let hash_out = run_git(&dir, &["rev-parse", "--short", "HEAD"])?;
    let hash = String::from_utf8_lossy(&hash_out.stdout).trim().to_string();
    Ok(hash)
}

#[derive(Debug, Clone, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// Unix timestamp (seconds), serialised as a number so the
    /// frontend can format it with `Intl.DateTimeFormat` without
    /// parsing a date string.
    pub timestamp: i64,
}

#[tauri::command]
pub fn sandbox_git_log(id: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    if !dir.join(".git").exists() {
        return Ok(Vec::new());
    }
    // Custom format with a unit-separator delimiter so we can split
    // safely without worrying about commit-message content. `%x1f`
    // is the ASCII US character — extremely unlikely to appear in a
    // real subject line.
    let limit_str = format!("-n{}", limit.unwrap_or(50).min(500));
    let format = "--pretty=format:%H%x1f%s%x1f%an%x1f%at";
    let out = run_git(&dir, &["log", &limit_str, format])?;
    if !out.status.success() {
        // An unborn branch (no commits yet) errors with exit 128 and
        // a "bad revision HEAD" message — that's not a real error,
        // just "log is empty". Return empty list rather than
        // propagating.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("does not have any commits yet")
            || stderr.contains("bad default revision")
            || stderr.contains("unknown revision")
        {
            return Ok(Vec::new());
        }
        return Err(format!("git log failed: {stderr}"));
    }
    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() != 4 {
            continue;
        }
        let timestamp = parts[3].parse::<i64>().unwrap_or(0);
        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            subject: parts[1].to_string(),
            author: parts[2].to_string(),
            timestamp,
        });
    }
    Ok(entries)
}

/// Open the project folder in the user's default file browser
/// (Finder / Explorer / Nautilus). Frontend uses this for the "open
/// in Finder" affordance in the sidebar so a learner can quickly
/// poke around the on-disk layout.
#[tauri::command]
pub fn sandbox_reveal_project(id: String) -> Result<(), String> {
    let dir = project_dir(&id).map_err(|e| e.to_string())?;
    if !dir.exists() {
        return Err(format!("project not found: {id}"));
    }
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let res = Command::new("explorer").arg(&path).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let res = Command::new("xdg-open").arg(&path).status();
    match res {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("open file manager: {e}")),
    }
}

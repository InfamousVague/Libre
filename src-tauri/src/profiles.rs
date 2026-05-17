//! Local profiles with isolated data directories.
//!
//! Until now all on-device data (courses, progress.sqlite, sandbox
//! projects, settings, caches) lived in one shared pool keyed off
//! nothing. This module introduces named profiles, each with its own
//! data root, so projects / books / progress / settings are
//! account-specific.
//!
//! ## Layout
//!
//! - Registry (GLOBAL, not profile-scoped): `<app_data>/profiles.json`
//!   — the list of profiles + which one is active. This is the one
//!   file that must stay outside any profile so we know where to
//!   look on launch.
//! - Per-profile app data: `<app_data>/profiles/<id>/…` — every
//!   builder that used to join onto `app_data_dir()` now joins onto
//!   this instead (courses/, progress.sqlite, settings.json,
//!   ingest-cache/, sveltekit-*).
//! - Per-profile sandbox: `<Documents>/Libre Sandbox/<id>/…`.
//!
//! ## Active-id source of truth
//!
//! The active profile id is held in a process-global `RwLock<String>`
//! (`ACTIVE`). It's a global rather than only Tauri-managed state
//! because `sandbox.rs::sandbox_root()` resolves a path with no
//! `AppHandle` in scope — a global lets every path builder, with or
//! without an `AppHandle`, agree on the same active id. `switch_*`
//! updates the global AND persists the registry atomically.
//!
//! ## Migration
//!
//! On the first launch after this lands, if there's no registry yet
//! we create one with a `default` profile and move any pre-existing
//! single-pool data into `profiles/default/` (and the loose sandbox
//! projects into `Libre Sandbox/default/`). Old installs keep all
//! their data; it just becomes the Default profile.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::progress_db::ProgressDb;
use crate::settings::SettingsState;

/// Reserved id of the always-present first profile that legacy /
/// single-pool data migrates into.
pub const DEFAULT_ID: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMeta {
    pub id: String,
    pub name: String,
    /// Unix ms.
    pub created_at: i64,
    /// Optional bound cloud account id (the hybrid model: a profile
    /// MAY link to a cloud account for sync). `None` = local-only.
    #[serde(default)]
    pub cloud_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    pub active: String,
    pub profiles: Vec<ProfileMeta>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            active: DEFAULT_ID.to_string(),
            profiles: vec![ProfileMeta {
                id: DEFAULT_ID.to_string(),
                name: "Default".to_string(),
                created_at: now_ms(),
                cloud_account_id: None,
            }],
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Process-global active profile id. Set once in `init`, swapped by
/// `switch_profile`. Readable from any path builder including ones
/// with no `AppHandle`.
static ACTIVE: OnceLock<RwLock<String>> = OnceLock::new();

fn active_cell() -> &'static RwLock<String> {
    ACTIVE.get_or_init(|| RwLock::new(DEFAULT_ID.to_string()))
}

/// The active profile id. Cheap (read lock). Never panics — a
/// poisoned lock falls back to `default` rather than aborting a path
/// resolution mid-IO.
pub fn active_id() -> String {
    active_cell()
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| DEFAULT_ID.to_string())
}

fn set_active_global(id: &str) {
    if let Ok(mut g) = active_cell().write() {
        *g = id.to_string();
    }
}

/// Id charset guard. Ids are minted by `slugify` below (lowercase
/// alphanumerics + `-`), never user-typed directly, but every path
/// builder joins the id onto a root so we validate defensively to
/// keep a hand-edited registry from smuggling `../` traversal into a
/// data path.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            s.push(ch);
            prev_dash = false;
        } else if !prev_dash && !s.is_empty() {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "profile".to_string()
    } else {
        s.chars().take(40).collect()
    }
}

// ── Paths ────────────────────────────────────────────────────────

/// Global registry file — NOT inside any profile.
fn registry_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("profiles.json"))
}

/// The active profile's app-data root: `<app_data>/profiles/<id>`.
/// Every former `app_data_dir().join("courses"|"progress.sqlite"|…)`
/// builder now routes through here.
pub fn profile_app_root(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    let id = active_id();
    let root = base.join("profiles").join(&id);
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// The active profile's sandbox-projects root under Documents:
/// `<Documents>/Libre Sandbox/<id>`. `docs_base` is whatever
/// `sandbox.rs` already resolved (Documents or home fallback).
pub fn sandbox_profile_root(docs_base: &Path) -> PathBuf {
    docs_base.join("Libre Sandbox").join(active_id())
}

// ── Registry I/O ─────────────────────────────────────────────────

fn load_registry(app: &tauri::AppHandle) -> anyhow::Result<Registry> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(Registry::default());
    }
    let raw = fs::read_to_string(&path)?;
    let mut reg: Registry = serde_json::from_str(&raw)?;
    // Defensive: never trust the persisted active pointer to name a
    // profile that still exists, and never let it be an unsafe id.
    if reg.profiles.is_empty() {
        reg = Registry::default();
    }
    if !reg.profiles.iter().any(|p| p.id == reg.active) {
        reg.active = reg.profiles[0].id.clone();
    }
    Ok(reg)
}

fn save_registry(app: &tauri::AppHandle, reg: &Registry) -> anyhow::Result<()> {
    let path = registry_path(app)?;
    fs::write(&path, serde_json::to_vec_pretty(reg)?)?;
    Ok(())
}

// ── Migration ────────────────────────────────────────────────────

/// Move a file or directory, preferring a fast rename and falling
/// back to recursive copy + delete across volumes. No-op if `from`
/// doesn't exist.
fn move_path(from: &Path, to: &Path) -> anyhow::Result<()> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Cross-device or other rename failure → copy then remove.
    if from.is_dir() {
        copy_dir_all(from, to)?;
        fs::remove_dir_all(from)?;
    } else {
        fs::copy(from, to)?;
        fs::remove_file(from)?;
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// One-time migration of pre-profile single-pool data into
/// `profiles/default/`. Runs only when the registry is being created
/// for the first time. Idempotent-safe: each `move_path` no-ops if
/// the source is already gone.
fn migrate_legacy_into_default(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    let dst = base.join("profiles").join(DEFAULT_ID);
    fs::create_dir_all(&dst)?;

    // App-data items that used to sit directly under app_data_dir.
    // progress.sqlite is moved WITH its WAL sidecars — moving only
    // the main file while a `-wal` exists risks losing the last
    // committed pages (WAL mode is on).
    for name in [
        "courses",
        "progress.sqlite",
        "progress.sqlite-wal",
        "progress.sqlite-shm",
        "seeded-packs.json",
        "settings.json",
        "ingest-cache",
        "sveltekit-runs",
        "sveltekit-npm-cache",
    ] {
        let from = base.join(name);
        if from.exists() {
            move_path(&from, &dst.join(name))?;
        }
    }

    // Loose sandbox projects: `<Documents>/Libre Sandbox/<proj>/` →
    // `<Documents>/Libre Sandbox/default/<proj>/`. Move every child
    // that isn't already the `default` bucket.
    if let Some(docs) = dirs::document_dir().or_else(dirs::home_dir) {
        let sb = docs.join("Libre Sandbox");
        if sb.is_dir() {
            let default_bucket = sb.join(DEFAULT_ID);
            fs::create_dir_all(&default_bucket)?;
            if let Ok(rd) = fs::read_dir(&sb) {
                for entry in rd.flatten() {
                    let name = entry.file_name();
                    if name == std::ffi::OsStr::new(DEFAULT_ID) {
                        continue;
                    }
                    move_path(&entry.path(), &default_bucket.join(name))?;
                }
            }
        }
    }
    Ok(())
}

// ── Lifecycle ────────────────────────────────────────────────────

/// Called once from `setup()` BEFORE the ProgressDb / SettingsState
/// are opened, so those open against the (possibly just-migrated)
/// active profile's paths. Creates + persists a registry on first
/// run, runs the legacy migration, and seeds the global ACTIVE id.
pub fn init(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let path = registry_path(app)?;
    let first_run = !path.exists();
    let reg = if first_run {
        let reg = Registry::default();
        migrate_legacy_into_default(app)?;
        save_registry(app, &reg)?;
        reg
    } else {
        load_registry(app)?
    };
    set_active_global(&reg.active);
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn list_profiles(app: tauri::AppHandle) -> Result<Registry, String> {
    load_registry(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_profile() -> String {
    active_id()
}

#[tauri::command]
pub fn create_profile(
    app: tauri::AppHandle,
    name: String,
) -> Result<ProfileMeta, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("profile name required".into());
    }
    let mut reg = load_registry(&app).map_err(|e| e.to_string())?;
    // Derive a unique, safe id from the name.
    let base = slugify(trimmed);
    let mut id = base.clone();
    let mut n = 2;
    while reg.profiles.iter().any(|p| p.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    if !is_safe_id(&id) {
        return Err("could not derive a safe profile id".into());
    }
    let meta = ProfileMeta {
        id,
        name: trimmed.to_string(),
        created_at: now_ms(),
        cloud_account_id: None,
    };
    reg.profiles.push(meta.clone());
    save_registry(&app, &reg).map_err(|e| e.to_string())?;
    // The new profile's data root is created lazily on first switch
    // (seed runs then). Nothing to do on disk here.
    Ok(meta)
}

#[tauri::command]
pub fn rename_profile(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("profile name required".into());
    }
    let mut reg = load_registry(&app).map_err(|e| e.to_string())?;
    let Some(p) = reg.profiles.iter_mut().find(|p| p.id == id) else {
        return Err(format!("unknown profile: {id}"));
    };
    p.name = trimmed.to_string();
    save_registry(&app, &reg).map_err(|e| e.to_string())
}

/// Optionally bind/unbind a cloud account to a profile (hybrid
/// model). Pass `None` to unbind. Frontend calls this after a
/// successful cloud sign-in within a profile.
#[tauri::command]
pub fn set_profile_cloud_account(
    app: tauri::AppHandle,
    id: String,
    cloud_account_id: Option<String>,
) -> Result<(), String> {
    let mut reg = load_registry(&app).map_err(|e| e.to_string())?;
    let Some(p) = reg.profiles.iter_mut().find(|p| p.id == id) else {
        return Err(format!("unknown profile: {id}"));
    };
    p.cloud_account_id = cloud_account_id;
    save_registry(&app, &reg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile(
    app: tauri::AppHandle,
    id: String,
    db: State<'_, ProgressDb>,
    settings: State<'_, SettingsState>,
) -> Result<String, String> {
    if id == DEFAULT_ID {
        return Err("the Default profile cannot be deleted".into());
    }
    let mut reg = load_registry(&app).map_err(|e| e.to_string())?;
    if !reg.profiles.iter().any(|p| p.id == id) {
        return Err(format!("unknown profile: {id}"));
    }
    reg.profiles.retain(|p| p.id != id);
    let switched = reg.active == id;
    if switched {
        reg.active = DEFAULT_ID.to_string();
    }
    save_registry(&app, &reg).map_err(|e| e.to_string())?;

    // Best-effort wipe of the deleted profile's data on disk. We do
    // this AFTER the registry no longer references it so a crash
    // mid-delete can't strand a half-registered profile.
    if let Ok(base) = app.path().app_data_dir() {
        let _ = fs::remove_dir_all(base.join("profiles").join(&id));
    }
    if let Some(docs) = dirs::document_dir().or_else(dirs::home_dir) {
        let _ = fs::remove_dir_all(docs.join("Libre Sandbox").join(&id));
    }

    // If we just deleted the active profile, fall back to Default —
    // same re-point work `switch_profile` does.
    if switched {
        apply_active(&app, DEFAULT_ID, &db, &settings)?;
    }
    Ok(reg.active.clone())
}

#[tauri::command]
pub fn switch_profile(
    app: tauri::AppHandle,
    id: String,
    db: State<'_, ProgressDb>,
    settings: State<'_, SettingsState>,
) -> Result<(), String> {
    let mut reg = load_registry(&app).map_err(|e| e.to_string())?;
    if !reg.profiles.iter().any(|p| p.id == id) {
        return Err(format!("unknown profile: {id}"));
    }
    if reg.active == id {
        return Ok(());
    }
    reg.active = id.clone();
    save_registry(&app, &reg).map_err(|e| e.to_string())?;
    apply_active(&app, &id, &db, &settings)
}

/// Re-point every process-global / managed-state handle at the given
/// profile. Order matters: flip the global id FIRST so the path
/// builders inside `reopen` / `ensure_seed` resolve to the new
/// profile, then reopen the SQLite connection, reload settings, and
/// seed the new profile's bundled courses if it's brand new.
fn apply_active(
    app: &tauri::AppHandle,
    id: &str,
    db: &ProgressDb,
    settings: &SettingsState,
) -> Result<(), String> {
    if !is_safe_id(id) {
        return Err(format!("unsafe profile id: {id}"));
    }
    set_active_global(id);

    let db_path = crate::progress_db::resolve_path(app).map_err(|e| e.to_string())?;
    db.reopen(db_path).map_err(|e| e.to_string())?;

    crate::settings::reload_into(settings, app).map_err(|e| e.to_string())?;

    // A freshly-created profile has no courses dir yet — seed the
    // bundled packs so it isn't an empty library.
    crate::courses::ensure_seed(app).map_err(|e| e.to_string())?;
    Ok(())
}

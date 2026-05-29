//! User settings stored in <app_data_dir>/settings.json, mirrored in memory
//! as a tauri-managed state so command handlers (particularly the LLM ingest)
//! can read the API key without re-opening the file on every call.

use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub anthropic_api_key: Option<String>,
    /// Which Claude model to use for the ingest pipeline. Kept as a free-form
    /// string so we can try new models without a schema change. Default is
    /// the balanced choice; users can trade cost for quality in Settings.
    pub anthropic_model: String,
    /// OpenAI API key — used for cover-art generation via `gpt-image-1`.
    /// Separate from `anthropic_api_key` because Anthropic doesn't offer
    /// image generation. None means "AI cover art is unavailable"; the
    /// frontend hides / disables the button in that case.
    pub openai_api_key: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            anthropic_api_key: None,
            anthropic_model: "claude-sonnet-4-8".to_string(),
            openai_api_key: None,
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    // Profile-scoped (per-profile AI keys / model): the active
    // profile's settings.json. `profile_app_root` create_dir_all's
    // the profile dir.
    let dir = crate::profiles::profile_app_root(app)?;
    Ok(dir.join("settings.json"))
}

/// Read settings.json from disk. Used at setup to hydrate
/// SettingsState and again by `reload_into` on a profile switch.
pub fn read_from_disk(app: &tauri::AppHandle) -> anyhow::Result<Settings> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path)?;
    let mut settings: Settings = serde_json::from_str(&raw)?;
    migrate_model(&mut settings.anthropic_model);
    Ok(settings)
}

/// In-place migration for the persisted `anthropic_model`. Without
/// this, a user who saved a settings.json back when the default was
/// `claude-sonnet-4-5` stays pinned to the 4.5 generation forever —
/// bumping the in-code default only helps fresh installs. The
/// generation suffix is a mechanical `-4-5` → `-4-8` swap; the bare
/// tier aliases (`claude-sonnet-4-8` etc.) resolve to the latest
/// snapshot at the API. Any model string we don't recognise (a
/// hand-edited custom pin) is left untouched.
fn migrate_model(model: &mut String) {
    const UPGRADES: &[(&str, &str)] = &[
        ("claude-sonnet-4-5", "claude-sonnet-4-8"),
        ("claude-opus-4-5", "claude-opus-4-8"),
        ("claude-haiku-4-5", "claude-haiku-4-8"),
    ];
    for (old, new) in UPGRADES {
        if model == old {
            *model = (*new).to_string();
            return;
        }
    }
}

/// Replace the in-memory settings with the active profile's
/// settings.json. Called by `profiles::switch_profile` so per-profile
/// API keys / model take effect without a restart. A missing file
/// (brand-new profile) resets to defaults rather than carrying the
/// previous profile's keys over.
pub fn reload_into(
    state: &SettingsState,
    app: &tauri::AppHandle,
) -> anyhow::Result<()> {
    let next = read_from_disk(app).unwrap_or_default();
    *state.0.lock() = next;
    Ok(())
}

#[tauri::command]
pub fn load_settings(state: State<'_, SettingsState>) -> Settings {
    state.0.lock().clone()
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    let path = settings_path(&app).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    *state.0.lock() = settings;
    Ok(())
}

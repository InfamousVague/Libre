//! Course loading + import/export.
//!
//! At rest, a course is a folder in `<app_data_dir>/courses/<course-id>/` with
//! a `course.json` at its root:
//!
//! ```json
//! { "id": "rust-book", "title": "...", "language": "rust",
//!   "chapters": [ { "id":"...", "title":"...", "lessons":[ ... ] } ] }
//! ```
//!
//! Lessons are inlined in the JSON for V1 (no separate .md files yet). A
//! future step will split prose out into sibling .md files.
//!
//! Share/export uses a `.academy` archive — a zip of the course folder.
//! `.libre` (the previous name) and `.kata` (the original Tauri-era
//! name before the Libre → Libre rebrand) are still accepted on
//! import for backwards compatibility with archives shipped or
//! exported by older builds.
//! Import unpacks the archive into `<app_data_dir>/courses/<course-id>/`.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::progress_db::ProgressDb;

/// Matches the shape of the frontend Course type in `src/data/types.ts`. We
/// pass-through as serde_json::Value so the Rust side doesn't need to mirror
/// every lesson-kind discriminator — if the frontend's types evolve, we don't
/// need to re-deploy the native side.
pub type CourseJson = serde_json::Value;

/// Resolve the directories we scan for courses. Currently just the app data
/// dir's `courses/` folder; bundled defaults are copied here on first launch.
pub fn courses_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    // Profile-scoped: <app_data>/profiles/<active>/courses. Each
    // profile has its own installed-books library. Bundled packs
    // (the read-only seed source under resource_dir) stay global and
    // are re-seeded into each profile by `ensure_seed`.
    let dir = crate::profiles::profile_app_root(app)?;
    let courses = dir.join("courses");
    fs::create_dir_all(&courses)?;
    Ok(courses)
}

/// Bump this when the bundled-packs content changes meaningfully (new
/// lessons added, drill stacks authored, lesson bodies refreshed) and
/// you want EXISTING installs to pick up the updates on their next
/// launch without an uninstall. The persisted seed_version in
/// `seeded-packs.json` is compared to this constant; if it's lower,
/// every pack the user still has installed gets RE-EXTRACTED from the
/// bundled archive (course.json overwritten, cover.png refreshed).
/// User-deleted packs (tracked by id in `seed_ids`) stay deleted.
///
/// The first launch after a bump prints a one-line refresh message;
/// subsequent launches are no-ops as before.
///
/// History:
///   1 — Initial. Adds the version concept itself; refreshes existing
///       installs so they pick up the 147 micropuzzle drills (792
///       cards) added across 11 tutorial courses.
///   2 — Library promotion. The dev's local library was zipped over
///       the previous bundled-packs (`scripts/promote-library-to-bundle.mjs`)
///       to ship 18 newly-imported books (Eloquent JS, Rust Book,
///       Python Crash Course, Mastering Bitcoin/Ethereum/Lightning,
///       Solana Programs, Solidity Complete, Vyper, Viem/Ethers, Three.js,
///       React Native, Fluent React, Svelte tutorial, Cryptography
///       Fundamentals, JavaScript The Definitive Guide, Learning Go,
///       Learning React Native) plus refreshed challenge packs. Existing
///       installs re-extract on next launch.
///   3 — Library retirement. Drops four books that shipped in earlier
///       bundles but were retired (`bun-complete`, `bun-fundamentals`,
///       `svelte-5-complete`, `javascript-crash-course`). Existing
///       desktop / mobile installs that still have these on disk get
///       them removed on next launch. Mirrors the web seeder's V6
///       LEGACY_STARTER_IDS prune (Apps/Libre/src/data/webSeedCourses.ts)
///       so all three platforms drop the same retirees in lockstep.
/// V9 — Library curation: introduces `should_seed_pack` allow-list
/// (see below). On version bump, ensure_seed prunes any auto-seeded
/// pack whose filename no longer passes the filter, so existing dev
/// installs converge to the new "TRPL + Mastering Ethereum +
/// challenges" default. User-imported packs are preserved (only ids
/// in seed_ids get the prune).
// Bumped to 10 alongside the mobile-side `should_seed_pack` override
// (auto-installs every bundled pack on mobile so phones converge to
// the same shelf desktop has). Existing installs re-evaluate the
// per-pack filter on the next launch and pull in the expanded set.
//
// V11 — Re-extract every pack to pick up restored blocks data +
// the audio-driven section blocks (`splitMarkdownIntoSections` +
// `apply-blocks` pipeline). The bundled .libre archives were
// repacked from the desktop's installed library via
// `promote-library-to-bundle.mjs`, which runs after `apply-blocks
// --install` so each course.json carries blocks payloads. Existing
// iOS/desktop installs that were on V10 still have the blocks-free
// extracted copies on disk — bumping forces re-extraction so the
// "this exercise hasn't been authored for blocks mode yet" message
// stops appearing on every challenge.
const SEED_VERSION: u32 = 12;

/// Ids that previously shipped via `resources/bundled-packs/` but have
/// since been retired. On a SEED_VERSION bump, ensure_seed deletes
/// these from the user's courses dir if they're still present — same
/// migration story the web seeder has via LEGACY_STARTER_IDS, kept in
/// sync so a learner with installs on multiple platforms sees the
/// shelf converge to the current shipped set after one launch each.
///
/// Don't trim this list when adding new retirees; an install that's
/// been dormant since the very first version still needs the older
/// ids cleaned up on its next launch.
const RETIRED_PACK_IDS: &[&str] = &[
    // bun-complete, svelte-5-complete, learning-react-native and
    // solidity-smart-contracts-from-first-principles were briefly
    // retired but came back into the active catalog on 2026-05-10
    // (Discover-cache strays the team decided to keep + author
    // covers for). Keep them OUT of this list — anything here is
    // pruned wholesale on next launch.
    "bun-fundamentals",
    "javascript-crash-course",
    "challenges-reactnative-visual",
    // 2026-05-07 cleanup
    "eloquent-javascript",
    "the-modern-javascript-tutorial-fundamentals",
    "you-dont-know-js-yet",
    "you-don-t-know-js-yet",
    "python-crash-course",
    "crafting-interpreters-javascript",
    "crafting-interpreters-js",
    "fluent-react",
    "interactive-web-development-with-three-js-and-a-frame",
    // 2026-05-10 cleanup
    "programming-bitcoin",
    "javascript-the-definitive-guide",
    "introduction-to-computer-organization-arm",
    "functional-light-javascript",
    "functional-light-js",
    "learning-zig",
];

/// Course-archive file extensions, in priority order. `.academy` is
/// the canonical extension after the Libre → Libre rebrand;
/// `.libre` and `.kata` remain accepted for backwards compat with
/// older shipped archives + user exports. Used by every match arm
/// that sniffs the bundled-packs directory (here + ingest.rs +
/// diagnostics.rs).
pub const ARCHIVE_EXTS: &[&str] = &["academy", "libre", "kata"];

/// True when the given path's extension is one of our course-archive
/// extensions. Pass the result of `path.extension().and_then(|s|
/// s.to_str())` directly — the helper handles the `Option`.
pub fn is_archive_ext(ext: Option<&str>) -> bool {
    matches!(ext, Some(e) if ARCHIVE_EXTS.contains(&e))
}

/// Whether a course archive in `resources/bundled-packs/` should be
/// auto-seeded into a fresh install. The default library is small —
/// just two foundational books plus every challenge pack — and the
/// user discovers + installs everything else from the in-app catalog
/// browser (CatalogBrowser modal, served from
/// libre.academy/catalog/manifest.json).
///
/// In dev mode, `app.path().resource_dir()` resolves to the source
/// `src-tauri/resources/` directory, which contains every archive
/// we've ever shipped (60+ files). Without this filter, every dev
/// launch would seed the full catalog into a fresh install — wrong
/// for the curated default-library spec and wrong for matching
/// production behaviour during dev.
///
/// Files NOT matching this filter still ship in the build (they
/// exist on disk for the catalog), but only ids that pass get
/// auto-imported on first launch. Keep in lockstep with the
/// LEGACY_STARTER_IDS allow-list in src/data/webSeedCourses.ts so
/// desktop + web seed the same minimal default set.
#[cfg(not(mobile))]
fn should_seed_pack(filename: &str) -> bool {
    let stem = filename
        .trim_end_matches(".academy")
        .trim_end_matches(".libre")
        .trim_end_matches(".kata");
    matches!(
        stem,
        "the-rust-programming-language" | "mastering-ethereum"
    ) || stem.contains("challenge")
}

/// Mobile-build override. On phones we auto-install EVERY bundled
/// pack, not just the curated default set. Reasons:
///   1. The phone has no Discover / catalog browser today, so the
///      learner can't manually install a missing book the way they
///      can on desktop.
///   2. The desktop user almost always picks up the phone expecting
///      to read whatever's on their laptop's shelf. Without a sync
///      protocol that streams "what's installed on my other device,"
///      the next-best heuristic is "ship everything we have."
///   3. Storage on iOS is plentiful relative to a few hundred MB of
///      .libre archives; sync is more expensive than redundant
///      copies for our scale.
/// Retired pack ids still get filtered out via RETIRED_PACK_IDS in
/// the caller.
#[cfg(mobile)]
fn should_seed_pack(_filename: &str) -> bool {
    true
}

/// Import any `.libre` / `.kata` archives bundled under
/// `resources/bundled-packs/` into the user's courses dir on first launch.
/// Idempotent — never overwrites an existing course (unless SEED_VERSION
/// has bumped, see above), and records every id we've seeded into
/// `<app-data>/seeded-packs.json` so a user-deleted pack stays deleted
/// instead of getting resurrected on the next run.
///
/// This is the entry point that ships the default Rust / TypeScript / Go
/// challenge packs along with Libre. Drop a `.libre` (or legacy
/// `.kata`) file in `src-tauri/resources/bundled-packs/`, commit it, and
/// new installs pick it up automatically.
pub fn ensure_seed(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let resource_dir = match app.path().resource_dir() {
        Ok(p) => p.join("resources").join("bundled-packs"),
        Err(_) => return Ok(()), // no resource dir (rare) — nothing to seed
    };
    if !resource_dir.exists() {
        return Ok(()); // no bundled packs shipped in this build
    }

    let courses_root = courses_dir(app)?;
    let marker = marker_path(app)?;
    let mut packs = load_seeded_packs(&marker).unwrap_or_default();
    // Refresh-mode: when the persisted seed_version is older than the
    // current SEED_VERSION, we treat already-installed packs as
    // candidates for re-extract. User-deleted packs (in seed_ids but
    // not on disk) still stay deleted.
    let needs_refresh = packs.seed_version < SEED_VERSION;

    // Prune retired packs first. Only fires on a version bump so we
    // don't waste IO on every cold start. We delete the course dir
    // wholesale (course.json, cover.png, lesson assets) — progress
    // lives in progress.sqlite which we leave alone, so if a future
    // build ever resurrects a retired id the completion history is
    // still there. We DON'T add the retired id to seed_ids: with the
    // .libre already gone from bundled-packs/ it would never be
    // re-imported anyway, and leaving seed_ids untouched lets a
    // future bundle re-introduce the id without needing a marker
    // surgery.
    let mut pruned_this_run = 0u32;
    if needs_refresh {
        for retired in RETIRED_PACK_IDS {
            let dir = courses_root.join(retired);
            if !dir.exists() {
                continue;
            }
            match fs::remove_dir_all(&dir) {
                Ok(()) => {
                    pruned_this_run += 1;
                    // Drop the id from seed_ids if it's there so the
                    // marker doesn't carry around dead entries forever.
                    packs.seed_ids.retain(|id| id != retired);
                }
                Err(e) => {
                    eprintln!(
                        "[libre:seed] failed to prune retired pack {:?}: {}",
                        dir, e
                    );
                }
            }
        }

        // V9 prune: any auto-seeded pack whose source filename is
        // NOT in the should_seed_pack allow-list gets removed too.
        // Catches the long-tail of books that shipped via earlier
        // versions of the bundled-packs/ directory but are no
        // longer in the curated default seed (Eloquent JavaScript,
        // Composing Programs, Mastering Bitcoin, …). User-imported
        // ids (not in seed_ids) are untouched.
        let allowed_ids: std::collections::HashSet<String> = fs::read_dir(&resource_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_str()?.to_string();
                if !should_seed_pack(&name) {
                    return None;
                }
                peek_archive_id(&p).ok()
            })
            .collect();
        let to_prune: Vec<String> = packs
            .seed_ids
            .iter()
            .filter(|id| !allowed_ids.contains(id.as_str()))
            .cloned()
            .collect();
        for id in to_prune {
            let dir = courses_root.join(&id);
            if dir.exists() {
                match fs::remove_dir_all(&dir) {
                    Ok(()) => {
                        pruned_this_run += 1;
                    }
                    Err(e) => {
                        eprintln!(
                            "[libre:seed] failed to prune deseeded pack {:?}: {}",
                            dir, e
                        );
                    }
                }
            }
            packs.seed_ids.retain(|x| x != &id);
        }
    }

    let mut imported_this_run = 0u32;
    let mut refreshed_this_run = 0u32;
    for entry in fs::read_dir(&resource_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_archive_ext(path.extension().and_then(|s| s.to_str())) {
            continue;
        }

        // Allow-list filter (see should_seed_pack above). Files
        // outside the curated default set ship with the binary but
        // don't auto-seed; the user installs them from the catalog
        // browser when they want them.
        let filename = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !should_seed_pack(filename) {
            continue;
        }

        // Peek at the course id in the archive so we can decide BEFORE
        // doing any extraction work.
        let id = match peek_archive_id(&path) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[libre:seed] could not read id from {:?}: {}", path, e);
                continue;
            }
        };
        if id.is_empty() {
            continue;
        }

        let course_exists = courses_root.join(&id).join("course.json").exists();

        if course_exists {
            // Make sure the marker knows we've effectively seeded this id
            // so the user can delete it later and we won't re-import.
            if !packs.seed_ids.contains(&id) {
                packs.seed_ids.push(id.clone());
            }
            // Refresh path — we have an installed copy AND the
            // persisted seed_version is older than the current. Wipe
            // and re-extract so the user picks up new lessons / drills
            // / cover artwork without an uninstall. Progress lives in
            // progress.sqlite (separate file) so completions survive.
            if needs_refresh {
                if let Err(e) = unzip_to(&path, &courses_root) {
                    eprintln!(
                        "[libre:seed] refresh-extract failed for {:?}: {}",
                        path, e
                    );
                    continue;
                }
                refreshed_this_run += 1;
            }
            continue;
        }

        // User previously had it + deleted — respect that decision.
        if packs.seed_ids.contains(&id) {
            continue;
        }

        // Fresh seed — extract into the courses dir.
        if let Err(e) = unzip_to(&path, &courses_root) {
            eprintln!("[libre:seed] unzip failed for {:?}: {}", path, e);
            continue;
        }
        packs.seed_ids.push(id);
        imported_this_run += 1;
    }

    if imported_this_run > 0 {
        eprintln!(
            "[libre:seed] imported {} bundled pack(s) from {:?}",
            imported_this_run, resource_dir
        );
    }
    if refreshed_this_run > 0 {
        eprintln!(
            "[libre:seed] refreshed {} pack(s) (seed_version {} → {})",
            refreshed_this_run, packs.seed_version, SEED_VERSION
        );
    }
    if pruned_this_run > 0 {
        eprintln!(
            "[libre:seed] pruned {} retired pack(s) on seed_version bump",
            pruned_this_run
        );
    }
    // Always advance the persisted seed_version so the next launch
    // knows it's caught up. Even if zero packs needed refresh (e.g.
    // user deleted them all), we mark this version as applied so
    // we don't re-evaluate on every launch.
    packs.seed_version = SEED_VERSION;
    save_seeded_packs(&marker, &packs)?;
    Ok(())
}

/// `<app-data>/seeded-packs.json` — a flat `{ "seedIds": [...] }` JSON.
/// Tracks every pack id we've ever auto-imported on this machine. If the
/// user deletes one, we keep the id here forever so we never resurrect
/// it on a subsequent launch. Cheap + resilient — losing the file just
/// means we seed once more, which is still a no-op if the course dir
/// already has the pack.
fn marker_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    // Profile-scoped: pairs with the per-profile courses dir so a
    // new profile re-seeds bundled packs independently.
    let dir = crate::profiles::profile_app_root(app)?;
    Ok(dir.join("seeded-packs.json"))
}

/// On-disk shape of `<app-data>/seeded-packs.json`. The `seedVersion`
/// field was added later; older marker files (without it) deserialise
/// with `seed_version: 0` via `#[serde(default)]`, which is exactly
/// what we want — those installs get re-evaluated against the
/// current SEED_VERSION on the next launch and refreshed in place.
#[derive(Default, Serialize, Deserialize)]
struct SeededPacks {
    #[serde(default, rename = "seedIds")]
    seed_ids: Vec<String>,
    #[serde(default, rename = "seedVersion")]
    seed_version: u32,
}

fn load_seeded_packs(path: &Path) -> anyhow::Result<SeededPacks> {
    if !path.exists() {
        return Ok(SeededPacks::default());
    }
    let bytes = fs::read(path)?;
    let parsed: SeededPacks = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(parsed)
}

fn save_seeded_packs(path: &Path, packs: &SeededPacks) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec_pretty(packs)?;
    fs::write(path, bytes)?;
    Ok(())
}

/// Read ONLY the course id out of a .libre/.kata archive without
/// extracting anything. Used by the seed routine to decide whether to skip.
pub fn peek_archive_id(archive: &Path) -> anyhow::Result<String> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            let v: CourseJson = serde_json::from_str(&buf)?;
            return Ok(str_field(&v, "id"));
        }
    }
    anyhow::bail!("course.json not found in archive");
}

// ---- Commands ---------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CourseEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub language: String,
}

/// Wipe `<app-data>/seeded-packs.json` so `ensure_seed` re-imports
/// every bundled archive on the next launch. Used by the "Start fresh"
/// Settings action: the JS side calls `delete_course` for every
/// installed pack, which DOES remove the on-disk dirs — but the
/// marker file keeps each id in `seed_ids` so `ensure_seed` recognises
/// "user explicitly deleted this, don't resurrect" and skips re-import.
/// Without this command, "Start fresh" reset the user to zero courses
/// AND zero re-seeds the bundled set — the library came up empty.
///
/// Deleting the marker is the right granularity: it resets the
/// "what's been auto-seeded on this machine" tracker without
/// touching progress.sqlite (a separate file), so a learner who
/// re-installs after Start-fresh gets the bundled set back with
/// their progress history intact (already wiped separately by the
/// JS-side `clearAllCompletions`).
///
/// Idempotent: re-running when the marker doesn't exist is a no-op.
#[tauri::command]
pub fn reset_seed_marker(app: tauri::AppHandle) -> Result<(), String> {
    let marker = marker_path(&app).map_err(|e| e.to_string())?;
    if marker.exists() {
        fs::remove_file(&marker).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List every course the app can see. Returns a lightweight manifest entry,
/// not the full course body — the frontend calls `load_course(id)` to get
/// the details.
#[tauri::command]
pub fn list_courses(app: tauri::AppHandle) -> Result<Vec<CourseEntry>, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let course_json = path.join("course.json");
        if !course_json.exists() { continue; }
        match read_course_json(&course_json) {
            Ok(v) => out.push(CourseEntry {
                id: str_field(&v, "id"),
                path: path.to_string_lossy().into_owned(),
                title: str_field(&v, "title"),
                language: str_field(&v, "language"),
            }),
            Err(_) => continue,
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn load_course(app: tauri::AppHandle, course_id: String) -> Result<CourseJson, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_json = dir.join(&course_id).join("course.json");
    read_course_json(&course_json).map_err(|e| e.to_string())
}

/// Return EVERY course's JSON in one shot, but with the heavy per-lesson
/// bodies stripped out: `starter`, `solution`, `tests`, `files`,
/// `solutionFiles`, and prose/markdown/content fields are removed.
/// Chapter + lesson titles, ids, difficulty, topic, and kind are kept —
/// which is everything the library, sidebar, and progress UI need to
/// render.
///
/// Why this exists: a full library load used to fire N parallel
/// `load_course` IPCs, each shipping megabytes of JSON across the
/// bridge and deserialising on the webview's main thread. For a
/// realistic library (~24 courses, ~12 MB of JSON) the app sat hung
/// for 1-3 seconds on every launch. Stripping bodies cuts the payload
/// by ~75% and collapses N IPCs into 1. Lesson bodies are fetched
/// on-demand through the existing `load_course` when the learner
/// actually opens a lesson.
#[tauri::command]
pub fn list_courses_summary(app: tauri::AppHandle) -> Result<Vec<CourseJson>, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let course_json = path.join("course.json");
        if !course_json.exists() {
            continue;
        }
        match read_course_json(&course_json) {
            Ok(mut v) => {
                strip_lesson_bodies(&mut v);
                out.push(v);
            }
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// Write a course's full JSON to disk. Used by the frontend's seeder to
/// materialize built-in courses into the app data dir on first run, and
/// (later) by the ingest importer.
#[tauri::command]
pub fn save_course(app: tauri::AppHandle, course_id: String, body: CourseJson) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    fs::create_dir_all(&course_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    fs::write(course_dir.join("course.json"), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a course folder and all its progress rows.
#[tauri::command]
pub fn delete_course(
    app: tauri::AppHandle,
    db: State<'_, ProgressDb>,
    course_id: String,
) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    if course_dir.exists() {
        fs::remove_dir_all(&course_dir).map_err(|e| e.to_string())?;
    }
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute("DELETE FROM completions WHERE course_id = ?1", [&course_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Export a course as a `.libre` zip archive at the chosen destination path.
#[tauri::command]
pub fn export_course(
    app: tauri::AppHandle,
    course_id: String,
    destination: String,
) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    if !course_dir.is_dir() {
        return Err(format!("course '{course_id}' not found"));
    }
    zip_dir(&course_dir, Path::new(&destination)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Import a `.libre` / `.kata` archive, extracting it into
/// app_data_dir/courses/<id>/. The archive's course.json determines the id.
#[tauri::command]
pub fn import_course(app: tauri::AppHandle, archive_path: String) -> Result<String, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_id = unzip_to(&Path::new(&archive_path), &dir).map_err(|e| e.to_string())?;
    Ok(course_id)
}

/// One catalog entry — what the CatalogBrowser modal uses to render
/// a row. `local_path` lets the JS install handler call back into
/// `import_course` without needing a server fetch.
#[derive(Debug, Serialize)]
pub struct BundledCatalogEntry {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub language: String,
    pub pack_type: Option<String>,
    pub lesson_count: u32,
    pub size_bytes: u64,
    /// Filesystem path to the .libre archive in
    /// resources/bundled-packs/. The frontend passes this back to
    /// `import_course` to install without a network round-trip.
    pub local_path: String,
}

/// Read the FULL course.json out of a bundled `.libre` archive
/// without extracting anything else. Used by the per-course update
/// detection (`fetchBundledCourse` in courseSync.ts) so it compares
/// against the in-binary source of truth instead of the
/// possibly-stale `public/starter-courses/<id>.json` that the web
/// extractor produces on its own cadence.
///
/// Looks the archive up by FILENAME first (fast — a single stat),
/// falls back to scanning every archive's course.id when the
/// filename doesn't match the requested id (some packs ship with a
/// .libre name that differs from the inner id).
#[tauri::command]
pub fn read_bundled_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Option<CourseJson>, String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(p) => p.join("resources").join("bundled-packs"),
        Err(_) => return Ok(None),
    };
    if !resource_dir.exists() {
        return Ok(None);
    }
    // Fast path — filename matches the id.
    for ext in ARCHIVE_EXTS {
        let candidate = resource_dir.join(format!("{course_id}.{ext}"));
        if candidate.is_file() {
            if let Ok(course) = read_course_json_from_archive(&candidate) {
                return Ok(Some(course));
            }
        }
    }
    // Slow path — scan every archive's course.id.
    for entry in fs::read_dir(&resource_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_archive_ext(path.extension().and_then(|s| s.to_str())) {
            continue;
        }
        if let Ok(id) = peek_archive_id(&path) {
            if id == course_id {
                return Ok(read_course_json_from_archive(&path).ok());
            }
        }
    }
    Ok(None)
}

fn read_course_json_from_archive(archive: &Path) -> anyhow::Result<CourseJson> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            return Ok(serde_json::from_str(&buf)?);
        }
    }
    anyhow::bail!("course.json not found in archive");
}

/// Lists every `.libre` archive shipped under
/// `resources/bundled-packs/` along with peek-extracted metadata.
/// Powers the in-app CatalogBrowser on desktop — no server needed,
/// since the catalog IS the bundled archives. Web uses a fetched
/// manifest.json instead (see lib/catalog.ts).
///
/// ### Cross-platform layout robustness
///
/// Tauri 2 places `resources` in different absolute locations
/// per-OS, but ALWAYS preserves the relative subpath declared in
/// `tauri.conf.json`. So `resources/bundled-packs/foo.libre`
/// lands at `<resource_dir>/resources/bundled-packs/foo.libre`
/// on every platform — in theory.
///
/// In practice, Windows MSI packaging has historically been
/// finicky: some Tauri / WiX combinations strip a level of nesting,
/// or place all declared resources directly under `<resource_dir>`
/// without preserving the `resources/` parent. The Discover tab
/// being empty on Windows v0.1.7 / v0.1.8 traced to exactly this:
/// `read_dir(<resource_dir>/resources/bundled-packs)` returned
/// `NotFound`, the function bailed, the JS got `[]`.
///
/// The fix: try a SHORT LIST of known candidate paths, take the
/// first one with at least one `.libre` inside, and walk it.
/// Logs every attempt so future regressions show up loudly in
/// `journalctl`/Console.app/whatever Windows users send us.
#[tauri::command]
pub fn list_bundled_catalog_entries(
    app: tauri::AppHandle,
) -> Result<Vec<BundledCatalogEntry>, String> {
    let base = match app.path().resource_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[libre:catalog] resource_dir() failed: {}", e);
            return Ok(Vec::new());
        }
    };

    // Candidates in priority order. `<resource_dir>/resources/bundled-packs`
    // is the canonical layout; the rest are fallbacks for installers
    // that flatten the path.
    let candidates: Vec<std::path::PathBuf> = vec![
        base.join("resources").join("bundled-packs"),
        base.join("bundled-packs"),
        base.clone(),
    ];

    let mut chosen: Option<std::path::PathBuf> = None;
    for c in &candidates {
        if !c.exists() {
            eprintln!("[libre:catalog] candidate missing: {:?}", c);
            continue;
        }
        // Quick probe: does this dir contain any course archive at
        // all (.academy / .libre / .kata)? We don't want to
        // silently pick `base` (the resource_dir root) just because
        // it exists — only the dir that actually holds course
        // archives wins.
        let has_archives = match fs::read_dir(c) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .any(|e| is_archive_ext(e.path().extension().and_then(|s| s.to_str()))),
            Err(e) => {
                eprintln!("[libre:catalog] read_dir({:?}) failed: {}", c, e);
                false
            }
        };
        if has_archives {
            eprintln!("[libre:catalog] using {:?}", c);
            chosen = Some(c.clone());
            break;
        }
    }

    let bundled_dir = match chosen {
        Some(p) => p,
        None => {
            eprintln!(
                "[libre:catalog] no course archives found under any of: {:?}",
                candidates
            );
            return Ok(Vec::new());
        }
    };

    let mut out = Vec::new();
    let entries = match fs::read_dir(&bundled_dir) {
        Ok(rd) => rd,
        Err(e) => return Err(format!("read_dir({:?}): {}", bundled_dir, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_archive_ext(path.extension().and_then(|s| s.to_str())) {
            continue;
        }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match peek_archive_metadata(&path) {
            Ok((id, title, author, language, pack_type, lesson_count)) => {
                // Defensive filter — RETIRED_PACK_IDS lists every pack
                // we've ever shipped and pulled. If an old archive
                // survived a build-target cleanup or a user dropped a
                // stale .libre into resources/bundled-packs by hand,
                // it won't surface in Discover. ensure_seed already
                // prunes the corresponding installed dir on a SEED_VERSION
                // bump — this complements that for the catalog side.
                if RETIRED_PACK_IDS.contains(&id.as_str()) {
                    eprintln!(
                        "[libre:catalog] skipping retired archive {:?} (id={})",
                        path, id
                    );
                    continue;
                }
                out.push(BundledCatalogEntry {
                    id,
                    title,
                    author,
                    language,
                    pack_type,
                    lesson_count,
                    size_bytes,
                    local_path: path.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                eprintln!(
                    "[libre:catalog] could not read metadata from {:?}: {}",
                    path, e
                );
            }
        }
    }
    // Stable order so the JS list doesn't shuffle between calls.
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    eprintln!(
        "[libre:catalog] returning {} entries from {:?}",
        out.len(),
        bundled_dir
    );
    Ok(out)
}

/// Same idea as `peek_archive_id` but pulls the full metadata set
/// the catalog UI needs — title, author, language, packType, lesson
/// count. Done in a single zip pass per archive so listing 60 packs
/// stays fast.
fn peek_archive_metadata(
    archive: &Path,
) -> anyhow::Result<(String, String, Option<String>, String, Option<String>, u32)> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            let v: CourseJson = serde_json::from_str(&buf)?;
            let id = str_field(&v, "id");
            let title = str_field(&v, "title");
            let author = opt_str_field(&v, "author");
            let language = str_field(&v, "language");
            let pack_type = opt_str_field(&v, "packType");
            // Walk chapters/lessons to get a count. CourseJson is
            // serde_json::Value so we just grab the array lengths.
            let mut lesson_count = 0u32;
            if let Some(chapters) = v.get("chapters").and_then(|c| c.as_array()) {
                for ch in chapters {
                    if let Some(lessons) = ch.get("lessons").and_then(|l| l.as_array()) {
                        lesson_count += lessons.len() as u32;
                    }
                }
            }
            return Ok((id, title, author, language, pack_type, lesson_count));
        }
    }
    anyhow::bail!("course.json not found in archive");
}

/// Like `str_field` but returns None for missing / non-string values
/// instead of an empty string. Used for optional fields in the catalog
/// metadata so missing-author renders blank rather than empty-string.
fn opt_str_field(v: &CourseJson, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Walk up from cwd + the running binary's dir looking for a folder
/// that contains BOTH `package.json` and `public/starter-courses/`.
/// That signature uniquely identifies the Libre repo root in dev
/// (where the binary lives at `src-tauri/target/debug/`) without
/// misfiring on someone else's checkout. Returns None when not found
/// (production builds, foreign cwd) — callers turn that into a
/// friendly error.
fn find_repo_root_for_starter_promotion() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    for start in candidates {
        let mut cur: &Path = start.as_path();
        loop {
            if cur.join("package.json").is_file()
                && cur.join("public").join("starter-courses").is_dir()
            {
                return Some(cur.to_path_buf());
            }
            match cur.parent() {
                Some(p) => cur = p,
                None => break,
            }
        }
    }
    None
}

/// Dev-only: write the supplied course JSON into
/// `<repo>/public/starter-courses/<courseId>.json` so the next install
/// picks up the in-app fixes. Refuses on release builds (the user is
/// running an installed app, not a dev tree) and when the repo root
/// can't be located.
#[tauri::command]
pub fn save_bundled_starter_course(course_id: String, body: CourseJson) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err(
            "Promote-to-bundled is only available in `tauri dev` builds; this is a release binary."
                .into(),
        );
    }
    if course_id.is_empty()
        || !course_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid course id (expected url-safe alphanumeric)".into());
    }
    let repo = find_repo_root_for_starter_promotion().ok_or_else(|| {
        "Couldn't locate the Libre repo root from this binary — are you running via `npm run tauri:dev`?"
            .to_string()
    })?;
    let dest = repo
        .join("public")
        .join("starter-courses")
        .join(format!("{course_id}.json"));
    let serialized = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&dest, &serialized).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Fetch a remote `.libre` archive over HTTPS and install it into
/// the user's courses dir. Used by the catalog's "Install" button on
/// remote-tier placeholders. Returns the in-zip course id on success.
#[tauri::command]
pub async fn download_and_install_course(
    app: tauri::AppHandle,
    archive_url: String,
) -> Result<String, String> {
    if !archive_url.starts_with("https://") {
        return Err(format!(
            "archive URL must use HTTPS (got: {archive_url})"
        ));
    }
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;

    // Fetch via reqwest (rustls already enabled in Cargo.toml).
    let bytes = reqwest::get(&archive_url)
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download stream failed: {e}"))?;

    // Stage to a temp file so unzip_to can read by path. We use a
    // unique name per call so concurrent installs don't collide.
    let tmp = std::env::temp_dir().join(format!(
        "libre-install-{}.libre",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::write(&tmp, &bytes).map_err(|e| format!("write temp archive failed: {e}"))?;

    let course_id = unzip_to(&tmp, &dir).map_err(|e| e.to_string())?;

    // Best-effort cleanup of the temp file — the install succeeds
    // either way.
    let _ = fs::remove_file(&tmp);
    Ok(course_id)
}

/// Counts returned to the UI after a manual sync. The frontend uses
/// these to render a one-line status ("Synced 1 new course" / "Already
/// up to date" / "Refreshed 12 packs") so the button gives the learner
/// concrete feedback instead of disappearing-spinner anxiety.
#[derive(Debug, Default, Serialize)]
pub struct RefreshReport {
    /// Packs that weren't on disk before this call. New books picked
    /// up from the binary's bundled-packs/ since the last sync.
    #[serde(rename = "new")]
    pub new_count: u32,
    /// Packs that already existed and got re-extracted in place. Lesson
    /// updates, drill stacks, cover changes — all land here.
    pub refreshed: u32,
    /// Packs the user had previously seeded then deleted (id in
    /// seed_ids but folder absent). We respect the deletion and DO NOT
    /// resurrect the pack — it's reported here so the UI can hint at
    /// it ("3 packs you deleted are still hidden").
    pub skipped_deleted: u32,
}

/// User-triggered "Sync latest courses" — re-extracts every bundled
/// pack that's still installed AND seeds any new packs that have landed
/// in `resources/bundled-packs/` since the last sync. Unlike
/// `ensure_seed` (which only refreshes when SEED_VERSION bumps), this
/// always re-extracts so the user can pull in mid-version updates.
/// User-deleted packs stay deleted (tracked by id in `seed_ids`).
///
/// Wired to the "Sync latest courses" button in Settings → Data.
#[tauri::command]
pub fn refresh_bundled_courses(app: tauri::AppHandle) -> Result<RefreshReport, String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(p) => p.join("resources").join("bundled-packs"),
        Err(_) => return Ok(RefreshReport::default()),
    };
    if !resource_dir.exists() {
        return Ok(RefreshReport::default());
    }

    let courses_root = courses_dir(&app).map_err(|e| e.to_string())?;
    let marker = marker_path(&app).map_err(|e| e.to_string())?;
    let mut packs = load_seeded_packs(&marker).unwrap_or_default();
    let mut report = RefreshReport::default();

    let read_dir = match fs::read_dir(&resource_dir) {
        Ok(r) => r,
        Err(e) => return Err(format!("read bundled-packs dir: {e}")),
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_archive_ext(path.extension().and_then(|s| s.to_str())) {
            continue;
        }

        let id = match peek_archive_id(&path) {
            Ok(id) if !id.is_empty() => id,
            Ok(_) => continue,
            Err(e) => {
                eprintln!("[libre:refresh] could not read id from {:?}: {}", path, e);
                continue;
            }
        };

        let course_exists = courses_root.join(&id).join("course.json").exists();

        if course_exists {
            // Always re-extract in force-refresh mode. The marker
            // lookup is just defensive — a manually-imported pack with
            // the same id as a bundled one might not be in seed_ids,
            // and we want to claim it once we replace its contents.
            if !packs.seed_ids.contains(&id) {
                packs.seed_ids.push(id.clone());
            }
            if let Err(e) = unzip_to(&path, &courses_root) {
                eprintln!(
                    "[libre:refresh] re-extract failed for {:?}: {}",
                    path, e
                );
                continue;
            }
            report.refreshed += 1;
            continue;
        }

        // User had it + deleted — respect that.
        if packs.seed_ids.contains(&id) {
            report.skipped_deleted += 1;
            continue;
        }

        // Brand-new pack — fresh seed.
        if let Err(e) = unzip_to(&path, &courses_root) {
            eprintln!("[libre:refresh] unzip failed for {:?}: {}", path, e);
            continue;
        }
        packs.seed_ids.push(id);
        report.new_count += 1;
    }

    // Persist marker. We DON'T touch seed_version here — that's the
    // launch-path's responsibility. Manual sync just records new
    // ids; the version-gated upgrade behavior stays as-is.
    if let Err(e) = save_seeded_packs(&marker, &packs) {
        eprintln!("[libre:refresh] failed to save marker: {}", e);
    }
    eprintln!(
        "[libre:refresh] new={} refreshed={} skipped_deleted={}",
        report.new_count, report.refreshed, report.skipped_deleted
    );
    Ok(report)
}

// ---- Helpers ----------------------------------------------------------------

fn read_course_json(path: &Path) -> anyhow::Result<CourseJson> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Mutate a course JSON in place to drop every per-lesson field that
/// carries a big code/prose payload. Used by `list_courses_summary`
/// to shrink the initial-load IPC from ~12 MB down to ~3 MB on a
/// typical library. If a future schema adds another heavy field,
/// add it here — silent-keeping it would resurrect the slow startup
/// the summary command was designed to prevent.
fn strip_lesson_bodies(course: &mut CourseJson) {
    const HEAVY_FIELDS: &[&str] = &[
        // Exercise lesson body (code challenges)
        "starter",
        "solution",
        "tests",
        "files",
        "solutionFiles",
        // Reading-lesson prose — same field can appear under a few
        // names historically; drop them all defensively.
        "prose",
        "content",
        "body",
        "markdown",
    ];
    let Some(chapters) = course.get_mut("chapters").and_then(|c| c.as_array_mut()) else {
        return;
    };
    for chapter in chapters.iter_mut() {
        let Some(lessons) = chapter.get_mut("lessons").and_then(|l| l.as_array_mut()) else {
            continue;
        };
        for lesson in lessons.iter_mut() {
            let Some(obj) = lesson.as_object_mut() else {
                continue;
            };
            for field in HEAVY_FIELDS {
                obj.remove(*field);
            }
        }
    }
}

fn str_field(v: &CourseJson, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn zip_dir(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let file = fs::File::create(dst)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let rel = path.strip_prefix(src)?;
        if rel.as_os_str().is_empty() { continue; }
        if path.is_dir() {
            writer.add_directory(rel.to_string_lossy(), options)?;
        } else {
            writer.start_file(rel.to_string_lossy(), options)?;
            let mut f = fs::File::open(path)?;
            std::io::copy(&mut f, &mut writer)?;
        }
    }
    writer.finish()?;
    Ok(())
}

/// Extract the archive file into `courses_dir`. Returns the course id (read
/// from the archive's course.json) so the frontend can navigate to it.
fn unzip_to(archive: &Path, courses_dir: &Path) -> anyhow::Result<String> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;

    // First pass: read course.json (wherever in the archive it is) to get id.
    let mut id = String::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            let v: CourseJson = serde_json::from_str(&buf)?;
            id = str_field(&v, "id");
            break;
        }
    }
    if id.is_empty() {
        anyhow::bail!("course.json not found or missing 'id' in archive");
    }
    // SECURITY: `id` is read from the archive's own course.json — fully
    // attacker-controlled. It's used as a directory name under
    // `courses_dir`, so an `id` like `../../../../etc` would escape the
    // courses dir (the first half of a zip-slip). Constrain it to a
    // plain slug: ASCII alphanumerics plus `-` `_` `.`, no path
    // separators, and not a `.`/`..` traversal token.
    if id == "." || id == ".." || !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        anyhow::bail!("course id {id:?} is not a safe directory name");
    }

    let dest = courses_dir.join(&id);
    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::create_dir_all(&dest)?;

    // Second pass: extract everything, flattening any top-level wrapper dir
    // in the archive (e.g. `my-course/course.json` becomes `course.json`).
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_owned();
        let rel = strip_top_level(&name);
        if rel.is_empty() { continue; }
        // SECURITY (zip-slip): `rel` is an archive-controlled path.
        // `strip_top_level` only drops the first segment — it does NOT
        // reject `..` or absolute components, so `wrapper/../../../x`
        // would resolve outside `dest`. Validate every component the
        // same way sandbox.rs::is_safe_relpath does: reject parent-dir
        // hops, absolute roots, and Windows drive prefixes. Fail the
        // whole import on the first hostile entry rather than skipping
        // it — a malicious archive shouldn't be partially trusted.
        if !is_safe_rel(&rel) {
            anyhow::bail!(
                "archive entry {name:?} has an unsafe path — refusing \
                 to extract (possible zip-slip)"
            );
        }
        let out_path = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut f = fs::File::create(&out_path)?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            f.write_all(&buf)?;
        }
    }
    Ok(id)
}

/// Reject relative paths that could escape the extraction root.
/// Mirrors the component-walk approach in `sandbox.rs::is_safe_relpath`:
/// a path is safe iff every component is a `Normal` (or no-op `CurDir`)
/// segment — any `ParentDir` (`..`), `RootDir` (absolute), or `Prefix`
/// (Windows `C:`) component means the join could land outside `dest`,
/// so the archive entry is hostile. Also rejects NUL bytes (defensive
/// against truncation tricks on the eventual `fs::File::create`).
fn is_safe_rel(rel: &str) -> bool {
    use std::path::{Component, Path};
    if rel.is_empty() || rel.contains('\0') {
        return false;
    }
    let mut saw_normal = false;
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(_) => saw_normal = true,
            Component::CurDir => {}
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return false,
        }
    }
    saw_normal
}

fn strip_top_level(path: &str) -> String {
    // If the zip contains a single top-level folder wrapping course.json, skip
    // it. Otherwise return as-is. This lets people share `my-course.libre`
    // created from a folder OR from its contents.
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() > 1 {
        parts[1..].join("/")
    } else if path.ends_with('/') {
        String::new() // skip top-level dir itself
    } else {
        path.to_string()
    }
}

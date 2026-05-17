//! Tiny SQLite-backed progress store.
//!
//! Schema is intentionally small for V1 — one row per (course, lesson) the
//! user has completed. A future iteration can add per-run logs (for streaks,
//! time-on-task, test attempts) without migration pain because we version
//! the schema here.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

pub struct ProgressDb(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
pub struct Completion {
    pub course_id: String,
    pub lesson_id: String,
    pub completed_at: i64,
}

fn open_conn(db_path: &PathBuf) -> anyhow::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS completions (
            course_id TEXT NOT NULL,
            lesson_id TEXT NOT NULL,
            completed_at INTEGER NOT NULL,
            PRIMARY KEY (course_id, lesson_id)
        );
        "#,
    )?;
    Ok(conn)
}

pub fn open(db_path: PathBuf) -> anyhow::Result<ProgressDb> {
    Ok(ProgressDb(Mutex::new(open_conn(&db_path)?)))
}

impl ProgressDb {
    /// Re-point this managed connection at a different profile's
    /// `progress.sqlite`. Called by `profiles::switch_profile` so a
    /// profile switch doesn't require a process restart — the
    /// `app.manage`d `ProgressDb` is process-wide, so we swap the
    /// `Connection` inside its `Mutex` in place. The old connection
    /// is dropped (closed, WAL checkpointed by SQLite) when the
    /// `std::mem::replace`d value goes out of scope.
    pub fn reopen(&self, db_path: PathBuf) -> anyhow::Result<()> {
        let fresh = open_conn(&db_path)?;
        let mut guard = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("progress db mutex poisoned"))?;
        *guard = fresh;
        Ok(())
    }
}

/// Build the path where the SQLite file lives. Uses Tauri's resolved app-data
/// dir so it ends up in the platform-appropriate location (~/Library/Application
/// Support/com.mattssoftware.libre on macOS, %APPDATA% on Windows).
pub fn resolve_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    // Profile-scoped: <app_data>/profiles/<active>/progress.sqlite.
    // `profile_app_root` create_dir_all's the profile dir.
    let dir = crate::profiles::profile_app_root(app)?;
    Ok(dir.join("progress.sqlite"))
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn list_completions(db: State<'_, ProgressDb>) -> Result<Vec<Completion>, String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let mut stmt = conn
        .prepare("SELECT course_id, lesson_id, completed_at FROM completions ORDER BY completed_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Completion {
                course_id: r.get(0)?,
                lesson_id: r.get(1)?,
                completed_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Mark a lesson complete for the active user.
///
/// `completed_at` is an optional epoch-seconds timestamp. The cloud-
/// sync path supplies it so a row pulled down from the relay carries
/// the original completion time across devices — without this, every
/// row stamps with `now()` and a fresh device's streak / activity
/// graphs collapse to "everything happened today" the moment the
/// learner signs in. The local self-mark path passes `None` and we
/// stamp with `now()` ourselves.
#[tauri::command]
pub fn mark_completion(
    db: State<'_, ProgressDb>,
    course_id: String,
    lesson_id: String,
    completed_at: Option<i64>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let supplied = completed_at.unwrap_or_else(|| chrono::Utc::now().timestamp());
    // Upsert with "earliest wins" semantics: if a row already exists
    // for this (course, lesson), keep the smaller timestamp. That way
    // a stale local copy (e.g. one stamped "today" by a pre-fix mobile
    // build) gets overwritten by the cloud's authentic completion
    // time on the next sync round, but a lesson the user just freshly
    // completed locally doesn't get retroactively backdated by some
    // older sync row arriving later. SQLite needs the
    // ON CONFLICT (...) syntax — the table's PRIMARY KEY is the
    // composite (course_id, lesson_id).
    conn.execute(
        "INSERT INTO completions (course_id, lesson_id, completed_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(course_id, lesson_id) DO UPDATE SET \
            completed_at = MIN(completions.completed_at, excluded.completed_at)",
        params![course_id, lesson_id, supplied],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_completions(db: State<'_, ProgressDb>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute("DELETE FROM completions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_lesson_completion(
    db: State<'_, ProgressDb>,
    course_id: String,
    lesson_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute(
        "DELETE FROM completions WHERE course_id = ?1 AND lesson_id = ?2",
        params![course_id, lesson_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_course_completions(
    db: State<'_, ProgressDb>,
    course_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute(
        "DELETE FROM completions WHERE course_id = ?1",
        params![course_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

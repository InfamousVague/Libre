# Bundled course packs

`.academy` archives (legacy `.libre` and `.kata` also accepted)
dropped in this directory ship inside the Tauri binary and are
auto-imported on first launch for new installs. Existing installs
pick them up the next time the app starts, unless the user has
already imported a pack with the same course id (in which case we
skip — the user's copy wins) OR has previously seeded-and-deleted
it (in which case we also skip, so a removed pack doesn't resurrect
itself).

## How to bundle a new pack

1. Open Libre.
2. Profile → "Generate challenge pack…" → pick language / count / model → Generate.
3. Wait for the floating panel to finish.
4. Right-click the pack in the sidebar → Course settings… → Export… and save the `.academy` file.
5. Move the `.academy` file into this directory.
6. Commit it alongside the Rust + frontend changes.
7. Next `cargo tauri build` / `cargo tauri dev` includes it.

## What gets tracked where

- **User's courses dir** — `<app-data>/courses/<id>/course.json` + assets.
  Normal course storage. Bundled packs land here on first seed.
- **Seed marker** — `<app-data>/seeded-packs.json`.
  Lists every pack id we've ever imported here. Prevents re-seed after
  the user deletes a pack (respect the deletion).

## Naming convention

Call the file something descriptive:

    rust-challenges-100.academy
    typescript-challenges-100.academy
    go-challenges-100.academy

The seed routine reads the internal `course.json` to get the real id —
filenames are for humans only.

## File extensions

`.academy` is the canonical extension after the Libre → Libre
rebrand. `.libre` (the previous name) and `.kata` (the original
pre-rebrand name) are still accepted on import for backwards compat
so older shipped archives + user exports keep working.

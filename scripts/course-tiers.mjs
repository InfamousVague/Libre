/// Single source of truth for which bundled `.libre` archives ship
/// inline with the app vs which appear as downloadable placeholders.
///
/// **Core** = bundled with the desktop installer and inlined into
/// the web build's first-launch seed. Always present after install.
///
/// **Remote** = listed in the catalog with a download URL. Render as
/// semi-opaque placeholders in the Library; one click installs.
///
/// The intent: ship a small enough core that the desktop installer
/// stays under ~30 MB (vs 145 MB if we bundle everything), while
/// still giving learners an opinionated starting set on first
/// launch (Rust + Go + every challenge pack so kata-style learners
/// can start immediately in any language).
///
/// Adding a new core book: drop the .libre into
/// `src-tauri/resources/bundled-packs/`, add the id here, add the
/// matching path entry to `tauri.conf.json` `resources`. Adding a
/// new remote book: drop the .libre into `bundled-packs/` and
/// add the id to ALL_PACK_IDS only — the build script + catalog
/// take care of the rest.

export const CORE_PACK_IDS = [
  // ── In-house "A to <lang>" tutorial books ──────────────────────
  // Flagship Libre-authored courses that walk a beginner from
  // zero to fluency in a single language. Bundled in core so every
  // install opens with two opinionated, end-to-end tutorials.
  "a-to-zig",
  "a-to-ts",
  // HelloTrade — 51 lessons + the in-app TradeDock (Postman-style
  // REST + WS client). Small enough to ship in core (96KB JSON).
  "hellotrade",

  // Long-form books we want every install to start with.
  "the-rust-programming-language",
  "learning-go",
  // (`learning-zig` was retired here — A to Zig is the in-house
  // replacement and is shipped above as its own bundled .libre.)

  // All challenge packs — kata-style learners are likely to bounce
  // through several languages, and the per-pack size is small
  // (~50-200 KB each). Cheap to ship them all.
  "rust-challenges",
  "go-challenges",
  "javascript-challenges",
  "typescript-challenge-pack",
  "python-challenges",
  "react-native-challenges",
  "c-challenges",
  "cpp-challenges",
  "java-challenges",
  "kotlin-challenges",
  "csharp-challenges",
  "swift-challenges",
  "assembly-challenges-arm64-macos",

  // ── 2026 expansion ───────────────────────────────────────────
  // Eleven Easy challenge packs added in the language expansion.
  // Same naming convention as recent additions (`challenges-<lang>-
  // handwritten`) so the in-zip course id matches the bundle
  // filename. All small (5 lessons each), so they fit the "ship
  // them all" rationale above.
  "challenges-ruby-handwritten",
  "challenges-lua-handwritten",
  "challenges-dart-handwritten",
  "challenges-haskell-handwritten",
  "challenges-scala-handwritten",
  "challenges-sql-handwritten",
  "challenges-elixir-handwritten",
  "challenges-zig-handwritten",
  // Move / Cairo / Sway runtimes are stubbed — Run currently surfaces
  // an install-hint banner. The packs ship anyway so the content is
  // installed and ready to run when the runtimes land.
  "challenges-move-handwritten",
  "challenges-cairo-handwritten",
  "challenges-sway-handwritten",
];

/// Every pack we extract metadata for at build time. Anything in
/// here but NOT in CORE_PACK_IDS becomes a remote placeholder. Kept
/// in the same order the Library should display them in.
export const ALL_PACK_IDS = [
  // ── In-house "A to <lang>" tutorial books ──────────────────────
  // Listed first so they top the catalog — these are the flagship
  // beginner-friendly tutorials Libre authors directly.
  "a-to-zig",
  "a-to-ts",
  // Hardware-wallet course — uses the new Ledger transport (Rust
  // hidapi on desktop, WebHID on web) introduced alongside it.
  // Course `requiresDevice: "ledger"` flag mounts the Ledger
  // status pill in the lesson view; readings include device-action
  // markdown buttons that send real APDUs.
  "learning-ledger",

  // ── Languages-as-a-foundation books ────────────────────────────
  // Removed from the catalog (retired) on 2026-05-07:
  //   eloquent-javascript, the-modern-javascript-tutorial-fundamentals,
  //   you-don-t-know-js-yet, python-crash-course, learning-zig.
  // The Zig spot is now covered by the in-house "A to Zig" course
  // bundled above, not via these third-party books.
  // Cleanup pass 2026-05-10: dropped rust-by-example, the-async-book-
  //   rust, composing-programs — code-only references with no archive
  //   anywhere (CDN dead, never bundled, never authored). The catalog
  //   layer was producing Discover tiles whose install button always
  //   404'd. Re-add when the .academy ships.
  "the-rust-programming-language",
  "the-rustonomicon",
  "learning-go",

  // ── Computer-science fundamentals ──────────────────────────────
  // Removed 2026-05-07: crafting-interpreters-javascript.
  // Removed 2026-05-10: algorithms-erickson, open-data-structures,
  //   pro-git — same archive-dead reason as the rust block above.

  // ── Frameworks + libraries ─────────────────────────────────────
  // Removed 2026-05-07: learning-react-native, fluent-react,
  //   interactive-web-development-with-three-js-and-a-frame.
  // Removed 2026-05-10: learning-svelte, solidjs-fundamentals,
  //   htmx-fundamentals, astro-fundamentals, react-native,
  //   tauri-2-fundamentals — archive-dead.

  // ── Smart-contract / web3 / crypto ─────────────────────────────
  // Removed 2026-05-10: mastering-lightning-network,
  //   vyper-fundamentals-pythonic-smart-contracts,
  //   viem-and-ethers-js-talking-to-ethereum-from-typescript,
  //   cryptography-fundamentals-hashes-to-zk — archive-dead.
  "mastering-bitcoin",
  "mastering-ethereum",
  "solana-programs-rust-on-the-svm",
  // HelloTrade — decentralised perp futures exchange. JavaScript-
  // primary; bundles with the in-app TradeDock (Postman-shaped REST
  // + WS client) so every dock-flagged lesson hits a real-or-mock
  // API. Source-distilled from hellotrade.gitbook.io.
  "hellotrade",

  // ── Challenge packs ───────────────────────────────────────────
  "javascript-challenges",
  "typescript-challenge-pack",
  "python-challenges",
  "go-challenges",
  "rust-challenges",
  "react-native-challenges",
  // Desktop-only challenge packs (their languages need a local
  // toolchain). Web build skips them at runtime via the desktopOnly
  // gate in runtimes/index.ts; they're still bundled in core because
  // the pack itself is tiny and ships even if the runtime can't run.
  "c-challenges",
  "cpp-challenges",
  "java-challenges",
  "kotlin-challenges",
  "csharp-challenges",
  "swift-challenges",
  "assembly-challenges-arm64-macos",
  // 2026 language-expansion challenge packs — also small, also
  // shipped in core. Order mirrors CORE_PACK_IDS.
  "challenges-ruby-handwritten",
  "challenges-lua-handwritten",
  "challenges-dart-handwritten",
  "challenges-haskell-handwritten",
  "challenges-scala-handwritten",
  "challenges-sql-handwritten",
  "challenges-elixir-handwritten",
  "challenges-zig-handwritten",
  "challenges-move-handwritten",
  "challenges-cairo-handwritten",
  "challenges-sway-handwritten",
];

/// Whether a pack is bundled with the app (extracted on first
/// launch) vs downloaded on demand. Drives the catalog `tier`
/// field which the Library uses to render placeholders.
export function tierFor(packId) {
  return CORE_PACK_IDS.includes(packId) ? "core" : "remote";
}

/// Pack ids that should be installed-able but NOT browsable. Each id
/// here gets `hidden: true` stamped onto its catalog manifest entry,
/// which kicks in three filters downstream:
///
///   1. `lib/catalog.ts` drops hidden entries from `fetchCatalog()`,
///      so the Discover grid never lists them.
///   2. The desktop App + mobile App filter `coursesAll.filter(c =>
///      !c.hidden)` so the Library tree doesn't show them either.
///   3. `data/webSeedCourses.ts` still seeds hidden entries into the
///      browser's IndexedDB, but stamps the `hidden: true` flag
///      onto the saved record so the library filter above kicks in
///      from the first paint.
///
/// Net effect: a hidden course is fully installed + ready, but only
/// reachable via a direct lesson URL (`?course=<id>&lesson=<id>`) or
/// a manual `.libre` import. Useful for partner / preview content
/// we want the URL of without exposing in the public shelf.
export const HIDDEN_PACK_IDS = new Set([
  // (empty — hellotrade graduated to Discover with the public BETA
  // surface; add new partner / preview ids here when they need a
  // direct-link-only soft launch)
]);

export function isHiddenPack(packId) {
  return HIDDEN_PACK_IDS.has(packId);
}

/// Default base URL where the remote `.libre` archives are
/// hosted. The catalog includes per-course archive URLs derived from
/// this — change here OR set LIBRE_CATALOG_BASE_URL at build time
/// to point at your own hosting.
export const REMOTE_ARCHIVE_BASE =
  process.env.LIBRE_CATALOG_BASE_URL ??
  "https://mattssoftware.com/fishbones/courses";

/// Editorial-tier overrides keyed by **pack id** (the .libre
/// filename minus extension). Applied by the extract script AFTER
/// reading each course.json so we can bump a book's tier without
/// repacking the archive.
///
/// Tier vocabulary:
///   - "BETA"       — final polish for release; renders at the top
///                    of the library section list.
///   - "ALPHA"      — next up in the queue; middle section.
///   - "UNREVIEWED" — drafts; bottom section. Default when a course
///                    has no releaseStatus AND no entry here.
///
/// To remove an override and let the in-zip value win, delete the
/// pack id from this map.
export const RELEASE_STATUS_OVERRIDES = {
  // ── Books bumped to BETA after substantive validation ─────────
  // Updated to use viem-style runtime + verified passing through
  // the cmd+K verifier.
  "mastering-ethereum": "BETA",
  "mastering-bitcoin": "BETA",
  "solana-programs-rust-on-the-svm": "BETA",
  // HelloTrade authored hand-on at BETA — every prose lesson
  // proofread, every dock-driven exercise pinned to a real preset
  // in the API tester. Lessons compile cleanly with the placeholder
  // exercise harness even though the dock is the actual interaction
  // surface.
  "hellotrade": "BETA",

  // ── Books bumped to ALPHA ────────────────────────────────────
  // (Vyper override removed 2026-05-10 alongside the ALL_PACK_IDS
  // cleanup — no archive shipped, so the override had nothing to
  // attach to.)

  // ── Challenge packs ──────────────────────────────────────────
  // Auto-generated kata sets validated as a class via the recent
  // runtime hardening (rand 0.10 trait fix, parseTestResults
  // defensive parsing, should_panic regex, missing-imports infer).
  // All challenge packs ship at BETA — they're small, focused, and
  // either run end-to-end on the host (the original 11) or against
  // a stubbed-runtime install-hint banner (Move / Cairo / Sway).
  "javascript-challenges": "BETA",
  "typescript-challenge-pack": "BETA",
  "python-challenges": "BETA",
  "react-native-challenges": "BETA",
  "c-challenges": "BETA",
  "cpp-challenges": "BETA",
  "java-challenges": "BETA",
  "kotlin-challenges": "BETA",
  "csharp-challenges": "BETA",
  "swift-challenges": "BETA",
  "assembly-challenges-arm64-macos": "BETA",
  "rust-challenges": "BETA",
  "go-challenges": "BETA",
  // ── 2026 expansion challenge packs ───────────────────────────
  // Same BETA tier — the runtimes for Ruby / Lua / Dart / Haskell
  // / Scala / SQL / Elixir / Zig run via the host's installed CLI
  // (or browser-native for Lua / SQL). Move / Cairo / Sway carry
  // BETA too because the content + #[test] form is final; the
  // language-runtime stubs surface install-hint banners cleanly.
  "challenges-ruby-handwritten": "BETA",
  "challenges-lua-handwritten": "BETA",
  "challenges-dart-handwritten": "BETA",
  "challenges-haskell-handwritten": "BETA",
  "challenges-scala-handwritten": "BETA",
  "challenges-sql-handwritten": "BETA",
  "challenges-elixir-handwritten": "BETA",
  "challenges-zig-handwritten": "BETA",
  "challenges-move-handwritten": "BETA",
  "challenges-cairo-handwritten": "BETA",
  "challenges-sway-handwritten": "BETA",
};

/// Normalise a course's tier through the override map. Falls back to
/// the in-zip value when no override is set, then to UNREVIEWED.
export function releaseStatusFor(packId, inZipStatus) {
  const override = RELEASE_STATUS_OVERRIDES[packId];
  if (override) return override;
  if (inZipStatus === "BETA" || inZipStatus === "ALPHA") return inZipStatus;
  return "UNREVIEWED";
}

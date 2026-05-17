/// First-time "compile Rust locally" nudge.
///
/// Rust lessons run on the public Rust Playground by default — it
/// works with zero setup but every run is a network round-trip to a
/// shared, rate-limited sandbox (seconds of latency, fails offline).
/// If the learner installs `rustc` locally (one rustup command, no
/// sudo), `runtimes/rust.ts` automatically prefers the local path:
/// instant, offline, no queue. This modal surfaces that option the
/// first time someone opens a Rust exercise.
///
/// Entirely optional + self-gating (same contract as SetupWizard):
///   - Web build → no-op (no Tauri, no local toolchain possible).
///   - `language !== "rust"` → no-op.
///   - `libre:rust-local-prompt-v1 === "permanent"` → never again.
///   - `rustc` already installed → no-op (nothing to offer).
/// The component renders nothing until it decides to show, so the
/// caller just mounts `<RustLocalPrompt language={lesson.language} />`.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModalBackdrop from "../../Shared/ModalBackdrop";
import { isDesktop } from "../../../lib/platform";
import { resetRustcProbe } from "../../../runtimes/rust";
import { useT } from "../../../i18n/i18n";
import "./RustLocalPrompt.css";

const DISMISS_KEY = "libre:rust-local-prompt-v1";

interface ToolchainStatus {
  language: string;
  installed: boolean;
  version: string | null;
  install_hint: {
    manager: string;
    command: string;
    requires_password?: boolean;
    description?: string;
  } | null;
}

interface InstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

function readDismissed(): "permanent" | "session" | null {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    return v === "permanent" || v === "session" ? v : null;
  } catch {
    return null;
  }
}

function writeDismissed(v: "permanent" | "session"): void {
  try {
    localStorage.setItem(DISMISS_KEY, v);
  } catch {
    /* private mode / quota — prompt just reappears next Rust lesson */
  }
}

interface Props {
  /// The active lesson's language. The prompt only arms itself when
  /// this is `"rust"`; any other value is an immediate no-op.
  language: string | undefined;
}

export default function RustLocalPrompt({ language }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<ToolchainStatus["install_hint"]>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [installed, setInstalled] = useState(false);

  // Arm gate. Probe only when this is actually a Rust lesson, on
  // desktop, and the learner hasn't permanently dismissed. A short
  // delay so the modal doesn't slam up the instant the lesson
  // paints — it arrives a beat after the editor settles.
  useEffect(() => {
    if (language !== "rust") return;
    if (!isDesktop) return;
    if (readDismissed() === "permanent") return;
    let cancelled = false;
    let timer: number | undefined;
    void (async () => {
      try {
        const status = await invoke<ToolchainStatus>(
          "probe_language_toolchain",
          { language: "rust" },
        );
        if (cancelled) return;
        // Already installed → the local fast path is already in
        // effect; nothing to prompt. Record a permanent dismiss so
        // we never probe again on this machine.
        if (status.installed) {
          writeDismissed("permanent");
          return;
        }
        setHint(status.install_hint);
        timer = window.setTimeout(() => {
          if (!cancelled) setOpen(true);
        }, 900);
      } catch {
        // Older binary without the probe / IPC failure — stay
        // silent. Rust still works via the Playground.
      }
    })();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [language]);

  if (!open) return null;

  const dismiss = (permanent: boolean) => {
    writeDismissed(permanent ? "permanent" : "session");
    setOpen(false);
  };

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    setOutput(null);
    try {
      const result = await invoke<InstallResult>(
        "install_language_toolchain",
        {
          language: "rust",
          password: null,
          command: hint?.command ?? null,
        },
      );
      if (result.success) {
        setInstalled(true);
        setOutput(tailOutput(result));
        // Drop the memoised "no rustc" probe in rust.ts so the very
        // next Run uses the local fast path without a reload.
        resetRustcProbe();
        // Earned its keep — never prompt again on this machine.
        writeDismissed("permanent");
      } else {
        setError(tailOutput(result) || t("rustLocal.installFailed"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <ModalBackdrop onDismiss={() => dismiss(false)} zIndex={210}>
      <div
        className="libre-rustlocal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="libre-rustlocal-title"
      >
        <button
          type="button"
          className="libre-rustlocal__close"
          onClick={() => dismiss(false)}
          aria-label={t("rustLocal.close")}
        >
          ×
        </button>

        <h2 id="libre-rustlocal-title" className="libre-rustlocal__title">
          {installed
            ? t("rustLocal.installedTitle")
            : t("rustLocal.title")}
        </h2>
        <p className="libre-rustlocal__blurb">
          {installed
            ? t("rustLocal.installedBlurb")
            : t("rustLocal.blurb")}
        </p>

        {!installed && hint?.command && (
          <div
            className="libre-rustlocal__cmd"
            role="note"
            aria-label={t("rustLocal.commandAria")}
          >
            <code>{hint.command}</code>
          </div>
        )}

        {error && <pre className="libre-rustlocal__error">{error}</pre>}
        {output && !error && (
          <pre className="libre-rustlocal__output">{output}</pre>
        )}

        <div className="libre-rustlocal__actions">
          {installed ? (
            <button
              type="button"
              className="libre-rustlocal__primary"
              onClick={() => setOpen(false)}
            >
              {t("rustLocal.done")}
            </button>
          ) : (
            <>
              <label className="libre-rustlocal__dontask">
                <input
                  type="checkbox"
                  checked={dontAskAgain}
                  onChange={(e) => setDontAskAgain(e.target.checked)}
                  disabled={installing}
                />
                <span>{t("rustLocal.dontAskAgain")}</span>
              </label>
              <div className="libre-rustlocal__btnrow">
                <button
                  type="button"
                  className="libre-rustlocal__secondary"
                  onClick={() => dismiss(dontAskAgain)}
                  disabled={installing}
                >
                  {t("rustLocal.later")}
                </button>
                <button
                  type="button"
                  className="libre-rustlocal__primary"
                  onClick={handleInstall}
                  disabled={installing}
                >
                  {installing
                    ? t("rustLocal.installing")
                    : t("rustLocal.install")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}

/// Keep the tail of installer output — rustup prints a long banner;
/// the last ~20 lines carry the "Rust is installed now" confirmation
/// or the actual failure.
function tailOutput(r: InstallResult): string {
  const both = `${r.stdout}\n${r.stderr}`.trim();
  const lines = both.split("\n").filter(Boolean);
  return lines.slice(-20).join("\n");
}

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Icon } from "@base/primitives/icon";
import { copy as copyIcon } from "@base/primitives/icon/icons/copy";
import { check as checkIcon } from "@base/primitives/icon/icons/check";
import { qrCode } from "@base/primitives/icon/icons/qr-code";
import { camera } from "@base/primitives/icon/icons/camera";
import {
  readAiEnabled,
  readAiHost,
  writeAiEnabled,
  writeAiHost,
} from "../../../lib/aiHost";
import { isMobile } from "../../../lib/platform";
import QrScanner from "../../Shared/QrScanner";
import { useT } from "../../../i18n/i18n";

const MODEL_OPTIONS: Array<{ id: string; labelKey: string; hintKey: string }> = [
  {
    id: "claude-sonnet-4-8",
    labelKey: "settings.sonnetLabel",
    hintKey: "settings.sonnetHint",
  },
  {
    id: "claude-opus-4-8",
    labelKey: "settings.opusLabel",
    hintKey: "settings.opusHint",
  },
  {
    id: "claude-haiku-4-8",
    labelKey: "settings.haikuLabel",
    hintKey: "settings.haikuHint",
  },
];

interface AiPaneProps {
  apiKey: string;
  onApiKeyChange: (next: string) => void;
  openaiKey: string;
  onOpenaiKeyChange: (next: string) => void;
  model: string;
  onModelChange: (next: string) => void;
}

export default function AiPane({
  apiKey,
  onApiKeyChange,
  openaiKey,
  onOpenaiKeyChange,
  model,
  onModelChange,
}: AiPaneProps) {
  const t = useT();
  // Per-field "just copied" flash. Keyed so the Anthropic + OpenAI
  // copy buttons each get their own check-mark moment without
  // stomping each other.
  const [copiedKey, setCopiedKey] = useState<null | "anthropic" | "openai">(
    null,
  );

  const copy = async (which: "anthropic" | "openai", value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(which);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === which ? null : cur));
      }, 1400);
    } catch {
      // Clipboard write may fail without user-gesture permission
      // (Tauri WebKit on macOS sometimes rejects). Silent — the
      // user can still select+copy from the input field manually.
    }
  };

  return (
    <section>
      <h3 className="libre-settings-section">{t("settings.aiSectionIngest")}</h3>
      <p className="libre-settings-blurb">
        {t("settings.aiIngestBlurb")}
      </p>
      <label className="libre-settings-field">
        <span className="libre-settings-label">{t("settings.anthropicApiKey")}</span>
        <div className="libre-settings-input-row">
          <input
            type="password"
            className="libre-settings-input"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-ant-..."
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="libre-settings-input-copy"
            onClick={() => void copy("anthropic", apiKey)}
            disabled={!apiKey}
            aria-label={
              copiedKey === "anthropic"
                ? t("settings.copiedLabel")
                : t("settings.copyAnthropic")
            }
            title={
              apiKey
                ? copiedKey === "anthropic"
                  ? t("settings.copiedExclaim")
                  : t("settings.copyClipboard")
                : t("settings.addKeyFirst")
            }
          >
            <Icon
              icon={copiedKey === "anthropic" ? checkIcon : copyIcon}
              size="xs"
              color="currentColor"
            />
          </button>
        </div>
      </label>
      <p className="libre-settings-note">
        Stored at <code>&lt;app_data_dir&gt;/settings.json</code>. Never
        leaves your machine except in requests to api.anthropic.com.
      </p>

      <label className="libre-settings-field">
        <span className="libre-settings-label">{t("settings.modelLabel")}</span>
        <div className="libre-settings-model-group">
          {MODEL_OPTIONS.map((opt) => (
            <label
              key={opt.id}
              className={`libre-settings-model ${model === opt.id ? "is-active" : ""}`}
            >
              <input
                type="radio"
                name="anthropic-model"
                value={opt.id}
                checked={model === opt.id}
                onChange={() => onModelChange(opt.id)}
              />
              <div>
                <div className="libre-settings-model-label">{t(opt.labelKey)}</div>
                <div className="libre-settings-model-hint">{t(opt.hintKey)}</div>
              </div>
            </label>
          ))}
        </div>
      </label>

      {/* Separate second provider for AI cover-art generation.
          Anthropic doesn't ship image generation, so we use
          OpenAI's gpt-image-1. Optional — without a key the
          cover-art button in Course Settings surfaces a
          friendly "add a key" message instead of crashing. */}
      <h3 className="libre-settings-section libre-settings-section--sub">
        {t("settings.aiCoverSection")}
      </h3>
      <p className="libre-settings-blurb">
        Optional. When set, a <strong>Generate artwork with AI</strong>{" "}
        button appears in Course Settings → Appearance. Uses OpenAI's{" "}
        <code>gpt-image-1</code> model (~$0.04 per cover) with a fixed
        editorial style so every book in your library shares the same
        visual language.
      </p>
      <label className="libre-settings-field">
        <span className="libre-settings-label">{t("settings.openaiApiKey")}</span>
        <div className="libre-settings-input-row">
          <input
            type="password"
            className="libre-settings-input"
            value={openaiKey}
            onChange={(e) => onOpenaiKeyChange(e.target.value)}
            placeholder="sk-..."
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="libre-settings-input-copy"
            onClick={() => void copy("openai", openaiKey)}
            disabled={!openaiKey}
            aria-label={
              copiedKey === "openai"
                ? t("settings.copiedLabel")
                : t("settings.copyOpenai")
            }
            title={
              openaiKey
                ? copiedKey === "openai"
                  ? t("settings.copiedExclaim")
                  : t("settings.copyClipboard")
                : t("settings.addKeyFirst")
            }
          >
            <Icon
              icon={copiedKey === "openai" ? checkIcon : copyIcon}
              size="xs"
              color="currentColor"
            />
          </button>
        </div>
      </label>
      <p className="libre-settings-note">
        Stored next to the Anthropic key in{" "}
        <code>&lt;app_data_dir&gt;/settings.json</code>. Only used for
        image requests to api.openai.com.
      </p>

      <AssistantHostField />
    </section>
  );
}

/// Inline section for the in-app chat assistant's HTTP host.
///
/// On desktop the assistant talks to a localhost Ollama daemon via
/// Tauri IPC and this field is unused (left visible so the user
/// remembers the field exists when they pick up their phone). On
/// mobile / web, the assistant uses this host directly: HTTP fetch
/// to `<host>:11434/api/chat` with `stream: true`. Typical value is
/// the user's own Mac on their Tailscale tailnet — that machine has
/// Ollama running, the phone reaches it over the encrypted tailnet
/// without exposing the daemon to the public internet.
///
/// State is read once on mount + persisted on blur (not on every
/// keystroke — saving partial hostnames triggers re-probes that
/// will all fail until the field is complete).
function AssistantHostField() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean>(() => readAiEnabled());
  const [host, setHost] = useState<string>(() => readAiHost() ?? "");
  const [savedFlash, setSavedFlash] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const persisted = readAiHost() ?? "";

  /// Toggle the master enable flag. The orb + panel are hidden
  /// app-wide when this is off (see AiAssistant.tsx). Persist
  /// immediately — no save button — and the writeAiEnabled helper
  /// dispatches the config-change event so the assistant
  /// re-evaluates without a remount.
  const toggleEnabled = (next: boolean) => {
    setEnabled(next);
    writeAiEnabled(next);
  };

  // Flash a brief "saved" affordance when the value commits. We
  // own the flash state locally; the Settings dialog's main "Save"
  // button doesn't gate this field because the assistant host is a
  // single-key localStorage write, not part of the settings.json
  // bundle.
  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), 1400);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  const commit = (next?: string) => {
    const val = (next ?? host).trim();
    if (val === persisted) return;
    setHost(val);
    writeAiHost(val);
    // Custom event so the remote chat hook re-probes immediately
    // (storage events don't fire same-tab).
    window.dispatchEvent(new CustomEvent("libre:ai-host-changed"));
    setSavedFlash(true);
  };

  // Re-render the QR every time the user opens the modal OR edits
  // the host with the modal open. Encoded as the bare host string
  // (matching exactly what the phone's Settings field expects);
  // simpler than wrapping it in a `libre://` URL scheme since
  // we don't need ANY context beyond the hostname.
  useEffect(() => {
    if (!qrOpen) {
      setQrDataUrl(null);
      return;
    }
    const value = host.trim();
    if (!value) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(value, {
      // High-contrast bone-on-dark to match the rest of the chrome.
      // The phone's QR scanner doesn't care about colour, but a
      // matching palette keeps the modal from feeling like a
      // bolt-on.
      color: { dark: "#d4c5a1", light: "#0a0a0d" },
      margin: 2,
      width: 320,
      errorCorrectionLevel: "M",
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [qrOpen, host]);

  /// Validate + write a hostname scanned from a QR. Strips schemes
  /// + trailing slashes (writeAiHost does the same, but checking
  /// here lets us reject obvious garbage before persisting). A
  /// "valid" host is anything that contains a `.` or a `:` or
  /// looks like an IPv4 — covers Tailscale (`mac.tailnet.ts.net`),
  /// LAN IP (`192.168.1.42`), and explicit-port forms
  /// (`mac:11500`).
  const handleScanResult = (raw: string) => {
    setScanOpen(false);
    const cleaned = raw
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    const looksLikeHost =
      /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(cleaned) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(cleaned) ||
      /^[\w-]+:\d+$/.test(cleaned);
    if (!looksLikeHost) {
      // Surface the rejection without throwing a blocking alert —
      // the user can re-open the scanner and try a different code.
      console.warn(
        "[AiPane] QR scanned but didn't look like a host:",
        cleaned.slice(0, 80),
      );
      return;
    }
    commit(cleaned);
  };

  return (
    <>
      <h3 className="libre-settings-section libre-settings-section--sub">
        {t("settings.aiAssistantSection")}
      </h3>
      <p className="libre-settings-blurb">
        The in-app chat tutor — a floating orb in the bottom-right
        that opens a side panel with conversational help. Off by
        default. Flip the toggle below to enable it; once on, the
        orb appears and the rest of the configuration applies.
      </p>
      <label className="libre-settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
        />
        <span className="libre-settings-toggle-slider" aria-hidden />
        <span className="libre-settings-toggle-label">
          {enabled ? t("settings.enabledLabel") : t("settings.disabledLabel")}
        </span>
      </label>

      {/* Host configuration is only meaningful once the toggle is
          on — collapse the host field + pairing affordances when
          the assistant is disabled so the section reads as a
          clean off-state, not a half-configured setup waiting on
          the user. */}
      {enabled && (
        <>
      <h3 className="libre-settings-section libre-settings-section--sub">
        {t("settings.assistantHostSection")}
      </h3>
      <p className="libre-settings-blurb">
        Hostname or IP of the machine running Ollama. The phone +
        web build talk straight to it over HTTP on port 11434. A
        Tailscale tailnet hostname is the recommended setup —
        encrypted, stable across LAN moves, no public exposure.
        Desktop ignores this field and uses its own localhost
        daemon via Tauri IPC.
      </p>
      <label className="libre-settings-field">
        <span className="libre-settings-label">{t("settings.hostnameIp")}</span>
        <div className="libre-settings-input-row">
          <input
            type="text"
            className="libre-settings-input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onBlur={() => commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            placeholder="libre-mac.tailnet-abc.ts.net  or  192.168.1.42"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
          />
          <span
            className="libre-settings-input-copy"
            aria-hidden
            style={{
              opacity: savedFlash ? 1 : 0,
              transition: "opacity 220ms ease",
              pointerEvents: "none",
            }}
            title={savedFlash ? t("settings.savedLabel") : ""}
          >
            <Icon icon={checkIcon} size="xs" color="currentColor" />
          </span>
        </div>
      </label>

      {/* Pair-with-QR row. Two affordances:
          - Show QR (desktop): turns the current host field into a
            scannable QR. The user opens this on their Mac, then
            scans from the phone — no typing tailnet hostnames on a
            tiny keyboard.
          - Scan QR (phone / web): opens the camera, decodes any
            visible QR, writes the result into the field.
          We render BOTH on every platform so a desktop test build
          can verify the round-trip without device-juggling, but
          weight the labels for the most useful platform. */}
      <div className="libre-settings-pair">
        <button
          type="button"
          className="libre-settings-pair-btn"
          onClick={() => setQrOpen(true)}
          disabled={!host.trim()}
          title={
            host.trim()
              ? "Show a QR code containing this hostname for the phone to scan"
              : "Enter a hostname first, then a QR can be generated"
          }
        >
          <Icon icon={qrCode} size="xs" color="currentColor" />
          <span>{t("settings.showQrForPhone")}</span>
        </button>
        <button
          type="button"
          className="libre-settings-pair-btn"
          onClick={() => setScanOpen(true)}
          title={
            isMobile
              ? "Open the phone's camera to scan a QR from your Mac's Settings"
              : "Open the camera to scan a QR (useful for testing on desktop)"
          }
        >
          <Icon icon={camera} size="xs" color="currentColor" />
          <span>{t("settings.scanQrFromMac")}</span>
        </button>
      </div>

      <p className="libre-settings-note">
        On the host: run{" "}
        <code>OLLAMA_HOST=0.0.0.0:11434 ollama serve</code> so the
        daemon listens on the tailnet interface, not just localhost.
        The default macOS Ollama install binds to 127.0.0.1 only —
        the phone won't reach it without the env override.
      </p>

      {qrOpen && (
        <div
          className="libre-settings-qr-modal"
          role="dialog"
          aria-label={t("settings.pairYourPhone")}
          onClick={() => setQrOpen(false)}
        >
          <div
            className="libre-settings-qr-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="libre-settings-qr-title">
              {t("settings.pairYourPhone")}
            </div>
            <p className="libre-settings-qr-blurb">
              On the phone: open <strong>Settings → AI &amp; API →
              Assistant host</strong>, tap <strong>Scan QR from
              Mac</strong>, then point the camera at this code.
            </p>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR code for ${host}`}
                className="libre-settings-qr-img"
              />
            ) : (
              <div className="libre-settings-qr-placeholder">
                {t("settings.generating")}
              </div>
            )}
            <div className="libre-settings-qr-host">{host}</div>
            <button
              type="button"
              className="libre-settings-pair-btn"
              onClick={() => setQrOpen(false)}
            >
              {t("settings.doneBtn")}
            </button>
          </div>
        </div>
      )}

      {scanOpen && (
        <QrScanner
          title={t("settings.scanMacQr")}
          hint="Open Settings → AI on your Mac, tap Show QR for phone, point this camera at it."
          onResult={handleScanResult}
          onCancel={() => setScanOpen(false)}
        />
      )}
        </>
      )}
    </>
  );
}

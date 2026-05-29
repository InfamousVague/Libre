import { useEffect, useMemo, useState } from "react";
import type { LanguageId } from "../../../data/types";
import ModalBackdrop from "../../Shared/ModalBackdrop";
import "./DocsImportDialog.css";

/// Rough per-page token budget. Each page's lesson call sends the
/// ~2k-token system prompt + the page's markdown (capped at ~15k
/// tokens in practice) and asks for up to ~8k tokens of output. Used
/// for the live cost estimate at the bottom of the dialog.
const AVG_TOKENS_PER_PAGE = {
  input: 4500,
  output: 5500,
};

const MODEL_PRICES: Record<ModelId, { inputPerM: number; outputPerM: number; label: string; hint: string }> = {
  "claude-haiku-4-8": {
    inputPerM: 0.8,
    outputPerM: 4,
    label: "Haiku 4.8",
    hint: "Fastest + cheapest. OK for smaller sites.",
  },
  "claude-sonnet-4-8": {
    inputPerM: 3,
    outputPerM: 15,
    label: "Sonnet 4.8",
    hint: "Solid baseline. Recommended default.",
  },
  "claude-opus-4-8": {
    inputPerM: 15,
    outputPerM: 75,
    label: "Opus 4.8",
    hint: "Highest quality. Best for reference docs.",
  },
};

type ModelId = "claude-haiku-4-8" | "claude-sonnet-4-8" | "claude-opus-4-8";

/// Language roster for docs courses. Same subset we use elsewhere —
/// the pipeline's `generate_lesson_from_docs_page` supports all of
/// these, and the workbench runtime covers exercises in each.
const LANGUAGE_OPTIONS: Array<{ id: LanguageId; label: string }> = [
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "swift", label: "Swift" },
];

export interface DocsImportStartOptions {
  bookId: string;
  title: string;
  language: LanguageId;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  requestDelayMs: number;
  embedImages: boolean;
  modelOverride?: string;
}

interface Props {
  onDismiss: () => void;
  onStart: (opts: DocsImportStartOptions) => void;
}

const DEFAULT_MAX_PAGES = 60;
const MIN_MAX_PAGES = 10;
const MAX_MAX_PAGES = 300;

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_REQUEST_DELAY = 250;

/// New-course import dialog for documentation websites. Separate from
/// `ImportDialog` (PDF-focused) because the inputs are genuinely
/// different — the PDF path asks for a file + metadata detection; the
/// docs path asks for a URL + crawl bounds + model selection.
export default function DocsImportDialog({ onDismiss, onStart }: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [language, setLanguage] = useState<LanguageId>("javascript");
  const [maxPages, setMaxPages] = useState<number>(DEFAULT_MAX_PAGES);
  const [maxDepth, setMaxDepth] = useState<number>(DEFAULT_MAX_DEPTH);
  const [embedImages, setEmbedImages] = useState<boolean>(true);
  const [model, setModel] = useState<ModelId>("claude-sonnet-4-8");
  const [urlError, setUrlError] = useState<string | null>(null);

  // Auto-suggest a title from the URL until the user edits the title
  // manually. After they touch it, we stop overwriting.
  useEffect(() => {
    if (titleTouched) return;
    const guess = suggestTitle(url);
    if (guess) setTitle(guess);
  }, [url, titleTouched]);

  // Validate URL as the user types. Errors surface inline; we disable
  // the Generate button until parse succeeds.
  useEffect(() => {
    if (!url.trim()) {
      setUrlError(null);
      return;
    }
    try {
      const u = new URL(url.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        setUrlError("URL must use http:// or https://");
      } else {
        setUrlError(null);
      }
    } catch {
      setUrlError("Not a valid URL");
    }
  }, [url]);

  const estimatedCostUsd = useMemo(() => {
    const price = MODEL_PRICES[model];
    const inputTokens = maxPages * AVG_TOKENS_PER_PAGE.input;
    const outputTokens = maxPages * AVG_TOKENS_PER_PAGE.output;
    return (
      (inputTokens / 1_000_000) * price.inputPerM +
      (outputTokens / 1_000_000) * price.outputPerM
    );
  }, [maxPages, model]);

  const canSubmit = !!url.trim() && !urlError && !!title.trim();

  function submit() {
    if (!canSubmit) return;
    const bookId = slugify(title) || `docs-${Date.now()}`;
    onStart({
      bookId,
      title: title.trim(),
      language,
      startUrl: url.trim(),
      maxPages,
      maxDepth,
      requestDelayMs: DEFAULT_REQUEST_DELAY,
      embedImages,
      modelOverride: model,
    });
  }

  return (
    <ModalBackdrop onDismiss={onDismiss} zIndex={120}>
      <div
        className="libre-docs-panel"
        role="dialog"
        aria-labelledby="libre-docs-title"
      >
        <div className="libre-docs-header">
          <div>
            <div className="libre-docs-kicker">New course</div>
            <div
              className="libre-docs-title"
              id="libre-docs-title"
            >
              Import from docs site
            </div>
          </div>
          <button
            type="button"
            className="libre-docs-close"
            onClick={onDismiss}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="libre-docs-body">
          <section className="libre-docs-section">
            <label
              className="libre-docs-section-label"
              htmlFor="libre-docs-url"
            >
              Start URL
            </label>
            <input
              id="libre-docs-url"
              type="url"
              className={`libre-docs-input ${
                urlError ? "libre-docs-input--error" : ""
              }`}
              placeholder="https://reactnative.dev/docs/getting-started"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
              autoComplete="url"
            />
            {urlError && (
              <div className="libre-docs-error">{urlError}</div>
            )}
            <div className="libre-docs-section-hint">
              Crawl is scoped to the same origin + path prefix —
              everything under the URL's "directory" gets visited, nothing
              above it or on other hosts.
            </div>
          </section>

          <section className="libre-docs-section">
            <label
              className="libre-docs-section-label"
              htmlFor="libre-docs-title-input"
            >
              Course title
            </label>
            <input
              id="libre-docs-title-input"
              type="text"
              className="libre-docs-input"
              placeholder="e.g. React Native Docs"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
            />
          </section>

          <section className="libre-docs-section">
            <label className="libre-docs-section-label">Language</label>
            <div className="libre-docs-lang-row">
              {LANGUAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`libre-docs-lang-btn ${
                    language === opt.id ? "libre-docs-lang-btn--active" : ""
                  }`}
                  onClick={() => setLanguage(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="libre-docs-section-hint">
              Sets the runtime for auto-generated exercises. The crawler
              doesn't inspect code blocks to pick one — you know the
              site better than our heuristic would.
            </div>
          </section>

          <section className="libre-docs-section libre-docs-section--two-up">
            <div className="libre-docs-slider-group">
              <label className="libre-docs-section-label">
                Max pages
                <span className="libre-docs-section-value">{maxPages}</span>
              </label>
              <input
                type="range"
                className="libre-docs-slider"
                min={MIN_MAX_PAGES}
                max={MAX_MAX_PAGES}
                step={10}
                value={maxPages}
                onChange={(e) => setMaxPages(parseInt(e.target.value, 10))}
              />
              <div className="libre-docs-slider-ticks">
                <span>{MIN_MAX_PAGES}</span>
                <span>{MAX_MAX_PAGES}</span>
              </div>
            </div>
            <div className="libre-docs-slider-group">
              <label className="libre-docs-section-label">
                Max depth
                <span className="libre-docs-section-value">{maxDepth}</span>
              </label>
              <input
                type="range"
                className="libre-docs-slider"
                min={1}
                max={5}
                step={1}
                value={maxDepth}
                onChange={(e) => setMaxDepth(parseInt(e.target.value, 10))}
              />
              <div className="libre-docs-slider-ticks">
                <span>shallow</span>
                <span>deep</span>
              </div>
            </div>
          </section>

          <section className="libre-docs-section">
            <label className="libre-docs-toggle">
              <input
                type="checkbox"
                checked={embedImages}
                onChange={(e) => setEmbedImages(e.target.checked)}
              />
              <span className="libre-docs-toggle-label">
                Embed images into the course
              </span>
            </label>
            <div className="libre-docs-section-hint">
              Downloads every image referenced on each page and inlines
              it as a data URL so the exported <code>.academy</code>{" "}
              archive is portable. Roughly doubles crawl time for
              image-heavy sites; recommended.
            </div>
          </section>

          <section className="libre-docs-section">
            <label className="libre-docs-section-label">Model</label>
            <div className="libre-docs-model-list">
              {(Object.keys(MODEL_PRICES) as ModelId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`libre-docs-model ${
                    model === id ? "libre-docs-model--active" : ""
                  }`}
                  onClick={() => setModel(id)}
                >
                  <div className="libre-docs-model-label">
                    {MODEL_PRICES[id].label}
                  </div>
                  <div className="libre-docs-model-hint">
                    {MODEL_PRICES[id].hint}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="libre-docs-estimate">
            <div className="libre-docs-estimate-label">
              Estimated cost
            </div>
            <div
              className={`libre-docs-estimate-value ${
                estimatedCostUsd > 20 ? "libre-docs-estimate-value--warn" : ""
              }`}
            >
              ~${estimatedCostUsd.toFixed(2)}
            </div>
            <div className="libre-docs-estimate-hint">
              {maxPages} pages × ~{AVG_TOKENS_PER_PAGE.output / 1000}k
              output tokens × {MODEL_PRICES[model].label}. Short pages
              cost less; API-reference pages cost more. Cancel any time.
              {estimatedCostUsd > 20 &&
                " — above $20. Consider Sonnet or a smaller page cap."}
            </div>
          </section>
        </div>

        <div className="libre-docs-footer">
          <button
            type="button"
            className="libre-docs-btn"
            onClick={onDismiss}
          >
            Cancel
          </button>
          <button
            type="button"
            className="libre-docs-btn libre-docs-btn--primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            Crawl + generate
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

/// Reasonable default title given a URL. Pulls the hostname + first
/// path segment and humanizes them. Example:
///   https://reactnative.dev/docs/getting-started
///     → "reactnative.dev · Docs"
/// The user can always edit it afterwards.
function suggestTitle(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg) {
      return `${host} · ${humanize(seg)}`;
    }
    return host;
  } catch {
    return "";
  }
}

function humanize(seg: string): string {
  return seg
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

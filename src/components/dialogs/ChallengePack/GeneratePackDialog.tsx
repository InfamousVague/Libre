import { useMemo, useState } from "react";
import type { LanguageId } from "../../../data/types";
import ModalBackdrop from "../../Shared/ModalBackdrop";
import "./GeneratePackDialog.css";

/// Rough per-challenge token budget. Each challenge call sends a
/// ~1.5k-token system prompt + a ~300-token user prompt and asks for
/// up to ~8k tokens of output (body, starter, solution, tests, hints).
/// We use these to show a live cost estimate as the learner drags the
/// count slider — good enough to set expectations without promising
/// accuracy. The user picks the model that matches their budget.
const AVG_TOKENS_PER_CHALLENGE = {
  input: 1800,
  output: 6500,
};

/// Prices as of the start of the Libre challenge-pack work. Per-1M-token
/// USD. Kept as a literal table so updates are obvious. Haiku is the
/// cheapest + fastest, Sonnet is the default, Opus is the highest-quality
/// option — matches the user's "$50-150 ceiling on Opus" decision.
const MODEL_PRICES: Record<ModelId, { inputPerM: number; outputPerM: number; label: string; hint: string }> = {
  "claude-haiku-4-8": {
    inputPerM: 0.8,
    outputPerM: 4,
    label: "Haiku 4.8",
    hint: "Fastest, cheapest. Good for drafts.",
  },
  "claude-sonnet-4-8": {
    inputPerM: 3,
    outputPerM: 15,
    label: "Sonnet 4.8",
    hint: "Solid baseline. Recommended for bulk packs.",
  },
  "claude-opus-4-8": {
    inputPerM: 15,
    outputPerM: 75,
    label: "Opus 4.8",
    hint: "Highest quality. Tests are more robust.",
  },
};

type ModelId = "claude-haiku-4-8" | "claude-sonnet-4-8" | "claude-opus-4-8";

export interface GeneratePackOptions {
  language: LanguageId;
  count: number;
  model: ModelId;
}

interface Props {
  onDismiss: () => void;
  onStart: (opts: GeneratePackOptions) => void;
}

/// Language roster for challenge packs. Subset of LanguageId — we only
/// offer languages we've thoroughly vetted the runtime + test harness
/// for. Adding a language here means both the runtime and the Rust
/// `generate_challenge` system prompt need to know about it.
const LANGUAGE_OPTIONS: Array<{ id: LanguageId; label: string }> = [
  { id: "rust", label: "Rust" },
  { id: "typescript", label: "TypeScript" },
  { id: "go", label: "Go" },
];

const DEFAULT_COUNT = 100;
const MIN_COUNT = 20;
const MAX_COUNT = 200;

export default function GeneratePackDialog({ onDismiss, onStart }: Props) {
  const [language, setLanguage] = useState<LanguageId>("rust");
  const [count, setCount] = useState<number>(DEFAULT_COUNT);
  const [model, setModel] = useState<ModelId>("claude-opus-4-8");

  const estimatedCostUsd = useMemo(() => {
    const price = MODEL_PRICES[model];
    const inputTokens = count * AVG_TOKENS_PER_CHALLENGE.input;
    const outputTokens = count * AVG_TOKENS_PER_CHALLENGE.output;
    return (
      (inputTokens / 1_000_000) * price.inputPerM +
      (outputTokens / 1_000_000) * price.outputPerM
    );
  }, [count, model]);

  return (
    <ModalBackdrop onDismiss={onDismiss} zIndex={120}>
      <div
        className="libre-genpack-panel"
        role="dialog"
        aria-labelledby="libre-genpack-title"
      >
        <div className="libre-genpack-header">
          <div>
            <div className="libre-genpack-kicker">Challenge pack</div>
            <div className="libre-genpack-title" id="libre-genpack-title">
              Generate new pack
            </div>
          </div>
          <button
            type="button"
            className="libre-genpack-close"
            onClick={onDismiss}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="libre-genpack-body">
          <section className="libre-genpack-section">
            <label className="libre-genpack-section-label">Language</label>
            <div className="libre-genpack-lang-row">
              {LANGUAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`libre-genpack-lang-btn ${
                    language === opt.id ? "libre-genpack-lang-btn--active" : ""
                  }`}
                  onClick={() => setLanguage(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="libre-genpack-section">
            <label className="libre-genpack-section-label">
              Count
              <span className="libre-genpack-section-value">{count}</span>
            </label>
            <input
              type="range"
              className="libre-genpack-slider"
              min={MIN_COUNT}
              max={MAX_COUNT}
              step={10}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value, 10))}
            />
            <div className="libre-genpack-slider-ticks">
              <span>{MIN_COUNT}</span>
              <span>{MAX_COUNT}</span>
            </div>
            <div className="libre-genpack-section-hint">
              Split roughly 40% easy, 40% medium, 20% hard across topic
              buckets (strings, arrays, iterators, concurrency, etc.).
              Saves incrementally — you can cancel midway and keep what
              has landed.
            </div>
          </section>

          <section className="libre-genpack-section">
            <label className="libre-genpack-section-label">Model</label>
            <div className="libre-genpack-model-list">
              {(Object.keys(MODEL_PRICES) as ModelId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`libre-genpack-model ${
                    model === id ? "libre-genpack-model--active" : ""
                  }`}
                  onClick={() => setModel(id)}
                >
                  <div className="libre-genpack-model-label">
                    {MODEL_PRICES[id].label}
                  </div>
                  <div className="libre-genpack-model-hint">
                    {MODEL_PRICES[id].hint}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="libre-genpack-estimate">
            <div className="libre-genpack-estimate-label">
              Estimated cost
            </div>
            <div className="libre-genpack-estimate-value">
              ~${estimatedCostUsd.toFixed(2)}
            </div>
            <div className="libre-genpack-estimate-hint">
              Back-of-envelope: {count} challenges ×{" "}
              {AVG_TOKENS_PER_CHALLENGE.output / 1000}k output tokens ×{" "}
              {MODEL_PRICES[model].label}. Actual usage will vary.
            </div>
          </section>
        </div>

        <div className="libre-genpack-footer">
          <button
            type="button"
            className="libre-genpack-btn"
            onClick={onDismiss}
          >
            Cancel
          </button>
          <button
            type="button"
            className="libre-genpack-btn libre-genpack-btn--primary"
            onClick={() => onStart({ language, count, model })}
          >
            Generate {count} challenge{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

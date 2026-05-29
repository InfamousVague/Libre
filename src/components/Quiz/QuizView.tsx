import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { check } from "@base/primitives/icon/icons/check";
import "@base/primitives/icon/icon.css";
import type { QuizLesson, QuizQuestion } from "../../data/types";
import { normalizeAnswer } from "../../data/types";
import { onCommand as onVerifierCommand } from "../../lib/verify/bus";
import { fireHaptic } from "../../lib/haptics";
import { renderMarkdown } from "../Lesson/markdown";
import "./QuizView.css";

/// Render an arbitrary markdown source through the lesson renderer
/// (markdown-it + Shiki) and mount the resulting HTML imperatively.
/// Used by quiz prompts + explanations so authored fenced code
/// (```rust let x = …```) renders as a real syntax-highlighted code
/// block instead of a wall of backtick-prefixed text.
///
/// Imperative innerHTML (not `dangerouslySetInnerHTML`) for the same
/// reason `LessonReader` uses this pattern: React 19 re-builds the
/// children on every render the prop is present even when the
/// string is identical, which would re-mount Shiki output on every
/// state tick (every keystroke / hover) inside the quiz card.
function QuizMarkdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(source).then((rendered) => {
      if (!cancelled) setHtml(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);
  useLayoutEffect(() => {
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }, [el, html]);
  return <div ref={setEl} className={className} />;
}

interface Props {
  lesson: QuizLesson;
  onComplete: () => void;
}

type QuestionState =
  | { status: "unanswered" }
  | { status: "correct" }
  | { status: "wrong" };

/// Passing threshold for the quiz — Notion issue
/// #a9c9e3d8fabb5ebe asked that a grade ≥ 80% pass the quiz
/// (was: every question must be correct). 0.8 is a permissive
/// floor that still demands the learner has the concept in hand
/// while letting a single wrong answer on a 5-question
/// checkpoint slide. Wrong answers on MCQ are also now retry-able
/// — picking again clears the "wrong" mark and runs a fresh
/// submission, so a learner who fumbles isn't stuck on a red
/// chip with no path forward.
const PASS_THRESHOLD = 0.8;

/// Renders a checkpoint quiz. Each question can be answered independently;
/// wrong answers can be retried until correct, and the lesson counts as
/// complete once the learner crosses the PASS_THRESHOLD share of correct
/// answers.
export default function QuizView({ lesson, onComplete }: Props) {
  const [state, setState] = useState<QuestionState[]>(() =>
    lesson.questions.map(() => ({ status: "unanswered" })),
  );

  // Latched once we've fired `onComplete` so a learner who passes
  // at 80% then KEEPS answering the remaining questions doesn't
  // re-trigger the completion bubble on each subsequent green
  // chip. Ref (not state) because the React render path doesn't
  // need to read it — it's purely a guard for the side-effectful
  // bubble.
  const completedRef = useRef(false);

  const correctCount = state.filter((s) => s.status === "correct").length;
  const correctShare = correctCount / Math.max(1, lesson.questions.length);
  const passed = correctShare >= PASS_THRESHOLD;

  function setQuestionState(index: number, next: QuestionState) {
    // Per-question haptic: success on correct, warning on wrong.
    // Fires BEFORE the state commit so the buzz feels like cause-
    // of-flip rather than reaction-to-flip. We don't haptic on
    // unanswered (the "reset to try again" path) because the
    // user didn't take a definitive action there.
    if (next.status === "correct") {
      void fireHaptic("notification-success");
    } else if (next.status === "wrong") {
      void fireHaptic("notification-warning");
    }
    setState((prev) => {
      const copy = prev.slice();
      copy[index] = next;
      const nextCorrect = copy.filter((s) => s.status === "correct").length;
      const nextShare = nextCorrect / Math.max(1, lesson.questions.length);
      if (!completedRef.current && nextShare >= PASS_THRESHOLD) {
        // Crossed the pass threshold. Fire a celebration haptic
        // alongside the per-question haptic above; the engine's
        // throttle collapses adjacent buzzes into one event so
        // the user feels a single confident "you passed" pulse
        // rather than two stacked.
        void fireHaptic("completion");
        // Latch so the bubble fires exactly once even if the
        // learner answers the rest of the questions afterward.
        completedRef.current = true;
        queueMicrotask(onComplete);
      }
      return copy;
    });
  }

  /// Watch-mode verifier wiring: when the cmd+K verify-course
  /// coroutine dispatches `answerQuiz` for this lesson, mark every
  /// question correct one at a time so the user can see the chips
  /// flip green in sequence (rather than snapping all at once). The
  /// completion bubble fires automatically via the existing
  /// `setQuestionState` "all green" check.
  useEffect(() => {
    const off = onVerifierCommand((cmd) => {
      if (cmd.type !== "answerQuiz") return;
      if (cmd.lessonId !== lesson.id) return;
      lesson.questions.forEach((_, i) => {
        // 220ms stagger keeps the visual rhythm slow enough to read
        // but fast enough that a 10-question quiz still finishes
        // in a couple of seconds.
        setTimeout(() => setQuestionState(i, { status: "correct" }), i * 220);
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.id, lesson.questions.length]);

  return (
    <div className="libre-quiz">
      <div className="libre-quiz-progress">
        {lesson.questions.map((_, i) => (
          <span
            key={i}
            className={`libre-quiz-pip libre-quiz-pip--${state[i].status}`}
            aria-hidden
          />
        ))}
        <span className="libre-quiz-progress-label">
          {state.filter((s) => s.status === "correct").length} / {lesson.questions.length}
        </span>
      </div>

      {lesson.questions.map((q, i) => (
        <QuestionCard
          key={i}
          index={i}
          question={q}
          state={state[i]}
          onResult={(status) => setQuestionState(i, { status })}
        />
      ))}

      {passed && (
        <div className="libre-quiz-done">
          {correctShare >= 1
            ? "nice — checkpoint cleared"
            : `nice — checkpoint cleared (${Math.round(correctShare * 100)}%)`}
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  index,
  question,
  state,
  onResult,
}: {
  index: number;
  question: QuizQuestion;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  // "Ask Libre" badge — fires the same `libre:ask-ai` event
  // the lesson reader's code-block badges use, with `kind: "quiz"`
  // so the AiAssistant builds a hint-not-answer prompt for the
  // local LLM.
  function askAi() {
    window.dispatchEvent(
      new CustomEvent("libre:ask-ai", {
        detail: { kind: "quiz", prompt: question.prompt },
      }),
    );
  }
  return (
    <div className={`libre-quiz-card libre-quiz-card--${state.status}`}>
      <div className="libre-quiz-num">{index + 1}</div>
      <div className="libre-quiz-q-body">
        <div className="libre-quiz-prompt-row">
          <QuizMarkdown
            source={question.prompt}
            className="libre-quiz-prompt"
          />
          {state.status === "wrong" && (
            <span
              className="libre-quiz-retry-pill"
              role="status"
              aria-live="polite"
            >
              Try again
            </span>
          )}
          <button
            type="button"
            className="libre-quiz-ask"
            onClick={askAi}
            title="Discuss this question with the local assistant"
            aria-label="Ask Libre for a hint"
          >
            ?
          </button>
        </div>
        {question.kind === "mcq" ? (
          <McqAnswer question={question} state={state} onResult={onResult} />
        ) : (
          <ShortAnswer question={question} state={state} onResult={onResult} />
        )}
        {state.status !== "unanswered" && question.explanation && (
          <QuizMarkdown
            source={question.explanation}
            className="libre-quiz-explanation"
          />
        )}
      </div>
    </div>
  );
}

function McqAnswer({
  question,
  state,
  onResult,
}: {
  question: Extract<QuizQuestion, { kind: "mcq" }>;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  // Lock the question once it's CORRECT — wrong answers stay
  // retry-able so a learner who misclicks or guesses can pick
  // again (Notion issue #a9c9e3d8fabb5ebe). Re-clicking after a
  // wrong answer clears the wrong-state visual on the previous
  // pick and runs a fresh submission against the new index.
  const locked = state.status === "correct";

  function submit(i: number) {
    if (locked) return;
    setPicked(i);
    onResult(i === question.correctIndex ? "correct" : "wrong");
  }

  // Wrong-state visual decoration: only paint the just-clicked
  // option as wrong, AND only while we're still in wrong-state.
  // Once the learner picks again, the wrong-state visual moves
  // to the new pick (or clears entirely if the new pick was
  // correct).
  return (
    <div className="libre-quiz-options">
      {question.options.map((opt, i) => {
        const isPicked = i === picked;
        const isCorrect = i === question.correctIndex;
        // Show the correct option as green only after the learner
        // has either landed on it OR after they've burned a wrong
        // guess — same "reveal the answer" semantic as before, but
        // staged through the retry-able state machine.
        const showCorrect =
          state.status === "correct" && isCorrect;
        const showWrong =
          state.status === "wrong" && isPicked && !isCorrect;
        const classes = [
          "libre-quiz-option",
          showCorrect ? "libre-quiz-option--correct" : "",
          showWrong ? "libre-quiz-option--wrong" : "",
        ].join(" ");
        return (
          <button
            key={i}
            className={classes}
            onClick={() => submit(i)}
            disabled={locked}
          >
            <span className="libre-quiz-option-letter">{String.fromCharCode(65 + i)}</span>
            <span>{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

function ShortAnswer({
  question,
  state,
  onResult,
}: {
  question: Extract<QuizQuestion, { kind: "short" }>;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  const [value, setValue] = useState("");
  // Track the most recently SUBMITTED value so we can clear the
  // red visual when the learner starts editing a fresh attempt.
  // Without this the input + card stayed red while the user was
  // mid-typing their next guess — visually telling them they were
  // wrong even though they hadn't submitted yet.
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);
  const committed = state.status === "correct";

  function submit() {
    if (committed) return;
    const normalized = normalizeAnswer(value);
    const ok = question.accept.some((a) => normalizeAnswer(a) === normalized);
    setLastSubmitted(value);
    onResult(ok ? "correct" : "wrong");
  }

  // Visual "is this still a wrong-state value" check: only treat
  // the input + card as wrong when the user hasn't edited their
  // input since the last (wrong) submission. As soon as they type
  // anything different, the wrong-visual clears and the
  // submit button reads as a fresh attempt.
  const isStaleWrong =
    state.status === "wrong" && value === lastSubmitted;
  const inputClasses = [
    "libre-quiz-short-input",
    isStaleWrong ? "libre-quiz-short-input--wrong" : "",
    state.status === "correct" ? "libre-quiz-short-input--correct" : "",
  ].join(" ");

  return (
    <div className="libre-quiz-short">
      <input
        className={inputClasses}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="type your answer"
        disabled={committed}
      />
      <button
        className="libre-quiz-short-submit"
        onClick={submit}
        disabled={committed || !value.trim()}
      >
        {committed ? (
          <Icon icon={check} size="xs" color="currentColor" />
        ) : isStaleWrong ? (
          "try again"
        ) : (
          "check"
        )}
      </button>
    </div>
  );
}

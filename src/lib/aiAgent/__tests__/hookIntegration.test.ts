/// Integration test for the React-level useAiAgent hook.
///
/// Asserts that the hook's React state evolves correctly in
/// response to a scripted multi-turn run — token streaming,
/// canonical assistant messages, tool dispatch, confidence
/// surfacing, usage accumulation. Uses @testing-library/react's
/// renderHook to drive the hook outside of a full app mount.
///
/// We mock the Tauri transport via `vi.mock` of the
/// `createTauriTransport` module so the hook's internal calls
/// hit our scripted version.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../aiTools/types";
import type { AgentTransport, AgentTurnResponse } from "../types";

// Mock the transport module BEFORE the hook is imported, so the
// hook's useMemo(createTauriTransport) closure picks up the
// scripted version instead of the real Tauri one.
const transportRef: { current: AgentTransport | null } = { current: null };
vi.mock("../transport", () => ({
  createTauriTransport: () => transportRef.current,
}));

// Import AFTER the mock is registered.
import { useAiAgent } from "../../../hooks/useAiAgent";

function scripted(turns: AgentTurnResponse[]): AgentTransport {
  let i = 0;
  return {
    async send(req) {
      const turn = turns[i];
      if (!turn) throw new Error("script underrun");
      i += 1;
      // Stream tokens chunk-by-chunk so the hook's chunk handler
      // exercises (chunks aren't streamed by the scripted
      // transport itself; the hook only sees the final content).
      // We DO emit the full content as a single onChunk call so
      // the streaming-token path runs.
      if (turn.content && req.onChunk) {
        for (const ch of turn.content) req.onChunk(ch);
      }
      return turn;
    },
  };
}

function tool(name: string, opts?: Partial<ToolDef>): ToolDef {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    auto: true,
    async handler() {
      return { ok: true };
    },
    ...opts,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  transportRef.current = null;
});

describe("useAiAgent integration", () => {
  it("evolves messages, usage, confidence across a multi-turn run", async () => {
    transportRef.current = scripted([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }],
        usage: { promptTokens: 50, completionTokens: 10, durationMs: 100 },
      },
      {
        content: "Done.\n<confidence>0.9</confidence>",
        usage: { promptTokens: 60, completionTokens: 20, durationMs: 150 },
      },
    ]);
    const { result } = renderHook(() =>
      useAiAgent({
        systemPrompt: "system",
        tools: [tool("noop")],
      }),
    );

    await act(async () => {
      await result.current.send("hello");
    });

    // After the run, confidence should equal the final turn's value.
    await waitFor(() => {
      expect(result.current.confidence).toBeCloseTo(0.9, 5);
    });
    // Usage should be the sum across 2 turns.
    expect(result.current.usage.turns).toBe(2);
    expect(result.current.usage.promptTokens).toBe(110);
    expect(result.current.usage.completionTokens).toBe(30);
    // The final assistant message has the cleaned content.
    const messages = result.current.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    if (lastAssistant && lastAssistant.role === "assistant") {
      expect(lastAssistant.content).toBe("Done.");
      expect(lastAssistant.content).not.toContain("<confidence>");
    }
  });

  it("auto-approve setting skips the chip path entirely", async () => {
    transportRef.current = scripted([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "gated_tool", arguments: "{}" },
        ],
      },
      { content: "Done.\n<confidence>0.85</confidence>" },
    ]);
    const { result } = renderHook(() =>
      useAiAgent({
        systemPrompt: "",
        tools: [tool("gated_tool", { auto: false })],
      }),
    );
    // Flip auto-approve on FIRST, then send.
    act(() => {
      result.current.updateSettings({
        ...result.current.settings,
        autoApprove: true,
      });
    });
    await act(async () => {
      await result.current.send("go");
    });
    // No pending approvals should ever have surfaced — the auto-
    // approve fast path runs the tool immediately.
    expect(result.current.pending).toEqual([]);
    expect(result.current.timeline).toHaveLength(1);
  });

  it("stores and applies settings updates", async () => {
    const { result } = renderHook(() =>
      useAiAgent({ systemPrompt: "", tools: [] }),
    );
    // Default is `false` — auto-approving model-authored
    // shell/file writes without user consent is a security
    // foot-gun the per-action Allow chip is meant to protect
    // against. Verify the toggle still works both ways.
    expect(result.current.settings.autoApprove).toBe(false);
    act(() => {
      result.current.updateSettings({
        ...result.current.settings,
        autoApprove: true,
        maxTurns: 30,
      });
    });
    expect(result.current.settings.autoApprove).toBe(true);
    expect(result.current.settings.maxTurns).toBe(30);
    act(() => {
      result.current.updateSettings({
        ...result.current.settings,
        autoApprove: false,
      });
    });
    expect(result.current.settings.autoApprove).toBe(false);
  });

  it("resets all run state via reset()", async () => {
    transportRef.current = scripted([
      { content: "ok\n<confidence>0.8</confidence>" },
    ]);
    const { result } = renderHook(() =>
      useAiAgent({ systemPrompt: "", tools: [] }),
    );
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(result.current.confidence).not.toBeNull();
    act(() => {
      result.current.reset();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.confidence).toBeNull();
    expect(result.current.usage.turns).toBe(0);
  });
});

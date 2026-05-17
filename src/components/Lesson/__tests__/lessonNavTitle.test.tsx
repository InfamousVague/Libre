import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
vi.mock("../../../i18n/i18n", () => ({ useT: () => (k: string) => k }));
import LessonNav from "../LessonNav";

describe("LessonNav with malformed neighbor titles", () => {
  it("does not crash when a neighbor title is undefined", () => {
    expect(() =>
      render(
        <LessonNav
          prev={{ id: "a", title: undefined as unknown as string }}
          next={{ id: "b", title: "" as unknown as string }}
          onPrev={() => {}}
          onNext={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});

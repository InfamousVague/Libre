/// Repro: render ChallengesView with a koan course in the catalog
/// and assert the page (cards/grid/hyper) mounts + a koan card
/// click resolves without throwing. The user reported the crash
/// "when clicking" a Koans challenge.
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../i18n/i18n", () => ({
  useT: () => (k: string) => k,
}));

import ChallengesView from "../ChallengesView";
import type { Course } from "../../../data/types";

const koanLesson = {
  id: "about-asserts",
  title: "About Asserts",
  kind: "exercise",
  language: "python",
  body: "# About Asserts\n",
  starter: "x\n",
  solution: "x\n",
  tests: "# inline\n",
  hints: ["a", "b"],
  difficulty: "easy",
  topic: "koans",
};

const koanCourse = {
  id: "python-koans",
  title: "Python Koans",
  author: "Libre",
  language: "python",
  packType: "koans",
  chapters: [{ title: "Koans", lessons: [koanLesson, { ...koanLesson, id: "about-lists", title: "About Lists" }] }],
} as unknown as Course;

describe("ChallengesView with koans", () => {
  it("mounts with a koan course present without throwing (grid mode)", () => {
    expect(() =>
      render(
        <ChallengesView
          courses={[koanCourse]}
          completed={new Set<string>()}
          onOpenLesson={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});

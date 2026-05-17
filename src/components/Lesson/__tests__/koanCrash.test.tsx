/// Repro for "Koans challenges crash the app when clicking" —
/// render the FULL LessonView with a real koan exercise lesson +
/// realistic props (the shape App.tsx passes when a koan card is
/// clicked on the Challenges page) and assert it mounts without
/// throwing. Surfaces the actual unminified `undefined is not an
/// object (t.length)` stack.
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../i18n/i18n", () => ({
  useT: () => (k: string) => k,
}));
// Monaco can't resolve under vitest + is irrelevant to the crash.
// Only stub Monaco's module resolution (vitest can't resolve the
// package); keep the REAL EditorPane so its render path is exercised.
vi.mock("../../../lib/monaco/setup", () => ({}));
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
vi.mock("../InlineSandbox", () => ({ default: () => null }));

import LessonView from "../LessonView";
import type { Course, Lesson } from "../../../data/types";
import { findNeighbors } from "../../../lessonHelpers";

const koan: Lesson = {
  id: "about-asserts",
  title: "About Asserts",
  kind: "exercise",
  language: "python",
  body: "# About Asserts\n\n!/usr/bin/env python\n-*- coding: utf-8 -*-\n",
  starter:
    "from runner.koan import *\n\nclass AboutAsserts(Koan):\n    def test_assert_truth(self):\n        self.assertTrue(__)\n",
  solution: "self.assertTrue(True)\n",
  tests:
    "# Tests are inline in the koan file — replace each `__` with the expected value\n",
  hints: [
    "Replace __ with a value that makes the assertion pass.",
    "assertTrue expects a truthy value.",
  ],
  difficulty: "easy",
  topic: "koans",
} as unknown as Lesson;

const koan2: Lesson = { ...koan, id: "about-attribute-access", title: "About Attribute Access" } as Lesson;

const course = {
  id: "python-koans",
  title: "Python Koans",
  language: "python",
  packType: "koans",
  chapters: [{ title: "Koans", lessons: [koan, koan2] }],
} as unknown as Course;

describe("koan lesson render (full LessonView)", () => {
  it("mounts a python-koans exercise opened from Challenges without throwing", () => {
    expect(() =>
      render(
        <LessonView
          courseId="python-koans"
          courseLanguage={course.language}
          isChallenge={false}
          lesson={koan}
          neighbors={findNeighbors(course, koan.id)}
          isCompleted={false}
          autoAdvanceFireAt={null}
          onComplete={() => {}}
          onNavigate={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});

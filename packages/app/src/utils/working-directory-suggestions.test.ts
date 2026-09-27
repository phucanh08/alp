import { describe, expect, it } from "vitest";
import { buildWorkingDirectorySuggestions } from "./working-directory-suggestions";

describe("buildWorkingDirectorySuggestions", () => {
  it("returns de-duplicated recommendations when query is empty", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/alp", "/Users/me/projects/alp"],
      serverPaths: ["/Users/me/projects/playground"],
      query: "",
    });

    expect(results).toEqual(["/Users/me/projects/alp"]);
  });

  it("keeps fuzzy recommendation matches before de-duplicated daemon suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/alp-desktop", "/Users/me/documents"],
      serverPaths: ["/Users/me/projects/alp-plan", "/Users/me/projects/alp-desktop"],
      query: "pso",
    });

    expect(results).toEqual(["/Users/me/projects/alp-desktop", "/Users/me/projects/alp-plan"]);
  });

  it("does not reinterpret daemon-ranked suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/projects/alp-desktop"],
      query: "a-query-ranked-by-the-daemon",
    });

    expect(results).toEqual(["/Users/me/projects/alp-desktop"]);
  });

  it("matches recommended paths using the complete path text", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [
        "/Users/me/archive/projects/alp-desktop",
        "/Users/me/projects/alp-desktop",
      ],
      serverPaths: [],
      query: "projects/pso",
    });

    expect(results).toEqual([
      "/Users/me/archive/projects/alp-desktop",
      "/Users/me/projects/alp-desktop",
    ]);
  });

  it("fuzzy-matches recommended paths using their full path", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/blankpage/editor"],
      serverPaths: [],
      query: "blank page editor",
    });

    expect(results).toEqual(["/Users/me/projects/blankpage/editor"]);
  });

  it("treats '~' as an active query and includes daemon suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/alp"],
      serverPaths: ["/Users/me/documents", "/Users/me/projects"],
      query: "~",
    });

    expect(results).toEqual([
      "/Users/me/projects/alp",
      "/Users/me/documents",
      "/Users/me/projects",
    ]);
  });
});

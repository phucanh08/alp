import { describe, expect, it } from "vitest";
import {
  projectDisplayNameFromProjectId,
  projectIconPlaceholderLabelFromDisplayName,
} from "./project-display-name";

describe("projectDisplayNameFromProjectId", () => {
  it("shows owner and repo for GitHub remote ids", () => {
    expect(projectDisplayNameFromProjectId("remote:github.com/getpaseo/paseo")).toBe("alp/alp");
  });

  it("shows the trailing directory name for local projects", () => {
    expect(projectDisplayNameFromProjectId("/Users/me/dev/alp")).toBe("alp");
  });
});

describe("projectIconPlaceholderLabelFromDisplayName", () => {
  it("uses repo name instead of owner for GitHub-style display names", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("alp/alp")).toBe("alp");
  });

  it("returns the original display name when it has no path separator", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("alp")).toBe("alp");
  });
});

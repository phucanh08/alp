import { describe, expect, it } from "vitest";
import { availableStarterTriggerConnections } from "./starter-trigger.js";

describe("starter trigger connections", () => {
  it("returns only concrete connections that can back the generated trigger", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-alp",
              accountLogin: "alp",
              accountType: "Organization",
              repositories: ["alp/alp"],
            },
          ],
          slack: [{ slug: "alp", teamName: "Alp" }],
          discord: [{ slug: "alp-discord", guildName: "Alp Discord" }],
          daemons: [],
          linear: [],
        },
        "alp/alp",
      ),
    ).toEqual([
      {
        id: "github:alp/alp",
        label: "GitHub — alp/alp",
        provider: "github",
        filters: { connection: "github-alp", repo: "alp/alp" },
      },
      {
        id: "slack:alp",
        label: "Slack — Alp",
        provider: "slack",
        filters: { connection: "alp" },
      },
      {
        id: "discord:alp-discord",
        label: "Discord — Alp Discord",
        provider: "discord",
        filters: { connection: "alp-discord" },
      },
    ]);
  });

  it("does not offer GitHub when the current repository is not connected", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-alp",
              accountLogin: "alp",
              accountType: "Organization",
              repositories: ["alp/hub"],
            },
          ],
          slack: [],
          discord: [],
          daemons: [],
          linear: [],
        },
        "alp/alp",
      ),
    ).toEqual([]);
  });
});

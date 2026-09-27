import { describe, expect, test } from "vitest";
import { ALP_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  getAlpBrowserIdForWebContents,
  getAlpBrowserWorkspaceId,
  isAlpBrowserWebviewAttach,
  prepareAlpBrowserWebContents,
  registerAttachedAlpBrowser,
  unregisterAlpBrowser,
  unregisterAlpBrowserFromHost,
} from "./index.js";

class FakeRenderer {
  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }
}

class FakeBrowserGuest {
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isAlpBrowserWebviewAttach({
        src: "https://example.com",
        partition: ALP_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isAlpBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:paseo-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isAlpBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedAlpBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getAlpBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getAlpBrowserWorkspaceId("browser-a")).toBe("workspace-a");
    unregisterAlpBrowser("browser-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedAlpBrowser({
      browserId: "browser-rejected-owner",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getAlpBrowserIdForWebContents(guest)).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedAlpBrowser({
      browserId: "browser-rejected-profile",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getAlpBrowserIdForWebContents(guest)).toBeNull();
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(1);
    const secondRenderer = new FakeRenderer(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedAlpBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedAlpBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getAlpBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getAlpBrowserIdForWebContents(secondGuest)).toBe("browser-second");
    unregisterAlpBrowser("browser-first");
    unregisterAlpBrowser("browser-second");
  });

  test("unregisters the same browser only from its requesting host", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(11);
    const secondRenderer = new FakeRenderer(22);
    const firstGuest = new FakeBrowserGuest(501, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(502, secondRenderer, profileSession);

    for (const [renderer, guest] of [
      [firstRenderer, firstGuest],
      [secondRenderer, secondGuest],
    ] as const) {
      registerAttachedAlpBrowser({
        browserId: "browser-shared-hosts",
        workspaceId: "workspace-shared",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
    }

    unregisterAlpBrowserFromHost(firstRenderer.id, "browser-shared-hosts");

    expect(getAlpBrowserIdForWebContents(firstGuest)).toBeNull();
    expect(getAlpBrowserIdForWebContents(secondGuest)).toBe("browser-shared-hosts");
    expect(getAlpBrowserWorkspaceId("browser-shared-hosts")).toBe("workspace-shared");
    unregisterAlpBrowser("browser-shared-hosts");
  });

  test("removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(31);
    const guest = new FakeBrowserGuest(601, renderer, profileSession);
    prepareAlpBrowserWebContents(guest);
    registerAttachedAlpBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(getAlpBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getAlpBrowserIdForWebContents(guest)).toBeNull();
  });
});

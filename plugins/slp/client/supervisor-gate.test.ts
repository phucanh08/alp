import { describe, expect, it } from "vitest";
import { gateSupervisor, isSlpEnabled } from "./supervisor-gate";

describe("isSlpEnabled", () => {
  it("reads enabled from a ready state", () => {
    expect(
      isSlpEnabled({
        status: "ready",
        revision: "r1",
        values: { enabled: false, supervisorModel: null },
      }),
    ).toBe(false);
    expect(
      isSlpEnabled({
        status: "ready",
        revision: "r1",
        values: { enabled: true, supervisorModel: null },
      }),
    ).toBe(true);
  });

  it("counts an invalid state or values outside the schema as enabled", () => {
    expect(isSlpEnabled({ status: "invalid", revision: "r1", error: "corrupt" })).toBe(true);
    expect(isSlpEnabled({ status: "ready", revision: "r1", values: { enabled: "no" } })).toBe(true);
    expect(isSlpEnabled({ status: "ready", revision: "r1", values: {} })).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function harness() {
  const reads: ReturnType<typeof deferred<boolean>>[] = [];
  const events: string[] = [];
  let refresh: () => void = () => undefined;
  const cleanup = gateSupervisor({
    readEnabled: () => {
      const read = deferred<boolean>();
      reads.push(read);
      return read.promise;
    },
    watch: (next) => {
      refresh = next;
      return () => events.push("unwatch");
    },
    show: () => {
      events.push("show");
      return () => events.push("hide");
    },
    ensure: () => events.push("ensure"),
  });
  return { reads, events, cleanup, refresh: () => refresh() };
}

describe("gateSupervisor", () => {
  it("applies only the most recent read when reads overlap", async () => {
    const h = harness();
    h.refresh();
    h.refresh();

    h.reads[1].resolve(false);
    await settle();
    h.reads[0].resolve(true);
    await settle();

    expect(h.events).toEqual([]);
  });

  it("counts a failed read as enabled", async () => {
    const h = harness();
    h.refresh();

    h.reads[0].reject(new Error("offline"));
    await settle();

    expect(h.events).toEqual(["show", "ensure"]);
  });

  it("shows and ensures once per transition to enabled", async () => {
    const h = harness();
    for (const enabled of [true, true, false, false, true]) {
      h.refresh();
      h.reads.at(-1)?.resolve(enabled);
      await settle();
    }

    expect(h.events).toEqual(["show", "ensure", "hide", "show", "ensure"]);
  });

  it("stops watching, hides the item, and ignores late reads after cleanup", async () => {
    const h = harness();
    h.refresh();
    h.reads[0].resolve(true);
    await settle();
    h.refresh();

    h.cleanup();
    h.reads[1].resolve(true);
    await settle();

    expect(h.events).toEqual(["show", "ensure", "unwatch", "hide"]);
  });
});

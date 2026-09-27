// alp-rename-keep-file: the fixture is app storage written by alp 1.0.0 under its old keys.
import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStorage } from "./fakes";
import { SETTINGS_MIGRATIONS_KEY } from "./keys";
import { renamePreRenameStorageKeys } from "./storage-key-rename";

function releasedStorage() {
  return createInMemoryKeyValueStorage({
    "@paseo:daemon-registry": '[{"serverId":"host-1"}]',
    "@paseo:client-id-v1": "client-1",
    "@paseo:app-settings": '{"theme":"dark"}',
    "@paseo:settings-migrations": '{"applied":["steer-default"]}',
    "@paseo:expo-push-token:host-1": "token-1",
    "@paseo:changes-ship-default:/repo": "pr",
    "paseo-drafts": '{"state":{"drafts":{}},"version":1}',
    "paseo:last-workspace-route-selection": '{"serverId":"host-1"}',
    "sidebar-collapsed-sections": "{}",
  });
}

function withAllKeys(storage: ReturnType<typeof createInMemoryKeyValueStorage>) {
  return { ...storage, getAllKeys: async () => [...storage.entries.keys()] };
}

describe("renamePreRenameStorageKeys", () => {
  it("copies every 1.0.0 key to its alp name and keeps the old one", async () => {
    const storage = releasedStorage();

    await renamePreRenameStorageKeys(withAllKeys(storage));

    expect(Object.fromEntries(storage.entries)).toMatchObject({
      "@alp:daemon-registry": '[{"serverId":"host-1"}]',
      "@alp:client-id-v1": "client-1",
      "@alp:app-settings": '{"theme":"dark"}',
      "@alp:expo-push-token:host-1": "token-1",
      "@alp:changes-ship-default:/repo": "pr",
      "alp-drafts": '{"state":{"drafts":{}},"version":1}',
      "alp:last-workspace-route-selection": '{"serverId":"host-1"}',
      "@paseo:daemon-registry": '[{"serverId":"host-1"}]',
      "paseo-drafts": '{"state":{"drafts":{}},"version":1}',
      "sidebar-collapsed-sections": "{}",
    });
    // Settings migrations already applied under the old key stay applied.
    expect(JSON.parse(storage.entries.get(SETTINGS_MIGRATIONS_KEY)!).applied).toEqual([
      "steer-default",
      "alp-storage-keys",
    ]);
  });

  it("never overwrites a key the renamed build already wrote", async () => {
    const storage = releasedStorage();
    storage.entries.set("@alp:client-id-v1", "client-2");

    await renamePreRenameStorageKeys(withAllKeys(storage));

    expect(storage.entries.get("@alp:client-id-v1")).toBe("client-2");
  });

  it("runs once: a key removed after the rename is not brought back", async () => {
    const storage = releasedStorage();
    await renamePreRenameStorageKeys(withAllKeys(storage));
    storage.entries.delete("@alp:changes-ship-default:/repo");

    await renamePreRenameStorageKeys(withAllKeys(storage));

    expect(storage.entries.has("@alp:changes-ship-default:/repo")).toBe(false);
  });

  it("retries on the next start when a copy does not read back", async () => {
    const storage = releasedStorage();
    const flaky = withAllKeys(storage);
    let dropWrites = true;
    flaky.setItem = async (key, value) => {
      if (!(dropWrites && key === "@alp:daemon-registry")) storage.entries.set(key, value);
    };

    await renamePreRenameStorageKeys(flaky);
    expect(storage.entries.has("@alp:daemon-registry")).toBe(false);
    expect(JSON.parse(storage.entries.get(SETTINGS_MIGRATIONS_KEY)!).applied).not.toContain(
      "alp-storage-keys",
    );

    dropWrites = false;
    await renamePreRenameStorageKeys(flaky);
    expect(storage.entries.get("@alp:daemon-registry")).toBe('[{"serverId":"host-1"}]');
  });
});

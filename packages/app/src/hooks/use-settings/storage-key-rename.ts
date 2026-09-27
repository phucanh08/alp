// alp-rename-keep-file: this module reads the storage keys alp 1.0.0 wrote before the rename.
import { readValidatedJson } from "@/storage/validated-storage";
import { SETTINGS_MIGRATIONS_KEY } from "./keys";
import { AppliedMigrationsSchema } from "./migrations";
import type { KeyValueStorage } from "./storage";

// COMPAT(paseo-storage-keys): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
// alp 1.0.0 stored saved hosts, the client id, settings, drafts, and preferences under paseo
// keys. Each one is copied to its alp key once, before anything reads storage; the old keys stay.
const STORAGE_KEY_RENAME_MIGRATION = "alp-storage-keys";
const LEGACY_KEY_PREFIX = "@paseo:";
const KEY_PREFIX = "@alp:";
const RENAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["paseo-drafts", "alp-drafts"],
  ["paseo:last-workspace-route-selection", "alp:last-workspace-route-selection"],
]);
// Retired before the rename; legacy-cleanup removes it, so there is nothing to carry over.
const SKIPPED_KEYS = new Set(["@paseo:replica-cache"]);

export interface RenameStorage extends KeyValueStorage {
  getAllKeys(): Promise<readonly string[]>;
}

function renamedKey(key: string): string | null {
  if (SKIPPED_KEYS.has(key)) return null;
  if (key.startsWith(LEGACY_KEY_PREFIX))
    return `${KEY_PREFIX}${key.slice(LEGACY_KEY_PREFIX.length)}`;
  return RENAMED_KEYS.get(key) ?? null;
}

async function readApplied(storage: KeyValueStorage): Promise<string[]> {
  const marker = await readValidatedJson(storage, SETTINGS_MIGRATIONS_KEY, AppliedMigrationsSchema);
  return marker?.applied ?? [];
}

/**
 * Copies each pre-rename key whose new key is still empty, and reads the copy back. The marker
 * is written only when every copy read back, so an interrupted run repeats on the next start
 * and one that finished never repeats: a key removed after the rename stays removed.
 */
export async function renamePreRenameStorageKeys(storage: RenameStorage): Promise<void> {
  if ((await readApplied(storage)).includes(STORAGE_KEY_RENAME_MIGRATION)) return;

  const keys = await storage.getAllKeys();
  const present = new Set(keys);
  let complete = true;
  for (const legacyKey of keys) {
    const key = renamedKey(legacyKey);
    if (key === null || present.has(key)) continue;
    const value = await storage.getItem(legacyKey);
    if (value === null) continue;
    await storage.setItem(key, value);
    if ((await storage.getItem(key)) !== value) complete = false;
  }
  if (!complete) return;

  // Read after the copies: the settings-migrations marker is itself one of the renamed keys.
  const applied = await readApplied(storage);
  await storage.setItem(
    SETTINGS_MIGRATIONS_KEY,
    JSON.stringify({ applied: [...applied, STORAGE_KEY_RENAME_MIGRATION] }),
  );
}

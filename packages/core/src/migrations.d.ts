export type Migration = { from: number; to: number; name: string; run(home: string): Promise<void> };
export const MIGRATIONS: Migration[];
export type MigrationResult = { from: number; to: number; steps: Array<{ name: string; from: number; to: number; backup: string; resumed: boolean }> };
export function migrateState(home: string, options?: {
  by?: string;
  migrations?: Migration[];
  target?: number;
  log?: { info(message: string, fields?: object): void; warn(message: string, fields?: object): void };
}): Promise<MigrationResult>;

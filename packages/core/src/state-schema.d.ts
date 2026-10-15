export const STATE_SCHEMA: number;
export const OLDEST_STATE_SCHEMA: number;
export function stateDir(home: string): string;
export function schemaFile(home: string): string;
export function migrationFile(home: string): string;
export type StateSchemaInfo = { schema: number; fresh: boolean; marked: boolean; by?: string };
export function readStateSchema(home: string): Promise<StateSchemaInfo>;
export function assertStateSupported(info: StateSchemaInfo, home: string): StateSchemaInfo;
export function writeStateSchema(home: string, schema: number, by?: string): Promise<void>;

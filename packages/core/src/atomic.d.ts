export function moveFile(from: string, to: string): Promise<void>;
export function writeAtomic(file: string, body: string | Uint8Array, mode?: number): Promise<void>;

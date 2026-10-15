/** Names accepted by the conformance runner. */
export type Profile = 'handshake' | 'wire' | 'errors' | 'limits' | 'session';
export interface ConformanceOptions {
  /** Unix socket path or Windows named pipe path. */
  socket: string;
  /** Defaults to all profiles except session. */
  profiles?: Profile[] | undefined;
  /** Required by the session profile. */
  project?: string | undefined;
  model?: string | undefined;
  /** Prompt marker that keeps the test provider running until interrupted. */
  hold?: string | undefined;
}
export interface ConformanceResult {
  id: string;
  ok: boolean;
  error?: string;
  /** A capability-dependent scenario was skipped. */
  note?: string;
}
export interface ConformanceCase {
  id: string;
  profile: Profile;
  description: string;
  hello: boolean;
  steps: Array<Record<string, unknown>>;
}
export const PROFILES: Profile[];
export const CASES: ConformanceCase[];
export const SESSION_SCENARIOS: Array<{ id: string; description: string }>;
/** Run selected profiles against an already-running disposable daemon. */
export function runConformance(options: ConformanceOptions): Promise<ConformanceResult[]>;

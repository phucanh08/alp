export type RuntimeKind = 'codex' | 'claude' | 'acp' | 'antigravity';

export type MailKind = 'question' | 'answer' | 'note' | 'steer' | 'result' | 'stalled' | 'board' | 'checkin';

export type MailEvent = {
  id: string;
  kind: MailKind;
  from: string;
  assignment: string;
  body?: string;
  replyTo?: string;
  result?: Record<string, unknown>;
  redelivered?: boolean;
  /** Informational; never steers or wakes a session by itself. */
  passive?: boolean;
  /** Delivered between turns, never steered into a running one or taken by alp_wait. */
  defer?: boolean;
  /** Turn that received the event; acknowledged when that turn completes. */
  deliveredTurn?: string;
};


export type PinKind = 'claim' | 'decision' | 'finding';

export type Pin = {
  id: string;
  /** The project root the board belongs to. */
  project: string;
  kind: PinKind;
  body: string;
  /** Project-relative files or directories, or absolute paths in an external write root; required for claims. */
  paths?: string[];
  agent: string;
  sessionId: string;
  rootId: string;
  at: string;
  /** When a claim ended, or any pin was taken down. */
  released?: string;
  /** The task the claiming assignment works on. */
  task?: string;
};

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

/** A project's task as task screens show it (schema/methods-v1.json `taskRow`). */
export type TaskRow = {
  id: string;
  title: string;
  type: string;
  priority: number;
  status: 'open' | 'in_progress' | 'review' | 'closed';
  /** Changes with every write; task.update and task.gate.resolve refuse an older one given as `ifRev`. */
  rev: number;
  parent?: string;
  assignee?: string;
  ready: boolean;
  blockedBy?: string[];
  waits?: string[];
  approvals?: Array<{ gate: string; note: string; /** Answers to pick from; any approves. */ options?: string[]; /** The user's latest rejection; the gate stays open. */ rejected?: { at: string; reason?: string } }>;
  handoff?: { outcome: string; summary: string; agent?: string };
  closed?: { reason: string; summary?: string; at: string };
  description?: string;
  labels?: string[];
  paths?: string[];
  progress?: { done: number; total: number };
  createdAt?: string;
  updatedAt: string;
};

export type LibraryKind = 'agents' | 'skills' | 'mcp' | 'hooks' | 'teams' | 'providers';
export type LibraryScope = 'library' | 'project';
export type LibrarySource = 'builtin' | 'library' | 'project';
/** Letters, digits, '.', '_' or '-', not '.' or '..'. */
export type EntryName = string;
export type LibraryEntryRow = { name: string; source: LibrarySource; overrides?: LibrarySource; description?: string; usedBy?: string[] };
export type TeamRow = { id: string; label?: string; description?: string; source: LibrarySource; overrides?: LibrarySource; error?: string };
/** language null: unset, so `default` applies. */
export type LanguageSetting = { language: string | null; applies: string; default: string };
/** Stands for a stored secret in library.get content; sent back in library.save it keeps the stored value. */
export type SecretMarker = { $secret: 'keep' };

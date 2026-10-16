/** The last path segment, for labels; the full path stays in titles. */
export function baseName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || path;
}

/** "just now", "5 min ago", "3 h ago", then a date. */
export function relativeTime(iso: string | undefined, now = Date.now()) {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(iso: string | undefined) {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const MODES: Record<string, string> = { 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'full-access': 'Full access' };
export const modeLabel = (mode: string | undefined) => (mode ? MODES[mode] ?? mode : '');

/** A session's name in lists: its title, else a short form of its id. */
export function sessionName(session: { id: string; title?: string; teamLabel?: string } | undefined, fallbackId?: string) {
  if (session?.title) return session.title;
  const id = session?.id ?? fallbackId ?? '';
  return `Session ${id.replace(/^(web_|ses_)/, '').slice(0, 6)}`;
}

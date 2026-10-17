import * as React from 'react';
import { needsInput } from '../lib/controller.js';
import { FAVICONS, faviconStatus, newlyWaiting, notificationBody, userSees } from '../lib/attention.js';
import { baseName, sessionName } from '../lib/format';
import { bucketOf } from './Sidebar';
import { useAppState } from './store';

/** The first read of a workspace's questions (question.watch, or question.list polled every 5 s on an older host) brings in ones already waiting: none of them is new within this long. */
const SETTLE_MS = 6_000;

/** Whether this browser can show notifications at all. */
export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

/**
 * The browser's notification permission, live; `request` asks for it (call it from a click: the
 * browser only asks on a user gesture).
 */
export function useNotificationPermission() {
  const [permission, setPermission] = React.useState<NotificationPermission | 'unsupported'>(() => notificationsSupported() ? Notification.permission : 'unsupported');
  // Changed in the browser's site settings meanwhile: read again when the page comes back.
  React.useEffect(() => {
    if (!notificationsSupported()) return;
    const read = () => setPermission(Notification.permission);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => { window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, []);
  const request = React.useCallback(async () => {
    if (!notificationsSupported()) return;
    try { setPermission(await Notification.requestPermission()); } catch { setPermission(Notification.permission); }
  }, []);
  return { permission, request };
}

/**
 * Paseo's page status for the workspace's sessions: the favicon (running, waiting, or plain),
 * the window title (the open session, else the workspace), and a browser notification when a
 * session starts waiting for an answer while the user does not see it. Clicking the notification
 * brings the window forward on that session.
 */
export function usePageAttention({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const state = useAppState();
  const { workspace, sessions, tree, attention, selected, focus } = state;

  // Favicon: any session running, else any waiting.
  const status = faviconStatus(sessions.list.map(session => bucketOf(session, needsInput(state, session.id))));
  React.useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
    link.type = 'image/svg+xml';
    link.href = FAVICONS[status];
    link.dataset.status = status;
  }, [status]);
  React.useEffect(() => () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) { link.href = FAVICONS.none; link.dataset.status = 'none'; }
  }, []);

  // Window title: the open session's name, else the workspace's.
  const root = tree?.rootId;
  const listed = root ? sessions.list.find(session => session.id === root) : undefined;
  const title = root ? sessionName({ id: root, title: tree?.projection.sessions[root]?.title ?? listed?.title }) : workspace ? baseName(workspace) : 'ALP';
  React.useEffect(() => {
    document.title = title;
    return () => { document.title = 'ALP'; };
  }, [title]);

  // Questions per root: the open tree's live ones, the others from question.watch (or question.list).
  // A tree just left keeps its last live count until the counts change, so a read that has not
  // seen its question yet does not drop it and bring it back as a new one.
  const remembered = React.useRef<{ attention: Record<string, number>; live: Record<string, number> }>({ attention, live: {} });
  const counts = React.useMemo(() => {
    const memory = remembered.current;
    if (memory.attention !== attention) memory.live = {};
    memory.attention = attention;
    const result: Record<string, number> = { ...attention };
    for (const [id, count] of Object.entries(memory.live)) result[id] = Math.max(result[id] ?? 0, count);
    if (tree) {
      const live = Object.keys(tree.projection.questions).length;
      result[tree.rootId] = tree.status === 'attached' ? live : Math.max(live, attention[tree.rootId] ?? 0);
      if (tree.status === 'attached') memory.live[tree.rootId] = live;
    }
    return result;
  }, [attention, tree]);
  const seen = React.useRef<{ workspace: string | null; since: number; counts: Record<string, number> }>({ workspace: null, since: Date.now(), counts: {} });
  const open = React.useRef(onOpenSession);
  open.current = onOpenSession;
  React.useEffect(() => {
    const last = seen.current;
    if (last.workspace !== workspace) {
      seen.current = { workspace, since: Date.now(), counts };
      return;
    }
    const fresh = newlyWaiting(last.counts, counts);
    last.counts = counts;
    if (!fresh.length || !notificationsSupported() || Notification.permission !== 'granted') return;
    const settling = Date.now() - last.since < SETTLE_MS;
    const page = { visible: document.visibilityState === 'visible', focused: document.hasFocus(), shown: focus ?? selected };
    for (const id of fresh) {
      const questions = tree?.rootId === id ? Object.values(tree.projection.questions) as Array<{ body?: string; askedAt?: string; sessionId?: string }> : [];
      const latest = questions.sort((a, b) => (Date.parse(b.askedAt ?? '') || 0) - (Date.parse(a.askedAt ?? '') || 0))[0];
      // While settling, only a question seen asked since the workspace opened is new.
      if (settling && !(latest && (Date.parse(latest.askedAt ?? '') || 0) >= last.since)) continue;
      if (userSees(page, id) || (latest?.sessionId && userSees(page, latest.sessionId))) continue;
      const name = sessionName(sessions.list.find(session => session.id === id) ?? { id, title: tree?.rootId === id ? tree.projection.sessions[id]?.title : undefined });
      try {
        const note = new Notification('Agent needs attention', {
          body: `${name}: ${latest?.body ? notificationBody(latest.body) : 'Waiting for your answer.'}`,
          tag: `alp-question-${id}`,
          icon: FAVICONS.attention,
        });
        note.onclick = () => { window.focus(); open.current(id); note.close(); };
      } catch {
        // Some browsers allow notifications only from a service worker: nothing to show then.
      }
    }
  }, [counts, workspace, tree, sessions, selected, focus]);
}

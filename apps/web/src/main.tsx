import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Controller } from './lib/controller.js';
import { PREFERENCES_KEY, type PreferenceStorage } from './lib/preferences.js';
import { takeLinkToken, type TokenStorage } from './lib/link-token.js';
import { App } from './app/App';
import { ControllerProvider } from './app/store';
import './styles.css';

/** The browser's localStorage when the page may use it (it throws when storage is disabled). */
function browserStorage(): PreferenceStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** This tab's sessionStorage when the page may use it. */
function tabStorage(): TokenStorage | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

// The address `alp web` opened carries its token in the fragment (#token=alpgw1.…): taken out of the
// address bar first, before anything renders, and kept in this tab's sessionStorage only, so a
// reload of this tab connects again (lib/link-token.js, docs/alp/web.md §4.2).
const linkStorage = tabStorage();
const link = takeLinkToken({ location: window.location, history: window.history, storage: linkStorage });

// One controller for the page's life. A token typed in the form is held in memory only; closing or
// reloading the tab forgets it. Only the app's preferences go to localStorage (lib/preferences.js).
const controller = new Controller({ storage: browserStorage(), linkStorage });
if (link && 'token' in link) controller.connect({ url: link.url, token: link.token, link: true });
else if (link) controller.showError(link.error);
// A terminal outlives a reload: the host keeps it for a minute and the page attaches it again. So
// does a link's token, kept in this tab for the reload.
window.addEventListener('pagehide', () => controller.disconnect({ keepTerminals: true, keepLink: true }));
// Back from the back-forward cache: the pagehide above ended the connection; a link's token connects again.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  const again = takeLinkToken({ location: window.location, history: window.history, storage: linkStorage });
  if (again && 'token' in again) controller.connect({ url: again.url, token: again.token, link: true });
});
// Another tab changed the preferences: follow it.
window.addEventListener('storage', event => { if (event.key === PREFERENCES_KEY || event.key === null) controller.reloadPreferences(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerProvider controller={controller}>
      <App />
    </ControllerProvider>
  </StrictMode>,
);

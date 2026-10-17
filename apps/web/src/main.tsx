import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Controller } from './lib/controller.js';
import { PREFERENCES_KEY, type PreferenceStorage } from './lib/preferences.js';
import { App } from './app/App';
import { ControllerProvider } from './app/store';
import './styles.css';

/** The browser's localStorage when the page may use it (it throws when storage is disabled). */
function browserStorage(): PreferenceStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

// One controller for the page's life. It holds the access token in memory only; closing or
// reloading the tab forgets it. Only the app's preferences go to localStorage (lib/preferences.js).
const controller = new Controller({ storage: browserStorage() });
window.addEventListener('pagehide', () => controller.disconnect());
// Another tab changed the preferences: follow it.
window.addEventListener('storage', event => { if (event.key === PREFERENCES_KEY || event.key === null) controller.reloadPreferences(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerProvider controller={controller}>
      <App />
    </ControllerProvider>
  </StrictMode>,
);

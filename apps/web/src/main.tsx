import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Controller } from './lib/controller.js';
import { App } from './app/App';
import { ControllerProvider } from './app/store';
import './styles.css';

// One controller for the page's life. It holds the access token in memory only; closing or
// reloading the tab forgets it.
const controller = new Controller();
window.addEventListener('pagehide', () => controller.disconnect());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerProvider controller={controller}>
      <App />
    </ControllerProvider>
  </StrictMode>,
);

// t-81b0.12 round 4: the theme tiles of Settings › Appearance draw each theme in the colours
// styles.css gives it, so the table in lib/theme-previews.js must match the stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../src/lib/preferences.js';
import { THEME_PREVIEWS } from '../src/lib/theme-previews.js';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties a theme ends with: :root, then each block naming that theme, in order. */
function themeVars(theme) {
  const vars = {};
  for (const [, head, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // The selector is what follows the last statement before the block (@import …;).
    const list = head.split(';').at(-1).split(',').map(entry => entry.trim());
    if (!list.includes(':root') && !list.includes(`:root[data-theme="${theme}"]`)) continue;
    for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[name] = value.trim();
  }
  return vars;
}

test('theme tiles: every theme but System has a preview, in the colours styles.css sets for it (t-81b0.12)', () => {
  assert.deepEqual(Object.keys(THEME_PREVIEWS).sort(), THEMES.filter(theme => theme !== 'system').sort());
  for (const [theme, preview] of Object.entries(THEME_PREVIEWS)) {
    const vars = themeVars(theme);
    assert.deepEqual(preview, {
      background: vars.background, sidebar: vars.sidebar, muted: vars['muted-foreground'], foreground: vars.foreground, accent: vars.primary,
    }, theme);
  }
});

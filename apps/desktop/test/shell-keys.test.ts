import { describe, expect, test } from 'bun:test';
import { attentionBadge, isCloseWindowKey, isDashboardKey } from '../src/shell-keys';

const key = (key: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}, type = 'keyDown') =>
  ({ type, key, meta: false, control: false, alt: false, shift: false, ...mods });

describe('isCloseWindowKey', () => {
  test('⌘W on macOS, Ctrl+W elsewhere, nothing else', () => {
    expect(isCloseWindowKey(key('w', { meta: true }), true)).toBe(true);
    expect(isCloseWindowKey(key('W', { meta: true }), true)).toBe(true);
    expect(isCloseWindowKey(key('w', { control: true }), false)).toBe(true);
    expect(isCloseWindowKey(key('w', { control: true }), true)).toBe(false);
    expect(isCloseWindowKey(key('w', { meta: true }), false)).toBe(false);
    expect(isCloseWindowKey(key('w', { meta: true, shift: true }), true)).toBe(false);
    expect(isCloseWindowKey(key('w', { meta: true, alt: true }), true)).toBe(false);
    expect(isCloseWindowKey(key('w', { meta: true }, 'keyUp'), true)).toBe(false);
    expect(isCloseWindowKey(key('q', { meta: true }), true)).toBe(false);
  });
});

describe('attentionBadge', () => {
  const ORIGIN = 'http://127.0.0.1:7433';
  test('a dot for the attention favicon on the dashboard origin only', () => {
    expect(attentionBadge([`${ORIGIN}/favicon-attention.svg`], ORIGIN)).toBe('•');
    expect(attentionBadge([`${ORIGIN}/favicon-running.svg`], ORIGIN)).toBe('');
    expect(attentionBadge([`${ORIGIN}/favicon.svg`], ORIGIN)).toBe('');
    expect(attentionBadge(['http://127.0.0.1:9999/favicon-attention.svg'], ORIGIN)).toBe('');
    expect(attentionBadge([`${ORIGIN}/favicon-attention.svg`], undefined)).toBe('');
    expect(attentionBadge(['not a url'], ORIGIN)).toBe('');
  });
});

describe('isDashboardKey', () => {
  const press = (code: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}, type = 'keyDown') =>
    ({ type, key: '', code, meta: false, control: false, alt: false, shift: false, ...mods });
  test('⌘W, ⌘1-9 and ⌥⌘1-9 go to the dashboard; the page keeps everything else', () => {
    expect(isDashboardKey(press('KeyW', { meta: true }))).toBe(true);
    expect(isDashboardKey(press('Digit1', { meta: true }))).toBe(true);
    expect(isDashboardKey(press('Digit9', { meta: true, alt: true }))).toBe(true);
    expect(isDashboardKey(press('Digit0', { meta: true }))).toBe(false);
    expect(isDashboardKey(press('KeyW', { meta: true, alt: true }))).toBe(false);
    expect(isDashboardKey(press('KeyW', { meta: true, shift: true }))).toBe(false);
    expect(isDashboardKey(press('KeyW', { control: true }))).toBe(false);
    expect(isDashboardKey(press('KeyC', { meta: true }))).toBe(false);
    expect(isDashboardKey(press('KeyW'))).toBe(false);
    expect(isDashboardKey(press('KeyW', { meta: true }, 'keyUp'))).toBe(false);
  });
});

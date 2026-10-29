import test from 'node:test';
import assert from 'node:assert/strict';

test('curate.monthly is a valid project and user setting, and only a boolean', async () => {
  const { validateSettings, validateUserSettings } = await import('../src/validation.js');
  for (const validate of [validateSettings, validateUserSettings]) {
    validate({ curate: { monthly: false } }, 'settings.json');
    validate({ curate: {} }, 'settings.json');
    assert.throws(() => validate({ curate: { monthly: 'no' } }, 'settings.json'), /curate\.monthly must be true or false/);
    assert.throws(() => validate({ curate: { weekly: true } }, 'settings.json'), /unsupported curate field/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, EFFORTS, useLiveModels, knownModel } from '@anhlp/alp-core/models';
import { fitEffort, modelEfforts } from '@anhlp/alp-core/profiles';
import { validateSettings } from '@anhlp/alp-core/validation';

const withProfile = entry => ({ team: { default: { peer: { profiles: [entry] } } } });

test('effort checks and fitting consult the live catalog when one is loaded, never beyond EFFORTS (t-086c)', t => {
  t.after(() => useLiveModels(undefined));
  // Static rows: a model no catalog lists takes any known effort; a listed one only its own.
  assert.equal(modelEfforts('codex:gpt-live-x'), undefined);
  validateSettings(withProfile('codex:gpt-live-x:high'), 's');
  assert.equal(fitEffort('codex:gpt-live-x', 'high'), 'high');

  useLiveModels([...MODELS, { runtime: 'codex', id: 'gpt-live-x', label: 'X', description: '', efforts: ['low', 'medium', 'turbo'], effort: 'turbo' }]);
  assert.deepEqual(modelEfforts('codex:gpt-live-x'), ['low', 'medium'], 'an effort ALP does not know is dropped');
  assert.equal(knownModel('codex:gpt-live-x').effort, undefined, 'a default outside EFFORTS is dropped too');
  assert.throws(() => validateSettings(withProfile('codex:gpt-live-x:high'), 's'), /codex:gpt-live-x takes effort low, medium/);
  assert.throws(() => validateSettings(withProfile('codex:gpt-live-x:turbo'), 's'), /effort turbo is unsupported/);
  validateSettings(withProfile('codex:gpt-live-x:medium'), 's');
  assert.equal(fitEffort('codex:gpt-live-x', 'high'), 'low');
  // Models the catalog does not list stay accepted with any effort ALP knows.
  validateSettings(withProfile('codex:gpt-unknown:xhigh'), 's');
  assert.equal(fitEffort('codex:gpt-unknown', 'xhigh'), 'xhigh');
  assert.ok(EFFORTS.includes('xhigh'));

  useLiveModels(undefined);
  assert.equal(modelEfforts('codex:gpt-live-x'), undefined, 'back to static rows');
});

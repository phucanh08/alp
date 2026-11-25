// t-81b0.12: the Files panel's file icons, as Paseo's (material-file-icons.ts, file-icon-svg.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { desaturateHexColor, fileIconUrl, rawFileIconSvg } from '../dist-lib/file-icons.js';

test('file icons: by extension, case-insensitive, the default for anything else', () => {
  assert.match(rawFileIconSvg('main.ts'), /#0288d1/);
  assert.equal(rawFileIconSvg('README.MD'), rawFileIconSvg('notes.md'));
  assert.notEqual(rawFileIconSvg('a.go'), rawFileIconSvg('a.py'));
  for (const name of ['LICENSE', 'Dockerfile', 'archive.', 'x.unknownext', '.env']) assert.equal(rawFileIconSvg(name), rawFileIconSvg(''), name);
});

test('file icons: colours toned toward grey at the same lightness (Paseo desaturateHexColor)', () => {
  assert.equal(desaturateHexColor('#0288d1', 1), '#0288d1');
  const grey = desaturateHexColor('#0288d1', 0);
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(grey.slice(at, at + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, grey);
  assert.equal(desaturateHexColor('#abc', 1), '#aabbcc');
  assert.equal(desaturateHexColor('none', 0.5), 'none');
  assert.equal(desaturateHexColor('#12345678', 0.5), '#12345678');
});

test('file icons: a data: SVG URL with toned colours, the same object for the same icon', () => {
  const url = fileIconUrl('a.ts');
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('#0288d1'), 'the vendor colour is toned');
  assert.ok(svg.includes(desaturateHexColor('#0288d1', 0.65)));
  assert.equal(fileIconUrl('b.ts'), url);
});

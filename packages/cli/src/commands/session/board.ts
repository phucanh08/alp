import path from 'node:path';
import { parseArgs } from 'node:util';
import { ago } from '@anhlp/alp-client/render';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

/** The project board every agent on the project shares: live claims, then decisions and findings. */

export async function board(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const projectRoot = path.resolve(values.project ?? process.cwd());
  const client = await running();
  const { pins } = await client.request('board.list', { projectRoot }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pins)); return; }
  if (!pins.length) { console.log(`The board for ${projectRoot} is empty`); return; }
  console.log(`Project board  ${projectRoot}`);
  for (const pin of pins) {
    const mark = pin.kind === 'claim' ? '⚑' : pin.kind === 'decision' ? '◆' : '•';
    console.log(`${mark} ${pin.kind.padEnd(8)} ${pin.id}  ${pin.agent}  ${ago(pin.at)} ago${pin.paths ? `  [${pin.paths.join(', ')}]` : ''}`);
    console.log(`  ${pin.body.replace(/\n/g, '\n  ')}`);
  }
}

import { parseArgs } from 'node:util';
import { alpHome } from '@anhlp/alp-client/index';
import { languageSetting, setLanguage } from '@anhlp/alp-core/user-settings';
import { UsageError } from '../_shared/usage.ts';

/** alp language: the language the user reads (ALPD §54); new sessions use it. */
export async function language(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reset: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length > 1 || (values.reset && positionals.length)) throw new UsageError();
  const state = values.reset ? await setLanguage(alpHome(), null) : positionals.length ? await setLanguage(alpHome(), positionals[0]) : await languageSetting(alpHome());
  if (values.json) console.log(JSON.stringify(state));
  else console.log(state.language ? `Language: ${state.language}` : `Language: ${state.applies} (the default; not set)`);
}

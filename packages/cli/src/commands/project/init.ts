import { initProject } from '@anhlp/alp-core/init';
import { upgradeProject } from '@anhlp/alp-core/upgrade';
import type { UpgradeResult } from '@anhlp/alp-core/upgrade';
import { seedLibrary } from '@anhlp/alp-core/library';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from '../_shared/usage.js';

export async function project(command: 'init' | 'upgrade', args: string[]) {
  if (args.length > 1) throw new UsageError();
  try {
    // init returns only created/preserved/updated; the upgrade-only fields are read under command === 'upgrade'.
    const result = await (command === 'upgrade' ? upgradeProject : initProject)(args[0] ?? process.cwd(), { library: alpHome() }) as UpgradeResult;
    console.log(`ALP initialized: ${result.created.length} files created, ${result.preserved.length} existing files preserved.`);
    // On upgrade an edited role-skills.json is offered the built-in role skills it never was (t-de1a).
    const library = await seedLibrary(alpHome(), { offerRoleSkills: command === 'upgrade' });
    if (library.created.length || library.updated.length) console.log(`Skill library ${alpHome()}: ${library.created.length} files added, ${library.updated.length} unchanged files updated.`);
    if (library.offered?.length) console.log(`New built-in skills given to roles in your edited role-skills.json: ${library.offered.join(', ')} (remove any you do not want; ALP will not add it again).`);
    if (command === 'init' && result.updated?.length) console.log(`Template model profiles refreshed: ${result.updated.join(', ')}`);
    if (command === 'upgrade') {
      console.log(`ALP upgraded: ${result.updated.length} files updated.${result.backup ? ` Backup: ${result.backup}` : ''}`);
      if (result.customInstructions.length) console.log(`Custom instructions preserved; reconcile with templates if needed: ${result.customInstructions.join(', ')}`);
      const copies = result.removed.filter(name => /^\.alp\/agents\/[^/]+$/.test(name));
      const skills = result.removed.filter(name => !copies.includes(name));
      if (skills.length) console.log(`Retired skills archived: ${skills.join(', ')}`);
      if (copies.length) console.log(`Unedited agent copies put away; the project now uses ALP's built-ins: ${copies.join(', ')}`);
      if (result.customSkills.length) console.log(`Customized retired skills preserved for review: ${result.customSkills.join(', ')}`);
    }
  } catch (error) {
    console.error(`ALP initialization failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

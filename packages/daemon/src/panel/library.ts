import { syncProjectSettings } from '@anhlp/alp-core/init';
import { MODELS } from '@anhlp/alp-core/models';
import { listProviders } from '@anhlp/alp-core/providers';
import { deleteEntry, duplicateEntry, getEntry, listEntries, renameEntry, saveEntry, setGivenSkills } from '@anhlp/alp-core/library-edit';
import { testEntry } from '@anhlp/alp-client/library-test';
import { alpHome } from '@anhlp/alp-client/index';
import { languageSetting, setLanguage } from '@anhlp/alp-core/user-settings';
import type { PluginServerContext } from './compat.js';
import { templates } from './mapping.js';
import { projectOf } from './tasks.js';
import { languageGet, languageSet, libraryDelete, libraryDuplicate, libraryGet, libraryList, libraryModels, libraryRename, librarySave, librarySkills, libraryTest } from '../shared/library.js';

/** The library Save also updates known project snapshots before acknowledging success. */
export function registerLibraryRpc(server: PluginServerContext, { home = alpHome(), projectDirectories }: { home?: string; projectDirectories?: () => Promise<string[]> } = {}) {
  async function where(directory?: string) {
    const root = directory ? await projectOf(directory) : null;
    return { root: root ?? undefined, library: home, templates };
  }
  server.handle(libraryModels, async () => {
    const models = MODELS.map(model => ({ id: `${model.runtime}:${model.id}`, label: `${model.runtime} · ${model.label}`, efforts: model.efforts, ...(model.effort ? { effort: model.effort } : {}) }));
    for (const provider of await listProviders(home)) {
      if (provider.enabled === false || provider.kind === 'antigravity') continue;
      models.push({ id: `acp:${provider.id}`, label: `${provider.label} · Provider default`, efforts: [] });
      for (const model of [...(provider.models ?? []), ...(provider.additionalModels ?? [])]) models.push({ id: `acp:${provider.id}/${model.id}`, label: `${provider.label} · ${model.label ?? model.id}`, efforts: [] });
    }
    return { models: [...new Map(models.map(model => [model.id, model])).values()] };
  });
  server.handle(libraryList, async ({ directory, kind }) => {
    const options = await where(directory);
    return { projectRoot: options.root ?? null, library: options.library, entries: await listEntries(kind, options) };
  });
  server.handle(libraryGet, async ({ directory, kind, name, scope }) => getEntry(kind, name, { ...await where(directory), ...(scope ? { scope } : {}) }));
  server.handle(librarySave, async ({ directory, kind, name, scope, content, revision }, context) => {
    const options = await where(directory);
    const result = await saveEntry(kind, name, content, { ...options, scope, ...(revision !== undefined ? { revision } : {}) });
    if (kind !== 'teams') return result;
    const directories = options.root ? [options.root] : [];
    const syncErrors: string[] = [];
    if (scope === 'library') {
      try {
        if (projectDirectories) directories.push(...await projectDirectories());
        else if (context?.paseo) {
          directories.push(...(await context.paseo.projects.list()).projects.map(project => project.projectRootPath));
          let cursor: string | undefined;
          do {
            const page = await context.paseo.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
            for (const workspace of page.entries) if (workspace.workspaceDirectory) directories.push(workspace.workspaceDirectory);
            const next = page.pageInfo.nextCursor ?? undefined;
            if (!page.pageInfo.hasMore || !next || next === cursor) break;
            cursor = next;
          } while (cursor);
        }
      } catch (cause) { syncErrors.push(`Project list: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    const roots = new Set<string>();
    let syncedProjects = 0;
    for (const directory of directories) {
      try {
        const root = await projectOf(directory);
        if (!root || roots.has(root)) continue;
        roots.add(root);
        if (await syncProjectSettings(root, { library: home, templates, teamIds: [name], replaceModels: true })) syncedProjects += 1;
      } catch (cause) { syncErrors.push(`${directory}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return { ...result, syncedProjects, syncErrors };
  });
  server.handle(librarySkills, async ({ agent, skills }) => setGivenSkills(agent, skills, { library: home }));
  server.handle(languageGet, async () => languageSetting(home));
  server.handle(languageSet, async ({ language }) => setLanguage(home, language));
  server.handle(libraryDelete, async ({ directory, kind, name, scope, revision }) => deleteEntry(kind, name, { ...await where(directory), scope, ...(revision !== undefined ? { revision } : {}) }));
  server.handle(libraryDuplicate, async ({ directory, kind, from, to, scope }) => duplicateEntry(kind, from, to, { ...await where(directory), scope }));
  server.handle(libraryRename, async ({ directory, kind, from, to, scope }) => renameEntry(kind, from, to, { ...await where(directory), scope }));
  server.handle(libraryTest, async ({ directory, kind, name, scope }) => {
    const { payload: _payload, kind: _kind, name: _name, source: _source, ...result } = await testEntry(kind, name, { ...await where(directory), ...(scope ? { scope } : {}) }) as Record<string, any>;
    return result as any;
  });
}

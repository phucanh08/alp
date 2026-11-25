import { describeFilePath } from './command-center.js';
import { describe } from './errors.js';

/**
 * The command center's file search, as Paseo's useWorkspaceFileSearch
 * (command-center/workspace-file-search.ts) without React: one request per (workspace, query),
 * sent 100 ms after the last keystroke (at once for an empty query), an answer that is no longer
 * the latest dropped, the entries of the same workspace kept on screen while the next answer
 * loads. The page calls update() on every render and reads `state`.
 */

/** Paseo's FILE_SEARCH_DEBOUNCE_MS. */
export const FILE_SEARCH_DEBOUNCE_MS = 100;

export type FileSearchState = { entries: import('./command-center.js').CommandFile[], loading: boolean, error: string | null, truncated: boolean };
export type FileSearchRequest = (query: string) => Promise<{ files: Array<{ path: string }>, truncated?: boolean }>;

export const EMPTY_FILE_SEARCH: FileSearchState = Object.freeze({ entries: [], loading: false, error: null, truncated: false });

export class FileSearch {
  state: FileSearchState = EMPTY_FILE_SEARCH;
  #source: string | null = null;
  #key: string | null = null;
  #request = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #search;
  #onChange;
  #debounceMs;

  constructor({ search, onChange = () => {}, debounceMs = FILE_SEARCH_DEBOUNCE_MS }: { search: FileSearchRequest; onChange?: (state: FileSearchState) => void; debounceMs?: number; }) {
    this.#search = search;
    this.#onChange = onChange;
    this.#debounceMs = debounceMs;
  }

  #publish(next: FileSearchState) { this.state = next; this.#onChange(next); }

  /**
   * What to search now. `source` names where (the workspace; another one drops the entries);
   * disabled, or without a source, nothing is asked and nothing shown.
   */
  update({ enabled, source, query }: { enabled: boolean; source: string | null; query: string; }) {
    const key = enabled && source ? `${source}\0${query}` : null;
    if (key === this.#key) return;
    this.#key = key;
    this.#cancel();
    if (!key) {
      this.#source = null;
      if (this.state !== EMPTY_FILE_SEARCH) this.#publish(EMPTY_FILE_SEARCH);
      return;
    }
    const sameSource = this.#source === source;
    this.#source = source;
    const request = ++this.#request;
    this.#publish({ entries: sameSource ? this.state.entries : [], loading: true, error: null, truncated: sameSource ? this.state.truncated : false });
    const run = async () => {
      this.#timer = undefined;
      try {
        const answer = await this.#search(query);
        if (request !== this.#request) return;
        this.#publish({ entries: (answer?.files ?? []).map(file => describeFilePath(file.path)), loading: false, error: null, truncated: answer?.truncated === true });
      } catch (error) {
        if (request !== this.#request) return;
        this.#publish({ entries: [], loading: false, error: describe(error).message, truncated: false });
      }
    };
    this.#timer = setTimeout(() => { void run(); }, query.trim() ? this.#debounceMs : 0);
  }

  /** Stops what is pending: its answer, when it comes, is dropped. */
  #cancel() {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#request += 1;
  }

  dispose() { this.#cancel(); this.#key = null; }
}

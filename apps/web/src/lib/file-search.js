// @ts-check
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

/**
 * @typedef {{ entries: import('./command-center.js').CommandFile[], loading: boolean, error: string | null, truncated: boolean }} FileSearchState
 * @typedef {(query: string) => Promise<{ files: Array<{ path: string }>, truncated?: boolean }>} FileSearchRequest
 */

/** @type {FileSearchState} */
export const EMPTY_FILE_SEARCH = Object.freeze({ entries: [], loading: false, error: null, truncated: false });

export class FileSearch {
  /** @type {FileSearchState} */ state = EMPTY_FILE_SEARCH;
  /** @type {string | null} */ #source = null;
  /** @type {string | null} */ #key = null;
  #request = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ #timer;
  #search;
  #onChange;
  #debounceMs;

  /** @param {{ search: FileSearchRequest, onChange?: (state: FileSearchState) => void, debounceMs?: number }} options */
  constructor({ search, onChange = () => {}, debounceMs = FILE_SEARCH_DEBOUNCE_MS }) {
    this.#search = search;
    this.#onChange = onChange;
    this.#debounceMs = debounceMs;
  }

  /** @param {FileSearchState} next */
  #publish(next) { this.state = next; this.#onChange(next); }

  /**
   * What to search now. `source` names where (the workspace; another one drops the entries);
   * disabled, or without a source, nothing is asked and nothing shown.
   * @param {{ enabled: boolean, source: string | null, query: string }} input
   */
  update({ enabled, source, query }) {
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

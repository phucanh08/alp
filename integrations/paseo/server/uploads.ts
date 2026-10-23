import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { displayName, type UploadedFile } from './upload-names.js';

/**
 * Reads a file Paseo's daemon received through its own file upload (Paseo's file.upload frames,
 * `@getpaseo/server` server/file-upload/index.js), so the provider can hand its bytes to alpd's
 * attachment store (docs/protocol/alp-json-rpc-v1.md §12.6). Paseo keeps an upload at
 * `<paseoHome>/uploads/upload_<uuid>/<sanitized file name>` and names it in the prompt by that path,
 * but the path is whatever the client put in its message: Paseo does not check it. So only a file
 * that is exactly where Paseo writes uploads is read, conservatively:
 *
 * - the path, compared as text, is `<paseoHome>/uploads/<id>/<one name>`, where `<id>` is the prompt
 *   part's own id and has Paseo's form `upload_<uuid>`; nothing else (no `..`, `.`, doubled
 *   separators, a relative or another directory's path) is read;
 * - `<paseoHome>` is resolved once with realpath (its own ancestors may be links, as /tmp is on
 *   macOS); below it `uploads` and the upload's directory must be real directories (lstat, never a
 *   link) owned by this user, and the file is opened with O_NOFOLLOW | O_NONBLOCK (a FIFO never
 *   blocks), then must be a regular file owned by this user with one link (a hard link elsewhere
 *   is refused), of exactly the declared size and at most `maxBytes`;
 * - after opening, the path's realpath must still be the expected one and name the inode opened,
 *   so a directory swapped for a link meanwhile is refused; the bytes read must be the declared size.
 *
 * Refusals name the file by its display name only, never a host path (fs errors, whose messages
 * carry paths, are never passed on). `<paseoHome>` is found as Paseo finds it (server/paseo-home.js,
 * resolvePaseoHome): PASEO_HOME, else ~/.paseo, `~` expanded, made absolute. Paseo's daemon sets
 * PASEO_HOME for itself and the plugin process it forks inherits that environment.
 */

/** Paseo's upload ids: `upload_${randomUUID()}`. */
const UPLOAD_ID = /^upload_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Paseo's home, exactly as Paseo resolves it (resolvePaseoHome in @getpaseo/server 0.11). */
export function paseoHome(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.PASEO_HOME ?? '~/.paseo';
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

export class UploadRefused extends Error {
  override name = 'UploadRefused';
}

const sameInode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;

/**
 * A reader of Paseo's uploads under `home` (default: paseoHome() at each read). `uid` is the owner
 * every directory and the file must have (default: this process's user).
 */
export function createUploadReader({ home = () => paseoHome(), uid = process.getuid?.() }: { home?: () => string; uid?: number } = {}) {
  return async function readUpload(file: UploadedFile, maxBytes: number): Promise<Uint8Array> {
    const name = displayName(file.fileName);
    const refuse = (why: string) => new UploadRefused(`ALP cannot attach ${name}: ${why}`);
    if (process.platform === 'win32' || constants.O_NOFOLLOW === undefined) throw refuse('files uploaded to Paseo can be attached on macOS and Linux only');
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw refuse('its size is not valid');
    if (file.size > maxBytes) throw refuse(`it is larger than ALP takes (${maxBytes} bytes)`);
    const notAnUpload = () => refuse('it is not a file uploaded to this Paseo daemon');
    if (typeof file.id !== 'string' || !UPLOAD_ID.test(file.id)) throw notAnUpload();
    const given = file.path;
    if (typeof given !== 'string' || given.includes('\0') || !path.isAbsolute(given) || path.normalize(given) !== given) throw notAnUpload();
    const base = home();
    const directory = path.join(base, 'uploads', file.id);
    const leaf = path.basename(given);
    if (path.dirname(given) !== directory || !leaf || leaf === '.' || leaf === '..' || path.join(directory, leaf) !== given) throw notAnUpload();

    let handle: fs.FileHandle | undefined;
    try {
      const realBase = await fs.realpath(base);
      const realUploads = path.join(realBase, 'uploads');
      const realDirectory = path.join(realUploads, file.id);
      const real = path.join(realDirectory, leaf);
      for (const dir of [realUploads, realDirectory]) {
        const info = await fs.lstat(dir);
        if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw notAnUpload();
      }
      handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || (uid !== undefined && opened.uid !== uid)) throw notAnUpload();
      if (opened.nlink !== 1) throw refuse('it has other links than Paseo\'s upload');
      if (opened.size !== file.size) throw refuse(`it holds ${opened.size} bytes, not the ${file.size} Paseo declared`);
      // Nothing on the way was swapped for a link since the checks above: the same path, the same file.
      if (await fs.realpath(real) !== real || !sameInode(await fs.stat(real), opened)) throw notAnUpload();
      const bytes = Buffer.alloc(file.size);
      let filled = 0;
      while (filled < file.size) {
        const { bytesRead } = await handle.read(bytes, filled, file.size - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, filled);
      if (filled !== file.size || extra.bytesRead !== 0) throw refuse('it changed while ALP read it');
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if (error instanceof UploadRefused) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      // ELOOP: O_NOFOLLOW met a link as the file itself.
      if (code === 'ELOOP') throw notAnUpload();
      if (code === 'ENOENT' || code === 'ENOTDIR') throw refuse('it is no longer among Paseo\'s uploads');
      throw refuse(`it could not be read${code ? ` (${code})` : ''}`);
    } finally {
      await handle?.close().catch(() => {});
    }
  };
}

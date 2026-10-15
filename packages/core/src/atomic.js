import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * Moves `from` to `to`. On Windows the move fails with EPERM, EACCES or EBUSY while another
 * process has the target open, such as a client reading it; it is tried again then.
 */
export async function moveFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 + attempt * 10));
    }
  }
}

/** Writes `file` through a temporary file beside it, so a reader sees the old or the new content. */
export async function writeAtomic(file, body, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, body, { mode });
    await moveFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

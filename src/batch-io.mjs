import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

/** @param {string} path @param {unknown} value */
export async function saveJson(path, value, io = { writeFile, rename, rm, wait: setTimeout }) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, path); break; }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || !['EPERM', 'EBUSY', 'EACCES'].includes(String(error.code)) || attempt >= 3) throw error;
        await io.wait(100 * 2 ** attempt);
      }
    }
  } finally { await io.rm(temporary, { force: true }); }
}

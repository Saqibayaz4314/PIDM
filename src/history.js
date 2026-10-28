import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function withFileLockRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // Windows readers/indexers can temporarily deny replacement of an open
      // history file. Preserve the previous manifest and retry only lock errors.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await sleep(10 * 2 ** attempt);
    }
  }
}

export async function writeHistory(root, snapshot) {
  const target = join(root, 'downloads.json');
  const temporary = target + '.tmp';
  await withFileLockRetry(async () => {
    const file = await open(temporary, 'w');
    try { await file.writeFile(snapshot); await file.sync(); }
    finally { await file.close(); }
  });
  await withFileLockRetry(() => rename(temporary, target));
}

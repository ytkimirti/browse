import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Hash runtime modules together: changing AI behavior must also flag a stale Box.
export function runtimeBuild(root) {
  const hash = createHash('sha256');
  for (const file of ['browse.mjs', 'scripts/ai.mjs', 'scripts/ai-task.mjs', 'scripts/build.mjs', 'scripts/video.mjs']) hash.update(readFileSync(join(root, file)));
  return hash.digest('hex').slice(0, 8);
}

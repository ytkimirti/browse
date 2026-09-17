import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Pinned Playwright has no recording FPS option. Adapt only its recorder at
// module load, in this daemon, without rewriting the shared installation.
export function recordingSource(source, fps) {
  const start = source.indexOf('// packages/playwright-core/src/server/videoRecorder.ts');
  const end = source.indexOf('// packages/', start + 3);
  const recorder = source.slice(start, end < 0 ? undefined : end);
  if (start < 0 || !recorder.includes('fps = 25;') || !recorder.includes('-f image2pipe -avioflags direct')) {
    throw new Error('Unsupported Playwright recorder: cannot set recording FPS. Run browse setup.');
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('Recording FPS must be an integer from 1 to 60');
  const patched = recorder.replace('fps = 25;', `fps = ${fps};`)
    // image2pipe defaults to 25 too. Both timestamps and encoder input must
    // use the capture cadence or ffmpeg stretches a 30 fps recording by 20%.
    .replace('-f image2pipe -avioflags direct', `-f image2pipe -framerate ${fps} -avioflags direct`);
  return source.slice(0, start) + patched + (end < 0 ? '' : source.slice(end));
}

export function loadRecordingPlaywright(require, pkg, fps) {
  const bundle = join(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js');
  const original = require.extensions['.js'];
  require.extensions['.js'] = (module, filename) => {
    if (filename !== bundle) return original(module, filename);
    module._compile(recordingSource(readFileSync(filename, 'utf8'), fps), filename);
  };
  try { return require(pkg); }
  finally { require.extensions['.js'] = original; }
}

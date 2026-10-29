#!/usr/bin/env node
import { existsSync } from 'node:fs';

const entrypoint = new URL('../dist/src/cli.js', import.meta.url);
if (!existsSync(entrypoint)) {
  console.error('defi-tool has not been built. Run bash scripts/install.sh from the project folder.');
  process.exit(1);
}

// Hide only the SQLite experimental notice; keep other runtime warnings visible.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (!(warning.name === 'ExperimentalWarning' && warning.message.startsWith('SQLite'))) {
    console.error(warning.stack ?? warning.message);
  }
});
await import(entrypoint.href);

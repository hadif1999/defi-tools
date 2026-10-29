import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('installer exposes the standalone command outside the project and preserves other programs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi tool install '));
  try {
    const install = spawnSync('bash', ['scripts/install.sh', '--bin-dir', directory], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(install.status, 0, install.stderr);
    const command = join(directory, 'defi-tool');
    const help = spawnSync(command, ['positions', 'list', '--help'], { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /defi-tool positions/);
    assert.match(help.stdout, /Examples:/);
    const again = spawnSync('bash', ['scripts/install.sh', '--bin-dir', directory], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(again.status, 0, again.stderr);
    rmSync(command);
    writeFileSync(command, 'do not overwrite');
    const collision = spawnSync('bash', ['scripts/install.sh', '--bin-dir', directory], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(collision.status, 1);
    assert.equal(readFileSync(command, 'utf8'), 'do not overwrite');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

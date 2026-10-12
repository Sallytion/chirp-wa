import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileDir } from '../src/util.js';

test('Chirp profiles use the new namespace and explicit roots outrank CHIRP_HOME', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'chirp-profiles-'));
  const variables = ['CHIRP_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME'] as const;
  const original = new Map(variables.map((key) => [key, process.env[key]]));
  try {
    delete process.env.CHIRP_HOME;
    process.env.LOCALAPPDATA = temporary;
    process.env.XDG_DATA_HOME = temporary;
    const fresh = profileDir(undefined, 'personal');
    assert.equal(fresh, join(temporary, 'chirp', 'personal'));
    assert.ok(existsSync(fresh));

    process.env.CHIRP_HOME = join(temporary, 'configured');
    assert.equal(profileDir(undefined, 'work'), join(temporary, 'configured', 'work'));
    assert.equal(
      profileDir(join(temporary, 'explicit'), 'work'),
      join(temporary, 'explicit', 'work'),
    );
    assert.throws(() => profileDir(undefined, '../outside'), /Profile names/);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});

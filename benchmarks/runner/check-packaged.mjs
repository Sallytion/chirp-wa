import assert from 'node:assert/strict';
import pty from '@lydell/node-pty';
import xterm from '@xterm/headless';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { Store } from '../../dist/store.js';

const root = mkdtempSync(join(tmpdir(), 'chirp-packaged-'));
const profile = join(root, 'fixture');
mkdirSync(profile);
const store = new Store(join(profile, 'history.sqlite'));
const jid = '123@s.whatsapp.net';
store.ingest({
  key: { remoteJid: jid, id: 'hindi' },
  pushName: 'Dwarika Sweets',
  messageTimestamp: 100,
  message: { conversation: 'दोनों आउटलेट पर उपलब्ध है।\nक्षेत्र हिन्दी नमस्ते' },
});
store.upsertChat({ jid, name: 'Dwarika Sweets And Namkeen' });
store.close();
const cli = resolve(process.argv[2] || 'dist/cli.js');
const terminal = new xterm.Terminal({ cols: 140, rows: 40, scrollback: 0, allowProposedApi: true });
const flags = readFileSync(cli, 'utf8')
  .split('\n')[0]
  .split(/\s+/)
  .filter((value) =>
    /^--(?:max-semi-space-size=\d+|optimize-for-size|disable-warning=\w+)$/.test(value),
  );
const child = pty.spawn(
  process.execPath,
  [...flags, cli, '--offline', '--data-dir', root, '--profile', 'fixture'],
  {
    cols: 140,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '3' },
  },
);
child.onData((data) => terminal.write(data));
let exited = false;
const exit = new Promise((resolve) =>
  child.onExit((event) => {
    exited = true;
    resolve(event);
  }),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (row) => terminal.buffer.active.getLine(row)?.translateToString(true) || '';
const screen = () => Array.from({ length: terminal.rows }, (_, row) => line(row)).join('\n');
async function waitFor(predicate, description) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline && !exited) await sleep(50);
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}
const checks = [];
try {
  await waitFor(
    () => line(0).includes('CHIRP') && screen().includes('Message…'),
    'offline composer',
  );
  assert.match(line(0), /CHIRP/);
  await sleep(700);
  for (const [cols, rows] of [
    [140, 40],
    [100, 30],
    [80, 24],
    [40, 18],
  ]) {
    child.resize(cols, rows);
    terminal.resize(cols, rows);
    await sleep(700);
    const top = Array.from({ length: rows }, (_, i) => line(i)).findIndex((text) =>
      text.includes('╭'),
    );
    assert.ok(top >= 0, 'Panel top must be visible');
    const buffer = terminal.buffer.active;
    const boundaries = [];
    for (let col = 0; col < cols; col++)
      if (
        buffer.getLine(top)?.getCell(col)?.getChars() === '╭' ||
        buffer.getLine(top)?.getCell(col)?.getChars() === '╮'
      )
        boundaries.push(col);
    let bottom = top + 1;
    for (
      ;
      bottom < rows && buffer.getLine(bottom)?.getCell(boundaries[0])?.getChars() !== '╰';
      bottom++
    ) {
      for (const col of boundaries)
        assert.equal(
          buffer.getLine(bottom)?.getCell(col)?.getChars(),
          '│',
          `${cols}x${rows}: broken border at row ${bottom}, column ${col}`,
        );
    }
    assert.ok(bottom < rows, 'Panel bottom must remain visible');
    const text = Array.from({ length: rows }, (_, i) => line(i)).join('\n');
    assert.match(text, /Message…/);
    assert.match(text, /दोनों|क्षेत्र/);
    checks.push({ columns: cols, rows, boundaries, top, bottom, hindi_border_intact: true });
  }
  child.resize(140, 40);
  terminal.resize(140, 40);
  await sleep(500);
  child.write(':smile');
  await waitFor(() => screen().includes('Emoji ·') && screen().includes(':smile:'), 'emoji picker');
  child.write('\t');
  const cached = new Store(join(profile, 'history.sqlite'));
  try {
    await waitFor(() => cached.draft(jid) === '😄', 'saved emoji draft');
    assert.equal(cached.draft(jid), '😄');
  } finally {
    cached.close();
  }
  writeFileSync(
    'benchmarks/indic-terminal-checks.json',
    JSON.stringify({ checks, packaged_emoji_completion: true }, null, 2),
  );
  console.log(JSON.stringify({ checks, packaged_emoji_completion: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!exited) child.write('\x11');
  await Promise.race([exit, sleep(5000)]);
  if (!exited) {
    child.kill();
    await exit;
  }
  terminal.dispose();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('chirp-packaged-'))
    throw new Error('Unexpected fixture cleanup path');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(process.exitCode || 0);

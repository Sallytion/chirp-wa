#!/usr/bin/env -S node --max-semi-space-size=1 --optimize-for-size
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import lockfile from 'proper-lockfile';
import { Store } from './store.js';
import { WhatsAppClient } from './client.js';
import { App } from './ui/App.js';
import { errorText, loadSettings, profileDir } from './util.js';
import type { Client } from './types.js';
import { archiveAccount, finishAccountReset } from './accounts.js';
import { silenceBackgroundConsole } from './ui/console.js';
import { Starting } from './ui/Starting.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command()
  .name('chirp')
  .description(
    'A full-screen WhatsApp terminal interface. QR login is the default; press P for phone pairing.',
  )
  .version(pkg.version)
  .option('--profile <name>', 'named account profile', 'default')
  .option('--data-dir <path>', 'custom profile root (or CHIRP_HOME)')
  .option('--phone <number>', 'start with phone pairing instead of QR')
  .option('--demo', 'explore the complete TUI offline with sample chats')
  .option('--offline', 'browse cached conversations without connecting to WhatsApp');

program
  .command('doctor')
  .description('Check runtime and profile diagnostics (no network connection)')
  .action(() => {
    const options = program.opts();
    const dir = profileDir(options.dataDir, options.profile);
    const store = new Store(join(dir, 'history.sqlite'));
    console.log(
      `chirp ${pkg.version}\nNode ${process.versions.node}\nPlatform ${process.platform} ${process.arch}\nInteractive terminal: ${process.stdin.isTTY && process.stdout.isTTY ? 'yes' : 'no'}\nProfile: ${dir}\nCached chats: ${store.stats().chats}\nCached messages: ${store.stats().messages}\nBackend: Baileys ${pkg.dependencies['@whiskeysockets/baileys']}\nUse chirp --demo to check the TUI without linking your account.`,
    );
    store.close();
  });
program
  .command('logout')
  .description(
    'Archive this account locally and prepare a fresh login (use TUI logout to unlink on WhatsApp)',
  )
  .option('--yes', 'confirm local logout and account archive')
  .action(async (options) => {
    if (!options.yes)
      throw new Error(
        'Run chirp logout --yes to archive this profile locally, or use Alt+L in the TUI to also unlink on WhatsApp.',
      );
    const parent = program.opts();
    const dir = profileDir(parent.dataDir, parent.profile);
    const release = await lockfile.lock(dir, { realpath: false, stale: 30_000 });
    let store: Store | undefined;
    try {
      store = new Store(join(dir, 'history.sqlite'));
      const archive = await archiveAccount(store, dir);
      console.log(
        `Local account archived in ${archive}. Restart chirp to link another account. Remove this linked device on your phone to revoke the old session.`,
      );
    } finally {
      store?.close();
      await release();
    }
  });

program.action(async (options) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'chirp needs an interactive terminal. Run it in Windows Terminal, PowerShell, Terminal, or a terminal emulator.',
    );
  if (options.phone && !/^\d{7,15}$/.test(String(options.phone).replace(/[+\s()-]/g, '')))
    throw new Error('--phone needs an international number, including country code.');
  if (options.demo && options.offline) throw new Error('Choose --demo or --offline.');
  const dir = options.demo
    ? mkdtempSync(join(tmpdir(), 'chirp-demo-'))
    : profileDir(options.dataDir, options.profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let release: (() => Promise<void>) | undefined;
  let store: Store | undefined;
  let client: Client | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let alternate = false;
  let restoreConsole: (() => void) | undefined;
  let startupCancelled = false;
  try {
    release = await lockfile.lock(dir, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      onCompromised: () => {
        instance?.unmount();
        process.exitCode = 1;
      },
    });
    restoreConsole = silenceBackgroundConsole();
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    alternate = true;
    instance = render(
      <Starting
        profile={options.profile}
        theme={loadSettings(dir).theme}
        onQuit={() => {
          startupCancelled = true;
          instance?.unmount();
        }}
      />,
      { exitOnCtrlC: false, patchConsole: false },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (startupCancelled) return;
    store = new Store(join(dir, 'history.sqlite'));
    await finishAccountReset(store, dir);
    const demo = options.demo ? await import('./demo.js') : undefined;
    client = demo
      ? new demo.DemoClient(store, dir)
      : new WhatsAppClient(
          store,
          dir,
          options.phone?.replace(/[+\s()-]/g, ''),
          () => loadSettings(dir).notifications,
        );
    if (options.demo) await client.connect();
    if (options.offline)
      client.state = {
        ...client.state,
        connection: 'offline',
        notice: 'Offline · browsing cached history · sending is disabled',
      };
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (startupCancelled) return;
    instance.rerender(
      <App
        store={store}
        client={client}
        dir={dir}
        profile={options.profile}
        demo={options.demo}
        settings={loadSettings(dir)}
        initialJid={demo?.DEMO_JID}
      />,
    );
    const shutdown = () => instance?.unmount();
    process.once('SIGTERM', shutdown);
    process.once('SIGHUP', shutdown);
    if (!options.demo && !options.offline) void client.connect();
    await instance.waitUntilExit();
    process.off('SIGTERM', shutdown);
    process.off('SIGHUP', shutdown);
  } finally {
    try {
      instance?.unmount();
      if (alternate) process.stdout.write('\x1b[?25h\x1b[?1049l');
      await client?.stop();
      store?.close();
      await release?.();
      if (options.demo) await rm(dir, { recursive: true, force: true });
    } finally {
      restoreConsole?.();
    }
  }
});

program
  .parseAsync()
  .catch((error) => {
    console.error(
      `chirp: ${errorText(error).includes('Lock file is already being held') ? 'This profile is already open in another terminal. Use a different --profile or close the other session.' : errorText(error)}`,
    );
    process.exitCode = 1;
  })
  .then(async () => {
    // All action cleanup (credentials, logs, SQLite and profile lock) has finished.
    // Windows ConPTY can otherwise retain the process after its event loop drains.
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    );
    process.exit(process.exitCode || 0);
  });

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import type { Settings } from './types.js';

// Strip terminal escape/control sequences from untrusted WhatsApp content.
export function safeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function jidFor(value: string): string {
  if (/^[\d-]+@(?:s\.whatsapp\.net|g\.us|lid)$/.test(value)) return value;
  const digits = value.replace(/[+\s()-]/g, '');
  if (!/^\d{7,15}$/.test(digits))
    throw new Error(
      'Use an international phone number, including country code, or a WhatsApp JID.',
    );
  return `${digits}@s.whatsapp.net`;
}
export function tokens(input: string): string[] {
  const output: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = '';
      else token += c;
      started = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        output.push(token);
        token = '';
        started = false;
      }
    } else {
      token += c;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote. Put paths with spaces inside double quotes.');
  if (started) output.push(token);
  return output;
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
export function privateFile(path: string) {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows uses account ACLs. */
  }
}
export function profileDir(root: string | undefined, profile: string) {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(profile))
    throw new Error('Profile names can contain letters, numbers, _ and - (1–48 characters).');
  const override = root || process.env.CHIRP_HOME;
  if (override) return privateDir(join(resolve(override), profile));
  const dataRoot =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || homedir()
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return privateDir(join(dataRoot, 'chirp', profile));
}
export function loadSettings(dir: string): Settings {
  const defaults: Settings = { autoRead: true, notifications: false, theme: 'dark' };
  try {
    const v = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return {
      autoRead: typeof v.autoRead === 'boolean' ? v.autoRead : defaults.autoRead,
      notifications:
        typeof v.notifications === 'boolean' ? v.notifications : defaults.notifications,
      theme: v.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    return defaults;
  }
}
export function saveSettings(dir: string, settings: Settings) {
  const path = join(dir, 'settings.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : error);
}

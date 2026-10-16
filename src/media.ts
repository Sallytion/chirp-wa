import { Chalk } from 'chalk';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import open from 'open';
import { imageProcessor } from './image.js';
import { isExecutableFile } from './util.js';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

// Attachment extensions come from sender-controlled metadata. Never hand an
// executable or script to the system's default handler.
export async function openExternally(path: string, opener: (path: string) => unknown = open) {
  if (isExecutableFile(path))
    throw new Error(
      `Chirp will not open ${extname(path)} attachments because they can run programs. Save it with /download and inspect it first.`,
    );
  await opener(path);
}

// Portable RGB half-block preview: no graphics protocol or native image renderer.
export async function imagePreview(path: string, columns: number, rows: number): Promise<string> {
  const sharp = await imageProcessor();
  const { data, info } = await sharp(path, { limitInputPixels: 20_000_000 })
    .rotate()
    .resize({
      width: Math.max(1, columns),
      height: Math.max(2, rows * 2),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const color = new Chalk({ level: 3 });
  const { width, height } = info;
  const output: string[] = [];
  const pixel = (x: number, y: number) => {
    const i = (Math.min(y, height - 1) * width + x) * 4;
    const alpha = data[i + 3] / 255;
    return [
      Math.round(data[i] * alpha),
      Math.round(data[i + 1] * alpha),
      Math.round(data[i + 2] * alpha),
    ] as [number, number, number];
  };
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++)
      line += color.rgb(...pixel(x, y)).bgRgb(...pixel(x, y + 1))('▀');
    output.push(line);
  }
  return output.join('\n');
}

// Write through a temporary file so an interrupted download never leaves a
// truncated file that later looks like a complete cached attachment.
export async function saveDownload(
  file: string,
  source: AsyncIterable<Uint8Array> | Uint8Array,
  limit = MAX_MEDIA_BYTES,
): Promise<void> {
  const temp = `${file}.${randomUUID()}.part`;
  let bytes = 0;
  try {
    await pipeline(
      source instanceof Uint8Array ? Readable.from([source]) : source,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > limit) throw new Error('Media downloads are limited to 100 MB in chirp.');
          yield chunk;
        }
      },
      createWriteStream(temp, { mode: 0o600 }),
    );
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

async function cacheFiles(dir: string) {
  const media = join(dir, 'media');
  const names = await readdir(media).catch(() => [] as string[]);
  const files: { path: string; bytes: number }[] = [];
  for (const name of names) {
    const path = join(media, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) files.push({ path, bytes: info.size });
  }
  return files;
}
export async function mediaCacheUsage(dir: string): Promise<{ files: number; bytes: number }> {
  const files = await cacheFiles(dir);
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) };
}
// Downloads are re-fetched on demand; `keep` protects unsent attachment drafts.
export async function clearMediaCache(
  dir: string,
  keep: Iterable<string> = [],
): Promise<{ files: number; bytes: number }> {
  const kept = new Set([...keep].map((path) => resolve(path)));
  let files = 0;
  let bytes = 0;
  for (const file of await cacheFiles(dir)) {
    if (kept.has(resolve(file.path))) continue;
    await rm(file.path, { force: true });
    files++;
    bytes += file.bytes;
  }
  return { files, bytes };
}

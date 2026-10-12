import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageProcessor } from './image.js';
import { privateDir, safeText } from './util.js';

export interface ClipboardImage {
  type: 'image';
  path: string;
  width: number;
  height: number;
  bytes: number;
}
export type ClipboardContent = ClipboardImage | { type: 'text'; text: string };
export interface ClipboardReader {
  hasImage(): boolean;
  getImageBase64(): Promise<string>;
  hasText(): boolean;
  getText(): Promise<string>;
}
const run = promisify(execFile);
const imageLimit = 32 * 1024 * 1024;

async function linuxClipboard(): Promise<Buffer | string> {
  const program = process.env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip';
  const args = (format: string) =>
    program === 'wl-paste'
      ? ['--no-newline', '--type', format]
      : ['-selection', 'clipboard', '-out', '-target', format];
  for (const format of ['image/png', 'image/jpeg', 'image/tiff']) {
    try {
      const { stdout } = await run(program, args(format), {
        encoding: 'buffer',
        maxBuffer: imageLimit,
        timeout: 3000,
        windowsHide: true,
      });
      if (stdout.length) return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `Clipboard access needs ${program} on this Linux desktop. Install it or use Ctrl+T to attach a file.`,
        );
    }
  }
  const { stdout } = await run(program, args(program === 'wl-paste' ? 'text' : 'UTF8_STRING'), {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 3000,
    windowsHide: true,
  });
  return stdout;
}

export async function readClipboard(
  dir: string,
  reader?: ClipboardReader,
): Promise<ClipboardContent> {
  let content: Buffer | string | undefined;
  if (!reader && process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    content = await linuxClipboard();
  } else {
    let clipboard = reader;
    if (!clipboard) {
      try {
        clipboard = await import('@crosscopy/clipboard');
      } catch {
        if (process.platform !== 'linux')
          throw new Error(
            'Native clipboard access is unavailable. Reinstall with optional dependencies, or use Ctrl+T to attach a file.',
          );
        content = await linuxClipboard();
      }
    }
    if (clipboard) {
      if (clipboard.hasImage()) content = Buffer.from(await clipboard.getImageBase64(), 'base64');
      else if (clipboard.hasText()) content = await clipboard.getText();
      else throw new Error('The clipboard has no image or text to paste.');
    }
  }
  if (content === undefined) throw new Error('The clipboard has no image or text to paste.');
  if (typeof content === 'string') {
    if (content.length > 2 * 1024 * 1024)
      throw new Error('Clipboard text is too large (limit 2 MB).');
    return { type: 'text', text: safeText(content.replace(/\r\n?/g, '\n')) };
  }
  if (!content.length || content.length > imageLimit)
    throw new Error('Clipboard images must be smaller than 32 MB.');
  const sharp = await imageProcessor();
  const image = sharp(content, { limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height)
    throw new Error('The clipboard does not contain a readable image.');
  const data = await image.png().toBuffer();
  if (data.length > imageLimit) throw new Error('Clipboard images must be smaller than 32 MB.');
  const path = join(privateDir(join(dir, 'media')), `clipboard-${randomUUID()}.png`);
  await writeFile(path, data, { mode: 0o600 });
  return {
    type: 'image',
    path,
    width: metadata.width,
    height: metadata.height,
    bytes: data.length,
  };
}

import { Chalk } from 'chalk';
import { imageProcessor } from './image.js';

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

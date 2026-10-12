import { build, transformSync } from 'esbuild';
import { resolve, sep } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { lazyProtobuf } from './protobuf-lazy.mjs';
import { compactYoga } from './yoga-memory.mjs';

const widthPath = resolve('src/ui/width.ts');
// tsc has emitted the unbundled modules; remove only generated bundle directories.
// Clear protocol factories as well as chunks so SDK upgrades cannot leave stale files.
for (const folder of ['chunks', 'protocol']) {
  const output = resolve('dist', folder);
  if (!output.startsWith(resolve('dist') + sep)) throw new Error('Unexpected build output path');
  rmSync(output, { recursive: true, force: true });
}
const bundled = await build({
  entryPoints: ['src/cli.tsx'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  minify: true,
  sourcemap: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  // Native addons, optional image libraries, and logger paths retain their installed layout.
  external: ['libsignal', 'sharp', 'pino', 'jimp', '@crosscopy/clipboard', 'react-devtools-core'],
  plugins: [
    {
      name: 'terminal-cell-width',
      setup(builder) {
        builder.onResolve({ filter: /^whatsapp-rust-bridge$/ }, () => ({
          path: resolve('src/sdk-crypto.ts'),
        }));
        builder.onResolve({ filter: /^string-width$/ }, (args) => {
          if (resolve(args.importer) === widthPath) return;
          return { path: widthPath };
        });
        builder.onLoad({ filter: /[\\/]WAProto[\\/]index\.js$/ }, (args) => {
          const directory = resolve('dist/protocol');
          mkdirSync(directory, { recursive: true });
          const result = lazyProtobuf(
            readFileSync(args.path, 'utf8'),
            args.path,
            (name, contents) => {
              writeFileSync(
                resolve(directory, name),
                transformSync(contents, {
                  minify: true,
                  platform: 'node',
                  format: 'cjs',
                  target: 'node24',
                }).code,
              );
            },
          );
          return { contents: result.code, loader: 'js', resolveDir: resolve(args.path, '..') };
        });
        builder.onLoad({ filter: /[\\/]yoga-wasm-base64-esm\.js$/ }, (args) => {
          return {
            contents: compactYoga(readFileSync(args.path, 'utf8')).code,
            loader: 'js',
            resolveDir: resolve(args.path, '..'),
          };
        });
      },
    },
  ],
});
// Bundling includes third-party code; ship its license notices with the package.
const names = new Set();
const notices = [];
for (const path of Object.keys(bundled.metafile.inputs)) {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path.replaceAll('\\', '/'));
  if (!match || names.has(match[1])) continue;
  names.add(match[1]);
  const root = resolve('node_modules', match[1]);
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try {
      notices.push(`===== ${match[1]} =====\n${readFileSync(resolve(root, filename), 'utf8')}`);
      break;
    } catch {}
  }
}
writeFileSync('dist/THIRD_PARTY_LICENSES.txt', notices.join('\n\n'));
mkdirSync('benchmarks', { recursive: true });
writeFileSync('benchmarks/build-metafile.json', JSON.stringify(bundled.metafile, null, 2));

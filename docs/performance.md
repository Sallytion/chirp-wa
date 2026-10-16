# Performance and production builds

Production builds differ from source development runs. Measure the built CLI when assessing memory or terminal behavior.

## Runtime choices

- Cache at most 128 SQLite prepared statements and invalidate cached counts after database changes.
- Decode the current 60-message history page and memoize transcript rendering across editor updates.
- Search through a trigram FTS5 index instead of scanning every message, page results 50 at a time, and memoize dialog queries on the database revision.
- Scan history for contact names once per profile rather than on every connection.
- Reuse date formatters and Unicode segmenters.
- Load the emoji index on first completion request and image processing on demand.
- Bound signal-key RAM caching to 1,024 entries with a five-minute TTL and group metadata to 128 entries. Evicted signal keys remain in persistent authentication storage.
- Limit Sharp's operation cache and clear socket timers, log destinations, and application caches at shutdown.

## Build adaptations

`scripts/build.mjs` bundles JavaScript with esbuild and production React. Native and optional modules retain their installed layout. The build also:

1. Extracts generated protobuf constructors into lazy factories while preserving shared module helpers, nested types, and conversion behavior.
2. Redirects four Rust/WASM crypto utilities to equivalent Node implementations. Signal encryption and SDK MAC checks remain active.
3. Reduces Yoga's initial WASM memory to 1 MiB while retaining memory growth.
4. Applies the project's terminal-cell width calculation to Ink and wrapping libraries.

The launcher supplies `--max-semi-space-size=1 --optimize-for-size`. These flags do not impose an old-generation heap limit. The application does not force periodic garbage collection.

These changes target the installed dependencies and must be revalidated on upgrades. The protobuf tests include nonempty 64-bit values and JSON serialization of timestamped send results: extracted factories must retain the helpers used after network sends succeed.

## Validation and measurements

```sh
npm test
npm run build
npm run check:protocol
npm run check:yoga
npm ci --prefix benchmarks/runner
npm run test:terminal
```

Chirp has no published memory guarantee. Development-era measurements are not release benchmarks. Startup, history sync, emoji indexing, and media previews can increase process memory.

For Windows process measurements, run `scripts/measure-memory.ps1` in another terminal with an absolute CLI path and a fresh output filename. Record the version, Node runtime, terminal dimensions, history size, workload, and sample timestamps. Working set and private allocation overlap and must not be added together. Keep real-account records local.

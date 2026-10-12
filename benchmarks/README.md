# Benchmark and build validation tools

The runner dependencies are isolated from the application's runtime dependencies:

```sh
npm ci --prefix benchmarks/runner
```

- `npm run check:protocol` compares lazy protocol factories with the pinned SDK, including timestamped binary and JSON round trips.
- `npm run check:yoga` checks reduced initial WASM memory and allocation growth.
- `npm run test:terminal` opens the built CLI against an offline fixture to check layout at several terminal sizes and emoji completion.
- `runner/profile-runtime.mjs` records runtime heap and resource samples only when `CHIRP_RUNTIME_METRICS` supplies an output path.
- `scripts/measure-memory.ps1` samples the Windows CLI process working set, private allocation, and CPU usage. Supply an absolute CLI path and a new CSV output filename.

Generated files under this directory are ignored. Keep real-account profiles, phone numbers, drafts, and raw measurements outside the source repository. Historical development records and release snapshots are not part of Chirp's release package.

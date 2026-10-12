# Contributing to Chirp

Use Node.js 24 or newer and an interactive terminal.

```sh
npm ci
npm run dev -- --demo
```

Demo mode uses temporary data and requires no WhatsApp account. Prefer demo mode and injected test sockets when developing features.

## Checks

```sh
npm run format
npm run verify
npm run build
npm run check:protocol
npm run check:yoga
npm run check:package
```

`verify` checks formatting and TypeScript, then runs the tests. `build` generates the production CLI. Package checks inspect npm's file selection without publishing.

For terminal integration tests, install the isolated runner dependencies:

```sh
npm ci --prefix benchmarks/runner
npm run test:terminal
```

The terminal test uses an offline fixture and checks resizing, Hindi borders, emoji completion, and the packaged CLI entry point.

## Code organization

Read [the architecture guide](docs/architecture.md) before changing authentication, persistence, or rendering. Keep WhatsApp operations behind the `Client` interface. Extend the demo client when a new user flow needs an offline preview.

Use Prettier for formatting. Add tests for behavior changes, especially account identity, receipts, migrations, Unicode input, and dependency build adaptations. Preserve raw SDK payloads and deduplicate incoming events.

## Dependency upgrades

Baileys is pinned because its authentication and addressing behavior changes between releases. Production also adapts generated protobuf factories, crypto utility imports, Yoga initialization, and terminal width calculations. Run the protocol, crypto parity, Yoga, and terminal checks after relevant upgrades. See [performance notes](docs/performance.md).

## Local data

Keep authentication files, SQLite databases, downloaded media, npm credentials, and real-account benchmark records out of the repository. Use fictional test data. Optional smoke checks contact WhatsApp; `smoke:session` opens the selected linked profile and can sync its local cache. Neither smoke check sends messages or read receipts.

See [the release guide](docs/releasing.md) for packaging and publishing.

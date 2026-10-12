# Releasing chirp-wa

The package name is `chirp-wa`; its executable is `chirp`. Version 0.1.0 is the initial release candidate. The source repository is [Sallytion/chirp-wa](https://github.com/Sallytion/chirp-wa). The npm package has not been published.

## Recommended order

1. Create the public source repository when ready, and review its contents.
2. Add the real repository, homepage, and issue tracker URLs to `package.json`. Do not publish placeholder URLs.
3. Complete the checks below and install the exact tarball in a temporary location.
4. Commit and tag the verified source version.
5. Publish that tarball to npm, then create the matching GitHub release.

GitHub hosts source and collaboration; npm distributes the installable CLI. A separate GitHub Pages website is optional. The README serves as the repository landing page and npm package description.

## Package checks

```sh
npm ci
npm run verify
npm run build
npm run check:protocol
npm run check:yoga
npm ci --prefix benchmarks/runner
npm run test:terminal
npm run check:package
npm pack
```

`npm pack` rebuilds and checks package contents. The package includes the production entry point, bundled chunks, lazy protocol factories, public documentation, and licenses. Source maps, tests, local profiles, and benchmark records are excluded.

Install `chirp-wa-0.1.0.tgz` into a temporary npm prefix and run its generated `chirp` command with `--version`, `--help`, and `--demo`. Check a fresh profile's login screen before publishing. Do not use your everyday account for automated outbound tests.

## Publish later

Check the current npm requirements and package-name availability immediately before publishing. Sign in to the intended npm account and enable the required account protection. Then publish the verified tarball:

```sh
npm login
npm publish ./chirp-wa-0.1.0.tgz --access public
```

Published versions cannot be overwritten. Update the package and lockfile versions together for future releases, and keep one changelog entry per release. Mark the initial changelog entry with its actual publication date after release.

After publication, verify the public installation in a clean environment:

```sh
npm i -g chirp-wa
chirp --version
chirp --demo
```

Local installs also work with `npm i chirp-wa` followed by `npx chirp`, but global installation is the primary CLI workflow.

References: [npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/), [global installation](https://docs.npmjs.com/downloading-and-installing-packages-globally/).

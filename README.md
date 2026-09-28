# Astro actions + server islands repro

Minimal reproduction of an intermittent error when using `astro:actions` in a server island with `@astrojs/cloudflare`.

## Reproduce

```sh
pnpm install
rm -rf node_modules/.vite
pnpm dev
```

Deleting `node_modules/.vite` before starting the server is required. The error may not reproduce if Vite's dependency cache already exists.

Open http://localhost:4321 and reload the page repeatedly.

The error is intermittent. It may happen after around 20 requests, but it can also take 50, 100, or more. Eventually the dev server returns a 500 error.

The patch is disabled by default, so the error can be reproduced.

## Playwright repro

```sh
pnpm run repro:playwright
```

The harness clears the local Vite cache, starts the dev server, warms one page load, then uses one Playwright page to issue a rapid burst of reloads. It intentionally waits only for each document to commit, allowing a new navigation to overlap the previous deferred-island request.

On this macOS checkout it reproduces the persistent server-island error during the first burst:

```text
Cannot read properties of undefined (reading 'actionName')
```

On macOS it uses the installed Google Chrome binary by default. On other platforms it uses Playwright's managed Chromium. Set `PLAYWRIGHT_CHROME_PATH` for another Chromium executable, `REPRO_BURST` to change the number of overlapping reloads, and `REPRO_HEADED=1` to see the browser.

The [GitHub Actions repro workflow](.github/workflows/playwright-repro.yml) runs this command on Ubuntu with Node 24 and fails if the error is not reproduced. The [patch workflow](.github/workflows/playwright-patch.yml) enables the existing Astro patch and runs the same browser sequence with `REPRO_EXPECT=healthy`; it fails if the error reappears.

## Try the patch

Uncomment `patchedDependencies` in `pnpm-workspace.yaml`, run `pnpm install`, delete `node_modules/.vite`, and start the dev server again.

The error does not occur with the patch enabled.

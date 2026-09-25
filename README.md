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

## Try the patch

Uncomment `patchedDependencies` in `pnpm-workspace.yaml`, run `pnpm install`, delete `node_modules/.vite`, and start the dev server again.

The error does not occur with the patch enabled.

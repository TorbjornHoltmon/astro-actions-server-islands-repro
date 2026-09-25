# Astro dev: server islands make `astro:actions` importers re-evaluate on every request

## Versions

- `astro` 7.3.4
- `@astrojs/cloudflare` 14.3.3
- `vite` 8.3.0
- Node 24.19.0, pnpm, macOS (arm64)
- `output: 'server'`, no integrations

## Describe the bug

In `astro dev` with `@astrojs/cloudflare`, a page with a single server island (`server:defer`) causes every module that imports `astro:actions` to be **re-evaluated on every request**, even when nothing has changed. As a consequence, a page load sometimes runs against a **partially initialised** actions runtime and crashes:

```
TypeError: Cannot read properties of undefined (reading 'actionName')
    at page (astro/dist/core/server-islands/endpoint.js:145:21)
    ...
Internal server error: Cannot read properties of undefined (reading 'actionName')
    at Object.getComponentByRoute (astro/dist/core/environment/dev-nonrunnable.js:48:10)
    at matchRoute (astro/dist/core/routing/dev.js:31:14)
```

(Or `reading 'a'`, depending on which access hits the half-built module.) The failed module stays cached, so **every later request returns 500** until the dev server is restarted. In a larger app this also shows up as steadily growing memory in workerd, since the actions runtime and everything importing it are rebuilt on every request.

## Reproduction

The setup is one action, one server island, no UI framework, no middleware, and the adapter's default worker entry:

- `src/actions/index.ts` defines one trivial action, `a.get`.
- `src/lib/hooks.ts` imports `astro:actions`, reads `actions.a.get` at module top level (a common pattern, e.g. building query hooks from actions), and has a `console.log` at the top, so every evaluation of the module shows up in the dev log.
- `src/lib/plain.ts` is a control. It imports nothing, and also has a `console.log` at the top.
- `src/components/IslandA.astro` calls the action and imports both modules.
- `src/pages/index.astro` renders `<IslandA server:defer />`.

Steps:

1. Run `astro dev`, open `/`, and reload the page a few times, slowly. The log line from `hooks.ts` appears **again on every reload**, while the one from `plain.ts` appears only once. So every module importing `astro:actions` is re-evaluated on every request.
2. Change the page to render `<IslandA />` without `server:defer`. `hooks.ts` is now evaluated only once, like `plain.ts`. The server island is what triggers the re-evaluation.
3. Restore `server:defer`, restart with a clean `node_modules/.vite`, and reload quickly, 10–20 times in a row. At some point a reload fails with the `TypeError` above, and every request after that returns 500.

## Root cause

Two dev plugins invalidate a virtual module with `moduleGraph.invalidateModule()`, which cascades to all importers:

- `dist/core/server-islands/vite-plugin-server-islands.js` (`transform`) invalidates `\0virtual:astro:server-island-manifest` whenever islands exist. The transform filter includes the manifest module itself, so every load of the manifest invalidates it again, on every request.
- `dist/vite-plugin-head/index.js` (`invalidateComponentMetadataModule`, called from `transform`) invalidates `\0virtual:astro:component-metadata` on every transform.

With `@astrojs/cloudflare`, Astro's runtime is pre-bundled into `.vite/deps_ssr`, so these virtual modules are imported by shared pre-bundled chunks, and the cascade reaches `astro:actions` and its importers:

```
\0virtual:astro:server-island-manifest
  \0virtual:astro:manifest
    .vite/deps_ssr/server-*.js
      .vite/deps_ssr/astro_actions_runtime_entrypoints_server__js.js
        \0astro:actions
          (every module importing astro:actions)
```

The module runner then re-evaluates them on the next request. When requests overlap (a browser reloading quickly, or several islands loading at once), one request can import a module that another is still re-evaluating, and `ModuleRunner.cachedRequest` hands out its partial exports (it treats the situation as a circular import). Top-level code reading `actions` or `ACTION_QUERY_PARAMS` then throws.

Neither invalidation needs to cascade. Both virtual modules are only consumed through a per-request dynamic `import()`: `manifest.serverIslandMappings: () => import('virtual:astro:server-island-manifest')` (`dist/manifest/serialized.js`), and `await import('virtual:astro:component-metadata')` in `headElements()` (`dist/core/environment/dev-nonrunnable.js`).

## Workaround / suggested fix

We run this as a pnpm patch. In both places, reset only that module instead of invalidating it with its importers:

```js
// instead of: env.moduleGraph.invalidateModule(mod)
if (mod?.transformResult) {
  env.moduleGraph.etagToModuleMap?.delete(mod.transformResult.etag);
  mod.transformResult = null;
}
```

With this change, `hooks.ts` is evaluated once no matter how many times the page is reloaded, and rapid reloads no longer crash. Without it, rapid reloads crashed the dev server within about 10 reloads.

## Expected result

Modules importing `astro:actions` are evaluated once and only re-evaluated when their own dependencies change. Loading a page with server islands, repeatedly or concurrently, never produces a partially initialised actions runtime.

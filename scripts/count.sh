#!/usr/bin/env bash
# Deterministic signal for the bug: counts how often src/lib/hooks.ts is evaluated over N page loads.
# Unpatched Astro re-evaluates it (and astro:actions) on every request → count ≈ N + 1.
# Fixed → the module is evaluated once or twice in total.
#
# Usage: scripts/count.sh [loads]   (default 20). Requires the DEBUG-REPRO console.log in src/lib/hooks.ts.
#
# Flow: stop any dev server, wipe Vite's dep cache, start `astro dev`, wait for Vite, then N times:
# GET / and fire its server-island requests concurrently. Finally count DEBUG-REPRO lines in the log.
set -u
cd "$(dirname "$0")/.."
LOADS=${1:-20}
B=http://localhost:4321

pnpm exec astro dev stop >/dev/null 2>&1
rm -rf node_modules/.vite
pnpm exec astro dev >/dev/null 2>&1
for _ in $(seq 60); do curl -s -f -o /dev/null -m 2 "$B/@vite/client" && break; sleep 1; done

for _ in $(seq "$LOADS"); do
  page=$(curl -s -m 60 "$B/")
  grep -oE 'fetch\("/_server-islands/[^"]+"' <<<"$page" | sed -E "s#fetch\\(\"(.*)\"#$B\\1#" |
    xargs -P 4 -n 1 curl -s -o /dev/null -m 60
done

errors=$(pnpm exec astro dev logs 2>&1 | grep -ac TypeError)
echo "loads=$LOADS  TypeErrors=$errors  evaluations per module:"
pnpm exec astro dev logs 2>&1 | grep -aoE 'DEBUG-REPRO eval [^ ,"]+' | sort | uniq -c
pnpm exec astro dev stop >/dev/null 2>&1

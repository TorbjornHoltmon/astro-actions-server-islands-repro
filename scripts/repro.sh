#!/usr/bin/env bash
# Repro: in `astro dev` with the Cloudflare adapter, Astro's server-island plugin invalidates its
# manifest module on transforms — including the manifest's own transform, so it re-invalidates
# itself on every request. The invalidation cascades through Astro's pre-bundled runtime to
# `astro:actions` and everything importing it, so each page load re-evaluates them. When a page's
# server islands load concurrently (as a browser does), one of them can get a partially-initialised
# `astro:actions` → `Cannot read properties of undefined (reading 'a')`; the failed module then
# breaks every later request until the dev server restarts.
#
# Usage: scripts/repro.sh [par|seq] [runs] [loads]    (defaults: par 1 30)
#   par   → fire each page's server-island requests concurrently (like a browser)
#   seq   → fire them one after another
#   runs  → number of cold dev-server starts
#   loads → page loads per start (page + its islands); a run stops at the first failure
#   FG=1  → run `astro dev` in the foreground instead of Astro's agent auto-background mode
set -u
cd "$(dirname "$0")/.."
MODE=${1:-par}
RUNS=${2:-1}
LOADS=${3:-30}
B=http://localhost:4321
LOG=.astro/repro-dev.log

stop_server() {
  pnpm exec astro dev stop >/dev/null 2>&1
  # Foreground servers (FG=1) have no lock file: stop whatever listens on the port.
  lsof -ti "tcp:${B##*:}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
  sleep 1
}

dev_log() {
  if [ "${FG:-0}" = 1 ]; then cat "$LOG"; else pnpm exec astro dev logs 2>&1; fi
}

start_server() {
  stop_server
  rm -rf node_modules/.vite
  if [ "${FG:-0}" = 1 ]; then
    mkdir -p .astro
    # --ignore-lock skips Astro's automatic backgrounding when it detects an AI agent.
    pnpm exec astro dev --ignore-lock >"$LOG" 2>&1 &
  else
    pnpm exec astro dev >/dev/null 2>&1
  fi
  # Probe a URL Vite serves itself, so the page below is the worker's first request.
  for _ in $(seq 60); do
    curl -s -f -o /dev/null -m 2 "$B/@vite/client" && break
    sleep 1
  done
}

# One page load: GET / then its server islands (GET /_server-islands/<Name>?e=..&p=..&s=).
# Prints "/=<code> IslandA=<code> ..." and returns 1 if anything isn't 200.
load_once() {
  local page status urls tmp pids=() codes
  page=$(curl -s -m 120 -w '\n%{http_code}' "$B/")
  status=$(tail -n1 <<<"$page")
  urls=$(grep -oE 'fetch\("/_server-islands/[^"]+"' <<<"$page" | sed -E 's/fetch\("(.*)"/\1/')
  tmp=$(mktemp)
  for u in $urls; do
    if [ "$MODE" = par ]; then
      curl -s -o /dev/null -w "${u%%\?*}=%{http_code}\n" -m 120 "$B$u" >>"$tmp" &
      pids+=($!)
    else
      curl -s -o /dev/null -w "${u%%\?*}=%{http_code}\n" -m 120 "$B$u" >>"$tmp"
    fi
  done
  # Wait only for the island requests (a bare `wait` would also wait for an FG=1 dev server).
  [ ${#pids[@]} -gt 0 ] && wait "${pids[@]}"
  codes="/=$status $(sed 's#/_server-islands/##' "$tmp" | sort | tr '\n' ' ')"
  rm -f "$tmp"
  echo "$codes"
  [ "$status" = 200 ] && ! grep -qvE '^Island[A-Z]=200$' <<<"$(sed 's#/_server-islands/##' <<<"$codes" | tr ' ' '\n' | grep '^Island')"
}

run() {
  start_server
  local n codes result="ok"
  for n in $(seq "$LOADS"); do
    if ! codes=$(load_once); then
      result="FAIL at load $n/$LOADS: $codes"
      break
    fi
  done
  [ "$result" = ok ] && result="ok    $LOADS loads: $codes"
  local errors
  errors=$(dev_log | grep -aoE "TypeError: [^\\\\\"]*" | sort | uniq -c | sed -E 's/^ +//' | tr '\n' ';')
  stop_server
  if [ "$result" != "${result#FAIL}" ] || [ -n "$errors" ]; then
    echo "FAIL  ${result#FAIL at }  $errors"
    return 1
  fi
  echo "$result"
}

failed=0
for i in $(seq "$RUNS"); do
  printf '#%-3s ' "$i"
  run || failed=$((failed + 1))
done
echo "=== $MODE, $LOADS loads/run: $failed/$RUNS runs failed"

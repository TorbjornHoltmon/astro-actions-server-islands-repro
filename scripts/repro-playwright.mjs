import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import net from 'node:net';
import { platform } from 'node:os';
import { chromium } from 'playwright';

const port = Number(process.env.REPRO_PORT ?? 4321);
const maxReloads = Number(process.env.REPRO_RELOADS ?? 50);
const reloadBurst = Number(process.env.REPRO_BURST ?? 3);
const origin = `http://127.0.0.1:${port}`;
const chromePath = process.env.PLAYWRIGHT_CHROME_PATH ?? (platform() === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const headless = process.env.REPRO_HEADED !== '1';
const expectedError = "Cannot read properties of undefined (reading 'actionName')";
const expectFailure = process.env.REPRO_EXPECT !== 'healthy';

async function removeCaches() {
  await Promise.all([
    rm(new URL('../node_modules/.vite', import.meta.url), { force: true, recursive: true }),
    rm(new URL('../.astro', import.meta.url), { force: true, recursive: true }),
    rm(new URL('../.wrangler', import.meta.url), { force: true, recursive: true }),
  ]);
}

async function waitForPort() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Astro dev server did not start on ${origin} within 30 seconds.`);
}

function stop(process) {
  if (process.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
    }, 5_000);

    process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill('SIGINT');
  });
}

async function requestPageAndIsland(page, navigation) {
  const islandResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname.startsWith('/_server-islands/'),
    { timeout: 10_000 },
  );

  await navigation();
  const response = await islandResponse;
  let body = '';
  try {
    body = await response.text();
  } catch {
    // A rapid follow-up navigation can cancel an island response after Vite
    // has already reported its error. The server log is authoritative then.
  }
  return {
    body,
    status: response.status(),
    url: response.url(),
  };
}

if (chromePath) {
  await access(chromePath).catch(() => {
    throw new Error(`Chrome was not found at ${chromePath}. Set PLAYWRIGHT_CHROME_PATH to a Chromium executable.`);
  });
}
await removeCaches();

const devServer = spawn('pnpm', ['exec', 'astro', 'dev', '--ignore-lock', '--host', '127.0.0.1', '--port', String(port)], {
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: '/tmp/astro-actions-playwright-wrangler.log',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
for (const stream of [devServer.stdout, devServer.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-100_000);
    process.stdout.write(chunk);
  });
}

let browser;
try {
  await waitForPort();
  browser = await chromium.launch({ ...(chromePath ? { executablePath: chromePath } : {}), headless });
  const page = await browser.newPage();
  let failedIsland;

  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/_server-islands/') && response.status() >= 500) {
      failedIsland = { status: response.status(), url: response.url() };
    }
  });

  const warmup = await requestPageAndIsland(page, () => page.goto(origin, { waitUntil: 'domcontentloaded' }));
  if (warmup.status !== 200) {
    throw new Error(`Warm-up island request failed with HTTP ${warmup.status}: ${warmup.body}`);
  }
  console.log(`Warm-up succeeded: ${new URL(warmup.url).pathname}`);

  for (let reload = 1; reload <= maxReloads; reload += 1) {
    // A browser can start another document navigation before the preceding
    // deferred-island fetch has finished. Waiting only for `commit` keeps that
    // overlap; waiting for the island here made the previous harness healthy.
    for (let burst = 0; burst < reloadBurst; burst += 1) {
      await page.reload({ waitUntil: 'commit' });
    }
    // Give the final deferred-island request a chance to report its result.
    // Do not wait for it to settle: the point of this repro is that the next
    // navigation can cancel it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (serverOutput.includes(expectedError)) {
      if (!expectFailure) {
        throw new Error(`Patch did not prevent the failure after burst ${reload}: ${expectedError}`);
      }
      console.log(`Reproduced after burst ${reload}: ${expectedError}`);
      break;
    }

    const island = await requestPageAndIsland(page, () =>
      page.goto(`${origin}/?playwright-repro=${reload}`, { waitUntil: 'domcontentloaded' }),
    );
    if (failedIsland) {
      const failure = failedIsland;
      failedIsland = undefined;
      if (serverOutput.includes(expectedError)) {
        if (!expectFailure) {
          throw new Error(`Patch did not prevent the failure after burst ${reload}: ${expectedError}`);
        }
        console.log(`Reproduced after burst ${reload}: HTTP ${failure.status} ${failure.url}`);
        break;
      }
      throw new Error(`Island request failed with HTTP ${failure.status}, but the expected server error was not logged.`);
    }
    if (island.status >= 500 && island.body.includes(expectedError)) {
      if (!expectFailure) {
        throw new Error(`Patch did not prevent the failure after burst ${reload}: ${expectedError}`);
      }
      console.log(`Reproduced after burst ${reload}: HTTP ${island.status} ${island.url}`);
      break;
    }
    if (island.status !== 200) {
      throw new Error(`Island request failed with an unexpected HTTP ${island.status}: ${island.body}`);
    }
    console.log(`Burst ${reload}: island HTTP 200`);

    if (reload === maxReloads) {
      if (expectFailure) {
        throw new Error(`Did not reproduce after ${maxReloads} reload bursts of ${reloadBurst}.`);
      }
      console.log(`Patch held for ${maxReloads} reload bursts of ${reloadBurst}.`);
      break;
    }
  }
} finally {
  await browser?.close();
  await stop(devServer);
}

# Performance baseline

`npm run perf` rebuilds the default production bundle, measures it, and writes `perf/baseline.json`. Run it from the repository root after `npm ci`. The command exits non-zero when a sample throws, a bridge total is zero, two samples of the same size disagree at cent precision, or the on-screen bridge does not match the Node result.

The run takes several minutes. It opens headless Chromium through `scripts/cdp.mjs` and stops that browser when the sample ends.

## Run the baseline

1. From the repository root, run `npm ci`.
2. Run `npm run perf`.

Copy `perf/baseline.json` before a later run. The command overwrites that file.

A partial run cannot overwrite `perf/baseline.json`. Pass `--out` to another path when you use `--skip-build`, `--only assets`, `--only engine`, `--only browser`, or `PERF_SAMPLES` set to a value other than 5. `--only browser` still runs the engine phase, because the CSV and the fingerprint come from it. Reported numbers come from a run that uses none of these switches.

If the script says a debug port is already in use, a Chromium process from an earlier run is still listening. Stop that process and run the command again. The script picks a free port on its own.

## Read a result

`perf/baseline.json` records the machine, the git SHA the run started from, and every sample. The median is the middle sample. `min` and `max` are the fastest and slowest.

Page load, from a fresh Chromium profile, served from `dist/` with `Cache-Control: no-store`:

- `browser.coldLoad.dclMs` is `domContentLoadedEventEnd` on the navigation entry.
- `browser.coldLoad.loadMs` is `loadEventEnd`.
- `browser.coldLoad.interactiveMs` is the time until the page shows the heading "Load a sales file" and an enabled file input that accepts csv. DuckDB starts when a file is chosen, so this mark does not include it. Cold load samples come from every measured file size, so with two sizes and five runs the count is 10.

File to a finished bridge:

- `browser.files[].totalMs` is the wall time from just before the file input is set until the bridge table and the KPI row are on screen.
- `parseMs` ends when the setup panel is visible and the status text is empty. It includes DuckDB startup and the CSV read.
- `configureMs` is the script setting year, jobs, sales, and the four attributes, then waiting until Calculate bridge is enabled.
- `calculateMs` runs from that click until the bridge table is on screen.

Engine, in Node, one connection per size, after one discarded warm-up:

- `engine.sizes[].generateMs` is `createSyntheticSales`. That is the in-app sample-data path. A person who loads a CSV does not pay it.
- `engine.sizes[].bridgeMs` is `runBridge` for Design, Coating, Color (photochromic and polar), and Material, on sales, with no gross column and no cost column.
- `engine.sizes[].dataCheckMs` is the scan the tool awaits before it draws the bridge. It is not part of `bridgeMs`. `dataCheck.rows` is the row count that scan saw.
- `engine.sizes[].duckdbThreads` is DuckDB's `threads` setting on that connection.
- `engine.sizes[].fingerprint.sha256` hashes money rounded to cents and coverage shares rounded to five decimals. Raw float sums move by a fraction of a cent. `maxAbsMoneyDelta` is the largest raw gap in that size.
- `cpu.bridgeUserMs` is Node's user CPU time during `runBridge`. Divide it by `bridgeMs` to see how many cores the bridge used.

Sizes are 10,000, 300,000, and 3,000,000 rows. The browser measures the first two. Each timed series has five samples. The warm-up sample is stored and left out of the median.

Bytes:

- `build.totals` sums every file under `dist/`. `gzipBytes` is zlib gzip at the default level. `brotliBytes` is brotli quality 5.
- `build.toolPage` sums the files the local server saw by the time the harness observed the interactive mark, including the HTML document. The page sets the mark. The harness polls until it reads that mark, so a request in the gap, such as the favicon, is included.
- `build.duckdbOnFirstFile` sums the DuckDB wasm and worker files requested while the first file was loading.

The local server sends bytes with no content encoding. `npm run build:cloudflare` is a different bundle. It turns on page counts, workspaces, and AI commentary, and it replaces each wasm file with a gzip copy. This script does not run that build.

## Compare two runs

Compare a metric when `machine.cpuModel`, `machine.cores`, `machine.node`, and `machine.chromium` match. Compare medians. Treat the gap as noise when the two ranges overlap.

When a change should keep the bridge the same, `fingerprint.sha256` for each size must match, and the browser's rounded prior sales and current sales must match too.

`git.sha` is the commit checked out when the run started. `git.porcelain` lists files that were uncommitted at that moment. `machine.loadAvg` is the load when the run started. `machine.loadAvgAtEnd` is the load when the file was written.

# Performance baseline

`npm run perf` rebuilds the default production bundle, measures it, and writes `perf/baseline.json`. Run it from the repository root after `npm ci`. The command exits non-zero when a sample throws, a bridge total is zero, two samples of the same size disagree at cent precision, or the on-screen bridge does not match the Node result.

The run takes several minutes. It opens headless Chromium through `scripts/cdp.mjs` and stops that browser when the sample ends.

## Run the baseline

1. From the repository root, run `npm ci`.
2. Run `npm run perf`.

Copy `perf/baseline.json` before a later run. The command overwrites that file.

A partial run cannot overwrite `perf/baseline.json`. Pass `--out` to another path when you use `--skip-build`, `--only assets`, `--only engine`, `--only browser`, `--pick-delay` with a value other than 0, or `PERF_SAMPLES` set to a value other than 5. `--only browser` still runs the engine phase, because the CSV and the fingerprint come from it. Reported numbers come from a run that uses none of these switches.

If the script says a debug port is already in use, a Chromium process from an earlier run is still listening. Stop that process and run the command again. The script picks a free port on its own.

## Wait before choosing the file

`--pick-delay` waits after the interactive mark, then sets the file. The wait is outside `totalMs`. The default is 0, which keeps the committed baseline comparable. A non-zero value gives the idle DuckDB open time to finish before the file timer starts. The page opens that database after the load event, on an idle callback, unless Save-Data is on. The idle callback's own cap is 2000 milliseconds, so a short delay can overlap only part of the open.

```
npm run perf -- --pick-delay 1000 --only browser --out /tmp/bridgekit-pick-delay.json
```

A non-zero delay is a partial run. During the wait the page may download the DuckDB wasm. The harness records requests at the interactive mark, before the wait, so that download is counted with the file requests. Do not compare those byte totals with the committed baseline.

## Measure larger files

`--sizes` replaces the row table for that run with a comma-separated list of row counts. Every listed size runs in the browser. Each count must be an integer from 1 to 20000000. A plain run without the flag measures 10,000 and 300,000 rows in the browser and 3,000,000 rows in Node only.

```
npm run perf -- --sizes 1000000,3000000 --out /home/marcus/.cache/pstack-t3/scratch/xxx/large.json
```

A run with `--sizes` is a partial run. Pass `--out` to another path. `--csv-dir` sets the base directory for the generated CSV scratch files, which default to `/tmp/bridgekit-perf`, and never changes the measured numbers. The run makes its own sub-directory under that base, writes only there, and removes only that sub-directory at the end. An assets-only run creates nothing there. Files that existed before are never deleted or replaced. Use it when the files are large enough to strain `/tmp`.

```
npm run perf -- --sizes 1000000 --csv-dir /home/marcus/.cache/pstack-t3/scratch/xxx --out /home/marcus/.cache/pstack-t3/scratch/xxx/one.json
```

## Time the Worker locally

`npm run perf:worker` applies local D1 migrations, starts `wrangler dev` on 127.0.0.1, times the routes below, writes `perf/worker-baseline.json`, and stops the dev server. Run `npm run build:cloudflare` first so each wasm file has a `.br` copy and a `.gz` copy. The script refuses `--remote`. It does not deploy.

Every wrangler command gets a generated `BETTER_AUTH_SECRET` through `--env-file`, and a child environment that keeps `PATH` and a private home directory. Telemetry, error reports, the update check banner, and the `cf.json` fetch are off. The script does not read `.env`, `.env.local`, or `.dev.vars`, and it does not pass inherited Cloudflare credentials. Commentary, Paddle, and sign-in keys stay unset. Those routes stop at the local refusal.

The generated file also sets `ACCOUNTS=on`, so the route timings still see those routes. `scripts/perf/worker.mjs:260` has `ACCOUNTS=on`.

Each route records the first request, discards one warm-up, then keeps five steady samples. The median is the middle steady sample. The first request is first-hit for that route in one process. Only the home page is the first request after the process starts.

The script times `/`, `/app/`, `/guide.html`, and `/method.html`. The Worker serves `/` and `/app/`. It also serves five articles, and it stores each one under the extensionless path: `/guide`, `/method`, `/privacy`, `/price-volume-mix-analysis`, and `/grouping-level`. Those seven paths are the pages that are counted. A request for any other path is not counted, even when the Worker serves 200 HTML for it. A request for the `.html` name fetches that same file and stores the same path. `/guide.html` and `/guide` are one `page_views` row. The other four articles work the same way.

`/pay/` is the checkout page. It is not in `run_worker_first`, so the Worker does not see it and `page_views` has no row for it. `/pay/index.html` matches `/*.html`. The Worker returns the asset redirect, and that 307 is not counted. `/index.html` and `/app/index.html` stay redirects and are not counted.

`wrangler.jsonc` does not set `html_handling`. An `.html` name that the Worker does not serve itself still gets the asset layer's default 307. The five article names are not that case. The Worker answers them with 200.

A stored referrer is a host name in lower case, with no port, user info, or path. The same site, including another port, is an empty referrer. A host longer than 200 characters is an empty referrer. It is not cut down to 200 characters. A new foreign host is stored when that page and day have fewer than 32 foreign hosts. A host row that already exists for that page and day stays, so a page can hold more than 32 foreign hosts. A further new host increments the row whose referrer is `other`. An empty referrer is a direct visit and does not take one of the 32 slots. The check and the insert are one statement. Overlapping writes do not admit a new host once that page and day have 32.

There is no HTTP route that reads the counts. After the samples, the script reads the local D1 `page_views` table and stores the rise for each page route. A route it counted is read with a trailing `.html` removed. A route it did not count is read at its final path.

The notes in `scripts/perf/worker.mjs` say that `/guide.html` and `/method.html` answer 200 and that the page view is stored as `/guide` and `/method`. The script counts a page route when the final path is the path it requested, then requires `page_views` to rise for that path, dropping a trailing `.html` when the path ends with one. A 200 for `/guide.html` is stored as `/guide`, and the check reads that row. `perf/worker-baseline.json` is an earlier capture and still says those two routes answer 307 and are not counted.

Wasm routes request `/assets/*.wasm` with `Accept-Encoding` of `br`, `gzip`, and no encoding header. One extra request per file sends `gzip, deflate, br, zstd`, which is the header current Chrome sends. `/api/config` is timed with no credentials. `GET /api/workspaces/perf-local` is timed for the unsigned-in 403. `POST /api/workspaces/perf-local/setups` is timed with no Origin header, for the 403 that returns before a save. `POST /api/paddle/webhook` sends `{}` and no signature, for the 401. `POST /api/commentary` sends `{}` and no session, for the 403. None of these call Paddle or a model.

A partial Worker run cannot overwrite `perf/worker-baseline.json`. Pass `--out` when you use `--samples` with a value other than 5.

Local `wrangler dev` is not production.

- The clock is miniflare on this machine. It is not the Cloudflare edge, and there is no edge cache.
- Cloudflare replaces the browser `Accept-Encoding` with `br, gzip` before the Worker runs. The browser header is `request.cf.clientAcceptEncoding`. Local wrangler does not do that replacement. The script's `Accept-Encoding` is what the Worker sees.
- Miniflare can recompress the Worker response. When gzip is listed before br, a body the Worker chose as the stored Brotli file can arrive as gzip. `cache-control: no-transform` does not stop that in local dev. Compare `bytes` with `stored.brBytes` and `stored.gzBytes` to see which file came back.
- The page-count insert runs after the response, in `waitUntil`. These timings end when the response body ends. They do not include the insert finishing.

## Read a result

`perf/baseline.json` records the machine, the git SHA the run started from, and every sample. The median is the middle sample. `min` and `max` are the fastest and slowest.

Page load, from a fresh Chromium profile, served from `dist/` with `Cache-Control: no-store`:

- `browser.coldLoad.dclMs` is `domContentLoadedEventEnd` on the navigation entry.
- `browser.coldLoad.loadMs` is `loadEventEnd`.
- `browser.coldLoad.interactiveMs` is the time until the page shows the heading "Load a sales file" and an enabled file input that accepts csv. The page opens DuckDB after the load event, on an idle callback, unless Save-Data is on. This mark does not wait for that open. Cold load samples come from every measured file size, so with two sizes and five runs the count is 10.

File to a finished bridge:

- `browser.files[].totalMs` is the wall time from just before the file input is set until the bridge table and the KPI row are on screen.
- `parseMs` ends when the setup panel is visible and the status text is empty. It includes the CSV read and any DuckDB startup still unfinished. With the default `--pick-delay` of 0, the harness sets the file as soon as it sees the interactive mark. The idle open has not finished, so this time includes the wasm download.
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
- `build.duckdbOnFirstFile` sums the DuckDB wasm and worker files requested after the interactive mark, including a `--pick-delay` wait and the first file. The idle open can request the worker before the harness sees the interactive mark. That worker is then counted in `toolPage`, and the wasm file stays here. The tool-page set can include the DuckDB chunk when the idle callback runs before the harness reads the interactive mark, which happened in 2 of 20 branch loads.

The local server sends bytes with no content encoding. `npm run build:cloudflare` is a different bundle. It turns on page counts, workspaces, and AI commentary, then stores a Brotli copy and a gzip copy of each wasm file and deletes the original. This script does not run that build.

## Compare two runs

Compare a metric when `machine.cpuModel`, `machine.cores`, `machine.node`, and `machine.chromium` match. Compare medians. Treat the gap as noise when the two ranges overlap.

When a change should keep the bridge the same, `fingerprint.sha256` for each size must match, and the browser's rounded prior sales and current sales must match too.

`git.sha` is the commit checked out when the run started. `git.porcelain` lists files that were uncommitted at that moment. `machine.loadAvg` is the load when the run started. `machine.loadAvgAtEnd` is the load when the file was written.

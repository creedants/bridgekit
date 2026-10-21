# Bridgekit

A price-volume-mix (PVM) bridge that works for one attribute or many. It runs
entirely in the browser: the sales file you load is not uploaded anywhere.

Bridgekit is a working name.

## Why

A classic PVM bridge needs a stable product key. When products are configured
rather than catalogued, no single grouping works: group finely and most
configurations have no prior-period match, group coarsely and mix shows up as
price. Bridgekit takes an ordered list of attributes, compares each
configuration against the same configuration in the prior period, and falls
back up the list to the nearest group that existed when there is no match.

## Method

Attributes are ordered from most to least important. For each configuration,
`R_j` is the prior-period average price of its group at level `j`, falling
back to `R_(j-1)` when that group had no prior volume. `R_0` is the overall
prior average price.

| Effect | Formula |
|---|---|
| Volume | `(q1 - q0) * R_0` |
| Mix, one per attribute | `(q1 - q0) * (R_j - R_(j-1))`, down to level `m` for discontinued configurations |
| Price (like-for-like) | `s1 - R_k * q1`, exact matches only |
| New configurations | `s1 - R_k * q1`, configurations with no exact match |
| Discontinued configurations | `(q1 - q0) * (R_k - R_m)`, where `m` is the finest level that still sells |
| Sales with no units | change in sales on rows with zero units (rebates, credits, fees) |

The effects add up exactly to the change in sales, in total and for any
grouping. Volume and price do not depend on the attribute order; the split of
mix between attributes does.

## What the tool does

- Reads a CSV or Excel (.xlsx) file in the browser tab. Nothing is uploaded.
- Bridge: waterfall, bridge table, match coverage and a written summary.
- Optional gross sales column splits price into list price and discounts.
- Optional cost column turns it into a margin bridge with price and unit cost.
- Rows with sales and no units (rebates, credits) are bridged on their own line.
- New and discontinued configurations: shown as a price difference (default)
  or at full sales, outside volume and mix.
- Movers: effects by any attribute, sortable, with click-through to the next
  attribute. Copy to clipboard or download as CSV.
- Accounts: the change split into new, lost, growing and shrinking, by any
  column, with net and gross retention.
- Price changes: share of matched sales by band of price change, and realized
  change against a planned increase.
- Price gaps: each value of the last attribute against its peer average.
- Trend: one bridge per pair of consecutive periods.
- Setup check: the bridge rerun with each attribute left out.
- Unmatched: configurations with no exact prior match and the reference price
  used for each.
- Data check: counts of returns, blank values and ignored rows.
- Filters, year-to-date comparison, roll-up detection, data preview.
- Exports: Excel with live formulas, chart PNG, one-file HTML report.
- The setup is remembered in the browser (column mapping only; can be turned off) and can be saved to a file.
- `/app/?sample` opens the tool with the sample data already calculated;
  `/app/?sample=3000000` sets the row count.

## Private by default

The tool sends nothing and keeps none of the data:

- Files are read in the tab and held in memory only. Closing or reloading the
  tab, or choosing Clear data, removes them.
- No cookies, IndexedDB, caches, private file system or service worker.
- localStorage holds the setup (column choices, attribute order, options),
  saved after a bridge is calculated, never filter selections or data.
  Unticking "Remember this setup in this browser" deletes it and leaves a
  single `bridgekit:remember=off` flag so the choice persists.
- No analytics and no third-party requests. Built pages carry a content
  security policy limited to their own origin (`scripts/policy.ts`);
  `public/_headers` sends the same policy as a response header on hosts that
  support it, which is what covers the database worker.
- `npm run smoke` asserts all of the above against a running server.

The Cloudflare build adds opt-in features (see Deploying). A visitor who does
not sign in still gets the whole tool. The build also asks its own server which
features are on and whether anyone is signed in, when the page loads and again
when the first file opens; those requests carry nothing from the file. The
server counts the page load, and the smoke test passes against it unchanged.
Pages that describe the site mark feature-specific wording with
`<!-- feature:NAME -->`, so each build states only what is true for it.

## Optional AI commentary

Off unless the site is built with `VITE_AI_COMMENTARY=1`. It then shows a
button under the summary that sends the bridge totals (`src/summary.ts`:
totals and names, never rows or values from text columns) to `/api/commentary`
on the same site. `server/commentary.ts` checks that the request is exactly a
summary, adds the Anthropic API key and asks Claude for a commentary. The
handler uses web-standard `Request` and `Response`, so any host with functions
can mount it. To try it locally, copy `.env.example` to `.env.local`, add a key
and run `npm run dev`.

Wording that only applies when a feature is on sits between
`<!-- feature:ai -->` and `<!-- /feature:ai -->` in the pages and is removed
from builds without it.

## Run it

```sh
npm install
npm run dev      # the site at /, the tool at /app/
npm test         # engine tests
npm run demo     # 3 million made-up rows on the command line
npm run smoke    # drives the tool in headless Chromium; needs `npm run dev` running
```

The app reads CSV and Excel files. "Load sample data" generates made-up
prescription lens sales so you can try it without a file.

## Deploying

`npm run build` writes the free, static site to `dist/`. Any static host works
if it allows single files over 40 MB: the DuckDB WebAssembly files are 36 MB
and 41 MB.

### Cloudflare, with the opt-in features

`npm run build:cloudflare` reads `VITE_PAGE_COUNTS`, `VITE_WORKSPACES`, and
`VITE_AI_COMMENTARY`. An unset or empty value counts as on, and a feature is
included only when its value is exactly `1`. `npm run build:cloudflare:free`
forces page counts on and the other two off. The build then gzips the two
engine files to about 8 MB each, under Cloudflare's 25 MiB per-file limit. The
Worker in `server/` serves the site and the API on one address, so the
security policy stays limited to the site's own origin:

- `server/counts.ts`: a daily count for seven extensionless paths, `/`,
  `/app/`, `/guide`, `/method`, `/privacy`, `/price-volume-mix-analysis`, and
  `/grouping-level`. A referrer is a host with no port. A host longer than 200
  characters is a direct visit. At most 32 new foreign hosts are stored for
  each page and day, and further new hosts count under `other`. No script,
  cookie or visitor details.
- `server/auth.ts`, `server/workspace.ts`: accounts (Better Auth: emailed
  sign-in link, Microsoft, Google) and team workspaces that save setups without
  filter values and bridge totals (`src/summary.ts`). Saving needs Pro.
- `server/paddle.ts`: Pro subscriptions through Paddle. Checkout opens on
  `/pay/`, the only page allowed to load Paddle's script.
- `server/commentary.ts`: AI commentary for Pro members.
- `migrations/`: the D1 database tables. `scripts/auth-schema.ts` regenerates
  the account tables from `server/auth.ts`.

To run all of it on this machine with a local database and no Cloudflare
account: copy `.dev.vars.example` to `.dev.vars`, set `BETTER_AUTH_SECRET`,
then `npm run build:cloudflare && npm run cf:dev` and open
http://localhost:8790. With `VITE_PAGE_COUNTS`, `VITE_WORKSPACES`, and
`VITE_AI_COMMENTARY` unset or empty, that build switches all three on.

Sign-in, workspaces, checkout, the Paddle webhook, and commentary answer only
when `ACCOUNTS` is exactly `on`. `.dev.vars` sets that for local work.

Sign-in links are printed in the terminal only when `LOCAL_EMAIL_LOG` is
exactly `on`. When email cannot be sent and no sign-in provider is configured,
the Workspace panel shows `Accounts are not open yet.` and no form.
`npm run smoke -- http://localhost:8790` runs the smoke test against it.

To go live, follow [DEPLOY.md](DEPLOY.md). Part 1 puts the free tool and page
counts on your domain. Part 2 turns on accounts and payments. Enabling accounts
needs `ACCOUNTS=on` as well as the secrets.

## Layout

- `src/engine.ts`: the calculation. It generates SQL and takes a query
  function, so the same code runs on DuckDB in Node and in the browser.
- `src/app/`: the tool, a React app using DuckDB-WASM and ECharts.
- `index.html`, `guide.html`, `method.html`, `price-volume-mix-analysis.html`, `grouping-level.html`,
  `src/site/`: the site pages.
- `src/commentary.ts`: the written summary.
- `src/summary.ts`: the bridge reduced to totals, the only thing an opt-in feature may send.
- `server/`: server code for opt-in features, not part of the static site.
- `src/tokens.css`: colors and type shared by the site and the tool.
- `src/synth.ts`: the sample data generator.

## License

MIT

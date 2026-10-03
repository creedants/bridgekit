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

- Reads a CSV, Excel (.xlsx) or Parquet file in the browser tab. Nothing is uploaded.
- Bridge: waterfall, bridge table, match coverage and a written summary.
- Optional gross sales column splits price into list price and discounts.
- Rows with sales and no units (rebates, credits) are bridged on their own line.
- New and discontinued configurations: shown as a price difference (default)
  or at full sales, outside volume and mix.
- Movers: effects by any attribute, sortable, with click-through to the next
  attribute. Copy to clipboard or download as CSV.
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
- The setup is remembered per set of column names, and can be saved to a file.
- `/app/?sample` opens the tool with the sample data already calculated;
  `/app/?sample=3000000` sets the row count.

## Run it

```sh
npm install
npm run dev      # the site at /, the tool at /app/
npm test         # engine tests
npm run demo     # 3 million made-up rows on the command line
npm run smoke    # drives the tool in headless Chromium; needs `npm run dev` running
```

The app reads CSV and Parquet files. "Load sample data" generates made-up
prescription lens sales so you can try it without a file.

## Deploying

`npm run build` writes a static site to `dist/`. Any static host works. Check
the host's per-file size limit first: the DuckDB WebAssembly files are 36 MB
and 41 MB, which is over the limit on some hosts.

## Layout

- `src/engine.ts`: the calculation. It generates SQL and takes a query
  function, so the same code runs on DuckDB in Node and in the browser.
- `src/app/`: the tool, a React app using DuckDB-WASM and ECharts.
- `index.html`, `guide.html`, `method.html`, `price-volume-mix-analysis.html`,
  `src/site/`: the site pages.
- `src/commentary.ts`: the written summary.
- `src/tokens.css`: colors and type shared by the site and the tool.
- `src/synth.ts`: the sample data generator.

## License

MIT

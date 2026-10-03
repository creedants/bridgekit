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
| Mix, one per attribute | `(q1 - q0) * (R_j - R_(j-1))` |
| Price (like-for-like) | `s1 - R_k * q1`, exact matches only |
| New configurations | `s1 - R_k * q1`, configurations with no exact match |

The effects add up exactly to the change in sales, in total and for any
grouping. Volume and price do not depend on the attribute order; the split of
mix between attributes does.

## Run it

```sh
npm install
npm run dev      # the browser app
npm test         # engine tests
npm run demo     # 3 million made-up rows on the command line
```

The app reads CSV and Parquet files. "Load sample data" generates made-up
prescription lens sales so you can try it without a file.

## Layout

- `src/engine.ts`: the calculation. It generates SQL and takes a query
  function, so the same code runs on DuckDB in Node and in the browser.
- `src/app/`: the React app, using DuckDB-WASM and ECharts.
- `src/synth.ts`: the sample data generator.

## License

MIT

The results pages now explain their numbers and their chart labels, the Accounts tab asks which column holds the account, and Export shows that it is saving the file.

- A matched share prints 100.0% only when the engine reports every current row matched at the full configuration, and a share below all sales prints below 100.0%. The last-bit tolerance is gone. The Setup check exact-share cell uses the same formatter.
- The Price changes note says the counts are exactly matched configurations with positive units in both periods and a positive prior measure, after each configuration's rows are added together, and that the Bridge price step can include other configurations. A margin bridge adds that the combined Price and Unit cost steps should be read together.
- The main Bridge chart's value labels print the same largest-remainder amounts as the table beside it, while the bars keep their exact geometry. Small bridges keep their own labels.
- A Full sales bridge adds one sentence saying Volume and Mix cover continuing configurations only, using prior averages from those configurations.
- The export button reads Saving… while the workbook is made, so every top-bar button ends inside a 360 px wide screen.
- `scripts/smoke.mjs` latches that busy label with a MutationObserver installed before the click, so the check does not depend on export timing.

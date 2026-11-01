The results pages now explain their numbers and their chart labels, the Accounts tab asks which column holds the account, and Export shows that it is saving the file.

- A matched share prints 100.0% only when the engine reports every current row with units matched at the full configuration and the computed share is positive. A computed share below 1 prints below 100.0%, and the last-bit tolerance is gone. The Setup check exact-share cell uses the same formatter, without the complete flag.
- The Price changes note says the counts are exactly matched configurations with positive units in both periods and a positive prior measure, after each configuration's rows are added together, and that the Bridge price step can include other configurations. A margin bridge adds that the combined Price and Unit cost steps should be read together.
- The main Bridge chart's value labels print the same largest-remainder amounts as the table beside it, while the bars keep their exact geometry. Small bridges keep their own labels.
- A Full sales bridge adds one sentence saying Volume and Mix cover continuing configurations only, using prior averages from those configurations.
- The export button reads Saving… while the workbook is made, which narrows the button by about 8 px against its ready width. At 360 px the top bar's Clear button still ends 1.3 px past the viewport, so the fit there is not finished.
- `scripts/smoke.mjs` latches that busy label with a MutationObserver installed before the click, so the check does not depend on export timing.

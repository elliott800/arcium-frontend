# Model tracker view

**Source:** Data Hub brief (Nov 17), "Model tracker". **State:** designed; no view of its own yet.

A tracker decides which symbols get recorded for models, organised by fund. A tracker (for example
"Options") has a record spec — which source key to run per symbol — and one category per fund it tracks.

| Category member | Means |
|---|---|
| list | a whole watchlist, e.g. all of DIA's holdings |
| top | a fund's top N holdings by weight, e.g. `QQQ#10` |
| symbol | one symbol: the fund itself (e.g. UVXY) or any stock |
| exclude | a symbol taken out although a list or top-N brings it in |

## How it works today

- **Creation:** the hub's settings create each category once, as a hub list of kind `tracker` named
  `<tracker>: <FUND>`; after that the database is the record, edited with `tracker_add` / `tracker_remove`.
- **Recording:** each watchlist pass turns a tracker's symbols into recording hooks
  (`submitted_by tracker:<name>`); a symbol that leaves has its hook switched off and its data kept.
- **On the site:** trackers appear only as lists in the Portfolio Maker's hub scope, and are kept out of the
  Recorder's bundle view on purpose (trackers are for models).

## To build

A drill table over the trackers: tracker → fund category → members (list / top / symbol / exclude), with the
resolved symbol set and each symbol's recording state; add and remove through `tracker_add` /
`tracker_remove` (the Data Hub command routes, `/api/admin/datahub/*`).

Open question from the brief: should trackers get a full view of their own as well as a pin (see Pinned list
layers)?

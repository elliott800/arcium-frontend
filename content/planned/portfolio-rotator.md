# Portfolio rotator

**Source:** the Nov 7 plan (engine layer, after engines trade real models) and the backend foundation's
required pieces (SignalFilter, portfolio rotator; deferred by the owner on Oct 31). **State:** planned;
not built.

## What it does

- Filters on a `SignalFilter` base — custom ones, combined with weights or AND/OR (for example market-cap
  rank, momentum rank, a Fusion macro phase, liquidity) — score a **universe** (a portfolio from the
  Portfolio Maker).
- On a schedule, the top assets rotate into the engine's active portfolio, with a limit on changes per
  rotation.
- The filters and the universe are chosen in the engine's configuration.

## Where it lives

- **Backend:** `primary_trade_engine_classes/portfolio_rotator.py` and `super_classes/signal_filter.py`
  (arcium backend, engine side).
- **Frontend:** a panel in the Engine Hangar for the filters, weights, universe and schedule, saved with
  the engine's settings (the settings dictionary in the backend's database).

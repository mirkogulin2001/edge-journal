# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Edge Journal is a trading journal web application built with Python Dash. Traders log entries/exits, track open positions with live prices, and analyze performance via analytics, Monte Carlo simulation, and portfolio equity curves.

## Running the app

```bash
# Development (with hot reload)
python app.py

# Production
gunicorn app:server
```

Requires a `.env` file with:
```
SUPABASE_URL=...
SUPABASE_KEY=...
```

## Architecture

The app is two files:

- **`app.py`** — everything Dash: layout, callbacks, chart helpers, live price fetching. ~2000 lines.
- **`database.py`** — Supabase data access layer. All SQL/table logic lives here.

### Key patterns in app.py

**Session state** is stored in a `dcc.Store(id='session-store')` component. All callbacks that need the logged-in user read `session['user']` from this store.

**Live prices** are fetched via `yfinance` with a 30-second in-memory cache (`_price_cache`, `_price_cache_time`). `get_cached_live_prices(tickers)` is the entry point.

**Partial close merging** — when a position is partially closed multiple times, `close_partial()` and `close_trade_total()` in `database.py` merge subsequent closes into a single CLOSED row using weighted-average exit price and cumulative PnL. `find_sibling_in_history()` detects an existing CLOSED record to merge into.

**Tabs** rendered by `render_tab()` callback: `tab-active` (open positions), `tab-history` (closed trades), `tab-analytics`, `tab-montecarlo` (risk simulator), `tab-performance`, `tab-info`.

**Global style constants** at the top of `app.py` (`COLOR_POS`, `COLOR_NEG`, `CARD_BG`, etc.) define the dark terminal theme. Use these when adding new UI elements.

### Supabase schema (inferred)

- `users` — `username`, `password_hash`, `full_name`, `config` (JSONB for custom strategy tags + `initial_balance`)
- `trades` — `id`, `username`, `symbol`, `side` (LONG/SHORT), `entry_price`, `quantity`, `entry_date`, `initial_stop_loss`, `current_stop_loss`, `tags` (JSONB), `entry_notes`, `status` (OPEN/CLOSED), `exit_price`, `exit_date`, `pnl`, `rr`, `result_type` (WIN/LOSS/BE), `exit_notes`

### CSV/Excel import format

`parse_contents()` accepts flexible column names. Required: `TICKER`/`SYMBOL`, `SIDE`, `QTY`/`QUANTITY`, `PRECIO IN`/`ENTRY_PRICE`. Extra columns become strategy tag keys stored in the `tags` JSONB field.

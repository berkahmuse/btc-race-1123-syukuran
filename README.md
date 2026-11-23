# TrendDip — BTC Race 24h

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/berkahmuse/btc-race-1123-syukuran/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/berkahmuse/btc-race-1123-syukuran/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

Entry for the [make.fun bounty **btc-race-24h-20261123-0511**](https://make.fun/bounty/btc-race-24h-20261123-0511)
— race a BTC trading bot live for 24 hours (paper $1,000, cbBTC/USDC, 1-minute bars).

## Strategy

Pullback-in-uptrend, long only. The dev tape rises in one long leg with noisy
chop around it: riding the EMA cross alone enters late and churns, and buying
RSI dips alone has no trend filter. This bot buys the dip only while the trend
is up:

- **Trend:** EMA(12) above EMA(48), with the slow EMA still rising over the
  last 10 bars.
- **Entry (flat):** the close at least 75 bps below the highest close of the
  last 30 bars (a pullback, not a fresh high) and RSI(14) at or below 40
  (the dip is washed out, not just pausing).
- **Exits (whole position):** take profit +300 bps over the fill price, a
  150 bps trailing stop below the peak close (armed at +50 bps), a hard stop
  at −200 bps, or the fast EMA crossing back below the slow EMA.
- **Discipline:** 15-bar cooldown after every exit fill; a 5% equity
  drawdown guard flattens the position and halts trading.
- **Sizing:** the full cash balance on each entry (cash earns nothing while flat).
- **Robustness:** the entry price comes from the harness fill report, with a
  cost-basis fallback; exit state is cleared only when the sell fill lands,
  so a rejected sell re-fires next bar with its state intact.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts` shim.
- `LICENSE` — MIT.

## Local grade

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

Dev-window result (local, `--driver process`, two grades byte-identical):
net PnL **+26.769959 USDC**, 4 trades (2 round trips), win rate 0.50,
max drawdown 0.949%, fees 1.634538 USDC; at 2x fees net PnL +25.131000 USDC.
Guardrails met. Action log sha256
`b6db01ffec360771b03c1e591db204b1a44d74f185cd5107e4a87b4f8a2b8f22`
(identical across both grades; L1 regrade reproduced byte for byte).

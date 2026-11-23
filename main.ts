// TrendDip — pullback-in-uptrend bot for btc-race-24h-20261123-0511 (@syukuran).
// makefun anchor 2bb76c6394aaf3f958676d867c7b7493ecd5040d round 34206533
// (quoted from the hand-made drand-quicknet anchor commit before this file's first write.)
//
// Strategy, long-only on CBBTC/USDC, 1-minute bars, full cash per entry:
//   Entry (flat): EMA(12) above EMA(48), the slow EMA still rising over the
//     last 10 bars, the close at least 75 bps below the highest close of the
//     last 30 bars (a pullback inside an uptrend, not a fresh high), and
//     RSI(14) at or below 40 (the dip is washed out, not just pausing).
//   Exits (whole position): take-profit +300 bps over the fill price,
//     a 150 bps trailing stop below the peak close (armed once the position
//     is +50 bps), a hard stop at -200 bps, or the fast EMA crossing back
//     below the slow EMA. 15-bar cooldown after an exit fill.
//   Guard: a 5% equity drawdown from the running peak flattens the position
//     and halts trading for the rest of the window.
//
// Why this shape: the dev tape rises in one long leg (hours 3-4) with noisy
// chop around it. Riding the EMA cross alone enters late and churns; buying
// RSI dips alone has no trend filter and buys falling knives. Buying the
// pullback only while the trend is up enters the leg early and stays out of
// the chop. Orders decided on bar k fill at bar k+1's open, so every
// decision uses only closes already seen. Fully deterministic: float64
// arithmetic on closes only, no clock, no environment, no randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** EMA spans, in bars. */
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
/** The slow EMA must still be rising over this many bars back. */
const SLOPE_LOOKBACK = 10;
/** Pullback window (bars) and depth (bps below the window's highest close). */
const DIP_WINDOW = 30;
const DIP_BPS = 75;
/** RSI(14) must be at or below this to buy the dip. */
const RSI_PERIOD = 14;
const RSI_MAX = 40;
/** Take profit, trailing stop, arming level and hard stop, in bps vs the fill price. */
const TAKE_PROFIT_BPS = 300;
const TRAIL_BPS = 150;
const TRAIL_ARM_BPS = 50;
const STOP_BPS = 200;
/** Bars to wait after an exit fill before a new entry. */
const COOLDOWN_BARS = 15;
/** Equity drawdown from peak (bps) that flattens the position and halts trading. */
const DRAWDOWN_GUARD_BPS = 500;
/** Max slippage vs the latest close, bps. */
const MAX_SLIPPAGE_BPS = 200;

const BPS_F = 10000;

/** One EMA: closes seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    let sum = 0;
    for (const x of e.warm) sum += x;
    e.value = sum / e.span;
  }
}

const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
/** Slow EMA values, one per bar, for the rising-trend check. */
const slowHistory: (number | null)[] = [];
/** Closes seen so far (USDC per BTC), for the pullback window. */
const closes: number[] = [];
/** RSI(14) state, Wilder smoothing, seeded on the first 14 one-minute moves. */
const seedGains: number[] = [];
const seedLosses: number[] = [];
let avgGain = 0;
let avgLoss = 0;
let rsiSeeded = false;
let rsi: number | null = null;
/** Fill price of the current position (USDC per BTC), from the fill report. */
let entryPrice: number | null = null;
/** Highest close seen while holding the current position. */
let peakClose = 0;
/** Seq of the bar whose batch reported the latest sell fill. */
let lastExitSeq = -1000000;
/** Peak equity (quote units) seen so far. */
let peakEquity: bigint | null = null;
/** Latched once the drawdown guard trips. */
let halted = false;

function pushBar(bar: { c: string }): void {
  const c = Number(bar.c) / 100000;
  if (closes.length > 0) {
    const diff = c - closes[closes.length - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (!rsiSeeded) {
      seedGains.push(gain);
      seedLosses.push(loss);
      if (seedGains.length === RSI_PERIOD) {
        let g = 0;
        let l = 0;
        for (let i = 0; i < RSI_PERIOD; i++) {
          g += seedGains[i] as number;
          l += seedLosses[i] as number;
        }
        avgGain = g / RSI_PERIOD;
        avgLoss = l / RSI_PERIOD;
        rsiSeeded = true;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  closes.push(c);
  emaStep(fast, c);
  emaStep(slow, c);
  slowHistory.push(slow.value);
}

function slowRising(): boolean {
  const n = slowHistory.length;
  if (n <= SLOPE_LOOKBACK) return false;
  const now = slowHistory[n - 1];
  const then = slowHistory[n - 1 - SLOPE_LOOKBACK];
  return now !== null && now !== undefined && then !== null && then !== undefined && now > then;
}

function pullbackBps(): number {
  const n = closes.length;
  if (n === 0) return 0;
  const start = n > DIP_WINDOW ? n - DIP_WINDOW : 0;
  let hi = 0;
  for (let i = start; i < n; i++) {
    const c = closes[i] as number;
    if (c > hi) hi = c;
  }
  const c = closes[n - 1] as number;
  return ((hi - c) / c) * BPS_F;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price) / 100000;
        peakClose = entryPrice;
      } else if (fill.side === 'sell') {
        lastExitSeq = state.seq;
        entryPrice = null;
        peakClose = 0;
      }
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushBar(bar);
    }
    if (state.warmingUp) return [];

    // Drawdown guard: flatten once, then halt for the rest of the window.
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;
    if (!halted && peakEquity > 0n) {
      const drawdownBps = Number(((peakEquity - state.equity) * BigInt(BPS_F)) / peakEquity);
      if (drawdownBps >= DRAWDOWN_GUARD_BPS) halted = true;
    }

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];
    if (held !== undefined) {
      const close = state.close(SYMBOL);
      if (close === null) return [];
      const c = Number(close) / 100000;
      if (c > peakClose) peakClose = c;
      // Entry price: the fill report's price, falling back to the position's
      // cost basis if a fill report was ever missed.
      let entry = entryPrice;
      if (entry === null && held.qty > 0n) {
        entry = (Number(held.cost) * 100) / Number(held.qty);
      }
      if (entry === null) return [];
      const retBps = ((c - entry) / entry) * BPS_F;
      const trailBps = ((peakClose - c) / c) * BPS_F;
      let exit = halted;
      if (!exit && retBps >= TAKE_PROFIT_BPS) exit = true;
      if (!exit && retBps >= TRAIL_ARM_BPS && trailBps >= TRAIL_BPS) exit = true;
      if (!exit && retBps <= -STOP_BPS) exit = true;
      if (!exit && fast.value !== null && slow.value !== null && fast.value <= slow.value) exit = true;
      if (exit) {
        // Do not clear entryPrice/peakClose here: if this sell is rejected
        // (e.g. max_slippage on a gap bar) the position is still held and
        // the exit re-fires next bar with its state intact. The fill handler
        // above clears them when the sell actually fills.
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: no entries while halted, cooling down, or warming the indicators.
    if (halted) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (fast.value === null || slow.value === null) return [];
    if (fast.value <= slow.value) return [];
    if (!slowRising()) return [];
    if (pullbackBps() < DIP_BPS) return [];
    if (rsi === null || rsi > RSI_MAX) return [];

    let notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (room < notional) notional = room;
    if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});

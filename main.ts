// Early-strength momentum for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea: on a 6-hour window most new pump.fun coins either spike early or bleed
// out. This bot buys a coin once, only after it has already shown strength
// (+10% over its first-seen price, at least 3 trades), then exits on a
// take-profit (+50%), a stop-loss (-25%), a trailing exit (20% below the peak
// once the peak reached +30%), or a slot-age exit (7200 slots) so capital keeps
// turning over. One buy per mint, at most 5 open positions, 0.05 SOL a buy.
//
// Everything is deterministic: every decision is a pure function of the replay
// state (slots, reserves, fills). No randomness, no clock, no network, no
// environment reads, so two runs of the same replay produce identical orders.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.

import { LAMPORTS_PER_SOL, runBot, type BotState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bot.ts';

/** SOL spent on each buy (0.05 SOL). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
/** Smallest buy that counts toward the minimum bar (0.01 SOL round trip). */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Buy only after the price is this far above its first-seen price (x1.10). */
const TRIGGER_NUM = 11n;
const TRIGGER_DEN = 10n;
/** Trades a curve must have shown before it can trigger. */
const MIN_TRADES = 3;
/** Sell at +50% over the entry price. */
const TAKE_PROFIT_NUM = 3n;
const TAKE_PROFIT_DEN = 2n;
/** Sell at -25% under the entry price. */
const STOP_LOSS_NUM = 3n;
const STOP_LOSS_DEN = 4n;
/** Once the peak is +30% or more, sell on a 20% fall from the peak. */
const TRAIL_ARM_NUM = 13n;
const TRAIL_ARM_DEN = 10n;
const TRAIL_FALL_NUM = 4n;
const TRAIL_FALL_DEN = 5n;
/** Sell whatever is left after this many slots held (~48 min at 0.4 s/slot). */
const MAX_HOLD_SLOTS = 7200;
/** Wide-open buy slippage (same reasoning as the house equal-weight baseline). */
const BUY_SLIPPAGE_BPS = 10_000;
/** Sell slippage: a rejected sell just retries next batch. */
const SELL_SLIPPAGE_BPS = 2000;

/** Scale for integer prices: price = virtual quote per virtual token x SCALE. */
const PRICE_SCALE = 1_000_000_000_000n;

interface CoinNote {
  /** Scaled price (virtual quote per virtual token) when the coin was first seen. */
  firstPrice: bigint;
  /** True once the coin has been decided (bought or skipped for good). */
  decided: boolean;
}

interface HeldNote {
  /** Scaled entry price at buy time. */
  entryPrice: bigint;
  /** Highest scaled price seen since the buy. */
  peakPrice: bigint;
  /** Slot the buy was decided on. */
  buySlot: number;
}

const notes = new Map<string, CoinNote>();
const held = new Map<string, HeldNote>();

/** Current scaled price of a curve from its virtual reserves; 0n when unpriced. */
function priceOf(state: BotState, mint: string): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  const vt = curve.virtual_token_reserves;
  const vq = curve.virtual_quote_reserves;
  if (vt <= 0n || vq <= 0n) return 0n;
  return (vq * PRICE_SCALE) / vt;
}

/** Compare a/b against num/den using integers: true when a/b >= num/den. */
function atLeastRatio(a: bigint, b: bigint, num: bigint, den: bigint): boolean {
  return a * den >= b * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // Note every coin the batch mentions, in event order. A coin's first price
    // is fixed at its CreateEvent reserves (or its first trade when the create
    // was outside the window).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!notes.has(e.mint)) {
          const price = priceOf(state, e.mint);
          if (price > 0n) notes.set(e.mint, { firstPrice: price, decided: false });
        }
      } else if (e.event === 'TradeEvent') {
        if (!notes.has(e.mint)) {
          const price = priceOf(state, e.mint);
          if (price > 0n) notes.set(e.mint, { firstPrice: price, decided: false });
        }
      } else if (e.event === 'CompleteEvent') {
        notes.delete(e.mint);
        held.delete(e.mint);
      }
    }

    // Exits first: free position slots before deciding new buys.
    // A mint with a sell already pending is left alone: the fill will clear
    // it, and re-sending would only stack a duplicate order.
    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const note = held.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        held.delete(mint);
        continue;
      }
      const price = priceOf(state, mint);
      if (price <= 0n || note === undefined) continue;
      if (price > note.peakPrice) note.peakPrice = price;
      // Exact integer comparisons on the scaled prices.
      const takeProfit = atLeastRatio(price, note.entryPrice, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
      const stopLoss = price * STOP_LOSS_DEN <= note.entryPrice * STOP_LOSS_NUM;
      const trailing =
        atLeastRatio(note.peakPrice, note.entryPrice, TRAIL_ARM_NUM, TRAIL_ARM_DEN) &&
        price * TRAIL_FALL_DEN <= note.peakPrice * TRAIL_FALL_NUM;
      const aged = state.slot - note.buySlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || aged) {
        // Keep the note: if this sell is rejected the next batch re-evaluates
        // and retries; the note is dropped once the position is gone.
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(sell);
      }
    }
    // Drop notes for positions that are gone with no buy pending (sold, or
    // closed by the harness on completion / flattening).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint)) held.delete(mint);
    }

    // Entries: coins in this batch's event order, decided once.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    // Sells in this reply free slots at fill time, not now; count buys only
    // against positions still open, which committedPositionCount already does.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const note = notes.get(e.mint);
      if (note === undefined || note.decided) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete || curve.trades < MIN_TRADES) continue;
      const price = priceOf(state, e.mint);
      if (price <= 0n) continue;
      // Trigger: price >= firstPrice * 11/10, compared exactly.
      if (price * TRIGGER_DEN < note.firstPrice * TRIGGER_NUM) continue;
      note.decided = true;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      orders.push(buy);
      free -= amount + tx;
      slots -= 1;
      held.set(e.mint, { entryPrice: price, peakPrice: price, buySlot: state.slot });
    }
    return orders;
  },
});

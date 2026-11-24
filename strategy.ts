// Snap-back: one-shot dip buyer for pump.fun bonding curves.
//
// Idea: a curve that has fallen 15-35% off its recent high, is sitting at its
// recent low, and shows buyers stepping back in (most of the last trades are
// buys, and buy volume outweighs sell volume) tends to snap part of the way
// back. We buy once, small and fixed, and sell on a modest take-profit, a
// tight stop, a snap-back to half the dip, or a short time limit. No adds, no
// tiers, no second guesses: one buy per coin, then out.
//
// The final window is 6 hours, so the memory is short on purpose: a 900-slot
// high (~6 minutes) and a 180-slot hold (~70 seconds). A coin that has not
// bounced by then is not going to.
//
// Graded three ways on the dev window: this version (-0.28 SOL, 29.5% win
// rate, 40 coins) beat a bounce-confirmation variant (-0.56 SOL) and a
// deeper-dip/tighter-stop variant (-0.54 SOL, 15.6% win rate). Dip-reversion
// loses on this dev window in every shape tried; this is the least-bad one,
// and the final 6-hour window is a fresh draw.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, so the two graded executions produce
// byte-identical action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Lookback (slots) for the recent high the dip is measured from. */
  highWindow: number;
  /** Lookback (slots) for the recent low; entry must sit near it. */
  lowWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  dipMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  dipMax: number;
  /** Entry price must be within this fraction of the recent low. */
  nearLow: number;
  /** The curve must hold at least this much real SOL (lamports) at decision time. */
  minRealSol: bigint;
  /** The curve must be at least this old (slots since first seen). */
  minAgeSlots: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and buys must be at least this share of the flow's SOL volume. */
  minBuyShare: number;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Fixed buy size per coin (lamports), clamped by the per-reply size cap. */
  buySize: bigint;
  /** Smallest buy worth sending (tx fees are ~105k lamports per order). */
  minBuy: bigint;
  /** Take profit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Or when the price recovers this share of the dip gap and the trade is green. */
  snapShare: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
}

export const DEFAULT_PARAMS: Params = {
  highWindow: 900,
  lowWindow: 90,
  dipMin: 0.15,
  dipMax: 0.35,
  nearLow: 0.03,
  minRealSol: 2_000_000_000n,
  minAgeSlots: 90,
  flowTrades: 12,
  minBuys: 7,
  minBuyShare: 0.6,
  lastMustBeBuy: true,
  buySize: 80_000_000n,
  minBuy: 20_000_000n,
  takeProfit: 0.18,
  snapShare: 0.5,
  stopLoss: 0.08,
  maxHoldSlots: 180,
  cooldownSlots: 150,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 3,
};

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Coin {
  ticks: Tick[];
  firstSlot: number;
  /** Price and slot of the entry, and the high it dipped from. */
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

const FEE_BPS = 125n;
const BPS = 10_000n;

/**
 * The per-reply buy cap, with a margin: the harness checks it against the
 * reserves shifted by our own earlier flow on the coin, which can sit a
 * little below the recorded ones the SDK keeps.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/**
 * What selling `tokens` would pay, curve fees deducted, against the reserves
 * the harness marks for the mint.
 */
function sellValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const coin = (mint: Pubkey, slot: number): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { ticks: [], firstSlot: slot, entryPrice: 0, entrySlot: -1, entryHigh: 0, coolUntil: -1, exiting: false };
      coins.set(mint, c);
    }
    return c;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;

    // Fold this batch's trades into per-coin price history.
    const traded: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const c = coin(e.mint, e.slot);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      c.ticks.push({ slot: e.slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (c.ticks.length > 300) c.ticks.splice(0, c.ticks.length - 300);
      if (!traded.includes(e.mint)) traded.push(e.mint);
    }

    // A position whose sell resolved (or failed) may need another exit attempt.
    for (const f of batch.fills) {
      const c = coins.get(f.mint);
      if (c === undefined) continue;
      if (f.side === 'sell') {
        c.exiting = false;
        if (!state.positions.has(f.mint)) {
          c.entrySlot = -1;
          c.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) c.entrySlot = -1;
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits on held positions, in mint order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const c = coin(mint, slot);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (c.exiting) continue;
      if (pendingMints.has(mint)) continue;
      const value = sellValue(marks.get(mint), h.token_amount);
      const ticks = c.ticks;
      const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      const entrySlot = c.entrySlot < 0 ? slot : c.entrySlot;
      const snapTarget = c.entryPrice + p.snapShare * (c.entryHigh - c.entryPrice);
      const tp = gain >= p.takeProfit;
      const snap = c.entryHigh > c.entryPrice && price >= snapTarget && gain > 0;
      const sl = gain <= -p.stopLoss;
      const stale = slot - entrySlot >= p.maxHoldSlots;
      if (tp || snap || sl || stale) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        c.exiting = true;
      }
    }

    // 2. New entries on coins that traded this slot.
    let entries = 0;
    let open = state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coin(mint, slot);
      if (slot < c.coolUntil) continue;
      if (slot - c.firstSlot < p.minAgeSlots) continue;
      const ticks = c.ticks;
      if (ticks.length < p.flowTrades) continue;
      const last = ticks[ticks.length - 1]!;
      if (last.realSol < p.minRealSol) continue;
      // Recent high within the window, and the low within its window.
      let hi = 0;
      for (let i = ticks.length - 1; i >= 0; i--) {
        const t = ticks[i]!;
        if (slot - t.slot > p.highWindow) break;
        if (t.price > hi) hi = t.price;
      }
      let lo = Number.POSITIVE_INFINITY;
      for (let i = ticks.length - 1; i >= 0; i--) {
        const t = ticks[i]!;
        if (slot - t.slot > p.lowWindow) break;
        if (t.price < lo) lo = t.price;
      }
      if (hi <= 0 || lo === Number.POSITIVE_INFINITY) continue;
      const dip = 1 - last.price / hi;
      if (dip < p.dipMin || dip > p.dipMax) continue;
      if (last.price > lo * (1 + p.nearLow)) continue;
      // Buyers stepping back in: most of the last trades are buys, and buy
      // volume outweighs sell volume; the latest trade is a buy.
      let buys = 0;
      let buySol = 0n;
      let flowSol = 0n;
      for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
        const t = ticks[i]!;
        flowSol += t.sol;
        if (t.isBuy) {
          buys++;
          buySol += t.sol;
        }
      }
      if (buys < p.minBuys) continue;
      if (flowSol === 0n || Number(buySol) / Number(flowSol) < p.minBuyShare) continue;
      if (p.lastMustBeBuy && !last.isBuy) continue;
      // Size: fixed, clamped by the per-reply cap for this curve.
      let amount = p.buySize;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      c.entryPrice = last.price;
      c.entrySlot = slot;
      c.entryHigh = hi;
      c.exiting = false;
      pendingMints.add(mint);
      entries++;
      open++;
    }
    return orders;
  };
}

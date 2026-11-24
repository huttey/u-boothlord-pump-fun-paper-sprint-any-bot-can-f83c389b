// Snap-back dip buyer for the Pump.fun Paper Sprint.
//
// The harness says hello, then sends one batch per slot; this bot answers
// each batch with its orders (buys into a dip, sells on the exit rules).
// Wiring only — the strategy lives in strategy.ts. The done handler reports
// the final account to stderr only; stdout carries replies and nothing else.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot({
  onBatch: createStrategy(),
  onDone(state, done) {
    console.error(`done: ${done.reason}, cash ${state.cash} lamports, ${state.positions.size} positions left`);
  },
});

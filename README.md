# Pump.fun Paper Sprint: Snap-Back Dip Buyer

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/huttey/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/huttey/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for pump.fun bonding curves, entered in the
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
competition on make.fun. Paper trading only — no real funds.

## Strategy

Snap-back: buy once into a dip, then out. A coin qualifies when it has
fallen 15–35% off its 900-slot high, is sitting within 3% of its 90-slot
low, and buyers are stepping back in (at least 7 of the last 12 trades are
buys, buy volume is at least 60% of flow volume, and the latest trade is a
buy). One fixed buy of 0.08 SOL per coin, no adds. Exit on +18%
take-profit, a snap-back to half the dip while green, a −8% stop, or a
180-slot hold limit.

## Files

- `main.ts` — wiring: the harness sends a hello, then one batch per slot,
  and the bot answers each batch with its orders.
- `strategy.ts` — the snap-back strategy.
- `vendor/agentfun-bot.ts` — the kit's replay-v2 wire shim (unmodified).
- `LICENSE` — MIT.
- `prompt-user.txt` — the prompt this entry was built under.

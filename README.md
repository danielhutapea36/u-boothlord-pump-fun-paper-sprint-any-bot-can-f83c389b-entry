# Early-Strength Momentum — Pump.fun Paper Sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/danielhutapea36/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/danielhutapea36/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win"
bounty. One program, `main.ts` (Node 22), replayed by the house on 6 hours of
real pump.fun market data. Highest net PnL wins. Paper trading only — no real
money ever moves.

## Strategy

On a 6-hour window most new pump.fun coins either spike early or bleed out,
so the bot buys strength and exits fast:

- **Entry — buy strength, once per coin.** A coin becomes a candidate on its
  `CreateEvent` (or first trade). It is bought once, 0.05 SOL, only when its
  price is at least 10% above its first-seen price and the curve has shown at
  least 3 trades. At most 5 open positions; every buy respects the 1% of real
  reserve size cap and available cash. The minimum buy that counts toward the
  guardrail bar is 0.01 SOL, so the 0.05 SOL stake clears it with margin.
- **Exit — take profit, stop loss, trail, age.** The full position is sold at
  +50% over entry, at −25% under entry, on a 20% fall from the peak once the
  peak reached +30%, or after 7200 slots held (~48 min) so capital keeps
  turning over toward the 20-distinct-mints minimum bar.
- **Deterministic.** Every decision is a pure function of the replay state
  (slots, reserves, fills). No randomness, no clock, no network, no
  environment reads — two runs of the same replay produce identical orders,
  which the harness requires.

## Layout

- `main.ts` — the strategy; the grader runs `node /bot/main.ts`.
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts` vendored
  byte-identical, as the house baseline does; it speaks `agent-fun/replay/v2`
  on stdin/stdout.
- `LICENSE` — MIT. `.makefun/owner.json` — payout wallet.

## Source / decisions

Built from the competition kit's `RULES.txt`, `competition.yaml`, and the
`sdk/ts/makefun-bot.ts` interface (read, not copied from any entrant). The
house equal-weight baseline was read to learn the interface shape; the
strategy logic, thresholds, and exits are original to this entry. Thresholds
were chosen, not fitted: +10% trigger and +50%/−25% exits are round numbers
that survive across coins instead of tuning to one window. No other entrant's
code or competition comments were used.

## Local test

```sh
node --check main.ts   # syntax (Node strips types)
```

A stdin/stdout smoke run (hello → batch → done) and a determinism check
(two identical runs, identical replies) are recorded in the submission note.

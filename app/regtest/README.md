# Private chain harness (tests only)

A regtest chain on this machine: zebrad 7.0.0-rc.0, no peers, NU7 active from block 1. It is used to test the host program and the
blind bid auction end to end without a public network or real money. Every key is a throwaway key made for the run.

## What you need

- zebrad 7.0.0-rc.0: `cargo install zebrad --version 7.0.0-rc.0 --locked --root <folder>`, then `ZEBRAD=<folder>/bin/zebrad`.
- The host program built with its test only regtest switch: `cargo build --release -p ll-host --features regtest` (from `app/`).
  Normal builds know only mainnet and testnet and refuse a regtest wallet.
- The wallet tool built with regtest support: `cargo build --release --features regtest_support` (from the repository root).
- `ll-relay` and `ll-contrib`: `cargo build --release -p ll-relay -p ll-contrib`.

Put the four programs in one folder (or point `BIN` at the build folder).

## Use

```
ZEBRAD=... BIN=... app/regtest/check-ordinary.sh runs/regtest/check-ordinary
```

runs the harness check: an ordinary auction on the private chain, one contribution, its ticket issued, opened from the relay and mined
as a withdrawal, and the payment back in the contributor's wallet minus the refund fee. About 4 minutes.

The blind bid auction has two more checks (each about 10 to 15 minutes):

- `check-sealed-intake.sh`: four auctions, one per way of sending coins (at once, every N bids, every N minutes, and at once near the
  coin cutoff); a deposit after the cutoff; the host's self check; the early ticket refused after the deadline.
- `check-sealed-close.sh`: uniform price, second price and pay your bid auctions closed by their hosts (round R from a local stand in for
  drand, with a dead and a forged address first), settlements, signed refunds, the viewing key after the settlements are mined, the
  recount passing; and an auction whose host never closes, where the own signed late tickets are refused before the late
  ticket block and mined after it, and the recount says "did not finish".

They need `ll-contrib` and `cb-host` from this branch. No public network is used: drand is replaced by `CB_DRAND_URLS` (regtest builds
only) pointing at local servers.

`chain.sh` has the single steps (start, stop, mine, tip, rpc, wallet). Notes:

- zebrad's light wallet service (`lightwalletd_listen_addr`, plain gRPC on 127.0.0.1:19067) refuses a request for block 0, so
  wallets are made once the chain has a few blocks, with that height as their birthday.
- Mining rewards go to the Ironwood pool of the miner address. To fund a wallet, restart the node with `KEEP=1` and the wallet's
  address as the miner address, then mine 101 blocks or more (coinbase maturity). Restarting can drop the last few blocks; restart only
  before funding.
- The host reaches the node at `CB_REGTEST_SERVER` (default `http://127.0.0.1:19067`).
- Regtest block times are not real times, so checks that compare block times with drand rounds need their own inputs in tests.

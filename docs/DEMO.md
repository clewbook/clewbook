# Try it (no wallet, no money)

Moved here from the README on 14 October 2026, unchanged. The same campaigns can be recounted on the hosted demo, https://clewbook.xyz/demo/proofs/.

The repository carries the public data of thirteen finished testnet campaigns in `examples/relay` (exactly what a relay serves: rules, ledger, sealed tickets). With the tools and the browser module built, serve them and recount them; the recount reads the public testnet chain servers, so it needs the internet.

```
python3 app/web/serve.py 8770 &
./app/target/release/cb-relay serve --dir examples/relay --listen 127.0.0.1:8787 &
mkdir -p runs && cp -r examples/relay runs/example-relay-b && ./app/target/release/cb-relay serve --dir runs/example-relay-b --listen 127.0.0.1:8788 &
```

Then open `http://127.0.0.1:8770/recount.html#c=<campaign id>&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788` with an id from this table (replace `recount.html` with `campaign.html` or `card.html` for the campaign page or the capability card). Each recount takes up to a minute.

| What it is | Campaign id | What the recount shows (checked 2026-10-14, with the R4 / R4b split) |
|---|---|---|
| Uniform-price auction, finished: 3 bids, 2 items, one price of 0.0019 TAZ for both winners | `5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb` | All checks pass: 13 of 13 (R1 to R12 and R4b) |
| Fundraiser, finished: closed, goal missed, the contribution refunded | `48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f` | All checks pass: 9 of 9 |
| Fundraiser with 40 contributions from 5 wallets (the stress test; not closed) | `47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da` | All checks pass: 9 of 9 |
| Fundraiser with a name chosen by its host ("Community radio mast (demo)"), finished: closed, goal missed, both contributions refunded | `f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a` | All checks pass: 9 of 9 |
| Failing fixture: an auction whose winners were settled after the settlement deadline (a real result, kept on purpose) | `32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a` | Some checks FAIL: 12 pass, R9 fails with its evidence |
| Uniform price auction, finished: 6 bids for 3 items; the two bids above the price paid the price and got the rest back, a tie at the price went to the bid earlier in the chain, one bid was taken back before the deadline, one was too low | `f8b2bc9f0b9e17666b8b87dd0eeb0b19a17ab8e95d154d63ff1b8d2849980501` | All checks pass: 13 of 13; every amount received was read from the receiving wallets and matched |
| Caught on purpose: the host spent two contributions itself, one before the deadline and one after (a test of a dishonest host) | `3c34b9ff18656a9fad2e81ea91e803320917eced570ba5f69dde1a10dbba4004` | Some checks FAIL: R5 and R6, each naming the spending transaction |
| Late host: the same auction run with the host's watcher stopped between bids, so one ticket was issued one block after its window | `65f3dd513ee88895804f2135a947ee9ac2e1b5d85b405e3d10c10168324b7ac6` | Some checks FAIL: R4b (ticket timing, as the host reports it) for that one ticket; the other 12 pass |
| Odd payments: 19 hand made payments (another campaign's message, a refund address that cannot be paid, a wrong version, too small, no message, and five valid ones) | `80fc0eb3081ac58d91ac95fec1fe92286c49d000d5bdd24befe5c53153ed025d` | All checks pass: 9 of 9; 10 justified rejects, 5 contributions refunded at the close |
| Fundraiser closed early: its rules allow it, and the host closed once the goal was met, 196 blocks before the deadline; a payment after the close is not counted | `d119ba4b6b032cacf5d5838eef8aa9ec5903a224b9c6d9f6cca9362f70d49671` | All checks pass: 9 of 9 |
| Caught on purpose: a host that closed early although the rules do not allow it (a test of a dishonest host) | `36a5178294cc8643929b654ea4f25df1dad7145527a311848dd5f526430d5897` | Some checks FAIL: R2 (closed before the deadline) and R5 (its sweep before the deadline) |

If a public chain server is slow or does not answer, the recount shows "limited" rather than a pass (it needs two servers to cross-check); wait and press "Run it again". Leave out the second `relay=` part and the result is marked "limited": one relay cannot be cross-checked. The second relay above is a copy of the first, which is enough to see the page work but is not independent evidence. The fixture's data has had one published viewing key removed (a contributor's), which does not change the failing check.

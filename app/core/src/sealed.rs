//! Sealed bid auctions (SPEC §9): the settings in the rules, the constants every part shares, and the timing rules that tie the
//! deadline block, the drand round that unlocks the bids, and the block from which late tickets are valid.
//!
//! A sealed bid auction is its own mode (`"sealed_auction"`): campaigns of the older modes keep their rules and ids, and code that does
//! not know this mode refuses it.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// drand's quicknet, pinned: the page and the recount never take the chain or its key from the rules or from a server.
pub const QUICKNET_CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const QUICKNET_PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
/// Unix time of round 1, and the seconds between rounds.
pub const QUICKNET_GENESIS: u64 = 1_692_803_367;
pub const QUICKNET_PERIOD: u64 = 3;
/// The public addresses that serve quicknet, tried in this order; every round's signature is checked against the pinned key, so any of them
/// will do and a wrong one is caught.
pub const DRAND_URLS: [&str; 4] = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

/// The range of average block times the timing rules assume on the main network, fastest to slowest, in seconds (the owner's decision of
/// 20 Oct 2026: the cautious row, 16 C8).
pub const BLOCK_SECS: (u64, u64) = (60, 80);
/// The same range on the test network, whose blocks came every 24 to 25 s on 20 Oct 2026 (the owner's decision of that day: 20 to 80 s).
pub const BLOCK_SECS_TEST: (u64, u64) = (20, 80);

/// The block time range of the quick test timing (test network only, the owner's decision of 20 Oct 2026): 20 to 40 s.
pub const BLOCK_SECS_QUICK: (u64, u64) = (20, 40);

/// The block time range for a network (`Rules::network`) and timing: the main network's, the test network's for every other, or the quick
/// test range when the auction chose it.
pub fn block_secs(network: &str, timing: Timing) -> (u64, u64) {
    match timing {
        Timing::Quick => BLOCK_SECS_QUICK,
        Timing::Standard if network == "main" => BLOCK_SECS,
        Timing::Standard => BLOCK_SECS_TEST,
    }
}
/// Seconds between the close of bidding and the moment the bids can open, at the least (covers the lag of the median block time).
pub const GAP_SECS: u64 = 30 * 60;
/// The same for the quick test timing: 10 minutes.
pub const GAP_SECS_QUICK: u64 = 10 * 60;

/// The gap before the bids open for a timing.
pub fn gap_secs(timing: Timing) -> u64 {
    match timing { Timing::Standard => GAP_SECS, Timing::Quick => GAP_SECS_QUICK }
}

/// The timing an auction was made with. Standard is the default and the only one on the main network; quick test is a choice on the test
/// network for short trial auctions (a faster block range and a shorter gap, so a slower chain makes them void sooner). Left out of the
/// rules when standard, so every auction made before it keeps its id.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Timing {
    #[default]
    Standard,
    Quick,
}
impl Timing {
    pub fn is_standard(&self) -> bool {
        *self == Timing::Standard
    }
}
/// Seconds the host has, after the bids open, to settle every winner and refund the losers before late tickets become valid.
pub const SETTLE_SECS: u64 = 60 * 60;
/// The same on the test network (the owner's decision of 20 Oct 2026, to keep a proof run under about two hours): 30 minutes.
pub const SETTLE_SECS_TEST: u64 = 30 * 60;

/// The settlement time for a network: the main network's, or the test network's for every other.
/// The margin the plan adds to the late ticket block, in seconds at the fast end of the block range: 60 minutes for the standard timing,
/// 10 minutes for the quick test timing.
pub fn margin_secs(timing: Timing) -> u64 {
    match timing { Timing::Standard => 60 * 60, Timing::Quick => 10 * 60 }
}

pub fn settle_secs(network: &str) -> u64 {
    if network == "main" { SETTLE_SECS } else { SETTLE_SECS_TEST }
}
/// The small transparent coin the host sends to each bid page, in zatoshis.
pub const COIN_ZAT: u64 = 5_000;
/// Blocks before the deadline by which a bid's coin must have arrived; after it the page tells the person who bid to take their money back.
pub const COIN_CUTOFF_BLOCKS: u32 = 10;
/// Within this many blocks before the coin cutoff, the host sends coins at once whatever it chose.
pub const COIN_RUSH_BLOCKS: u32 = 20;
/// A payment mined in the last blocks before the deadline (the deadline itself and the two before it) is not a deposit: its early ticket,
/// which expires at the deadline, could not be built in time (the wallet library refuses an expiry below the next block). Like a payment
/// after the deadline, the host sends it back on its own (SPEC 9.5).
pub const LATE_MARGIN_BLOCKS: u32 = 3;

/// The last block in which a payment can be a deposit.
pub fn last_deposit_height(deadline: u32) -> u32 {
    deadline.saturating_sub(LATE_MARGIN_BLOCKS)
}

/// The fewest blocks in which deposits must be accepted: an auction whose bidding window is shorter is refused when it is made.
pub const MIN_BID_WINDOW_BLOCKS: u32 = 10;

/// The blocks from now in which deposits are accepted, for a deadline `deadline_in` blocks from now: a deposit must get its ticket within
/// `ticket_k` blocks and its small payment before the coin cutoff, both before the deadline (the bid page closes at the earlier of the two).
pub fn bid_window(deadline_in: u32, ticket_k: u32) -> u32 {
    deadline_in.saturating_sub(ticket_k.max(COIN_CUTOFF_BLOCKS))
}

/// Refuses a deadline and ticket window that leave fewer than `MIN_BID_WINDOW_BLOCKS` for deposits, saying why.
pub fn check_bid_window(deadline_in: u32, ticket_k: u32) -> Result<()> {
    let w = bid_window(deadline_in, ticket_k);
    if w < MIN_BID_WINDOW_BLOCKS {
        bail!(
            "This leaves {w} block(s) for deposits: a deposit must be made at least {} blocks before the deadline (the ticket window, or the {COIN_CUTOFF_BLOCKS} block cutoff for the host's small payment if larger). Make the deadline at least {} blocks, or the ticket window smaller.",
            ticket_k.max(COIN_CUTOFF_BLOCKS),
            ticket_k.max(COIN_CUTOFF_BLOCKS) + MIN_BID_WINDOW_BLOCKS
        );
    }
    Ok(())
}

/// The most tranches a host may set.
pub const MAX_TRANCHES: usize = 10;
pub const PRICING: [&str; 3] = ["uniform", "second", "pay_your_bid"];

/// How the host sends the coins. There is no default: the host chooses one when it creates the auction.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CoinSending {
    /// One coin as soon as each deposit has its tickets.
    AtOnce,
    /// Coins in one transaction once `n` deposits are waiting.
    EveryBids { n: u32 },
    /// Coins in one transaction every `n` minutes.
    EveryMinutes { n: u32 },
}

/// The sealed bid auction settings in the rules.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sealed {
    /// The deposit sizes, smallest first, 1 to 10 of them. A bid must be at most its tranche minus the fee.
    pub tranches_zat: Vec<u64>,
    /// `"uniform"`, `"second"` or `"pay_your_bid"`.
    pub pricing: String,
    /// Always quicknet (`QUICKNET_CHAIN_HASH`).
    pub drand_chain: String,
    /// The round whose signature unlocks every bid.
    pub drand_round: u64,
    /// Late tickets are valid in blocks after this height (H_s).
    pub claim_after: u32,
    pub coin_zat: u64,
    /// The coin cutoff: blocks before the deadline (`COIN_CUTOFF_BLOCKS` at least).
    pub coin_cutoff: u32,
    pub coin_sending: CoinSending,
    /// Standard (left out of the rules) or quick test (test network only).
    #[serde(default, skip_serializing_if = "Timing::is_standard")]
    pub timing: Timing,
    /// SPEC §9.1, open_payouts: every payment the host signs to a person is made with an outgoing viewing key from `payout`, and the reveal publishes the
    /// payload key, so the page and the recount check who each payment pays. Set by every auction made from 20 Oct 2026 on; left out by
    /// earlier ones (their ids are unchanged; their recount does not check destinations).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open_payouts: bool,
    /// The review, M4: bids use the bound kind of memo (a 16 byte tag made with the locked key, `bid::lock_bid_bound`); the older kind is
    /// no bid. Set by every auction made from 20 Oct 2026 on (after the review); left out by earlier ones.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub long_tag: bool,
    /// The second review, C1: the early ticket is made with its own outgoing key too (kind `payout::EARLY`), so a deposit taken back
    /// before the deadline can be checked to have paid the person's refund address (S4). Set by every auction made from 21 Oct 2026 on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub early_key: bool,
    /// The mentor's second review: the late ticket is made with its own outgoing key too (kind `payout::LATE`), so once the reveal publishes
    /// the payload key the recount also checks that a late ticket paid the person's refund address the deposit minus the fee (S7). Set by
    /// every auction made from 22 Oct 2026 on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub late_key: bool,
    /// Blocks before the coin cutoff in which a payment no longer becomes a deposit: its small payment could not be mined by the cutoff, so
    /// an honest host would fail S3 (a coin the network took 10 blocks to mine, test network, 21 Oct 2026). Such a payment is late: sent
    /// back on its own, minus the fee, like one in the last blocks before the deadline. 0 (left out) for auctions made before.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub coin_margin: u32,
}

impl Sealed {
    /// The checks this auction's rules leave out (it was made before they existed): with any of them missing, the recount says the auction
    /// cannot be fully checked. Every new auction sets all four.
    pub fn missing_checks(&self) -> Vec<&'static str> {
        [(self.open_payouts, "who each refund, change and return pays"), (self.long_tag, "the long binding tag of each bid"), (self.early_key, "who an early ticket paid"), (self.late_key, "who a late ticket paid")]
            .into_iter()
            .filter_map(|(on, what)| (!on).then_some(what))
            .collect()
    }
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// The coin margin new auctions take.
pub const COIN_MARGIN_BLOCKS: u32 = 10;

/// Lock times from this value on are unix times, not block heights (consensus rule).
pub const LOCK_TIME_THRESHOLD: u32 = 500_000_000;
/// How much later than the plan the round (in rounds, 10 minutes) and the late ticket block (in blocks) may be.
pub const PLAN_SLACK_ROUNDS: u64 = 200;
pub const PLAN_SLACK_BLOCKS: u32 = 10;

/// The main network's NU7 activation height, decided on 20 Oct 2026 and listed in ZIP 259 (https://zips.z.cash/zip-0259), whose status was
/// still "Proposed" on 22 Oct 2026. Signed tickets are valid for one network version only, so a sealed bid auction on the main network must
/// be over, late tickets included, before it.
pub const NU7_MAIN_HEIGHT: u32 = 3_543_405;
/// The margin kept before it: about a day at the 75 s blocks before NU7 (the owner's decision of 22 Oct 2026: the official height, with a margin).
pub const NU7_MAIN_MARGIN: u32 = 1_152;
/// A main network sealed bid auction's whole life must end before this block.
pub const MAIN_UPGRADE_CUTOFF: u32 = NU7_MAIN_HEIGHT - NU7_MAIN_MARGIN;
/// Blocks after the late ticket block for the late tickets to be sent and mined, plus a margin.
pub const LATE_LIFE_BLOCKS: u32 = 100;

/// The last block a sealed bid auction needs: its late ticket block, the ticket window and `LATE_LIFE_BLOCKS` (the review, L7: counted
/// from the late ticket block, not from the deadline).
pub fn life_end(rules: &crate::rules::Rules, s: &Sealed) -> u32 {
    s.claim_after.saturating_add(rules.ticket_k).saturating_add(LATE_LIFE_BLOCKS)
}

/// The review, L7: on the main network a sealed bid auction is taken only if its whole life, up to and past its late ticket block, ends
/// before the network upgrade (`next_upgrade`); without a height, not at all. The rules check runs this, so the host, the bid page and the recount all refuse it.
pub fn upgrade_guard(rules: &crate::rules::Rules, s: &Sealed, next_upgrade: Option<u32>) -> Result<()> {
    if rules.network != "main" {
        return Ok(());
    }
    let end = life_end(rules, s);
    match next_upgrade {
        None => bail!("blind bid auctions are not offered on the main network yet: this build does not know the height of the next network upgrade, which signed tickets would not survive"),
        Some(h) if end >= h => Err(too_long_for_main(end, h)),
        Some(_) => Ok(()),
    }
}

fn too_long_for_main(end: u32, cutoff: u32) -> anyhow::Error {
    anyhow::anyhow!("Too long for the main network before the NU7 upgrade: this auction runs, late tickets included, until about block {end}, but it must end before block {cutoff} (the upgrade is at block {NU7_MAIN_HEIGHT}). Choose an earlier deadline.")
}

/// Before any wallet is made: whether a main network sealed bid auction with this deadline, planned from the chain's height now, would be over
/// (late tickets included) before `MAIN_UPGRADE_CUTOFF`. The same plan and the same count as the rules check, which runs again at creation.
pub fn check_main_fits(tip: u32, tip_time: u64, deadline: u32, ticket_k: u32) -> Result<()> {
    let (_, claim_after) = plan("main", Timing::Standard, tip, tip_time, deadline)?;
    let end = claim_after.saturating_add(ticket_k).saturating_add(LATE_LIFE_BLOCKS);
    if end >= MAIN_UPGRADE_CUTOFF {
        return Err(too_long_for_main(end, MAIN_UPGRADE_CUTOFF));
    }
    Ok(())
}

/// The time at which a round's signature is published.
pub fn round_time(round: u64) -> u64 {
    QUICKNET_GENESIS + round.saturating_sub(1) * QUICKNET_PERIOD
}

/// The first round published at or after `t` (unix seconds).
pub fn round_at(t: u64) -> u64 {
    if t <= QUICKNET_GENESIS { 1 } else { (t - QUICKNET_GENESIS).div_ceil(QUICKNET_PERIOD) + 1 }
}

/// The drand round and the late ticket block for a deadline, chosen from the chain as it is now (`tip` and its block time), under the
/// cautious block range: the bids cannot open before the close even if every block is slow, and late tickets cannot become valid before the
/// host has had `SETTLE_SECS` after the bids open even if every block is fast.
pub fn plan(network: &str, timing: Timing, tip: u32, tip_time: u64, deadline: u32) -> Result<(u64, u32)> {
    if deadline <= tip {
        bail!("the deadline must be after the current block");
    }
    let (fast, slow) = block_secs(network, timing);
    let n = (deadline - tip) as u64;
    let unlock = tip_time + n * slow + gap_secs(timing);
    let round = round_at(unlock);
    // plus a margin: a page checks the same rule later, from the chain as it is then, and a run of blocks faster than `fast` since the plan
    // would otherwise put the late ticket block "too early" (the owner's mainnet auction of 22 Oct 2026: 19 blocks at 54.6 s on average
    // made the page refuse it by 0.4 minutes)
    let need = round_time(round) + settle_secs(network) + margin_secs(timing) - tip_time;
    let after = tip as u64 + need.div_ceil(fast);
    Ok((round, u32::try_from(after).map_err(|_| anyhow::anyhow!("too far"))?))
}

impl Sealed {
    /// Checks a sealed auction's settings against the rest of its rules (no chain data needed).
    pub fn check(&self, rules: &crate::rules::Rules) -> Result<()> {
        let n = self.tranches_zat.len();
        if n == 0 || n > MAX_TRANCHES {
            bail!("a blind bid auction has 1 to {MAX_TRANCHES} tranches, not {n}");
        }
        if self.tranches_zat.windows(2).any(|w| w[0] >= w[1]) {
            bail!("the tranches must be different and in increasing order");
        }
        let smallest = self.tranches_zat[0];
        if smallest != rules.min_contribution_zat {
            bail!("the smallest contribution must be the smallest tranche");
        }
        let floor = rules.refund_fee_zat + rules.reserve_zat.unwrap_or(0);
        if smallest <= floor {
            bail!("every tranche must be more than the refund fee plus the reserve, so that a bid fits in it");
        }
        if self.long_tag && self.tranches_zat.iter().any(|&t| t > crate::bid::BOUND_BID_MAX) {
            bail!("with the long tag a tranche is at most {} zatoshis", crate::bid::BOUND_BID_MAX);
        }
        if !PRICING.contains(&self.pricing.as_str()) {
            bail!("the pricing must be uniform, second or pay_your_bid");
        }
        if self.drand_chain != QUICKNET_CHAIN_HASH {
            bail!("the bids must be locked to drand quicknet");
        }
        if self.claim_after <= rules.deadline_height {
            bail!("late tickets must become valid after the deadline");
        }
        // a lock time of 500,000,000 or more is read by the network as a date (long past), so late tickets would work at once (the review, M1)
        if self.claim_after >= LOCK_TIME_THRESHOLD {
            bail!("the late ticket block must be below {LOCK_TIME_THRESHOLD}");
        }
        if self.coin_zat < COIN_ZAT {
            bail!("the coin must be at least {COIN_ZAT} zatoshis");
        }
        if self.coin_cutoff < COIN_CUTOFF_BLOCKS || self.coin_cutoff >= rules.deadline_height.saturating_sub(rules.start_height) {
            bail!("the coin cutoff must be at least {COIN_CUTOFF_BLOCKS} blocks and before the start");
        }
        if self.coin_margin > 0 && self.coin_cutoff + self.coin_margin >= rules.deadline_height.saturating_sub(rules.start_height) {
            bail!("the coin cutoff and its margin must leave blocks for deposits after the start");
        }
        if self.timing == Timing::Quick && rules.network == "main" {
            bail!("the quick test timing is for the test network only");
        }
        match self.coin_sending {
            CoinSending::AtOnce => {}
            CoinSending::EveryBids { n } if (1..=1000).contains(&n) => {}
            CoinSending::EveryMinutes { n } if (1..=1440).contains(&n) => {}
            _ => bail!("coins are sent at once, every 1 to 1000 bids, or every 1 to 1440 minutes"),
        }
        upgrade_guard(rules, self, Some(MAIN_UPGRADE_CUTOFF))
    }

    /// The coin cutoff height: a coin mined after it is too late.
    pub fn cutoff_height(&self, deadline: u32) -> u32 {
        deadline.saturating_sub(self.coin_cutoff)
    }

    /// The last block a payment can be mined in and still be a deposit: the deadline minus `LATE_MARGIN_BLOCKS`, and with a coin margin no
    /// later than the coin cutoff minus that margin. A payment after it is late and goes back on its own.
    pub fn last_deposit(&self, deadline: u32) -> u32 {
        let base = last_deposit_height(deadline);
        if self.coin_margin > 0 { base.min(self.cutoff_height(deadline).saturating_sub(self.coin_margin)) } else { base }
    }

    /// Whether the round and the late ticket block are still safe for a chain at `tip` (its block time `tip_time`): the page checks this
    /// before it lets anyone bid, and the host before it creates the auction. Both hold as the chain moves on, as long as blocks stay
    /// inside `BLOCK_SECS`.
    pub fn check_timing(&self, network: &str, deadline: u32, tip: u32, tip_time: u64) -> Result<()> {
        let (fast, slow) = block_secs(network, self.timing);
        if deadline <= tip {
            bail!("bidding has closed");
        }
        let close_latest = tip_time + (deadline - tip) as u64 * slow;
        if round_time(self.drand_round) < close_latest + gap_secs(self.timing) {
            bail!("the bids could open before bidding closes: the drand round is too early");
        }
        let claim_earliest = tip_time + (self.claim_after + 1 - tip) as u64 * fast;
        if claim_earliest < round_time(self.drand_round) + settle_secs(network) {
            bail!("late tickets could become valid before the host can settle: the late ticket block is too early");
        }
        Ok(())
    }

    /// The review, M1: the round and the late ticket block are no later than the plan for this deadline gives from the block before the
    /// start (the chain as the host saw it when it made the auction: `plan_time` is that block's time), with a small slack. A host cannot
    /// set late tickets to work years later, or the bids to open long after the close.
    pub fn check_not_too_late(&self, network: &str, start_height: u32, deadline: u32, plan_time: u64) -> Result<()> {
        let (round, after) = plan(network, self.timing, start_height.saturating_sub(1), plan_time, deadline)?;
        if self.drand_round > round + PLAN_SLACK_ROUNDS {
            bail!("the bids open later than this deadline needs: drand round {}, where the plan gives {round}", self.drand_round);
        }
        if self.claim_after > after + PLAN_SLACK_BLOCKS {
            bail!("late tickets work later than this deadline needs: after block {}, where the plan gives {after}", self.claim_after);
        }
        Ok(())
    }

    /// The tranche a payment of `value` counts as: the largest tranche at or below it (a payment that matches no tranche counts as the one
    /// below), or none if it is below the smallest.
    pub fn tranche_of(&self, value: u64) -> Option<u64> {
        self.tranches_zat.iter().rev().find(|t| **t <= value).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_and_times() {
        assert_eq!(round_time(1), QUICKNET_GENESIS);
        assert_eq!(round_at(QUICKNET_GENESIS), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 1), 2);
        assert_eq!(round_at(QUICKNET_GENESIS + 3), 2);
        // the saved real round: 33,187,201 was published at genesis + 33,187,200 * 3
        assert_eq!(round_time(33_187_201), QUICKNET_GENESIS + 99_561_600);
        for t in [QUICKNET_GENESIS + 10, 1_800_000_000, 1_800_000_001, 1_800_000_002] {
            let r = round_at(t);
            assert!(round_time(r) >= t && round_time(r) < t + QUICKNET_PERIOD, "{t}");
        }
    }

    #[test]
    fn the_plan_is_safe_at_both_ends_of_the_block_range() {
        // a 7 day auction at 75 s blocks: 8,064 blocks
        let (tip, t0, deadline) = (100_000u32, 1_800_000_000u64, 108_064u32);
        let (round, after) = plan("main", Timing::Standard, tip, t0, deadline).unwrap();
        let s = Sealed { tranches_zat: vec![10_000_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: round, claim_after: after, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Timing::Standard, open_payouts: false, long_tag: false, early_key: false, late_key: false, coin_margin: 0 };
        s.check_timing("main", deadline, tip, t0).unwrap();
        // slow chain (80 s): the close comes before the bids open, with the gap
        let close_slow = t0 + 8_064 * 80;
        assert!(round_time(round) >= close_slow + GAP_SECS);
        // fast chain (60 s): the late tickets come after the bids open plus the settlement time
        let claim_fast = t0 + (after + 1 - tip) as u64 * 60;
        assert!(claim_fast >= round_time(round) + SETTLE_SECS);
        // the wait after the close, in blocks: the cautious row of 16 C8 (2,778 blocks for 7 days; here from block `tip`), plus the plan's
        // margin of 60 minutes at 60 s (60 blocks)
        let wait = after + 1 - deadline;
        assert!((2_760..=2_860).contains(&wait), "{wait}");
        // the margin: a run of fast blocks right after the plan (the owner's case of 22 Oct 2026, 19 blocks at 54.6 s) does not make the late
        // ticket block "too early" for a page that checks then
        s.check_timing("main", deadline, tip + 19, t0 + 1_038).unwrap();
        s.check_timing("main", deadline, tip + 200, t0 + 200 * 45).unwrap();
        // as the chain moves on at 70 s a block, the same settings stay safe
        s.check_timing("main", deadline, tip + 4_000, t0 + 4_000 * 70).unwrap();
        // a round that is too early, or a late ticket block that is too early, is refused
        let mut early = s.clone();
        early.drand_round -= 200; // ten minutes earlier
        assert!(early.check_timing("main", deadline, tip, t0).is_err());
        let mut soon = s.clone();
        soon.claim_after -= 100;
        assert!(soon.check_timing("main", deadline, tip, t0).is_err());
    }

    #[test]
    fn before_any_wallet_a_main_network_auction_must_end_before_the_nu7_cutoff() {
        // the owner's first mainnet auction: about one day (1,152 blocks at 75 s) from block 3,527,800 on 22 Oct 2026 evening
        check_main_fits(3_527_800, 1_792_700_000, 3_527_800 + 1_152, 30).unwrap();
        assert_eq!(MAIN_UPGRADE_CUTOFF, 3_542_253);
        // one whose late tickets would still be valid at the cutoff: refused with one plain line naming the blocks
        let e = check_main_fits(3_527_800, 1_792_700_000, 3_541_000, 30).unwrap_err().to_string();
        assert!(e.starts_with("Too long for the main network before the NU7 upgrade") && e.contains("block 3542253") && e.contains("block 3543405"), "{e}");
    }

    #[test]
    fn l7_on_the_main_network_the_upgrade_cutoff_counts_from_the_late_ticket_block() {
        let mut r = crate::rules::Rules {
            v: 1, network: "main".into(), mode: "sealed_auction".into(), goal_zat: None, items: Some(1), start_height: 3_000_000, deadline_height: 3_008_064,
            ticket_k: 10, close_grace: 10, reissue_window: 20, refund_fee_zat: 10_000, min_contribution_zat: 30_000, campaign_ufvk: None,
            ufvk_hash: None, pay_to: None, early_close: None, cancellable: None, cap_zat: None, name: None, pricing: None, settle_window: None, reserve_zat: None,
            treasury_address: None, treasury_ufvk: None, sealed: None, ledger_pubkey: String::new(), payload_pubkey: String::new(),
        };
        let s = Sealed { tranches_zat: vec![30_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: 1, claim_after: 3_010_842, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Timing::Standard, open_payouts: true, long_tag: true, early_key: false, late_key: false, coin_margin: 0 };
        // the rules check uses the official NU7 height less the margin: a short auction that ends well before it is taken, one whose late tickets reach it is not
        s.check(&r).unwrap();
        let late = Sealed { claim_after: MAIN_UPGRADE_CUTOFF - 50, ..s.clone() };
        assert!(late.check(&r).unwrap_err().to_string().contains(&format!("block {MAIN_UPGRADE_CUTOFF}")));
        assert!(Sealed { claim_after: MAIN_UPGRADE_CUTOFF - LATE_LIFE_BLOCKS - r.ticket_k - 1, ..s.clone() }.check(&r).is_ok(), "the last one that fits");
        // a short proof auction made tonight (block 3,524,780, deadline in 100 blocks) on the standard plan fits
        let (round, after) = plan("main", Timing::Standard, 3_524_780, 1_792_529_253, 3_524_880).unwrap();
        let mut tonight = r.clone();
        (tonight.start_height, tonight.deadline_height) = (3_524_781, 3_524_880);
        Sealed { drand_round: round, claim_after: after, ..s.clone() }.check(&tonight).unwrap();
        // an upgrade after the deadline but before the late tickets are done: refused (counting from the deadline would have let it in)
        let between = 3_009_000;
        assert!(r.deadline_height + r.ticket_k + 100 < between, "the old count from the deadline would pass");
        assert!(upgrade_guard(&r, &s, Some(between)).unwrap_err().to_string().contains("must end before block 3009000"));
        // one after the whole life: taken
        upgrade_guard(&r, &s, Some(life_end(&r, &s) + 1)).unwrap();
        // the test network is never refused this way
        r.network = "test".into();
        upgrade_guard(&r, &s, None).unwrap();
    }

    #[test]
    fn m1_the_round_and_the_late_ticket_block_have_upper_limits() {
        let (tip, t0, deadline) = (4_500_000u32, 1_800_000_000u64, 4_500_090u32);
        let (round, after) = plan("test", Timing::Standard, tip, t0, deadline).unwrap();
        let s = Sealed { tranches_zat: vec![30_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: round, claim_after: after, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Timing::Standard, open_payouts: true, long_tag: false, early_key: false, late_key: false, coin_margin: 0 };
        // the host's own plan (start = tip + 1) passes, and so does a little slack
        s.check_not_too_late("test", tip + 1, deadline, t0).unwrap();
        Sealed { drand_round: round + PLAN_SLACK_ROUNDS, claim_after: after + PLAN_SLACK_BLOCKS, ..s.clone() }.check_not_too_late("test", tip + 1, deadline, t0).unwrap();
        // late tickets a year later, or bids that open a day after the plan: refused
        let years = Sealed { claim_after: after + 1_300_000, ..s.clone() };
        assert!(years.check_not_too_late("test", tip + 1, deadline, t0).unwrap_err().to_string().contains("late tickets work later"));
        let day = Sealed { drand_round: round + 28_800, ..s.clone() };
        assert!(day.check_not_too_late("test", tip + 1, deadline, t0).unwrap_err().to_string().contains("the bids open later"));
        // a late ticket block read as a date is refused by the rules check itself
        let mut r = crate::rules::Rules {
            v: 1, network: "test".into(), mode: "sealed_auction".into(), goal_zat: None, items: Some(1), start_height: tip + 1, deadline_height: deadline,
            ticket_k: 10, close_grace: 10, reissue_window: 20, refund_fee_zat: 10_000, min_contribution_zat: 30_000, campaign_ufvk: None,
            ufvk_hash: None, pay_to: None, early_close: None, cancellable: None, cap_zat: None, name: None, pricing: None, settle_window: None, reserve_zat: None,
            treasury_address: None, treasury_ufvk: None, sealed: None, ledger_pubkey: String::new(), payload_pubkey: String::new(),
        };
        s.check(&r).unwrap();
        r.deadline_height = deadline;
        assert!(Sealed { claim_after: LOCK_TIME_THRESHOLD, ..s.clone() }.check(&r).unwrap_err().to_string().contains("below 500000000"));
    }

    #[test]
    fn the_test_network_plan_is_safe_for_its_fast_blocks() {
        // 90 blocks on the test network: the bids open after the close even at 80 s a block, and the late tickets come after the bids
        // open plus the settlement time even at 20 s a block
        let (tip, t0, deadline) = (4_500_000u32, 1_800_000_000u64, 4_500_090u32);
        let (round, after) = plan("test", Timing::Standard, tip, t0, deadline).unwrap();
        assert!(round_time(round) >= t0 + 90 * 80 + GAP_SECS);
        assert!(t0 + (after + 1 - tip) as u64 * 20 >= round_time(round) + SETTLE_SECS_TEST);
        let s = Sealed { tranches_zat: vec![30_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: round, claim_after: after, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Timing::Standard, open_payouts: false, long_tag: false, early_key: false, late_key: false, coin_margin: 0 };
        s.check_timing("test", deadline, tip, t0).unwrap();
        // at the test network's real pace (25 s), the late tickets work about 4.95 h after creation (3.7 h before the plan's margin of
        // 60 minutes at 20 s, 180 blocks), the bids open about 2.5 h after
        let (open_h, claim_h) = ((round_time(round) - t0) as f64 / 3600.0, (after - tip) as f64 * 25.0 / 3600.0);
        assert!((2.4..2.6).contains(&open_h) && (4.75..5.15).contains(&claim_h), "{open_h} {claim_h}");
        // the proof run's 30 blocks: bids open after 70 minutes, the late ticket block is 480 blocks on (300 before the margin)
        let (round30, after30) = plan("test", Timing::Standard, tip, t0, tip + 30).unwrap();
        assert!((4_200..4_203).contains(&(round_time(round30) - t0)));
        assert!((480..=481).contains(&(after30 - tip)), "{}", after30 - tip);
    }

    #[test]
    fn the_quick_test_timing_is_safe_for_its_range_and_shorter() {
        let (tip, t0) = (4_500_000, 1_792_000_000);
        let (round, after) = plan("test", Timing::Quick, tip, t0, tip + 30).unwrap();
        // the bids cannot open before the close even at 40 s a block, and the host has its 30 minutes even at 20 s a block
        assert!(round_time(round) >= t0 + 30 * 40 + GAP_SECS_QUICK);
        assert!(t0 + (after + 1 - tip) as u64 * 20 >= round_time(round) + SETTLE_SECS_TEST);
        let s = Sealed { tranches_zat: vec![30_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: round, claim_after: after, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Timing::Quick, open_payouts: false, long_tag: false, early_key: false, late_key: false, coin_margin: 0 };
        s.check_timing("test", tip + 30, tip, t0).unwrap();
        // the same round under the standard timing is too early: the timing is part of what is checked
        assert!(Sealed { timing: Timing::Standard, ..s.clone() }.check_timing("test", tip + 30, tip, t0).is_err());
        // 30 blocks: the bids open after 30 minutes (70 standard), late tickets 210 blocks on (180 before the margin of 10 minutes at 20 s;
        // 480 standard), about 88 minutes at 25 s
        assert!((1_800..1_803).contains(&(round_time(round) - t0)), "{}", round_time(round) - t0);
        assert!((210..=211).contains(&(after - tip)), "{}", after - tip);
        // blocks slower than 40 s: after 10 blocks of 60 s the page stops taking bids (the round could come before the close)
        assert!(s.check_timing("test", tip + 30, tip + 10, t0 + 600).is_err());
        // the main network never uses it, whatever is asked
        assert_eq!(block_secs("main", Timing::Standard), BLOCK_SECS);
        assert_eq!(block_secs("test", Timing::Standard), BLOCK_SECS_TEST);
        assert_eq!((gap_secs(Timing::Standard), gap_secs(Timing::Quick)), (30 * 60, 10 * 60));
    }

    #[test]
    fn the_bidding_window_must_hold_ten_blocks() {
        assert_eq!(bid_window(30, 30), 0);
        assert_eq!(bid_window(30, 10), 20);
        assert_eq!(bid_window(30, 5), 20, "the coin cutoff of 10 blocks counts when the ticket window is shorter");
        let e = check_bid_window(30, 30).unwrap_err().to_string();
        assert!(e.contains("This leaves 0 block(s) for deposits") && e.contains("at least 40 blocks"), "{e}");
        assert!(check_bid_window(19, 10).is_err());
        check_bid_window(20, 10).unwrap();
        check_bid_window(40, 30).unwrap();
        check_bid_window(20, 3).unwrap();
    }

    #[test]
    fn coin_sending_is_written_as_the_host_chose_it() {
        assert_eq!(serde_json::to_string(&CoinSending::AtOnce).unwrap(), r#"{"mode":"at_once"}"#);
        assert_eq!(serde_json::to_string(&CoinSending::EveryBids { n: 5 }).unwrap(), r#"{"mode":"every_bids","n":5}"#);
        assert_eq!(serde_json::to_string(&CoinSending::EveryMinutes { n: 30 }).unwrap(), r#"{"mode":"every_minutes","n":30}"#);
    }
}

//! Guards for a campaign on the real network (mainnet). Nothing here moves money; it only refuses to start or close a campaign unless the host
//! has confirmed it handles real ZEC, and refuses a campaign that could still be running when the NU7 network upgrade activates (the pre-signed
//! refund tickets are valid for one consensus branch only, and this build's libraries do not know the mainnet NU7 parameters).

use anyhow::{bail, Result};

/// 2026-11-05 00:00 UTC: the date announced for the mainnet NU7 upgrade. The activation HEIGHT is to be decided on 2026-10-20; until it is given with
/// --nu7-mainnet-height, a campaign must be over a week before this date.
pub const NU7_TARGET_UNIX: u64 = 1_793_836_800;
const SAFETY_SECS: u64 = 7 * 86_400;
/// Mainnet blocks are about 75 seconds before NU7 (this is the pre-upgrade length, used only for the date-based guard, with a 25% allowance).
const PRE_NU7_BLOCK_SECS: u64 = 75;
/// Blocks kept free before the activation height, on top of the whole life of the campaign.
const MARGIN_BLOCKS: u32 = 50;

/// How many blocks a campaign created now will stay alive: until its deadline, its ticket window, the host's close grace, the re-issue window and the
/// time for refunds to be mined, plus a margin.
pub fn blocks_needed(deadline_in: u32, ticket_k: u32) -> u32 {
    deadline_in.saturating_add(ticket_k).saturating_add(10 + 20 + MARGIN_BLOCKS)
}

pub fn require_confirmation(network: &str, confirmed: bool) -> Result<()> {
    if network == "main" && !confirmed {
        bail!("MAINNET: this program is set to the real network, so this uses real ZEC. Tick the box that says you understand this, then try again.");
    }
    Ok(())
}

/// Refuses a mainnet campaign that could cross the NU7 activation. `tip` is the current chain height when known.
pub fn nu7_guard(network: &str, tip: Option<u32>, blocks_needed: u32, now_unix: u64, activation_height: Option<u32>) -> Result<()> {
    if network != "main" {
        return Ok(());
    }
    match (activation_height, tip) {
        (Some(h), Some(t)) => {
            if t >= h {
                bail!("The mainnet NU7 upgrade is already active (block {h}). This build's libraries do not know the mainnet NU7 parameters, so it cannot make valid refund tickets yet.");
            }
            if t.saturating_add(blocks_needed) >= h {
                bail!("This campaign could still be running when the NU7 upgrade activates at block {h} (it needs ≈ {blocks_needed} blocks and the chain is at block {t}). Refund tickets signed before the upgrade stop working after it. Choose a shorter deadline.");
            }
            Ok(())
        }
        (Some(_), None) => Ok(()), // the height check runs again once the chain height is known
        (None, _) => {
            let end = now_unix + (blocks_needed as u64) * PRE_NU7_BLOCK_SECS * 5 / 4;
            if end + SAFETY_SECS >= NU7_TARGET_UNIX {
                bail!("The mainnet NU7 upgrade is announced for 5 November 2026 and its block height is not published yet (it is expected on 20 October). A campaign must be over a week before that, and this one could still be running then. Choose a shorter deadline, or give the published height with --nu7-mainnet-height.");
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OCT_8: u64 = 1_791_417_600; // 2026-10-08 00:00 UTC

    #[test]
    fn mainnet_needs_the_confirmation_and_the_test_network_does_not() {
        assert!(require_confirmation("main", false).is_err());
        assert!(require_confirmation("main", true).is_ok());
        assert!(require_confirmation("test", false).is_ok());
    }

    #[test]
    fn without_a_published_height_a_campaign_must_end_a_week_before_the_target_date() {
        // 500 blocks is about 13 hours: fine on 8 October
        assert!(nu7_guard("main", None, blocks_needed(500, 30), OCT_8, None).is_ok());
        // 60,000 blocks is about 52 days: crosses the target date
        let e = nu7_guard("main", None, blocks_needed(60_000, 30), OCT_8, None).unwrap_err().to_string();
        assert!(e.contains("5 November 2026") && e.contains("not published yet"), "{e}");
        // late October: even a short campaign is too late
        assert!(nu7_guard("main", None, blocks_needed(500, 30), NU7_TARGET_UNIX - 3 * 86_400, None).is_err());
    }

    #[test]
    fn a_short_campaign_is_allowed_without_a_published_height_until_29_october() {
        // the cut-off is 7 days before 2026-11-05 00:00 UTC, i.e. 2026-10-29 00:00 UTC, measured on the campaign's WHOLE life:
        // deadline + ticket window + 10 (close grace) + 20 (re-issue window) + 50 (margin) blocks, at 75 s per block plus 25%
        let cutoff = NU7_TARGET_UNIX - 7 * 86_400;
        assert_eq!(cutoff, 1_793_232_000); // 2026-10-29 00:00:00 UTC
        let life_secs = |deadline_in| blocks_needed(deadline_in, 30) as u64 * 75 * 5 / 4;
        // a 200-block pilot (about 4 hours of deadline) started at noon on 28 October ends that evening: allowed
        let noon_28 = cutoff - 12 * 3600;
        assert!(noon_28 + life_secs(200) < cutoff);
        assert!(nu7_guard("main", None, blocks_needed(200, 30), noon_28, None).is_ok());
        // the same campaign started at 20:00 on 28 October would still be alive after the cut-off: refused
        assert!(nu7_guard("main", None, blocks_needed(200, 30), cutoff - 4 * 3600, None).is_err());
        // today (8 October) the longest allowed deadline is about 19,000 blocks
        let oct_8 = 1_791_417_600u64;
        assert!(nu7_guard("main", None, blocks_needed(19_000, 30), oct_8, None).is_ok());
        assert!(nu7_guard("main", None, blocks_needed(19_400, 30), oct_8, None).is_err());
    }

    #[test]
    fn with_a_published_height_the_whole_life_of_the_campaign_must_fit_before_it() {
        let h = Some(4_000_000);
        assert!(nu7_guard("main", Some(3_990_000), blocks_needed(500, 30), OCT_8, h).is_ok());
        assert!(nu7_guard("main", Some(3_999_500), blocks_needed(500, 30), OCT_8, h).is_err());
        let e = nu7_guard("main", Some(4_000_001), 10, OCT_8, h).unwrap_err().to_string();
        assert!(e.contains("already active"), "{e}");
        // exactly at the edge: the margin keeps it out
        assert!(nu7_guard("main", Some(4_000_000 - blocks_needed(100, 30)), blocks_needed(100, 30), OCT_8, h).is_err());
    }

    #[test]
    fn the_test_network_is_never_refused() {
        assert!(nu7_guard("test", Some(1), u32::MAX, OCT_8, Some(5)).is_ok());
    }
}

//! The OS random number generator, in the shape the Zcash libraries expect.
//!
//! `rand` 0.10 replaced `OsRng` with the fallible `SysRng`; the Zcash crates take an
//! infallible `CryptoRng`, so we wrap it in `UnwrapErr` (panicking if the OS RNG fails,
//! as `OsRng` did). The type and constant share a name so call sites keep using `OsRng`.

use rand::{rand_core::UnwrapErr, rngs::SysRng};

pub(crate) type OsRng = UnwrapErr<SysRng>;

#[allow(non_upper_case_globals)]
pub(crate) const OsRng: OsRng = UnwrapErr(SysRng);

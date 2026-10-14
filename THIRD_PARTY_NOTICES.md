# Third party notices

Clewbook is licensed under the MIT licence or the Apache License 2.0, at your option (see LICENSE-MIT, LICENSE-APACHE and NOTICE). It is built on top of work by other people. This file lists the outside libraries that go into the programs and the browser module, with the licence each one declares.

## How this list was made, and what it does not prove

- It was generated from the two lock files (`app/Cargo.lock` and the root `Cargo.lock`) and the licence field of each library's manifest in the local Rust crate cache. It reports what each library declares about itself. It is not legal advice, and the licence texts themselves are in each library's source package.
- A lock file also lists libraries used only for tests, only on other operating systems, or only for optional features. So these lists are a superset of what is compiled into any one program.
- Libraries that are never built on this system (for example ones for other operating systems, or behind optional features) were not in the local crate cache at first. On 14 October 2026 every library in both lock files was downloaded from crates.io for this purpose, and their licences were read from their own packages; those rows say so. Nothing was guessed, and every row now has a licence.
- Every licence listed is permissive, or offers a permissive choice. One needs a note: mozjpeg (IJG licence) asks that a program shipping it say it is based in part on the work of the Independent JPEG Group. It is in the wallet tool's lock file only through an optional feature and is not compiled into the wallet tool as this repository builds it.
- The licences below mostly require that the copyright notice and licence text stay with copies of the code. The source packages carry them. The browser module (`pkg/` and `proof/`, built from the libraries in the first table) is served to visitors without a separate notice page, which is a gap we know about.
- Zig (the build tool for the browser module's one C dependency) and Python (the page server) are not part of the shipped code. The test tools in `app/vectors/js` are not shipped either (Playwright 1.63.0, Apache-2.0; libsodium-wrappers-sumo 0.7.16, ISC; jsqr 1.4.0, Apache-2.0; pngjs 7.0.0, MIT; qrcode 1.5.4, MIT; @noble/hashes 1.8.0, MIT, all as declared in their installed packages).
- Fonts served by the pages: Newsreader, Geist, Geist Mono and Atkinson Hyperlegible, under the SIL Open Font License 1.1. Their licence files are in `app/web/www/fonts/`.

## 1. Programs and browser module in `app/` (469 libraries)

| Library | Version | Licence declared |
|---|---|---|
| addchain | 0.3.0 | MIT OR Apache-2.0 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aead | 0.5.2 | MIT OR Apache-2.0 |
| aead | 0.6.1 | MIT OR Apache-2.0 |
| aes | 0.8.4 | MIT OR Apache-2.0 |
| aes | 0.9.3 | MIT OR Apache-2.0 |
| aes-gcm | 0.10.3 | Apache-2.0 OR MIT |
| age | 0.12.1 | MIT OR Apache-2.0 |
| age-core | 0.12.0 | MIT OR Apache-2.0 |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| anstream | 1.0.0 | MIT OR Apache-2.0 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 |
| anstyle-wincon | 3.0.11 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| arc-swap | 1.9.2 | MIT OR Apache-2.0 |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| ascii | 1.1.0 | Apache-2.0 OR MIT |
| async-trait | 0.1.92 | MIT OR Apache-2.0 |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| axum | 0.8.9 | MIT |
| axum-core | 0.5.6 | MIT |
| base16ct | 0.2.0 | Apache-2.0 OR MIT |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT |
| basic-toml | 0.1.10 | MIT OR Apache-2.0 |
| bech32 | 0.11.1 | MIT |
| bellman | 0.15.0 | MIT OR Apache-2.0 |
| bip0039 | 0.14.2 | Apache-2.0 |
| bip32 | 0.6.0 | Apache-2.0 OR MIT |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bitvec | 1.1.1 | MIT |
| blake2 | 0.10.6 | MIT OR Apache-2.0 |
| blake2b_simd | 1.0.5 | MIT |
| blake2s_simd | 1.0.5 | MIT |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 |
| bls12_381 | 0.9.0 | MIT/Apache-2.0 |
| bounded-vec | 0.9.0 | CC0-1.0 |
| bs58 | 0.5.1 | MIT/Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| byteorder | 1.5.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cbc | 0.2.1 | MIT OR Apache-2.0 |
| cc | 1.6.0 | MIT OR Apache-2.0 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |
| chacha20 | 0.9.1 | Apache-2.0 OR MIT |
| chacha20poly1305 | 0.10.1 | Apache-2.0 OR MIT |
| chacha20poly1305 | 0.11.0 | Apache-2.0 OR MIT |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| chunked_transfer | 1.5.0 | MIT OR Apache-2.0 |
| cipher | 0.4.4 | MIT OR Apache-2.0 |
| cipher | 0.5.2 | MIT OR Apache-2.0 |
| clap | 4.6.7 | MIT OR Apache-2.0 |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 |
| clap_derive | 4.6.7 | MIT OR Apache-2.0 |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 |
| cmov | 0.5.4 | Apache-2.0 OR MIT |
| cobs | 0.3.0 | MIT OR Apache-2.0 |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 |
| const-oid | 0.10.2 | Apache-2.0 OR MIT |
| const-oid | 0.9.6 | Apache-2.0 OR MIT |
| constant_time_eq | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| cookie-factory | 0.3.3 | MIT |
| corez | 0.1.1 | MIT OR Apache-2.0 |
| cpubits | 0.1.1 | MIT OR Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crunchy | 0.2.4 | MIT |
| crypto-bigint | 0.5.5 | Apache-2.0 OR MIT |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 |
| crypto_box | 0.9.1 | Apache-2.0 OR MIT |
| crypto_secretbox | 0.1.1 | Apache-2.0 OR MIT |
| ctr | 0.9.2 | MIT OR Apache-2.0 |
| ctutils | 0.4.2 | Apache-2.0 OR MIT |
| curve25519-dalek | 4.1.3 | BSD-3-Clause |
| curve25519-dalek-derive | 0.1.1 | MIT/Apache-2.0 |
| daggy | 0.8.1 | MIT/Apache-2.0 |
| darling | 0.24.1 | MIT |
| darling_core | 0.24.1 | MIT |
| darling_macro | 0.24.1 | MIT |
| defmt | 1.1.1 | MIT OR Apache-2.0 |
| defmt-macros | 1.1.1 | MIT OR Apache-2.0 |
| defmt-parser | 1.0.0 | MIT OR Apache-2.0 |
| der | 0.7.10 | Apache-2.0 OR MIT |
| deranged | 0.5.8 | MIT OR Apache-2.0 |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| digest | 0.11.3 | MIT OR Apache-2.0 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| document-features | 0.2.12 | MIT OR Apache-2.0 |
| ed25519 | 2.2.3 | Apache-2.0 OR MIT |
| ed25519-dalek | 2.2.0 | BSD-3-Clause |
| either | 1.18.0 | MIT OR Apache-2.0 |
| elliptic-curve | 0.13.8 | Apache-2.0 OR MIT |
| embedded-io | 0.4.0 | MIT OR Apache-2.0 |
| embedded-io | 0.6.1 | MIT OR Apache-2.0 |
| equihash | 0.3.0 | MIT OR Apache-2.0 |
| equivalent | 1.0.2 | Apache-2.0 OR MIT |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| f4jumble | 0.1.1 | MIT OR Apache-2.0 |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| ff | 0.13.1 | MIT/Apache-2.0 |
| ff | 0.14.0 | MIT/Apache-2.0 |
| ff_derive | 0.14.0 | MIT/Apache-2.0 |
| fiat-crypto | 0.2.9 | MIT OR Apache-2.0 OR BSD-1-Clause (read from the package on 14 October 2026) |
| find-crate | 0.6.3 | Apache-2.0 OR MIT |
| find-msvc-tools | 0.1.14 | MIT OR Apache-2.0 |
| fixedbitset | 0.5.7 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| fluent | 0.17.0 | Apache-2.0 OR MIT |
| fluent-bundle | 0.16.0 | Apache-2.0 OR MIT |
| fluent-langneg | 0.13.1 | Apache-2.0 OR MIT |
| fluent-syntax | 0.12.0 | Apache-2.0 OR MIT |
| flume | 0.11.1 | Apache-2.0/MIT |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| foldhash | 0.1.5 | Zlib |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| fpe | 0.7.0 | MIT OR Apache-2.0 |
| funty | 2.0.0 | MIT |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| getset | 0.1.7 | MIT |
| ghash | 0.5.1 | Apache-2.0 OR MIT |
| groth16 | 0.2.0 | MIT OR Apache-2.0 |
| group | 0.13.0 | MIT/Apache-2.0 |
| group | 0.14.0 | MIT/Apache-2.0 |
| h2 | 0.4.19 | MIT |
| halo2_gadgets | 0.6.0 | MIT OR Apache-2.0 |
| halo2_legacy_pdqsort | 0.1.0 | MIT OR Apache-2.0 |
| halo2_poseidon | 0.2.0 | MIT OR Apache-2.0 |
| halo2_proofs | 0.4.0 | MIT OR Apache-2.0 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 |
| hashbrown | 0.15.5 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| hashlink | 0.10.0 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| hermit-abi | 0.5.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| hex | 0.4.3 | MIT OR Apache-2.0 |
| hkdf | 0.12.4 | MIT OR Apache-2.0 |
| hmac | 0.12.1 | MIT OR Apache-2.0 |
| hmac | 0.13.0 | MIT OR Apache-2.0 |
| hpke | 0.12.0 | MIT/Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| http-body | 1.1.0 | MIT |
| http-body-util | 0.1.5 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| hybrid-array | 0.2.3 | MIT OR Apache-2.0 |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 |
| hyper | 1.11.1 | MIT |
| hyper-timeout | 0.5.2 | MIT OR Apache-2.0 |
| hyper-util | 0.1.21 | MIT |
| i18n-config | 0.4.8 | MIT |
| i18n-embed | 0.16.0 | MIT |
| i18n-embed-fl | 0.10.1 | MIT |
| i18n-embed-impl | 0.8.4 | MIT |
| icu_collections | 2.3.0 | Unicode-3.0 |
| icu_locale_core | 2.3.0 | Unicode-3.0 |
| icu_normalizer | 2.3.0 | Unicode-3.0 |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 |
| icu_properties | 2.3.0 | Unicode-3.0 |
| icu_properties_data | 2.3.0 | Unicode-3.0 |
| icu_provider | 2.3.1 | Unicode-3.0 |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| incrementalmerkletree | 0.9.0 | MIT OR Apache-2.0 |
| indexmap | 1.9.3 | Apache-2.0 OR MIT |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| inout | 0.1.4 | MIT OR Apache-2.0 |
| inout | 0.2.2 | MIT OR Apache-2.0 |
| intl-memoizer | 0.5.3 | Apache-2.0 OR MIT |
| intl_pluralrules | 7.0.2 | Apache-2.0/MIT |
| io_tee | 0.1.1 | MIT OR Apache-2.0 |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| itertools | 0.14.0 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| jiff | 0.2.37 | Unlicense OR MIT |
| jiff-core | 0.1.1 | Unlicense OR MIT |
| jiff-static | 0.2.37 | Unlicense OR MIT (read from the package on 14 October 2026) |
| js-sys | 0.3.106 | MIT OR Apache-2.0 |
| jubjub | 0.11.1 | MIT/Apache-2.0 |
| keccak | 0.1.6 | Apache-2.0 OR MIT |
| kem | 0.3.0-pre.0 | Apache-2.0 OR MIT |
| lazy_static | 1.5.1 | MIT OR Apache-2.0 |
| libc | 0.2.190 | MIT OR Apache-2.0 |
| libm | 0.2.16 | MIT |
| libsqlite3-sys | 0.35.0 | MIT |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| litemap | 0.8.3 | Unicode-3.0 |
| litrs | 1.0.0 | MIT OR Apache-2.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.34 | MIT OR Apache-2.0 |
| matchit | 0.8.4 | MIT AND BSD-3-Clause |
| maybe-rayon | 0.1.1 | MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| memuse | 0.2.2 | MIT/Apache-2.0 |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| mime_guess | 2.0.5 | MIT |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| mio | 1.2.4 | MIT |
| ml-kem | 0.2.3 | Apache-2.0 OR MIT |
| multimap | 0.10.1 | MIT OR Apache-2.0 |
| nanorand | 0.7.0 | Zlib |
| nom | 7.1.3 | MIT |
| nom | 8.0.0 | MIT |
| nonempty | 0.11.0 | MIT |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 |
| num-bigint | 0.5.1 | MIT OR Apache-2.0 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| num_cpus | 1.17.0 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| once_cell_polyfill | 1.70.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| opaque-debug | 0.3.1 | MIT OR Apache-2.0 |
| orchard | 0.16.0 | MIT OR Apache-2.0 |
| p256 | 0.13.2 | Apache-2.0 OR MIT |
| pairing | 0.24.0 | MIT/Apache-2.0 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| pasta_curves | 0.6.0 | MIT OR Apache-2.0 |
| pastey | 0.2.3 | MIT OR Apache-2.0 |
| pbkdf2 | 0.12.2 | MIT OR Apache-2.0 |
| pbkdf2 | 0.13.0 | MIT OR Apache-2.0 |
| pczt | 0.10.0-pre.0 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| petgraph | 0.7.1 | MIT OR Apache-2.0 |
| petgraph | 0.8.3 | MIT OR Apache-2.0 |
| phf | 0.14.0 | MIT |
| phf_generator | 0.14.0 | MIT |
| phf_macros | 0.14.0 | MIT |
| phf_shared | 0.14.0 | MIT |
| pin-project | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-internal | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| pkcs8 | 0.10.2 | Apache-2.0 OR MIT |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 |
| poly1305 | 0.8.0 | Apache-2.0 OR MIT |
| poly1305 | 0.9.1 | Apache-2.0 OR MIT |
| polyval | 0.6.2 | Apache-2.0 OR MIT |
| portable-atomic | 1.15.0 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| postcard | 1.1.3 | MIT OR Apache-2.0 |
| potential_utf | 0.1.6 | Unicode-3.0 |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| prettyplease | 0.2.37 | MIT OR Apache-2.0 |
| primeorder | 0.13.6 | Apache-2.0 OR MIT |
| proc-macro-error-attr3 | 3.1.1 | MIT OR Apache-2.0 |
| proc-macro-error3 | 3.1.1 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| prost | 0.14.4 | Apache-2.0 |
| prost-build | 0.14.4 | Apache-2.0 |
| prost-derive | 0.14.4 | Apache-2.0 |
| prost-types | 0.14.4 | Apache-2.0 |
| qrcode | 0.14.1 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later (read from the package on 14 October 2026) |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later (read from the package on 14 October 2026) |
| radium | 0.7.0 | MIT |
| rand | 0.10.3 | MIT OR Apache-2.0 |
| rand | 0.8.8 | MIT OR Apache-2.0 |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.10.1 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rand_distr | 0.6.0 | MIT OR Apache-2.0 |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| reddsa | 0.6.1 | MIT OR Apache-2.0 |
| redjubjub | 0.9.0 | MIT OR Apache-2.0 |
| redox_syscall | 0.5.18 | MIT (read from the package on 14 October 2026) |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| ripemd | 0.1.3 | MIT OR Apache-2.0 |
| ripemd | 0.2.0 | MIT OR Apache-2.0 |
| rusqlite | 0.37.0 | MIT |
| rust-embed | 8.12.0 | MIT |
| rust-embed-impl | 8.12.0 | MIT |
| rust-embed-utils | 8.12.0 | MIT |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 |
| rustix | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustls | 0.23.45 | Apache-2.0 OR ISC OR MIT |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 |
| rustls-webpki | 0.103.15 | ISC |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| salsa20 | 0.10.2 | MIT OR Apache-2.0 |
| same-file | 1.0.6 | Unlicense/MIT |
| sapling-crypto | 0.9.0 | MIT OR Apache-2.0 |
| schemerz | 0.2.0 | MIT/Apache-2.0 |
| schemerz-rusqlite | 0.370.0 | MIT OR Apache-2.0 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| scrypt | 0.11.0 | MIT OR Apache-2.0 |
| sec1 | 0.7.3 | Apache-2.0 OR MIT |
| secp256k1 | 0.33.1 | CC0-1.0 |
| secp256k1-sys | 0.14.1 | CC0-1.0 |
| secrecy | 0.10.3 | Apache-2.0 OR MIT |
| secrecy | 0.8.0 | Apache-2.0 OR MIT |
| self_cell | 1.3.0 | Apache-2.0 OR GPL-2.0-only |
| semver | 1.0.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 |
| sha1 | 0.10.7 | MIT OR Apache-2.0 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| sha2 | 0.11.0 | MIT OR Apache-2.0 |
| sha3 | 0.10.9 | MIT OR Apache-2.0 |
| shardtree | 0.8.0 | MIT OR Apache-2.0 |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| signature | 2.2.0 | Apache-2.0 OR MIT |
| simd-adler32 | 0.3.10 | MIT |
| sinsemilla | 0.2.0 | MIT OR Apache-2.0 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| smallvec | 1.16.2 | MIT OR Apache-2.0 |
| socket2 | 0.6.5 | MIT OR Apache-2.0 |
| spin | 0.9.9 | MIT |
| spki | 0.7.3 | Apache-2.0 OR MIT |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 |
| strsim | 0.11.1 | MIT |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.6 | MIT OR Apache-2.0 |
| sync_wrapper | 1.0.2 | Apache-2.0 |
| synstructure | 0.14.0 | MIT |
| tap | 1.0.1 | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tiny_http | 0.12.0 | MIT OR Apache-2.0 |
| tinystr | 0.8.4 | Unicode-3.0 |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| tokio | 1.53.2 | MIT |
| tokio-macros | 2.7.2 | MIT |
| tokio-rustls | 0.26.6 | MIT OR Apache-2.0 |
| tokio-stream | 0.1.19 | MIT |
| tokio-util | 0.7.19 | MIT |
| toml | 0.5.11 | MIT/Apache-2.0 |
| toml | 0.8.23 | MIT OR Apache-2.0 |
| toml_datetime | 0.6.11 | MIT OR Apache-2.0 |
| toml_edit | 0.22.27 | MIT OR Apache-2.0 |
| toml_write | 0.1.2 | MIT OR Apache-2.0 |
| tonic | 0.14.6 | MIT |
| tonic-build | 0.14.6 | MIT |
| tonic-prost | 0.14.6 | MIT |
| tonic-prost-build | 0.14.6 | MIT |
| tower | 0.5.3 | MIT |
| tower-layer | 0.3.3 | MIT |
| tower-service | 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| try-lock | 0.2.5 | MIT |
| type-map | 0.5.1 | MIT/Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| uint | 0.9.5 | MIT OR Apache-2.0 |
| unic-langid | 0.9.6 | MIT OR Apache-2.0 |
| unic-langid-impl | 0.9.6 | MIT OR Apache-2.0 |
| unicase | 2.9.0 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 |
| universal-hash | 0.5.1 | MIT OR Apache-2.0 |
| universal-hash | 0.6.1 | MIT OR Apache-2.0 |
| untrusted | 0.9.0 | ISC |
| ureq | 2.12.1 | MIT OR Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT |
| uuid | 1.27.0 | Apache-2.0 OR MIT |
| vcpkg | 0.2.15 | MIT/Apache-2.0 |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| visibility | 0.1.1 | Zlib OR MIT OR Apache-2.0 |
| walkdir | 2.5.0 | Unlicense/MIT |
| want | 0.3.1 | MIT |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 |
| webpki-roots | 0.26.11 | CDLA-Permissive-2.0 |
| webpki-roots | 1.0.9 | CDLA-Permissive-2.0 |
| which | 8.0.6 | MIT |
| winapi-util | 0.1.11 | Unlicense OR MIT (read from the package on 14 October 2026) |
| windows-link | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| winnow | 0.7.15 | MIT |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| writeable | 0.6.4 | Unicode-3.0 |
| wyz | 0.5.1 | MIT |
| x25519-dalek | 2.0.1 | BSD-3-Clause |
| yoke | 0.8.3 | Unicode-3.0 |
| yoke-derive | 0.8.4 | Unicode-3.0 |
| zcash_address | 0.14.0-pre.0 | MIT OR Apache-2.0 |
| zcash_client_backend | 0.25.0-pre.0 | MIT OR Apache-2.0 |
| zcash_client_sqlite | 0.23.0-pre.0 | MIT OR Apache-2.0 |
| zcash_encoding | 0.5.0 | MIT OR Apache-2.0 |
| zcash_keys | 0.17.0-pre.0 | MIT OR Apache-2.0 |
| zcash_note_encryption | 0.5.1 | MIT OR Apache-2.0 |
| zcash_pool_migration | 0.2.0-pre.0 | MIT OR Apache-2.0 |
| zcash_primitives | 0.31.0-pre.0 | MIT OR Apache-2.0 |
| zcash_protocol | 0.11.0-pre.0 | MIT OR Apache-2.0 |
| zcash_script | 0.6.0 | Apache-2.0 |
| zcash_spec | 0.2.1 | MIT OR Apache-2.0 |
| zcash_transparent | 0.11.0-pre.0 | MIT OR Apache-2.0 |
| zerocopy | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 |
| zeroize | 1.9.0 | Apache-2.0 OR MIT |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.8 | Unicode-3.0 |
| zerovec-derive | 0.11.6 | Unicode-3.0 |
| zip32 | 0.3.0 | MIT OR Apache-2.0 |
| zip321 | 0.10.0-pre.0 | MIT OR Apache-2.0 |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |

## 2. The wallet tool at the repository root, a modified copy of zcash-devtool (905 libraries)

The wallet tool's list is longer because it also carries optional features that the programs in `app/` do not use. The tool's own licence is MIT or Apache-2.0 and its changes are listed in CHANGES.md.

| Library | Version | Licence declared |
|---|---|---|
| addchain | 0.3.0 | MIT OR Apache-2.0 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aead | 0.5.2 | MIT OR Apache-2.0 |
| aead | 0.6.1 | MIT OR Apache-2.0 |
| aes | 0.8.4 | MIT OR Apache-2.0 |
| aes | 0.9.2 | MIT OR Apache-2.0 |
| aes-gcm | 0.10.3 | Apache-2.0 OR MIT |
| age | 0.12.1 | MIT OR Apache-2.0 |
| age-core | 0.12.0 | MIT OR Apache-2.0 |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| aligned | 0.4.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| aligned-vec | 0.6.4 | MIT (read from the package on 14 October 2026) |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 |
| ambassador | 0.4.2 | MIT OR Apache-2.0 |
| amplify | 4.9.0 | MIT |
| amplify_derive | 4.0.1 | Apache-2.0 |
| amplify_num | 0.5.4 | Apache-2.0 |
| amplify_syn | 2.0.1 | Apache-2.0 |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| anes | 0.1.6 | MIT OR Apache-2.0 |
| anstream | 1.0.0 | MIT OR Apache-2.0 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 |
| anstyle-wincon | 3.0.11 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| approx | 0.5.1 | Apache-2.0 (read from the package on 14 October 2026) |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| arc-swap | 1.9.2 | MIT OR Apache-2.0 |
| arg_enum_proc_macro | 0.3.4 | MIT (read from the package on 14 October 2026) |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| arti-client | 0.35.0 | MIT OR Apache-2.0 |
| as-slice | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| ascii | 1.1.0 | Apache-2.0 OR MIT |
| asn1-rs | 0.7.2 | MIT OR Apache-2.0 |
| asn1-rs-derive | 0.6.0 | MIT OR Apache-2.0 |
| asn1-rs-impl | 0.2.0 | MIT/Apache-2.0 |
| assert_matches | 1.5.0 | MIT/Apache-2.0 |
| async-compression | 0.4.50 | MIT OR Apache-2.0 |
| async-trait | 0.1.92 | MIT OR Apache-2.0 |
| async_executors | 0.7.0 | Unlicense |
| asynchronous-codec | 0.7.0 | MIT |
| atomic | 0.5.3 | Apache-2.0/MIT |
| atomic | 0.6.1 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| av-scenechange | 0.14.1 | MIT (read from the package on 14 October 2026) |
| av1-grain | 0.2.5 | BSD-2-Clause (read from the package on 14 October 2026) |
| avif-serialize | 0.8.9 | BSD-3-Clause (read from the package on 14 October 2026) |
| axum | 0.8.9 | MIT |
| axum-core | 0.5.6 | MIT |
| base16ct | 0.2.0 | Apache-2.0 OR MIT |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT |
| basic-toml | 0.1.10 | MIT OR Apache-2.0 |
| bech32 | 0.11.1 | MIT |
| bellman | 0.15.0 | MIT OR Apache-2.0 |
| bincode | 2.0.1 | MIT |
| bindgen | 0.65.1 | BSD-3-Clause (read from the package on 14 October 2026) |
| bip0039 | 0.14.2 | Apache-2.0 |
| bip32 | 0.6.0 | Apache-2.0 OR MIT |
| bit-set | 0.5.3 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| bit-set | 0.8.0 | Apache-2.0 OR MIT |
| bit-vec | 0.6.3 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT |
| bit_field | 0.10.3 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| bitcoin-consensus-encoding | 1.3.0 | CC0-1.0 (read from the package on 14 October 2026) |
| bitcoin-internals | 0.6.0 | CC0-1.0 (read from the package on 14 October 2026) |
| bitcoin-internals | 0.7.0 | CC0-1.0 (read from the package on 14 October 2026) |
| bitcoin_hashes | 1.2.0 | CC0-1.0 (read from the package on 14 October 2026) |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bitstream-io | 4.10.0 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| bitvec | 1.1.1 | MIT |
| blake2b_simd | 1.0.5 | MIT |
| blake2s_simd | 1.0.5 | MIT |
| blanket | 0.3.0 | MIT |
| block | 0.1.6 | MIT (read from the package on 14 October 2026) |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 |
| bls12_381 | 0.9.0 | MIT/Apache-2.0 |
| borsh | 1.8.1 | MIT OR Apache-2.0 |
| borsh-derive | 1.8.1 | Apache-2.0 |
| bounded-vec | 0.9.0 | CC0-1.0 |
| bs58 | 0.5.1 | MIT/Apache-2.0 |
| bstr | 1.13.1 | MIT OR Apache-2.0 |
| built | 0.8.1 | MIT (read from the package on 14 October 2026) |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| by_address | 1.2.1 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| byteorder-lite | 0.1.0 | Unlicense OR MIT (read from the package on 14 October 2026) |
| bytes | 1.12.1 | MIT |
| caret | 0.7.0 | MIT OR Apache-2.0 |
| cast | 0.3.0 | MIT OR Apache-2.0 |
| castaway | 0.2.4 | MIT (read from the package on 14 October 2026) |
| cbc | 0.2.1 | MIT OR Apache-2.0 |
| cc | 1.6.0 | MIT OR Apache-2.0 |
| cexpr | 0.6.0 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| cfg-if | 0.1.10 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| cfg_aliases | 0.2.2 | MIT |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |
| chacha20 | 0.9.1 | Apache-2.0 OR MIT |
| chacha20poly1305 | 0.10.1 | Apache-2.0 OR MIT |
| chacha20poly1305 | 0.11.0 | Apache-2.0 OR MIT |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| ciborium | 0.2.2 | Apache-2.0 |
| ciborium-io | 0.2.2 | Apache-2.0 |
| ciborium-ll | 0.2.2 | Apache-2.0 |
| cipher | 0.4.4 | MIT OR Apache-2.0 |
| cipher | 0.5.2 | MIT OR Apache-2.0 |
| clang-sys | 1.9.1 | Apache-2.0 (read from the package on 14 October 2026) |
| clap | 4.6.7 | MIT OR Apache-2.0 |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 |
| clap_derive | 4.6.7 | MIT OR Apache-2.0 |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 |
| cmov | 0.5.4 | Apache-2.0 OR MIT |
| coarsetime | 0.1.38 | BSD-2-Clause |
| cobs | 0.3.0 | MIT OR Apache-2.0 |
| cocoa | 0.20.2 | MIT / Apache-2.0 (read from the package on 14 October 2026) |
| cocoa-foundation | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| color_quant | 1.1.0 | MIT (read from the package on 14 October 2026) |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 |
| compact_str | 0.9.1 | MIT (read from the package on 14 October 2026) |
| compression-codecs | 0.4.45 | MIT OR Apache-2.0 |
| compression-core | 0.4.33 | MIT OR Apache-2.0 |
| const-oid | 0.10.2 | Apache-2.0 OR MIT |
| const-oid | 0.9.6 | Apache-2.0 OR MIT |
| constant_time_eq | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| convert_case | 0.10.0 | MIT |
| cookie-factory | 0.3.3 | MIT |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| core-foundation | 0.7.0 | MIT / Apache-2.0 (read from the package on 14 October 2026) |
| core-foundation-sys | 0.7.0 | MIT / Apache-2.0 (read from the package on 14 October 2026) |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| core-graphics | 0.19.2 | MIT / Apache-2.0 (read from the package on 14 October 2026) |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| core-media-sys | 0.1.2 | MIT (read from the package on 14 October 2026) |
| core-video-sys | 0.1.4 | MIT (read from the package on 14 October 2026) |
| corez | 0.1.1 | MIT OR Apache-2.0 |
| cpubits | 0.1.1 | MIT OR Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 |
| crc | 3.4.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| crc-catalog | 2.5.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 |
| criterion | 0.7.0 | Apache-2.0 OR MIT |
| criterion-cycles-per-byte | 0.7.0 | MIT OR Apache-2.0 |
| criterion-plot | 0.6.0 | MIT OR Apache-2.0 |
| critical-section | 1.2.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 |
| crossbeam-queue | 0.3.14 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crossterm | 0.29.0 | MIT (read from the package on 14 October 2026) |
| crossterm_winapi | 0.9.1 | MIT (read from the package on 14 October 2026) |
| crunchy | 0.2.4 | MIT |
| crypto-bigint | 0.5.5 | Apache-2.0 OR MIT |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 |
| csscolorparser | 0.6.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| ctr | 0.9.2 | MIT OR Apache-2.0 |
| ctutils | 0.4.2 | Apache-2.0 OR MIT |
| curve25519-dalek | 4.1.3 | BSD-3-Clause |
| curve25519-dalek-derive | 0.1.1 | MIT/Apache-2.0 |
| daggy | 0.8.1 | MIT/Apache-2.0 |
| darling | 0.14.4 | MIT |
| darling | 0.24.1 | MIT |
| darling_core | 0.14.4 | MIT |
| darling_core | 0.24.1 | MIT |
| darling_macro | 0.14.4 | MIT |
| darling_macro | 0.24.1 | MIT |
| data-encoding | 2.11.1 | MIT |
| defmt | 1.1.1 | MIT OR Apache-2.0 |
| defmt-macros | 1.1.1 | MIT OR Apache-2.0 |
| defmt-parser | 1.0.0 | MIT OR Apache-2.0 |
| deltae | 0.3.2 | MIT (read from the package on 14 October 2026) |
| der | 0.7.10 | Apache-2.0 OR MIT |
| der-parser | 10.0.0 | MIT OR Apache-2.0 |
| deranged | 0.5.8 | MIT OR Apache-2.0 |
| derive-deftly | 1.3.0 | MIT |
| derive-deftly-macros | 1.3.0 | MIT |
| derive_builder_core_fork_arti | 0.11.2 | MIT/Apache-2.0 |
| derive_builder_fork_arti | 0.11.2 | MIT/Apache-2.0 |
| derive_builder_macro_fork_arti | 0.11.2 | MIT/Apache-2.0 |
| derive_more | 2.1.1 | MIT |
| derive_more-impl | 2.1.1 | MIT |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| digest | 0.11.3 | MIT OR Apache-2.0 |
| directories | 6.0.0 | MIT OR Apache-2.0 |
| dirs | 6.0.0 | MIT OR Apache-2.0 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| document-features | 0.2.12 | MIT OR Apache-2.0 |
| downcast-rs | 2.0.2 | MIT OR Apache-2.0 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 (read from the package on 14 October 2026) |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| dynosaur | 0.3.1 | MIT OR Apache-2.0 |
| dynosaur_derive | 0.3.1 | MIT OR Apache-2.0 |
| ecdsa | 0.16.9 | Apache-2.0 OR MIT |
| ed25519 | 2.2.3 | Apache-2.0 OR MIT |
| ed25519-dalek | 2.2.0 | BSD-3-Clause |
| ed25519-zebra | 4.2.0 | MIT OR Apache-2.0 |
| educe | 0.4.23 | MIT |
| either | 1.18.0 | MIT OR Apache-2.0 |
| elliptic-curve | 0.13.8 | Apache-2.0 OR MIT |
| embedded-io | 0.4.0 | MIT OR Apache-2.0 |
| embedded-io | 0.6.1 | MIT OR Apache-2.0 |
| enum-ordinalize | 3.1.15 | MIT |
| enum_dispatch | 0.3.13 | MIT OR Apache-2.0 |
| env_filter | 0.1.4 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| equator | 0.4.2 | MIT (read from the package on 14 October 2026) |
| equator-macro | 0.4.2 | MIT (read from the package on 14 October 2026) |
| equihash | 0.2.0 | MIT OR Apache-2.0 |
| equihash | 0.3.0 | MIT OR Apache-2.0 |
| equivalent | 1.0.2 | Apache-2.0 OR MIT |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| euclid | 0.22.14 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| event-listener | 5.4.2 | Apache-2.0 OR MIT |
| exr | 1.74.2 | BSD-3-Clause (read from the package on 14 October 2026) |
| f4jumble | 0.1.1 | MIT OR Apache-2.0 |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 |
| fancy-regex | 0.11.0 | MIT (read from the package on 14 October 2026) |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| fax | 0.2.7 | MIT (read from the package on 14 October 2026) |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| ff | 0.13.1 | MIT/Apache-2.0 |
| ff | 0.14.0 | MIT/Apache-2.0 |
| ff_derive | 0.14.0 | MIT/Apache-2.0 |
| fiat-crypto | 0.2.9 | MIT OR Apache-2.0 OR BSD-1-Clause (read from the package on 14 October 2026) |
| figment | 0.10.19 | MIT OR Apache-2.0 |
| filedescriptor | 0.8.3 | MIT (read from the package on 14 October 2026) |
| filetime | 0.2.29 | MIT/Apache-2.0 |
| find-crate | 0.6.3 | Apache-2.0 OR MIT |
| find-msvc-tools | 0.1.14 | MIT OR Apache-2.0 |
| finl_unicode | 1.5.0 | (MIT OR Apache-2.0) AND Unicode-DFS-2016 (read from the package on 14 October 2026) |
| fixedbitset | 0.4.2 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| fixedbitset | 0.5.7 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| fluent | 0.17.0 | Apache-2.0 OR MIT |
| fluent-bundle | 0.16.0 | Apache-2.0 OR MIT |
| fluent-langneg | 0.13.1 | Apache-2.0 OR MIT |
| fluent-syntax | 0.12.0 | Apache-2.0 OR MIT |
| fluid-let | 1.0.0 | MIT |
| flume | 0.11.1 | Apache-2.0/MIT |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| foldhash | 0.1.5 | Zlib |
| foldhash | 0.2.0 | Zlib |
| foreign-types | 0.3.2 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| foreign-types-shared | 0.1.1 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| fpe | 0.7.0 | MIT OR Apache-2.0 |
| fs-mistrust | 0.12.0 | MIT OR Apache-2.0 |
| fslock | 0.2.1 | MIT |
| funty | 2.0.0 | MIT |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-rustls | 0.26.0 | MIT/Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| g2gen | 1.2.2 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| g2p | 1.2.2 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| g2poly | 1.2.2 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| getset | 0.1.7 | MIT |
| ghash | 0.5.1 | Apache-2.0 OR MIT |
| gif | 0.14.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| glob | 0.3.4 | MIT OR Apache-2.0 |
| glob-match | 0.2.1 | MIT |
| groth16 | 0.2.0 | MIT OR Apache-2.0 |
| group | 0.13.0 | MIT/Apache-2.0 |
| group | 0.14.0 | MIT/Apache-2.0 |
| h2 | 0.4.19 | MIT |
| half | 2.7.1 | MIT OR Apache-2.0 |
| halo2_gadgets | 0.6.0 | MIT OR Apache-2.0 |
| halo2_legacy_pdqsort | 0.1.0 | MIT OR Apache-2.0 |
| halo2_poseidon | 0.2.0 | MIT OR Apache-2.0 |
| halo2_proofs | 0.4.0 | MIT OR Apache-2.0 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 |
| hashbrown | 0.15.5 | MIT OR Apache-2.0 |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| hashlink | 0.10.0 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| hermit-abi | 0.5.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| hex | 0.4.3 | MIT OR Apache-2.0 |
| hkdf | 0.12.4 | MIT OR Apache-2.0 |
| hmac | 0.12.1 | MIT OR Apache-2.0 |
| hmac | 0.13.0 | MIT OR Apache-2.0 |
| home | 0.5.12 | MIT OR Apache-2.0 |
| hostname-validator | 1.1.1 | MIT |
| hpke | 0.12.0 | MIT/Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| http-body | 1.1.0 | MIT |
| http-body-util | 0.1.5 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| humantime | 2.4.0 | MIT OR Apache-2.0 |
| humantime-serde | 1.1.1 | MIT OR Apache-2.0 |
| hybrid-array | 0.2.3 | MIT OR Apache-2.0 |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 |
| hyper | 1.11.1 | MIT |
| hyper-timeout | 0.5.2 | MIT OR Apache-2.0 |
| hyper-util | 0.1.21 | MIT |
| i18n-config | 0.4.8 | MIT |
| i18n-embed | 0.16.0 | MIT |
| i18n-embed-fl | 0.10.1 | MIT |
| i18n-embed-impl | 0.8.4 | MIT |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| image | 0.25.10 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| image-webp | 0.2.4 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| imgref | 1.12.3 | CC0-1.0 OR Apache-2.0 (read from the package on 14 October 2026) |
| incrementalmerkletree | 0.9.0 | MIT OR Apache-2.0 |
| incrementalmerkletree-testing | 0.4.0 | MIT OR Apache-2.0 |
| indexmap | 1.9.3 | Apache-2.0 OR MIT |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| indoc | 2.0.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| inotify | 0.11.5 | ISC |
| inotify-sys | 0.1.8 | ISC |
| inout | 0.1.4 | MIT OR Apache-2.0 |
| inout | 0.2.2 | MIT OR Apache-2.0 |
| instability | 0.3.14 | MIT (read from the package on 14 October 2026) |
| interpolate_name | 0.2.4 | MIT (read from the package on 14 October 2026) |
| intl-memoizer | 0.5.3 | Apache-2.0 OR MIT |
| intl_pluralrules | 7.0.2 | Apache-2.0/MIT |
| inventory | 0.3.24 | MIT OR Apache-2.0 |
| io_tee | 0.1.1 | MIT OR Apache-2.0 |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| iso_country | 0.1.4 | MIT |
| iso_currency | 0.5.3 | MIT |
| itertools | 0.10.5 | MIT/Apache-2.0 |
| itertools | 0.13.0 | MIT OR Apache-2.0 |
| itertools | 0.14.0 | MIT OR Apache-2.0 |
| itertools | 0.15.0 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| jiff | 0.2.37 | Unlicense OR MIT |
| jiff-core | 0.1.1 | Unlicense OR MIT |
| jiff-static | 0.2.37 | Unlicense OR MIT (read from the package on 14 October 2026) |
| jiff-tzdb | 0.1.8 | Unlicense OR MIT (read from the package on 14 October 2026) |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT (read from the package on 14 October 2026) |
| jobserver | 0.1.35 | MIT OR Apache-2.0 |
| js-sys | 0.3.106 | MIT OR Apache-2.0 |
| jubjub | 0.11.1 | MIT/Apache-2.0 |
| kasuari | 0.4.12 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| keccak | 0.1.6 | Apache-2.0 OR MIT |
| kem | 0.3.0-pre.0 | Apache-2.0 OR MIT |
| known-folders | 1.4.2 | Apache-2.0 OR MIT |
| kqueue | 1.2.1 | MIT (read from the package on 14 October 2026) |
| kqueue-sys | 1.1.2 | MIT (read from the package on 14 October 2026) |
| lab | 0.11.0 | MIT (read from the package on 14 October 2026) |
| lazy_static | 1.5.1 | MIT OR Apache-2.0 |
| lazycell | 1.3.0 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| lebe | 0.5.3 | BSD-3-Clause (read from the package on 14 October 2026) |
| libc | 0.2.190 | MIT OR Apache-2.0 |
| libfuzzer-sys | 0.4.13 | (MIT OR Apache-2.0) AND NCSA (read from the package on 14 October 2026) |
| libloading | 0.8.9 | ISC (read from the package on 14 October 2026) |
| liblzma | 0.4.8 | MIT OR Apache-2.0 |
| liblzma-sys | 0.4.9 | MIT OR Apache-2.0 |
| libm | 0.2.16 | MIT |
| libredox | 0.1.25 | MIT (read from the package on 14 October 2026) |
| libsqlite3-sys | 0.35.0 | MIT |
| line-clipping | 0.3.8 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| linux-raw-sys | 0.4.15 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| litrs | 1.0.0 | MIT OR Apache-2.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.34 | MIT OR Apache-2.0 |
| loop9 | 0.1.5 | MIT (read from the package on 14 October 2026) |
| lru | 0.16.4 | MIT (read from the package on 14 October 2026) |
| lru | 0.18.5 | MIT (read from the package on 14 October 2026) |
| mac_address | 1.2.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| malloc_buf | 0.0.6 | MIT (read from the package on 14 October 2026) |
| matchers | 0.2.0 | MIT |
| matchit | 0.8.4 | MIT AND BSD-3-Clause |
| maybe-rayon | 0.1.1 | MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| memmap2 | 0.9.11 | MIT OR Apache-2.0 |
| memmem | 0.1.1 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| memoffset | 0.9.1 | MIT (read from the package on 14 October 2026) |
| memuse | 0.2.2 | MIT/Apache-2.0 |
| merlin | 3.0.0 | MIT |
| metal | 0.18.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| mime_guess | 2.0.5 | MIT |
| minicbor | 2.3.0 | BlueOak-1.0.0 (read from the package on 14 October 2026) |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| mio | 1.2.4 | MIT |
| ml-kem | 0.2.3 | Apache-2.0 OR MIT |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 (read from the package on 14 October 2026) |
| mozjpeg | 0.10.13 | IJG (read from the package on 14 October 2026) |
| mozjpeg-sys | 2.2.3 | IJG AND Zlib AND BSD-3-Clause (read from the package on 14 October 2026) |
| multimap | 0.10.1 | MIT OR Apache-2.0 |
| nanorand | 0.7.0 | Zlib |
| nasm-rs | 0.3.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| new_debug_unreachable | 1.0.6 | MIT (read from the package on 14 October 2026) |
| nix | 0.29.0 | MIT (read from the package on 14 October 2026) |
| nix | 0.30.1 | MIT (read from the package on 14 October 2026) |
| no_std_io2 | 0.9.4 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| nokhwa | 0.10.11 | Apache-2.0 (read from the package on 14 October 2026) |
| nokhwa-bindings-linux | 0.1.4 | Apache-2.0 (read from the package on 14 October 2026) |
| nokhwa-bindings-macos | 0.2.4 | Apache-2.0 (read from the package on 14 October 2026) |
| nokhwa-bindings-windows | 0.4.6 | Apache-2.0 (read from the package on 14 October 2026) |
| nokhwa-core | 0.1.9 | Apache-2.0 (read from the package on 14 October 2026) |
| nom | 7.1.3 | MIT |
| nom | 8.0.0 | MIT |
| nonany | 0.3.0 | MIT OR Apache-2.0 |
| nonempty | 0.11.0 | MIT |
| noop_proc_macro | 0.3.0 | MIT (read from the package on 14 October 2026) |
| notify | 8.2.0 | CC0-1.0 |
| notify-types | 2.1.0 | MIT OR Apache-2.0 |
| ntapi | 0.4.3 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| nu-ansi-term | 0.50.3 | MIT |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 |
| num-bigint | 0.5.1 | MIT OR Apache-2.0 |
| num-bigint-dig | 0.8.6 | MIT/Apache-2.0 |
| num-complex | 0.4.6 | MIT OR Apache-2.0 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-derive | 0.4.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-iter | 0.1.46 | MIT OR Apache-2.0 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| num_cpus | 1.17.0 | MIT OR Apache-2.0 |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| num_threads | 0.1.7 | MIT OR Apache-2.0 |
| objc | 0.2.7 | MIT (read from the package on 14 October 2026) |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| objc2-io-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| objc_exception | 0.1.2 | MIT (read from the package on 14 October 2026) |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| once_cell_polyfill | 1.70.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| oneshot-fused-workaround | 0.4.0 | MIT OR Apache-2.0 |
| oorandom | 11.1.5 | MIT |
| opaque-debug | 0.3.1 | MIT OR Apache-2.0 |
| option-ext | 0.2.0 | MPL-2.0 |
| orchard | 0.16.0 | MIT OR Apache-2.0 |
| ordered-float | 2.10.1 | MIT |
| ordered-float | 4.6.0 | MIT (read from the package on 14 October 2026) |
| os_str_bytes | 6.6.1 | MIT OR Apache-2.0 |
| p256 | 0.13.2 | Apache-2.0 OR MIT |
| p384 | 0.13.1 | Apache-2.0 OR MIT |
| p521 | 0.13.3 | Apache-2.0 OR MIT |
| pairing | 0.24.0 | MIT/Apache-2.0 |
| palette | 0.7.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| palette_derive | 0.7.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| palette_math | 0.7.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| parking | 2.2.1 | Apache-2.0 OR MIT |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| pasta_curves | 0.6.0 | MIT OR Apache-2.0 |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| pastey | 0.1.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| pastey | 0.2.3 | MIT OR Apache-2.0 |
| pbkdf2 | 0.12.2 | MIT OR Apache-2.0 |
| pbkdf2 | 0.13.0 | MIT OR Apache-2.0 |
| pczt | 0.10.0-pre.0 | MIT OR Apache-2.0 |
| peeking_take_while | 0.1.2 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| pem-rfc7468 | 0.7.0 | Apache-2.0 OR MIT |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| pest | 2.9.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| pest_derive | 2.9.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| pest_generator | 2.9.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| pest_meta | 2.9.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| petgraph | 0.7.1 | MIT OR Apache-2.0 |
| petgraph | 0.8.3 | MIT OR Apache-2.0 |
| phf | 0.11.3 | MIT |
| phf | 0.13.1 | MIT |
| phf | 0.14.0 | MIT |
| phf_codegen | 0.11.3 | MIT (read from the package on 14 October 2026) |
| phf_generator | 0.11.3 | MIT |
| phf_generator | 0.13.1 | MIT |
| phf_generator | 0.14.0 | MIT |
| phf_macros | 0.11.3 | MIT |
| phf_macros | 0.13.1 | MIT |
| phf_macros | 0.14.0 | MIT |
| phf_shared | 0.11.3 | MIT |
| phf_shared | 0.13.1 | MIT |
| phf_shared | 0.14.0 | MIT |
| pin-project | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-internal | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| pkcs1 | 0.7.5 | Apache-2.0 OR MIT |
| pkcs8 | 0.10.2 | Apache-2.0 OR MIT |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 |
| plotters | 0.3.7 | MIT |
| plotters-backend | 0.3.7 | MIT |
| plotters-svg | 0.3.7 | MIT |
| png | 0.18.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| poly1305 | 0.8.0 | Apache-2.0 OR MIT |
| poly1305 | 0.9.1 | Apache-2.0 OR MIT |
| polyval | 0.6.2 | Apache-2.0 OR MIT |
| portable-atomic | 1.15.0 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| postage | 0.5.0 | MIT |
| postcard | 1.1.3 | MIT OR Apache-2.0 |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| prettyplease | 0.2.37 | MIT OR Apache-2.0 |
| primeorder | 0.13.6 | Apache-2.0 OR MIT |
| priority-queue | 2.7.0 | LGPL-3.0-or-later OR MPL-2.0 |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 |
| proc-macro-error-attr3 | 3.1.1 | MIT OR Apache-2.0 |
| proc-macro-error3 | 3.1.1 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| profiling | 1.0.18 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| profiling-procmacros | 1.0.18 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| proptest | 1.6.0 | MIT OR Apache-2.0 |
| prost | 0.14.4 | Apache-2.0 |
| prost-build | 0.14.4 | Apache-2.0 |
| prost-derive | 0.14.4 | Apache-2.0 |
| prost-types | 0.14.4 | Apache-2.0 |
| pulp | 0.22.3 | MIT (read from the package on 14 October 2026) |
| pulp-wasm-simd-flag | 0.1.1 | MIT (read from the package on 14 October 2026) |
| pwd-grp | 1.0.2 | MIT |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 (read from the package on 14 October 2026) |
| qoi | 0.4.1 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| qrcode | 0.14.1 | MIT OR Apache-2.0 |
| quick-error | 1.2.3 | MIT/Apache-2.0 |
| quick-error | 2.0.1 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later (read from the package on 14 October 2026) |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later (read from the package on 14 October 2026) |
| radium | 0.7.0 | MIT |
| rand | 0.10.3 | MIT OR Apache-2.0 |
| rand | 0.8.8 | MIT OR Apache-2.0 |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.10.0 | MIT OR Apache-2.0 |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.10.1 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rand_distr | 0.6.0 | MIT OR Apache-2.0 |
| rand_jitter | 0.5.0 | MIT OR Apache-2.0 |
| rand_xorshift | 0.3.0 | MIT OR Apache-2.0 |
| rand_xoshiro | 0.8.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| ratatui | 0.30.2 | MIT (read from the package on 14 October 2026) |
| ratatui-core | 0.1.2 | MIT (read from the package on 14 October 2026) |
| ratatui-crossterm | 0.1.2 | MIT (read from the package on 14 October 2026) |
| ratatui-macros | 0.7.2 | MIT (read from the package on 14 October 2026) |
| ratatui-termina | 0.1.0 | MIT (read from the package on 14 October 2026) |
| ratatui-termwiz | 0.1.2 | MIT (read from the package on 14 October 2026) |
| ratatui-widgets | 0.3.2 | MIT (read from the package on 14 October 2026) |
| rav1e | 0.8.1 | BSD-2-Clause (read from the package on 14 October 2026) |
| ravif | 0.13.0 | BSD-3-Clause (read from the package on 14 October 2026) |
| raw-cpuid | 11.6.0 | MIT (read from the package on 14 October 2026) |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| rdrand | 0.8.3 | ISC |
| reborrow | 0.5.5 | MIT (read from the package on 14 October 2026) |
| reddsa | 0.6.1 | MIT OR Apache-2.0 |
| redjubjub | 0.9.0 | MIT OR Apache-2.0 |
| redox_syscall | 0.5.18 | MIT (read from the package on 14 October 2026) |
| redox_users | 0.5.3 | MIT (read from the package on 14 October 2026) |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| retry-error | 0.8.0 | MIT OR Apache-2.0 |
| rfc6979 | 0.4.0 | Apache-2.0 OR MIT |
| rgb | 0.8.53 | MIT (read from the package on 14 October 2026) |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| ripemd | 0.1.3 | MIT OR Apache-2.0 |
| ripemd | 0.2.0 | MIT OR Apache-2.0 |
| roaring | 0.11.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| rpassword | 7.5.4 | Apache-2.0 |
| rqrr | 0.10.1 | (MIT OR Apache-2.0) AND ISC (read from the package on 14 October 2026) |
| rsa | 0.9.10 | MIT OR Apache-2.0 |
| rtoolbox | 0.0.6 | Apache-2.0 |
| rusqlite | 0.37.0 | MIT |
| rust-embed | 8.12.0 | MIT |
| rust-embed-impl | 8.12.0 | MIT |
| rust-embed-utils | 8.12.0 | MIT |
| rust_decimal | 1.43.0 | MIT |
| rustc-hash | 1.1.0 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 |
| rusticata-macros | 4.1.0 | MIT/Apache-2.0 |
| rustix | 0.38.44 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| rustix | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustls | 0.23.45 | Apache-2.0 OR ISC OR MIT |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 |
| rustls-webpki | 0.103.15 | ISC |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| rusty-fork | 0.3.1 | MIT/Apache-2.0 |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| safelog | 0.6.0 | MIT OR Apache-2.0 |
| salsa20 | 0.10.2 | MIT OR Apache-2.0 |
| same-file | 1.0.6 | Unlicense/MIT |
| sanitize-filename | 0.6.0 | MIT |
| sapling-crypto | 0.9.0 | MIT OR Apache-2.0 |
| schemars | 0.9.0 | MIT |
| schemars | 1.2.2 | MIT |
| schemerz | 0.2.0 | MIT/Apache-2.0 |
| schemerz-rusqlite | 0.370.0 | MIT OR Apache-2.0 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| scrypt | 0.11.0 | MIT OR Apache-2.0 |
| sec1 | 0.7.3 | Apache-2.0 OR MIT |
| secp256k1 | 0.33.1 | CC0-1.0 |
| secp256k1-sys | 0.14.1 | CC0-1.0 |
| secrecy | 0.10.3 | Apache-2.0 OR MIT |
| secrecy | 0.8.0 | Apache-2.0 OR MIT |
| self_cell | 1.3.0 | Apache-2.0 OR GPL-2.0-only |
| semver | 1.0.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde-value | 0.7.0 | MIT |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_ignored | 0.1.14 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 |
| serde_spanned | 1.1.1 | MIT OR Apache-2.0 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 |
| sha1 | 0.10.7 | MIT OR Apache-2.0 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| sha2 | 0.11.0 | MIT OR Apache-2.0 |
| sha3 | 0.10.9 | MIT OR Apache-2.0 |
| sharded-slab | 0.1.7 | MIT |
| shardtree | 0.8.0 | MIT OR Apache-2.0 |
| shellexpand | 3.1.2 | MIT/Apache-2.0 |
| shlex | 1.3.0 | MIT OR Apache-2.0 |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| signal-hook | 0.3.18 | Apache-2.0/MIT (read from the package on 14 October 2026) |
| signal-hook-mio | 0.2.5 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 |
| signature | 2.2.0 | Apache-2.0 OR MIT |
| simd-adler32 | 0.3.10 | MIT |
| simd_helpers | 0.1.0 | MIT (read from the package on 14 October 2026) |
| sinsemilla | 0.2.0 | MIT OR Apache-2.0 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| slotmap | 1.1.1 | Zlib |
| slotmap-careful | 0.4.0 | MIT OR Apache-2.0 |
| smallvec | 1.16.2 | MIT OR Apache-2.0 |
| socket2 | 0.6.5 | MIT OR Apache-2.0 |
| spin | 0.9.9 | MIT |
| spki | 0.7.3 | Apache-2.0 OR MIT |
| ssh-cipher | 0.2.0 | Apache-2.0 OR MIT |
| ssh-encoding | 0.2.0 | Apache-2.0 OR MIT |
| ssh-key | 0.6.7 | Apache-2.0 OR MIT |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 |
| strsim | 0.10.0 | MIT |
| strsim | 0.11.1 | MIT |
| strum | 0.27.2 | MIT |
| strum | 0.28.0 | MIT (read from the package on 14 October 2026) |
| strum_macros | 0.27.2 | MIT |
| strum_macros | 0.28.0 | MIT (read from the package on 14 October 2026) |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 1.0.109 | MIT OR Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.6 | MIT OR Apache-2.0 |
| sync_wrapper | 1.0.2 | Apache-2.0 |
| synstructure | 0.13.2 | MIT |
| sysinfo | 0.36.1 | MIT |
| tap | 1.0.1 | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| termina | 0.3.3 | MIT OR MPL-2.0 (read from the package on 14 October 2026) |
| terminfo | 0.9.0 | WTFPL (read from the package on 14 October 2026) |
| termios | 0.3.3 | MIT (read from the package on 14 October 2026) |
| termwiz | 0.23.3 | MIT (read from the package on 14 October 2026) |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| thread_local | 1.1.10 | MIT OR Apache-2.0 |
| tiff | 0.11.3 | MIT (read from the package on 14 October 2026) |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tinystr | 0.8.4 | Unicode-3.0 |
| tinytemplate | 1.2.1 | Apache-2.0 OR MIT |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| tokio | 1.53.2 | MIT |
| tokio-macros | 2.7.2 | MIT |
| tokio-rustls | 0.26.6 | MIT OR Apache-2.0 |
| tokio-socks | 0.5.3 | MIT |
| tokio-stream | 0.1.19 | MIT |
| tokio-util | 0.7.19 | MIT |
| toml | 0.5.11 | MIT/Apache-2.0 |
| toml | 0.8.23 | MIT OR Apache-2.0 |
| toml | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 0.6.11 | MIT OR Apache-2.0 |
| toml_datetime | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_edit | 0.22.27 | MIT OR Apache-2.0 |
| toml_edit | 0.25.15+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_write | 0.1.2 | MIT OR Apache-2.0 |
| toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| tonic | 0.14.6 | MIT |
| tonic-build | 0.14.6 | MIT |
| tonic-prost | 0.14.6 | MIT |
| tonic-prost-build | 0.14.6 | MIT |
| tor-async-utils | 0.35.0 | MIT OR Apache-2.0 |
| tor-basic-utils | 0.35.0 | MIT OR Apache-2.0 |
| tor-bytes | 0.35.0 | MIT OR Apache-2.0 |
| tor-cell | 0.35.0 | MIT OR Apache-2.0 |
| tor-cert | 0.35.0 | MIT OR Apache-2.0 |
| tor-chanmgr | 0.35.0 | MIT OR Apache-2.0 |
| tor-checkable | 0.35.0 | MIT OR Apache-2.0 |
| tor-circmgr | 0.35.0 | MIT OR Apache-2.0 |
| tor-config | 0.35.0 | MIT OR Apache-2.0 |
| tor-config-path | 0.35.0 | MIT OR Apache-2.0 |
| tor-consdiff | 0.35.0 | MIT OR Apache-2.0 |
| tor-dirclient | 0.35.0 | MIT OR Apache-2.0 |
| tor-dircommon | 0.35.0 | MIT OR Apache-2.0 |
| tor-dirmgr | 0.35.0 | MIT OR Apache-2.0 |
| tor-error | 0.35.0 | MIT OR Apache-2.0 |
| tor-general-addr | 0.35.0 | MIT OR Apache-2.0 |
| tor-guardmgr | 0.35.0 | MIT OR Apache-2.0 |
| tor-hsclient | 0.35.0 | MIT OR Apache-2.0 |
| tor-hscrypto | 0.35.0 | MIT OR Apache-2.0 |
| tor-key-forge | 0.35.0 | MIT OR Apache-2.0 |
| tor-keymgr | 0.35.0 | MIT OR Apache-2.0 |
| tor-linkspec | 0.35.0 | MIT OR Apache-2.0 |
| tor-llcrypto | 0.35.0 | MIT OR Apache-2.0 |
| tor-log-ratelim | 0.35.0 | MIT OR Apache-2.0 |
| tor-memquota | 0.35.0 | MIT OR Apache-2.0 |
| tor-netdir | 0.35.0 | MIT OR Apache-2.0 |
| tor-netdoc | 0.35.0 | MIT OR Apache-2.0 |
| tor-persist | 0.35.0 | MIT OR Apache-2.0 |
| tor-proto | 0.35.0 | MIT OR Apache-2.0 |
| tor-protover | 0.35.0 | MIT OR Apache-2.0 |
| tor-relay-selection | 0.35.0 | MIT OR Apache-2.0 |
| tor-rtcompat | 0.35.0 | MIT OR Apache-2.0 |
| tor-rtmock | 0.35.0 | MIT OR Apache-2.0 |
| tor-socksproto | 0.35.0 | MIT OR Apache-2.0 |
| tor-units | 0.35.0 | MIT OR Apache-2.0 |
| tower | 0.5.3 | MIT |
| tower-layer | 0.3.3 | MIT |
| tower-service | 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| tracing-log | 0.2.0 | MIT |
| tracing-subscriber | 0.3.23 | MIT |
| tracing-test | 0.2.6 | MIT |
| tracing-test-macro | 0.2.6 | MIT |
| trait-variant | 0.1.3 | MIT OR Apache-2.0 |
| try-lock | 0.2.5 | MIT |
| tui-logger | 0.18.3 | MIT (read from the package on 14 October 2026) |
| type-map | 0.5.1 | MIT/Apache-2.0 |
| typed-index-collections | 3.3.0 | MIT OR Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| ucd-trie | 0.1.7 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| uint | 0.10.2 | MIT OR Apache-2.0 |
| uint | 0.9.5 | MIT OR Apache-2.0 |
| unarray | 0.1.4 | MIT OR Apache-2.0 |
| uncased | 0.9.10 | MIT OR Apache-2.0 |
| unic-langid | 0.9.6 | MIT OR Apache-2.0 |
| unic-langid-impl | 0.9.6 | MIT OR Apache-2.0 |
| unicase | 2.9.0 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 |
| unicode-truncate | 2.0.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| unicode-xid | 0.2.6 | MIT OR Apache-2.0 |
| universal-hash | 0.5.1 | MIT OR Apache-2.0 |
| universal-hash | 0.6.1 | MIT OR Apache-2.0 |
| untrusted | 0.9.0 | ISC |
| unty | 0.0.4 | MIT OR Apache-2.0 |
| ur | 0.5.2 | MIT (read from the package on 14 October 2026) |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT |
| uuid | 1.26.1 | Apache-2.0 OR MIT |
| v4l | 0.14.0 | MIT (read from the package on 14 October 2026) |
| v4l2-sys-mit | 0.3.0 | MIT (read from the package on 14 October 2026) |
| v_frame | 0.3.9 | BSD-2-Clause (read from the package on 14 October 2026) |
| valuable | 0.1.1 | MIT |
| vcpkg | 0.2.15 | MIT/Apache-2.0 |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| visibility | 0.1.1 | Zlib OR MIT OR Apache-2.0 |
| void | 1.0.2 | MIT |
| vtparse | 0.6.2 | MIT (read from the package on 14 October 2026) |
| wagyu-zcash-parameters | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-1 | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-2 | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-3 | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-4 | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-5 | 0.2.0 | MIT/Apache-2.0 |
| wagyu-zcash-parameters-6 | 0.2.0 | MIT/Apache-2.0 |
| wait-timeout | 0.2.1 | MIT/Apache-2.0 |
| walkdir | 2.5.0 | Unlicense/MIT |
| want | 0.3.1 | MIT |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wasix | 0.13.2 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 |
| weak-table | 0.3.2 | MIT |
| web-sys | 0.3.106 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| webpki-roots | 1.0.9 | CDLA-Permissive-2.0 |
| weezl | 0.1.12 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| wezterm-bidi | 0.2.3 | MIT AND Unicode-DFS-2016 (read from the package on 14 October 2026) |
| wezterm-blob-leases | 0.1.1 | MIT (read from the package on 14 October 2026) |
| wezterm-color-types | 0.3.0 | MIT (read from the package on 14 October 2026) |
| wezterm-dynamic | 0.2.1 | MIT (read from the package on 14 October 2026) |
| wezterm-dynamic-derive | 0.1.1 | MIT (read from the package on 14 October 2026) |
| wezterm-input-types | 0.1.0 | MIT (read from the package on 14 October 2026) |
| which | 4.4.2 | MIT (read from the package on 14 October 2026) |
| which | 8.0.6 | MIT |
| winapi | 0.3.9 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| winapi-util | 0.1.11 | Unlicense OR MIT (read from the package on 14 October 2026) |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 (read from the package on 14 October 2026) |
| windows | 0.61.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows | 0.62.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-collections | 0.2.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-core | 0.61.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-core | 0.62.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-future | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-future | 0.3.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-link | 0.1.3 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-link | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-numerics | 0.2.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-result | 0.3.4 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-result | 0.4.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-strings | 0.4.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.59.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-threading | 0.1.0 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 (read from the package on 14 October 2026) |
| winnow | 0.7.15 | MIT |
| winnow | 1.0.4 | MIT |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (read from the package on 14 October 2026) |
| wsl | 0.1.0 | MIT |
| wyz | 0.5.1 | MIT |
| x25519-dalek | 2.0.1 | BSD-3-Clause |
| xdg | 3.0.0 | Apache-2.0 OR MIT |
| y4m | 0.8.0 | MIT (read from the package on 14 October 2026) |
| zcash_address | 0.14.0-pre.0 | MIT OR Apache-2.0 |
| zcash_client_backend | 0.25.0-pre.0 | MIT OR Apache-2.0 |
| zcash_client_sqlite | 0.23.0-pre.0 | MIT OR Apache-2.0 |
| zcash_encoding | 0.5.0 | MIT OR Apache-2.0 |
| zcash_keys | 0.17.0-pre.0 | MIT OR Apache-2.0 |
| zcash_note_encryption | 0.5.1 | MIT OR Apache-2.0 |
| zcash_pool_migration | 0.2.0-pre.0 | MIT OR Apache-2.0 |
| zcash_primitives | 0.31.0-pre.0 | MIT OR Apache-2.0 |
| zcash_proofs | 0.31.0-pre.0 | MIT OR Apache-2.0 |
| zcash_protocol | 0.11.0-pre.0 | MIT OR Apache-2.0 |
| zcash_script | 0.6.0 | Apache-2.0 |
| zcash_spec | 0.2.1 | MIT OR Apache-2.0 |
| zcash_transparent | 0.11.0-pre.0 | MIT OR Apache-2.0 |
| zerocopy | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zeroize | 1.9.0 | Apache-2.0 OR MIT |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT |
| zerovec | 0.11.8 | Unicode-3.0 |
| zip32 | 0.3.0 | MIT OR Apache-2.0 |
| zip321 | 0.10.0-pre.0 | MIT OR Apache-2.0 |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |
| zstd | 0.14.0 | BSD-3-Clause |
| zstd-safe | 8.0.0 | BSD-3-Clause |
| zstd-sys | 2.1.0+zstd.1.5.7 | BSD-3-Clause |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib (read from the package on 14 October 2026) |
| zune-inflate | 0.2.54 | MIT OR Apache-2.0 OR Zlib (read from the package on 14 October 2026) |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib (read from the package on 14 October 2026) |

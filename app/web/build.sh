#!/usr/bin/env bash
# Builds the browser recount: WebAssembly module + JS glue into www/pkg.
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129, and Zig 0.14
# (set ZIG=/path/to/zig if it is not on PATH; it compiles the one C dependency).
set -euo pipefail
cd "$(dirname "$0")/.."
# Say plainly what is missing, instead of a compiler error half way through.
need() { command -v "$1" >/dev/null 2>&1 || { echo "build.sh: $1 is needed. $2" >&2; exit 1; }; }
need cargo "Install Rust with rustup (https://rustup.rs)."
rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown || { echo "build.sh: the wasm32 target is missing. Run: rustup target add wasm32-unknown-unknown" >&2; exit 1; }
need wasm-bindgen "Run: cargo install wasm-bindgen-cli --version 0.2.129"
need "${ZIG:-zig}" "Download Zig 0.14.0 from https://ziglang.org/download/ , unpack it, and run: ZIG=/path/to/zig app/web/build.sh (it compiles the one C dependency for the browser)."
# The built module is served to every visitor, so it must not carry the builder's folder names (panic messages include source paths): remap them.
# RUSTFLAGS replaces the rustflags in app/.cargo/config.toml, so the getrandom cfg from there is repeated here.
export RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$HOME=/build"
export CC_wasm32_unknown_unknown="$PWD/web/tools/wasm-cc" AR_wasm32_unknown_unknown="$PWD/web/tools/wasm-ar"
cargo build --release -p ll-web --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/www/pkg target/wasm32-unknown-unknown/release/ll_web.wasm
ls -la web/www/pkg/ll_web_bg.wasm
# Level 3: the proof checker is a separate module, loaded only when the person asks (web/www/proof-worker.js).
cargo build --release -p ll-proofcheck --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/www/proof target/wasm32-unknown-unknown/release/ll_proofcheck.wasm
ls -la web/www/proof/ll_proofcheck_bg.wasm

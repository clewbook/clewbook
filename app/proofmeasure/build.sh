#!/usr/bin/env bash
# Builds the level 3 measurement module into proofmeasure/out (needs the same toolchain as app/web/build.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
export CC_wasm32_unknown_unknown="$PWD/web/tools/wasm-cc" AR_wasm32_unknown_unknown="$PWD/web/tools/wasm-ar"
cargo build --release -p ll-proofmeasure --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir proofmeasure/out target/wasm32-unknown-unknown/release/ll_proofmeasure.wasm
ls -la proofmeasure/out/*.wasm

#!/usr/bin/env bash
# "Edit amount" on the payment step, at phone width. From the repository root. No network, no money. Rebuilds nothing: build the folder first with
# app/web/make-static.sh runs/static-polish. Needs Chromium's libraries on LD_LIBRARY_PATH.
set -uo pipefail
PORT=${PORT:-8803} SHOTS=${SHOTS:-runs/design-shots} DIR=${DIR:-runs/static-polish} timeout 600 node app/web/back-e2e.cjs

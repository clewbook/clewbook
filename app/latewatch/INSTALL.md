# Installing the late ticket watcher on the server

What it does: a blind bid page gives each list server a copy of its signed late ticket. The relay keeps the copies in its own folder and
never serves them (before the close a copy would show the deposit's size). The watcher reads them there, and once an auction's late ticket
block has passed, it waits 60 minutes from that block's time (`--wait-minutes` in the service file), and if the list still shows no close
and no settlement (the host never finished), it sends each copy to the chain servers. A late ticket can only
pay the deposit back to the refund address its page signed, so sending it is safe whoever sends it; a copy the network refuses is tried
again a few times, then left.

Two parts: the relay that keeps the copies (a new `cb-relay`), then the watcher. Each step is one command, run from the operator's computer
with `ssh -t`; each has its rollback. The files are first staged in `/home/clewbook/latewatch-stage` (`cb-relay`, `latewatch.py`,
`clewbook-latewatch.service`, `SHA256SUMS`).

1. Check the staged files:
   `ssh -t clewbook-vps 'cd /home/clewbook/latewatch-stage && sha256sum -c SHA256SUMS'`
2. The relay, swapped with `mv` (never copied onto the running program), with a backup of the one running now and of its data:
   `ssh -t clewbook-vps 'cd /home/clewbook/clewbook && cp -a relay-data relay-data.before-late && cd bin && cp -p cb-relay cb-relay.before-late && cp /home/clewbook/latewatch-stage/cb-relay cb-relay.new && chmod 755 cb-relay.new && mv cb-relay.new cb-relay && sudo systemctl restart clewbook-relay && sleep 2 && systemctl is-active clewbook-relay && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/v1/health'`
   Expect `active` and `200`. Rollback: `ssh -t clewbook-vps 'cd /home/clewbook/clewbook/bin && cp -p cb-relay.before-late cb-relay.new && mv cb-relay.new cb-relay && sudo systemctl restart clewbook-relay && systemctl is-active clewbook-relay'`
3. The watcher (runs as the relay's user `clewbook`, sees only the relay's folder, read only, and keeps what it sent in
   `/var/lib/clewbook-latewatch`; it holds no key):
   `ssh -t clewbook-vps 'sudo install -d -o root -g root -m 755 /opt/clewbook-latewatch && sudo install -o root -g root -m 644 /home/clewbook/latewatch-stage/latewatch.py /opt/clewbook-latewatch/latewatch.py && sudo install -o root -g root -m 644 /home/clewbook/latewatch-stage/clewbook-latewatch.service /etc/systemd/system/clewbook-latewatch.service && sudo systemctl daemon-reload && sudo systemctl enable --now clewbook-latewatch && sleep 4 && systemctl is-active clewbook-latewatch && sudo journalctl -u clewbook-latewatch -n 3 --no-pager'`
   Expect `active` and the line `late ticket watcher: relay folder /home/clewbook/clewbook/relay-data, networks main, test, waits 60 minutes after the late ticket block`.
   Rollback: `ssh -t clewbook-vps 'sudo systemctl disable --now clewbook-latewatch && sudo rm /etc/systemd/system/clewbook-latewatch.service && sudo rm -rf /opt/clewbook-latewatch && sudo systemctl daemon-reload'`

What it says: `sudo journalctl -u clewbook-latewatch -n 30 --no-pager` (one line per copy sent, with what each chain server answered).

Tests: `python3 app/latewatch/latewatch-test.py` (its decisions, no network) and `app/latewatch/latewatch-e2e.cjs` (the test network:
a real deposit through the bid page, the copy on a relay, a host that never closes, and the late ticket sent and mined after its block).

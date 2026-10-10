#!/usr/bin/env bash
# Helper for starting, stopping and checking the programs on this machine. Run it from the project folder:
#   ./run.sh status                  what is running, on which port, and which campaign folders nobody is watching
#   ./run.sh start   <name> [...]    start a program (nothing happens if it is already running)
#   ./run.sh stop    <name> [--yes]  stop a program (the ones that touch the real network need --yes)
#   ./run.sh restart <name> [--yes]  stop, then start
#   ./run.sh command <name>          print the exact command a program is started with
#   ./run.sh logs    <name>          print where its log is, and its last lines
#   ./run.sh names                   list the names
#   ./run.sh stable-config           print the tunnel configuration for the stable address (see docs/STABLE_ADDRESS.md)
#   ./run.sh set-relay <address> <campaign folder | --all> [--replace <old address> | --add] [--yes]
#                                    point campaigns at a relay address that works (shows what it would change; --yes applies it)
# Names: pageserver, tunnel-stable (the permanent address; needs runs/stable-address.conf), relay-testnet-1, relay-testnet-2, relay-demo, relay-mainnet, tunnel-page, tunnel-demo, tunnel-mainnet, dashboard,
#        watcher <campaign folder>, and practice-relay, practice-page, practice-dashboard (a sandbox on other ports, safe to start and stop).
# See docs/RUNNING.md (also: what to do when an address changes). This script never touches a campaign's files; it only starts and stops programs.
set -uo pipefail
cd "$(dirname "$0")"
BIN=./app/target/release
LOGS=runs/logs; TUN=runs/pilot-tunnels
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}   # the tunnel program
# The permanent address, when there is one, lives in ONE file (see docs/STABLE_ADDRESS.md). When it exists, everything below (the dashboard's command,
# the status check) uses its addresses instead of the free tunnels' random ones.
STABLE_CONF=${RUNSH_STABLE_CONF:-runs/stable-address.conf}
CF_CONFIG=${RUNSH_CF_CONFIG:-$HOME/.cloudflared/config.yml}
PAGE_URL=; RELAY_URL=; TUNNEL_NAME=
if [ -f "$STABLE_CONF" ]; then
  while IFS='=' read -r k v; do v=${v%%#*}; v=$(echo "$v" | tr -d ' \r'); case $k in PAGE_URL|RELAY_URL|TUNNEL_NAME) printf -v "$k" '%s' "${v%/}";; esac; done < <(grep -E '^(PAGE_URL|RELAY_URL|TUNNEL_NAME)=' "$STABLE_CONF")
fi
stable() { [ -n "$PAGE_URL" ] && [ -n "$RELAY_URL" ] && [ -n "$TUNNEL_NAME" ]; }
mkdir -p "$LOGS" "$TUN"

# ---- what each program is: port, command, and what it serves -------------------------------------------------------------------------------
NAMES="pageserver tunnel-stable relay-testnet-1 relay-testnet-2 relay-demo relay-mainnet tunnel-page tunnel-demo tunnel-mainnet dashboard practice-relay practice-page practice-dashboard"
url_of() { # the public address of "page" or "relay-main": the permanent one when it is set, else the free tunnel's
  if stable; then case $1 in page) echo "$PAGE_URL"; return;; relay-main) echo "$RELAY_URL"; return;; esac; fi
  cat "$TUN/$1.url" 2>/dev/null; }
port_of() { case $1 in pageserver) echo 8770;; relay-testnet-1) echo 8787;; relay-testnet-2) echo 8788;; relay-demo) echo 8789;; relay-mainnet) echo 8790;; dashboard) echo 8780;;
  tunnel-page) echo 8770;; tunnel-demo) echo 8789;; tunnel-mainnet) echo 8790;; tunnel-stable) echo 443;; practice-relay) echo 8794;; practice-page) echo 8795;; practice-dashboard) echo 8781;; *) echo "";; esac; }
serves_of() { case $1 in pageserver) echo "the web pages (app/web/www)";; relay-testnet-1) echo "runs/page/relay1 (testnet campaigns)";; relay-testnet-2) echo "runs/page/relay2 (testnet campaigns)";;
  relay-demo) echo "runs/pilot-relay-demo (testnet demo, reached through tunnel-demo)";; relay-mainnet) echo "runs/mainnet-pilot-relay (the real campaigns, reached through tunnel-mainnet)";;
  tunnel-page) echo "public address for the page server (port 8770)";; tunnel-demo) echo "public address for relay-demo (port 8789)";; tunnel-mainnet) echo "public address for relay-mainnet (port 8790)";;
  tunnel-stable) echo "the permanent addresses (page and relay) for ports 8770 and 8790; they are in $STABLE_CONF";;
  dashboard) echo "runs/mainnet-pilot-dash: the real-money dashboard; it also watches every campaign in that folder";;
  practice-relay) echo "runs/practice/relay";; practice-page) echo "the web pages (app/web/www)";; practice-dashboard) echo "runs/practice/dash (testnet; it also watches campaigns in that folder)";; esac; }
# tunnel name -> the file that holds its address
tunfile_of() { case $1 in tunnel-page) echo page;; tunnel-demo) echo relay;; tunnel-mainnet) echo relay-main;; esac; }
# the command, as words (one per line), for a program
cmd_of() {
  case $1 in
    pageserver) echo python3 app/web/serve.py 8770 127.0.0.1;;
    relay-testnet-1) echo $BIN/cb-relay serve --dir runs/page/relay1 --listen 127.0.0.1:8787;;
    relay-testnet-2) echo $BIN/cb-relay serve --dir runs/page/relay2 --listen 127.0.0.1:8788;;
    relay-demo) echo $BIN/cb-relay serve --dir runs/pilot-relay-demo --listen 127.0.0.1:8789;;
    relay-mainnet) echo $BIN/cb-relay serve --dir runs/mainnet-pilot-relay --listen 127.0.0.1:8790;;
    tunnel-stable) echo "$CLOUDFLARED" tunnel --no-autoupdate --protocol http2 run "${TUNNEL_NAME:-<tunnel name>}";;   # http2: the default QUIC (UDP) connection kept timing out on this computer
    tunnel-*) echo "$CLOUDFLARED" tunnel --no-autoupdate --url http://127.0.0.1:$(port_of $1);;
    dashboard) echo $BIN/cb-host serve --network main --server https://zjs.zec.rocks/mainnet --runs-dir runs/mainnet-pilot-dash --relay "$(url_of relay-main)" --page-base "$(url_of page)" --listen 127.0.0.1:8780;;
    practice-relay) echo $BIN/cb-relay serve --dir runs/practice/relay --listen 127.0.0.1:8794;;
    practice-page) echo python3 app/web/serve.py 8795 127.0.0.1;;
    practice-dashboard) echo $BIN/cb-host serve --runs-dir runs/practice/dash --relay http://127.0.0.1:8794 --listen 127.0.0.1:8781;;
    watcher:*) echo $BIN/cb-host watch --run "${1#watcher:}" --interval 10;;
  esac
}
# these touch real money or public addresses: stopping or restarting them needs --yes
risky() { case $1 in dashboard|relay-mainnet|tunnel-*|pageserver|tunnel-stable) return 0;; esac; return 1; }

# ---- finding a running program ---------------------------------------------------------------------------------------------------------------
pid_on_port() { ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
pid_of() { # name -> pid (empty when not running)
  case $1 in
    tunnel-stable) ps -eo pid=,args= | awk -v n="${TUNNEL_NAME:-}" 'n != "" { k = 0; for (i = 3; i <= NF; i++) if ($i == "tunnel" && $(i-1) ~ /cloudflared$/) k = i; if (k) { r = 0; for (j = k + 1; j <= NF; j++) if ($j == "run") r = j; if (r && $NF == n) {print $1; exit} } }';;
    tunnel-*) ps -eo pid=,args= | awk -v u="http://127.0.0.1:$(port_of $1)" '$2 ~ /cloudflared$/ && $3 == "tunnel" && $NF == u {print $1; exit}';;
    watcher:*) ps -eo pid=,args= | awk -v f="${1#watcher:}" '$2 ~ /(cb|ll)-host$/ && $3 == "watch" && $4 == "--run" && $5 == f {print $1; exit}';;
    *) pid_on_port "$(port_of $1)";;
  esac
}
known() { local n; for n in $NAMES; do [ "$n" = "$1" ] && return 0; done; case $1 in watcher:*) return 0;; esac; return 1; }
norm() { case $1 in watcher) echo "watcher:${2:-}";; *) echo "$1";; esac; }

# ---- start / stop --------------------------------------------------------------------------------------------------------------------------------
do_start() {
  local n=$1 pid log; pid=$(pid_of "$n")
  [ -n "$pid" ] && { echo "$n is already running (process $pid)"; return 0; }
  log="$LOGS/${n//[:\/]/_}.log"
  case $n in
    practice-relay) mkdir -p runs/practice/relay;;
    practice-dashboard) mkdir -p runs/practice/dash;;
    dashboard) [ -n "$(url_of relay-main)" ] && [ -n "$(url_of page)" ] || { echo "the dashboard needs the two tunnel addresses ($TUN/relay-main.url and $TUN/page.url): start tunnel-mainnet and tunnel-page first"; return 1; }
      for t in tunnel-mainnet tunnel-page; do [ -n "$(pid_of $t)" ] || echo "warning: $t is not running, so the links the dashboard hands out will not open from outside"; done;;
    watcher:*) [ -f "${n#watcher:}/rules.json" ] || { echo "no campaign folder at ${n#watcher:}"; return 1; };;
  esac
  case $n in
    tunnel-stable)
      stable || { echo "no permanent address is set: write $STABLE_CONF first (docs/STABLE_ADDRESS.md, step 6)"; return 1; }
      [ -f "$CF_CONFIG" ] || { echo "no tunnel configuration at $CF_CONFIG: run ./run.sh stable-config and save its output there (docs/STABLE_ADDRESS.md, step 7)"; return 1; }
      : > "$log"; ( setsid nohup $(cmd_of $n) > "$log" 2>&1 & )
      echo "starting $n ..."
      for i in $(seq 1 40); do grep -q -i 'registered tunnel connection' "$log" && break; sleep 1; done
      grep -q -i 'registered tunnel connection' "$log" && echo "$n is up. Page: $PAGE_URL   Relay: $RELAY_URL" || { echo "$n started but did not report a connection in 40 seconds: see $log"; return 1; };;
    tunnel-*)
      [ -n "$PAGE_URL" ] && echo "note: a permanent address is set ($STABLE_CONF); this is a free tunnel with a random address and is not what the dashboard uses";
      : > "$log"; ( setsid nohup $(cmd_of $n) > "$log" 2>&1 & )
      echo "starting $n (a free tunnel; it takes up to a minute to get its address) ..."
      for i in $(seq 1 60); do u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | head -1); [ -n "$u" ] && break; sleep 1; done
      [ -n "$u" ] || { echo "no address after 60 seconds: see $log"; return 1; }
      echo "$u" > "$TUN/$(tunfile_of $n).url"; echo "$n is up. NEW ADDRESS: $u  (saved in $TUN/$(tunfile_of $n).url). Anything that holds the old address must be changed.";;
    *)
      local words; mapfile -t words < <(cmd_of $n | tr ' ' '\n' | grep -v '^$')
      ( setsid nohup "${words[@]}" > "$log" 2>&1 & )
      for i in $(seq 1 30); do pid=$(pid_of "$n"); [ -n "$pid" ] && break; sleep 0.5; done
      [ -n "$pid" ] && echo "$n started (process $pid). Log: $log" || { echo "$n did not start: see $log"; tail -5 "$log"; return 1; };;
  esac
}
do_stop() {
  local n=$1 pid; pid=$(pid_of "$n")
  [ -z "$pid" ] && { echo "$n is not running"; return 0; }
  kill "$pid" 2>/dev/null
  for i in $(seq 1 20); do [ -z "$(pid_of "$n")" ] && break; sleep 0.5; done
  [ -z "$(pid_of "$n")" ] && echo "$n stopped (was process $pid)" || { echo "$n did not stop in 10 seconds (process $pid). Try: kill -9 $pid"; return 1; }
}

# ---- status ---------------------------------------------------------------------------------------------------------------------------------
do_status() {
  printf '%-18s %-6s %-6s %-8s %s\n' PROGRAM PORT STATE PROCESS "SERVES / NOTE"
  local n pid
  for n in $NAMES; do
    pid=$(pid_of $n)
    case $n in practice-*) [ -z "$pid" ] && continue;; tunnel-stable) stable || continue;; esac
    printf '%-18s %-6s %-6s %-8s %s\n' "$n" "$(port_of $n)" "$([ -n "$pid" ] && echo up || echo DOWN)" "${pid:--}" "$(serves_of $n)"
    case $n in tunnel-stable) [ -n "$pid" ] && printf '%-18s %-6s %-6s %-8s %s\n' "" "" "" "" "addresses: $PAGE_URL and $RELAY_URL";; tunnel-*) [ -n "$pid" ] && printf '%-18s %-6s %-6s %-8s %s\n' "" "" "" "" "address: $(url_of $(tunfile_of $n))";; esac
  done
  echo
  echo "ADDRESSES (are they reachable from outside, right now?)"
  addr_row() { local code; code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null); [ -z "$code" ] && code=000
    if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then printf '  %-10s %-60s answers (HTTP %s)\n' "$1" "$2" "$code"; else printf '  %-10s %-60s NOT ANSWERING (HTTP %s): the tunnel program may be running but its address is dead. Restart it: ./run.sh restart %s --yes\n' "$1" "$2" "$code" "$3"; fi; }
  if stable; then addr_row page "$PAGE_URL/" tunnel-stable; addr_row relay "$RELAY_URL/v1/campaigns/0" tunnel-stable
  else for t in page relay-main; do u=$(url_of $t); [ -n "$u" ] && addr_row "${t%-main}" "$u$([ $t = relay-main ] && echo /v1/campaigns/0 || echo /)" "tunnel-${t/relay-main/mainnet}"; done; fi
  echo
  echo "OTHER PROGRAMS LISTENING on 127.0.0.1 (87xx and 88xx; not started by this script):"
  ss -ltnp 2>/dev/null | awk '$4 ~ /^127\.0\.0\.1:(87|88)[0-9][0-9]$/ {print $4, $6}' | while read -r addr who; do
    port=${addr##*:}; known_port=0; for n in $NAMES; do [ "$(port_of $n)" = "$port" ] && known_port=1; done
    [ $known_port = 0 ] && echo "  $addr  $(echo "$who" | grep -o '"[^"]*"' | head -1 | tr -d '"') (process $(echo "$who" | grep -o 'pid=[0-9]*' | cut -d= -f2))"
  done
  echo
  python3 - "$@" <<'PY'
import glob, json, os, re, subprocess, sys, urllib.request
show_all = "--all" in sys.argv
ps = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True).stdout.splitlines()
watchers, dashboards = {}, []
for l in ps:
    pid, _, args = l.strip().partition(" ")
    m = re.match(r"^\S*(?:cb|ll)-host watch --run (\S+)", args)
    if m: watchers[os.path.realpath(m.group(1))] = pid
    m = re.match(r"^\S*(?:cb|ll)-host serve .*--runs-dir (\S+)", args)
    if m:
        lm = re.search(r"--listen (\S+)", args)
        dashboards.append((pid, os.path.realpath(m.group(1)), lm.group(1) if lm else "127.0.0.1:8780"))
folders = sorted({os.path.dirname(p) for p in glob.glob("runs/**/rules.json", recursive=True)})
rows, unwatched_old = [], 0
for f in folders:
    if not os.path.isdir(f + "/private") or not os.path.exists(f + "/config.json"): continue
    if "/relay" in f and "/campaigns/" in f: continue
    rules = json.load(open(f + "/rules.json"))
    closed = False
    for e in sorted(glob.glob(f + "/ledger/*.json")):
        try: closed = closed or json.load(open(e)).get("kind") == "close"
        except Exception: pass
    real = os.path.realpath(f)
    by = None
    if real in watchers: by = f"watcher (process {watchers[real]})"
    for pid, d, listen in dashboards:
        if real.startswith(d + os.sep): by = f"dashboard (process {pid}, {listen})"; dash = listen
    rid = open(f + "/rules_id").read().strip() if os.path.exists(f + "/rules_id") else ""
    extra = ""
    if by and by.startswith("dashboard"):
        try:
            req = urllib.request.Request(f"http://{dash}/api/campaigns/{rid}", headers={"x-dashboard": "1"})
            s = json.load(urllib.request.urlopen(req, timeout=5)); lc = s.get("last_check", {})
            extra = f"last network check {lc.get('seconds_ago')} s ago" + ("" if lc.get("ok") else " (FAILED)")
        except Exception as ex: extra = "dashboard did not answer"
    elif by:
        import time
        logs = [x for x in (f + "/watch.log", "runs/logs/watcher_" + f.replace("/", "_") + ".log") if os.path.exists(x)]
        if logs: extra = f"log last written {int(time.time() - max(os.path.getmtime(x) for x in logs))} s ago"
    net = rules.get("network", "?")
    rows.append((f, net, closed, by, extra, rules.get("name")))
print("CAMPAIGN FOLDERS" + ("" if show_all else " (mainnet, and testnet ones that are watched; add --all for every one)"))
for f, net, closed, by, extra, name in rows:
    label = f"{f}  [{net}{', named ' + repr(name) if name else ''}]"
    if closed:
        if show_all or net == "main": print(f"  {label}\n      closed: nothing to watch")
        continue
    if by: print(f"  {label}\n      watched by {by}" + (f"; {extra}" if extra else ""))
    elif net == "main" or show_all: print(f"  {label}\n      NOT WATCHED. Contributions are not getting tickets. Start it: ./run.sh start watcher {f}")
    else: unwatched_old += 1
if unwatched_old: print(f"  ({unwatched_old} older testnet folders that are not closed and not watched: nothing to do unless you want to use them; ./run.sh status --all lists them)")
PY
}


# ---- set-relay: change the relay address stored in a campaign folder ---------------------------------------------------------------------------
do_set_relay() {
  python3 - "$@" <<'PY'
import glob, json, os, re, subprocess, sys, time, urllib.request, urllib.error
args = sys.argv[1:]
apply = "--yes" in args; args = [a for a in args if a != "--yes"]
add = "--add" in args; args = [a for a in args if a != "--add"]
old = None
if "--replace" in args:
    i = args.index("--replace"); old = args[i + 1].rstrip("/"); del args[i:i + 2]
if len(args) < 2: print("usage: ./run.sh set-relay <new relay address> <campaign folder | --all> [--replace <old address> | --add] [--yes]"); sys.exit(2)
new = args[0].rstrip("/"); target = args[1]
if not re.match(r"^https?://[^\s/]+(:\d+)?$", new): print(f"'{new}' does not look like a relay address (it should be like https://name.example.org, without a path)"); sys.exit(2)
def campaign_folders():
    out = []
    for f in sorted({os.path.dirname(p) for p in glob.glob("runs/**/rules.json", recursive=True)}):
        if os.path.isfile(f + "/private/relays") and os.path.isfile(f + "/config.json"): out.append(f)
    return out
def is_closed(f):
    for e in glob.glob(f + "/ledger/*.json"):
        try:
            if json.load(open(e)).get("kind") == "close": return True
        except Exception: pass
    return False
if target == "--all":
    # only open real-network campaigns: an address for the real network must never be written into a test campaign by accident (name those explicitly)
    folders = []
    for f in campaign_folders():
        net = json.load(open(f + "/rules.json")).get("network")
        if is_closed(f): continue
        if net == "main": folders.append(f)
        else: print(f"  skipped {f} (a test-network campaign: name it explicitly to change it)")
else:
    if not os.path.isfile(target + "/private/relays"): print(f"{target} is not a campaign folder (no private/relays)"); sys.exit(2)
    folders = [target]
if not folders: print("no campaign folder to change"); sys.exit(0)
def ask(url, rid):
    """(answers?, holds the campaign?) for a relay address, with a short timeout."""
    try:
        r = urllib.request.urlopen(f"{url}/v1/campaigns/{rid}", timeout=15); return True, r.status == 200
    except urllib.error.HTTPError as e: return True, False      # it answered: it is alive, it just does not hold the campaign
    except Exception: return False, False
ok_new, _ = ask(new, "0" * 64)
if not ok_new:
    print(f"{new} does not answer. Nothing was changed. Check the address (and that the tunnel or server is running), then try again."); sys.exit(1)
changes = []
for f in folders:
    rid = open(f + "/rules_id").read().strip()
    lines = [l.strip() for l in open(f + "/private/relays").read().splitlines() if l.strip()]
    new_lines, notes = [], []
    for l in lines:
        base = l.rstrip("/")
        if old is not None: dead = base == old
        else: dead = base != new and not ask(base, rid)[0]          # without --replace: only an address that does not answer is replaced
        if dead:
            if new not in new_lines: new_lines.append(new)
            notes.append(f"replaces {base}" + ("" if old is not None else " (does not answer)"))
        else:
            if base not in new_lines: new_lines.append(base)
    if new not in new_lines:
        if add: new_lines.append(new); notes.append("added (--add)")
        elif not new_lines: new_lines.append(new); notes.append("added (nothing was stored)")
    holds = ask(new, rid)[1]
    changes.append((f, rid, lines, new_lines, notes, holds))
any_change = False
for f, rid, lines, new_lines, notes, holds in changes:
    same = [l.rstrip("/") for l in lines] == new_lines
    print(f"{f}  (campaign {rid[:8]}…)")
    print("   stored now:   " + (", ".join(lines) or "(nothing)"))
    print("   would become: " + ", ".join(new_lines) + ("   [no change]" if same else ""))
    for n in notes: print("   - " + n)
    print(f"   the new address {'already holds this campaign' if holds else 'does not hold this campaign yet: the host will publish it there on its next check'}")
    any_change = any_change or not same
    # the address is not part of the campaign: the rules and the id are not touched by this command
if not any_change: print("nothing to change."); sys.exit(0)
if not apply: print("\nThis was only a look. To apply it, run the same command again with --yes."); sys.exit(0)
for f, rid, lines, new_lines, notes, holds in changes:
    if [l.rstrip("/") for l in lines] == new_lines: continue
    path = f + "/private/relays"
    open(f"{path}.before-{int(time.time())}", "w").write("\n".join(lines) + "\n")   # a copy of what was there
    tmp = path + ".new"; open(tmp, "w").write("\n".join(new_lines) + "\n"); os.chmod(tmp, os.stat(path).st_mode & 0o777); os.replace(tmp, path)
    print(f"changed {path}")
ps = subprocess.run(["ps", "-eo", "args="], capture_output=True, text=True).stdout
dash = re.findall(r"(?:cb|ll)-host serve .*", ps)
print("\nWHAT TO RESTART: nothing, for these campaigns. The host program reads this file again on every check, so the next check (within about 15 seconds) publishes to the new address.")
for d in dash:
    m = re.search(r"--relay (\S+)", d)
    if m and m.group(1).rstrip("/") != new:
        print(f"The dashboard is running with --relay {m.group(1)}. That only decides the address given to NEW campaigns made in its set-up page. To change it, restart it after updating where it reads the address from: ./run.sh restart dashboard --yes")
print("Links already handed out with the old address keep that address inside them; make new links from the dashboard (its campaign page shows the contribute link).")
PY
}

# ---- the commands -----------------------------------------------------------------------------------------------------------------------------------
cmd=${1:-help}; shift || true
yes=0; args=(); for a in "$@"; do [ "$a" = "--yes" ] && yes=1 || args+=("$a"); done
if [ "$cmd" != status ]; then set -- "${args[@]:-}"; fi
case $cmd in
  status) do_status "$@";;
  set-relay) do_set_relay "${@:1}" $([ $yes = 1 ] && echo --yes);;
  names) echo $NAMES watcher; ;;
  stable-config)
    stable || { echo "no permanent address is set: write $STABLE_CONF first (see docs/STABLE_ADDRESS.md, step 6)"; exit 2; }
    cred=$(ls -t "$HOME"/.cloudflared/*.json 2>/dev/null | head -1)
    echo "# Save this as $CF_CONFIG (docs/STABLE_ADDRESS.md, step 7)"
    echo "tunnel: $TUNNEL_NAME"
    echo "credentials-file: ${cred:-$HOME/.cloudflared/<tunnel id>.json}"
    echo "ingress:"
    echo "  - hostname: ${PAGE_URL#https://}"
    echo "    service: http://127.0.0.1:8770"
    echo "  - hostname: ${RELAY_URL#https://}"
    echo "    service: http://127.0.0.1:8790"
    echo "  - service: http_status:404";;
  command|logs|start|stop|restart)
    [ $# -ge 1 ] && [ -n "${1:-}" ] || { echo "which program? ./run.sh names lists them"; exit 2; }
    n=$(norm "$@"); known "$n" || { echo "unknown name: $1 (./run.sh names)"; exit 2; }
    case $cmd in
      command) cmd_of "$n" | tr '\n' ' '; echo;;
      logs) l="$LOGS/${n//[:\/]/_}.log"; echo "log file: $l"; [ -f "$l" ] && tail -15 "$l" || echo "(no log yet: it was not started with this script)";;
      start) do_start "$n";;
      stop|restart)
        if risky "$n" && [ $yes = 0 ]; then echo "$n touches the real network or a public address. Add --yes if you really mean it: ./run.sh $cmd $* --yes"; exit 3; fi
        do_stop "$n" || exit 1; if [ "$cmd" = restart ]; then sleep 1; do_start "$n" || exit 1; fi;;
    esac;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//';;
esac

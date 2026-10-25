#!/usr/bin/env python3
"""Offline check of the operator bot's alert for a payment that is not in a blind bid auction: no Telegram, no host, no network. A stand in
host status lists one such payment; the bot must say it once, with its amount, reason, block and transaction id, and never again for the
same payment; a second payment gets its own alert.

Usage: python3 app/opbot/alerts-test.py
"""
import importlib.util, os, sys, tempfile

spec = importlib.util.spec_from_file_location("opbot", os.path.join(os.path.dirname(os.path.abspath(__file__)), "opbot.py"))
opbot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(opbot)
failed = 0


def check(name, ok, extra=""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(extra)[:220]) if extra else ''}", flush=True)
    failed += 0 if ok else 1


class Tg:
    def __init__(self):
        self.sent = []

    def call(self, method, body, timeout=40):
        self.sent.append(body["text"])
        return True


TX1, TX2 = "57" + "a" * 62, "b" * 64
status = {"ok": True, "short": "69aa0000", "name": "Apparition", "network": "main", "ticker": "ZEC", "tip": 3527800, "phase": "open",
          "sealed": {"claim_after": 3529600, "round_time": 1 << 40, "not_in_auction": [{"txid": TX1, "action": 0, "height": 3527753, "value_zat": 50000, "reason": "no memo"}]}}

with tempfile.TemporaryDirectory() as d:
    tg = Tg()
    bot = opbot.Bot(tg, {"chat_id": "1"}, {}, {}, None, os.path.join(d, "state.json"))
    bot.campaigns = lambda: [("main", "http://x", status)]
    opbot.log = lambda msg: None
    bot.alerts()
    check("one alert for the payment not in the auction", len(tg.sent) == 1, tg.sent)
    text = tg.sent[0] if tg.sent else ""
    check("it names the amount, the reason, the block and the full transaction id", "0.0005 ZEC" in text and "no memo" in text and "3,527,753" in text and TX1 in text, text)
    check("it says the payment is not a bid and stays in the auction wallet", "is not a bid" in text and "stays in the auction wallet" in text, text)
    check("no dash used as punctuation", " - " not in text and "\u2014" not in text, text)
    bot.alerts()
    check("the same payment is not alerted again", len(tg.sent) == 1, tg.sent)
    status["sealed"]["not_in_auction"].append({"txid": TX2, "action": 1, "height": 3527800, "value_zat": 100000, "reason": "unreadable memo"})
    bot.alerts()
    check("a second payment gets its own alert", len(tg.sent) == 2 and TX2 in tg.sent[-1] and "unreadable memo" in tg.sent[-1], tg.sent[-1:])

print("ALL PASS" if not failed else f"{failed} check(s) failed", flush=True)
sys.exit(1 if failed else 0)

#!/usr/bin/env python3
"""Prints the crashed thread of macOS/iOS .ips crash reports (CI: simulator processes that
died during xcodebuild test).  Usage: ci-crash-summary.py report.ips [...]"""
import json
import sys

for path in sys.argv[1:]:
    text = open(path, encoding="utf-8", errors="replace").read()
    head, _, body_text = text.partition("\n")
    try:
        hdr = json.loads(head)
        body = json.loads(body_text) if body_text.strip() else {}
    except json.JSONDecodeError as e:
        print(f"=== {path}: not a JSON crash report ({e})")
        continue
    print(f"=== {path}")
    print(hdr.get("app_name"), hdr.get("timestamp"), hdr.get("bug_type"))
    print("exception:", body.get("exception"))
    print("termination:", body.get("termination"))
    if body.get("asi"):
        print("asi:", body.get("asi"))
    threads = body.get("threads") or []
    idx = body.get("faultingThread", 0)
    images = body.get("usedImages", [])
    thr = threads[idx] if idx < len(threads) else {}
    print("faulting thread", idx, thr.get("name") or thr.get("queue") or "")
    for fr in (thr.get("frames") or [])[:30]:
        img = images[fr["imageIndex"]] if fr.get("imageIndex", -1) < len(images) and fr.get("imageIndex", -1) >= 0 else {}
        print("  %-30s %s + %s" % (img.get("name", "?"), fr.get("symbol", "?"), fr.get("symbolLocation", fr.get("imageOffset"))))

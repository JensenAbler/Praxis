#!/usr/bin/env python3
"""Report Claude subscription usage by reading Claude Code's /usage screen.

Claude Code (the official client) must already be logged in to the owner's
subscription for the invoking user. The script starts Claude Code in a
private tmux session, opens /usage, captures the rendered screen, exits and
prints JSON. It sends no prompt to the model, so it consumes no usage.

Exit codes: 0 parsed, 2 not logged in / unexpected screen, 3 timeout.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

READY_MARKERS = ("for shortcuts", "/effort", "shift+tab to cycle")
LOGIN_MARKERS = ("Select login method", "Paste code here")
TRUST_MARKERS = ("Do you trust", "trust the files", "trust this folder", "Quick safety check")
DIALOG_MARKERS = ("Enter to confirm", "Esc to cancel")
PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)%\s*used")
RESETS_RE = re.compile(r"^\s*Resets\s+(.+?)\s*$")


def slug(heading):
    text = heading.strip().lower()
    text = re.sub(r"^current\s+", "", text)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text or "unknown"


def parse_usage(screen):
    """Parse the rendered /usage screen into meters keyed by heading."""
    lines = [line.rstrip() for line in screen.splitlines()]
    meters = {}
    current = None
    extra = None
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("Current "):
            current = {"label": line, "percentUsed": None, "resets": None}
            meters[slug(line)] = current
            continue
        if line.startswith("Extra usage") and line != "Extra usage":
            extra = line
            current = None
            continue
        if current is None:
            continue
        match = PERCENT_RE.search(line)
        if match and current["percentUsed"] is None:
            value = float(match.group(1))
            current["percentUsed"] = int(value) if value.is_integer() else value
            continue
        match = RESETS_RE.match(line)
        if match and current["resets"] is None:
            current["resets"] = match.group(1)
    return {"meters": meters, "extraUsage": extra}


def tmux(*args, check=True):
    return subprocess.run(["tmux", *args], check=check, capture_output=True, text=True).stdout


def capture(session):
    return tmux("capture-pane", "-p", "-J", "-t", session, check=False)


def wait_for(session, predicate, timeout):
    deadline = time.monotonic() + timeout
    screen = ""
    while time.monotonic() < deadline:
        screen = capture(session)
        if predicate(screen):
            return screen, True
        time.sleep(0.5)
    return screen, False


def reach_prompt(session, timeout=60):
    """Get past startup dialogs to the input prompt.

    Returns (screen, status) where status is "ready", "login" or "timeout".
    The trust dialog is accepted (the folder is dedicated and empty); any
    other confirm dialog (feature tours, renderer offers) is dismissed with
    Escape so the run never opts into anything.
    """
    deadline = time.monotonic() + timeout
    screen = ""
    while time.monotonic() < deadline:
        screen = capture(session)
        if any(m in screen for m in LOGIN_MARKERS):
            return screen, "login"
        if any(m in screen for m in TRUST_MARKERS):
            tmux("send-keys", "-t", session, "Down")
            time.sleep(0.5)
            tmux("send-keys", "-t", session, "C-m")
            time.sleep(2)
            continue
        if any(m in screen for m in DIALOG_MARKERS):
            tmux("send-keys", "-t", session, "Escape")
            time.sleep(1.5)
            continue
        if any(m in screen for m in READY_MARKERS):
            return screen, "ready"
        time.sleep(0.5)
    return screen, "timeout"


def fail(code, reason, screen=""):
    tail = "\n".join(line for line in screen.splitlines() if line.strip())[-1500:]
    print(json.dumps({"ok": False, "reason": reason, "screenTail": tail}, indent=2))
    return code


def main():
    for tool in ("tmux", "claude"):
        if not shutil.which(tool):
            return fail(2, f"{tool} is not installed")
    session = f"claude-usage-{uuid.uuid4().hex[:8]}"
    # A dedicated empty folder: trusting it grants Claude Code nothing of value.
    cwd = os.path.join(os.path.expanduser("~"), ".cache", "claude-usage")
    os.makedirs(cwd, mode=0o700, exist_ok=True)
    command = "DISABLE_AUTOUPDATER=1 exec claude"
    tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "60", "-c", cwd, command)
    try:
        screen, status = reach_prompt(session)
        if status == "login":
            return fail(2, "Claude Code is not logged in to a subscription", screen)
        if status != "ready":
            return fail(3, "Claude Code did not reach its prompt", screen)
        time.sleep(1)
        tmux("send-keys", "-t", session, "-l", "/usage")
        time.sleep(1.5)
        tmux("send-keys", "-t", session, "C-m")
        screen, ready = wait_for(
            session,
            lambda s: len(PERCENT_RE.findall(s)) >= 2 or "Extra usage" in s,
            30,
        )
        time.sleep(1)
        screen = capture(session)
        if not ready:
            return fail(3, "The /usage screen did not render", screen)
        parsed = parse_usage(screen)
        if not parsed["meters"]:
            return fail(2, "Could not find usage meters on the screen", screen)
        result = {
            "ok": True,
            "capturedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **parsed,
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        tmux("send-keys", "-t", session, "Escape", check=False)
        time.sleep(0.5)
        tmux("send-keys", "-t", session, "-l", "/exit", check=False)
        tmux("send-keys", "-t", session, "C-m", check=False)
        time.sleep(1.5)
        tmux("kill-session", "-t", session, check=False)


if __name__ == "__main__":
    sys.exit(main())

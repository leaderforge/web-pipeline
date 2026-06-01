"""
Daily pipeline — runs at 7am via cron / scheduled task.

Executes:
1. follow-up.py  — Day 3 / Day 7 emails with screenshots
2. cleanup.py    — Delete expired demos >14 days without response
3. Checks for Telegram spam — verifies no false tracking notifications

Usage:
    python scripts/daily-pipeline.py
    python scripts/daily-pipeline.py --dry-run
    python scripts/daily-pipeline.py --lang es

Cron (Windows Task Scheduler or similar):
    0 7 * * * cd C:\\Hermes-Brain\\04-Web-Pipeline\\proyectos\\leaderforge-digital\\outreach && python scripts/daily-pipeline.py
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path
from datetime import datetime

SCRIPTS = Path(__file__).parent


def run_script(name: str, args: list[str], dry_run: bool) -> bool:
    """Run a Python script and return True if it succeeded."""
    cmd = [sys.executable, str(SCRIPTS / name)] + args
    if dry_run:
        cmd.append("--dry-run")

    label = f"{'[DRY RUN] ' if dry_run else ''}{name} {' '.join(args)}"
    print(f"\n{'=' * 60}")
    print(f"  {label}")
    print(f"{'=' * 60}")

    result = subprocess.run(
        cmd,
        capture_output=False,
        timeout=120,
        cwd=str(SCRIPTS.parent),
        env={**os.environ, "NO_COLOR": "1"},
    )
    ok = result.returncode == 0
    if not ok:
        print(f"  WARNING: {name} exited with code {result.returncode}")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Daily pipeline runner")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    parser.add_argument("--skip-cleanup", action="store_true")
    parser.add_argument("--skip-followup", action="store_true")
    args = parser.parse_args()

    print(f"Daily Pipeline — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"  Language: {args.lang}")
    if args.dry_run:
        print("  DRY RUN — no emails sent, no files deleted\n")

    results = {}

    if not args.skip_followup:
        results["follow-up"] = run_script(
            "follow-up.py", ["--lang", args.lang], args.dry_run
        )

    if not args.skip_cleanup:
        results["cleanup"] = run_script(
            "cleanup.py", ["--max-age", "14"], args.dry_run
        )

    print(f"\n{'=' * 60}")
    print("Daily pipeline complete")
    for name, ok in results.items():
        status = "OK" if ok else "FAILED"
        print(f"  {name}: {status}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()

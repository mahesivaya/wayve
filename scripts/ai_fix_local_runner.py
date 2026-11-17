#!/usr/bin/env python3
"""Local runner for the "Fix with AI" button.

When the backend runs with AI_FIX_RUNNER=local, clicking "Fix with AI" on a
ticket or user story queues the job instead of dispatching the GitHub Actions
workflow. This script, run on the developer's own machine, takes those jobs:

  1. fetches the latest `main` from origin,
  2. creates a separate git worktree on a new branch cut from it (your own
     checkout and uncommitted work are never touched),
  3. runs Claude Code there, non-interactively, with the /fix-ticket skill
     (using the Claude login already on this machine),
  4. runs the local checks itself, for the areas the change touched,
  5. if every check passes, pushes the branch and opens a pull request,
  6. reports the outcome to the item, where the app shows it.

While a job runs it also reports how far it has got (0-100%) and what it is
doing, which the item shows as a percentage.

A failed check, or any git / GitHub error, is reported as an error with the
output; nothing is pushed. CI is never waited on, and nothing is merged.

Usage:
    AI_FIX_RUNNER_TOKEN=<token> python3 scripts/ai_fix_local_runner.py
    python3 scripts/ai_fix_local_runner.py --once     # one job, then exit

Environment:
    AI_FIX_RUNNER_TOKEN    the shared secret the backend also has (16+ chars).
                           If unset, it is read from backend/.env.development.
    WAYVE_API_KEY          alternative to the token: an internal API key whose
                           user is platform staff with tickets:manage.
    WAYVE_BASE_URL         backend address. Default http://localhost:8080
    AI_FIX_REPO            the checkout to work from. Default: the one this
                           script is in
    AI_FIX_WORKDIR         where worktrees and the shared cargo target live.
                           Default ~/.cache/wayve-ai-fix
    AI_FIX_POLL_SECONDS    how often to ask for a job. Default 10
    AI_FIX_CLAUDE_TIMEOUT  seconds Claude may run. Default 2700 (45 min)
    AI_FIX_CHECK_TIMEOUT   seconds each check may run. Default 1800 (30 min)
    AI_FIX_MAX_TURNS       Claude's turn cap. Default 60
    AI_FIX_MODEL           model for Claude Code. Default: its own default
    AI_FIX_DB_TESTS=1      also run the backend's database tests (slow; needs
                           TEST_DATABASE_URL or DATABASE_URL)
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# The checkout to cut worktrees from. In the Docker runner the script is
# mounted on its own, so the container names its clone with AI_FIX_REPO.
REPO = Path(
    os.environ.get("AI_FIX_REPO") or Path(__file__).resolve().parent.parent
).expanduser()
BASE_URL = os.environ.get("WAYVE_BASE_URL", "http://localhost:8080").rstrip("/")


def token_from_env_file():
    """The backend's token, so the runner needs no setup of its own."""
    try:
        lines = (REPO / "backend" / ".env.development").read_text().splitlines()
    except OSError:
        return ""
    for line in lines:
        key, _, value = line.partition("=")
        if key.strip() == "AI_FIX_RUNNER_TOKEN":
            return value.strip().strip('"').strip("'")
    return ""


RUNNER_TOKEN = os.environ.get("AI_FIX_RUNNER_TOKEN", "") or token_from_env_file()
API_KEY = os.environ.get("WAYVE_API_KEY", "")
# The runner's own shared token when set; otherwise an API key.
AUTH_HEADERS = (
    {"X-AI-Fix-Runner-Token": RUNNER_TOKEN}
    if RUNNER_TOKEN
    else {"X-API-KEY": API_KEY}
)
WORKDIR = Path(
    os.environ.get("AI_FIX_WORKDIR", str(Path.home() / ".cache" / "wayve-ai-fix"))
).expanduser()
POLL_SECONDS = int(os.environ.get("AI_FIX_POLL_SECONDS", "10"))
CLAUDE_TIMEOUT = int(os.environ.get("AI_FIX_CLAUDE_TIMEOUT", "2700"))
CHECK_TIMEOUT = int(os.environ.get("AI_FIX_CHECK_TIMEOUT", "1800"))
MAX_TURNS = os.environ.get("AI_FIX_MAX_TURNS", "60")
MODEL = os.environ.get("AI_FIX_MODEL", "")
DB_TESTS = os.environ.get("AI_FIX_DB_TESTS") == "1"

ALLOWED_TOOLS = "Read,Glob,Grep,Edit,MultiEdit,Write,Bash,TodoWrite"
# How much of a failing command's output is sent back to the item.
LOG_TAIL = 6000


class JobError(Exception):
    """A job failed in a way worth showing on the item."""


class JobCanceled(Exception):
    """The fix was canceled from the app while the job was running."""


def log(message):
    print(f"[ai-fix] {message}", flush=True)


def run(cmd, cwd, timeout=None, env=None):
    """Run a command; return (exit code, combined output)."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            timeout=timeout,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        return proc.returncode, proc.stdout
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        if isinstance(out, bytes):
            out = out.decode(errors="replace")
        return 124, f"{out}\n[timed out after {timeout}s]"
    except FileNotFoundError:
        return 127, f"command not found: {cmd[0]}"


def git(*args, cwd):
    code, out = run(["git", *args], cwd)
    if code != 0:
        raise JobError(f"git {' '.join(args)} failed:\n{out[-LOG_TAIL:]}")
    return out


def api(method, path, body=None):
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers=AUTH_HEADERS | {"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode() or "null")


def collection(kind):
    # Stories and tickets expose identical ai-fix endpoints under their own
    # prefix, so only the collection segment changes.
    return "user-stories" if kind == "story" else "workspace-tickets"


def report(job, body):
    path = f"/api/{collection(job['kind'])}/{job['id']}/ai-fix-diff"
    try:
        api("POST", path, body)
        log(f"reported {body['status']} for {job['kind']} #{job['id']}")
    except urllib.error.HTTPError as exc:
        log(f"report failed ({exc.code}): {exc.read().decode()[:300]}")
    except OSError as exc:
        log(f"report failed: {exc}")


def progress(job, percent, step):
    """Tell the item how far the run has got. Best-effort: a report that can't
    be sent never fails a job. The reply is also how the runner hears that the
    fix was canceled in the app, which stops the job (JobCanceled)."""
    path = f"/api/{collection(job['kind'])}/{job['id']}/ai-fix-progress"
    try:
        reply = api("POST", path, {"percent": int(percent), "step": step})
    except urllib.error.HTTPError as exc:
        log(f"progress not reported ({exc.code})")
        return
    except OSError as exc:
        log(f"progress not reported: {exc}")
        return
    if isinstance(reply, dict) and reply.get("canceled"):
        raise JobCanceled()


# Where each stage sits on the 0-100 scale. Claude's stage is the long one, so
# it gets the widest span and moves with the turns it has used of its cap.
P_CLAIMED, P_CLAUDE, P_CHECKS, P_COLLECT, P_PUSH, P_PR = 3, 10, 70, 90, 93, 96


def run_claude(cmd, cwd, env, timeout, on_turn):
    """Run Claude Code with streamed output, calling on_turn(n) as it works.

    Returns (exit code, readable output): what Claude wrote, for the error
    report. The stream is one JSON event per line; each "assistant" event is
    one turn.
    """
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
    except FileNotFoundError:
        return 127, f"command not found: {cmd[0]}"

    timed_out = threading.Event()

    def stop():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(timeout, stop)
    timer.start()
    turns = 0
    text = []
    try:
        for line in proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                text.append(line)  # not an event: an error printed as plain text
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "assistant":
                turns += 1
                on_turn(turns)
                for block in (event.get("message") or {}).get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text.append(block.get("text", "") + "\n")
            elif event.get("type") == "result" and event.get("is_error"):
                text.append(f"{event.get('result') or event.get('subtype')}\n")
        code = proc.wait()
    except BaseException:
        # on_turn raised (the fix was canceled) or the runner is stopping:
        # don't leave Claude working on a job nobody is waiting for.
        proc.kill()
        raise
    finally:
        timer.cancel()
    out = "".join(text)
    if timed_out.is_set():
        return 124, f"{out}\n[timed out after {timeout}s]"
    return code, out


def changed_files(worktree):
    """The change as the callback wants it: path + base64 content, or deleted."""
    files = []

    def add_write(path):
        with open(worktree / path, "rb") as fh:
            files.append(
                {"path": path, "content": base64.b64encode(fh.read()).decode()}
            )

    listing = git("diff", "--name-status", "-M", "origin/main...HEAD", cwd=worktree)
    for line in listing.splitlines():
        parts = line.split("\t")
        status = parts[0]
        if status.startswith("R"):  # rename: delete old, add new
            files.append({"path": parts[1], "deleted": True})
            add_write(parts[2])
        elif status.startswith("D"):
            files.append({"path": parts[1], "deleted": True})
        else:  # A / M / C: current content
            add_write(parts[1])
    return files


def checks_for(paths):
    """The checks to run, by which areas the change touched."""
    checks = []
    if any(p.startswith("backend/") or p.startswith("infra/postgres/") for p in paths):
        checks += [
            ("backend", ["cargo", "fmt", "--all", "--", "--check"]),
            ("backend", ["cargo", "clippy", "--", "-D", "warnings"]),
        ]
        if DB_TESTS:
            checks.append(
                (
                    "backend",
                    ["cargo", "test", "--no-fail-fast", "--", "--test-threads=1"],
                )
            )
    if any(p.startswith("frontend/") for p in paths):
        checks += [
            ("frontend", ["npx", "tsc", "--noEmit"]),
            ("frontend", ["npm", "test"]),
        ]
    return checks


def prompt_for(job, branch):
    label = "User story" if job["kind"] == "story" else "Ticket"
    return f"""Use the /fix-ticket skill to implement and verify this {label.lower()}.

{label} #{job['id']}: {job['title']}

Description:
{job['description']}

You are running on the developer's machine, in a dedicated git worktree on the
branch `{branch}`, cut from the latest origin/main. Work only inside this
directory. Commit your change on this branch as the skill describes. Do not
push and do not open a pull request: the runner does both after it has re-run
the checks itself.
"""


def prepare_worktree(job):
    """Fetch the latest main and cut a fresh worktree + branch from it."""
    git("fetch", "origin", "main", cwd=REPO)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    branch = f"ai-fix/{job['kind']}-{job['id']}-{stamp}"
    worktree = WORKDIR / "worktrees" / f"{job['kind']}-{job['id']}-{stamp}"
    worktree.parent.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "origin/main", cwd=REPO)

    # The worktree has no installed frontend dependencies. Reuse the main
    # checkout's when they exist; otherwise install them.
    frontend = worktree / "frontend"
    main_modules = REPO / "frontend" / "node_modules"
    if frontend.is_dir() and not (frontend / "node_modules").exists():
        if main_modules.is_dir():
            os.symlink(main_modules, frontend / "node_modules")
        else:
            log("installing frontend dependencies (npm ci)")
            code, out = run(["npm", "ci"], frontend, timeout=CHECK_TIMEOUT)
            if code != 0:
                raise JobError(f"npm ci failed:\n{out[-LOG_TAIL:]}")
    return branch, worktree


def run_job(job):
    """Run one job to its end. Returns the worktree to remove, or None to keep."""
    log(f"claimed {job['kind']} #{job['id']}: {job['title']}")
    progress(job, P_CLAIMED, "Preparing a branch from the latest main")
    branch, worktree = prepare_worktree(job)
    log(f"worktree {worktree} on {branch}")

    # One cargo target for every run, so only the first build is cold.
    env = dict(os.environ, CARGO_TARGET_DIR=str(WORKDIR / "cargo-target"))

    cmd = [
        "claude",
        "-p",
        prompt_for(job, branch),
        "--allowedTools",
        ALLOWED_TOOLS,
        "--max-turns",
        MAX_TURNS,
        # One JSON event per line, so the turns can be counted as they happen.
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if MODEL:
        cmd += ["--model", MODEL]
    log("running Claude Code")
    progress(job, P_CLAUDE, "Claude is reading the code")

    max_turns = max(int(MAX_TURNS), 1)
    last = {"percent": P_CLAUDE, "at": 0.0}

    def on_turn(turn):
        span = P_CHECKS - P_CLAUDE
        percent = P_CLAUDE + span * min(turn, max_turns) // max_turns
        # At most one report every few seconds. A turn that doesn't move the
        # number still reports, because the reply is where a cancel is heard.
        if percent >= last["percent"] and time.monotonic() - last["at"] >= 3:
            last.update(percent=percent, at=time.monotonic())
            progress(job, percent, f"Claude is working (turn {turn} of up to {max_turns})")

    claude_code, claude_out = run_claude(cmd, worktree, env, CLAUDE_TIMEOUT, on_turn)

    commits = git("rev-list", "--count", "origin/main..HEAD", cwd=worktree).strip()
    if commits in ("", "0"):
        dirty = git("status", "--porcelain", cwd=worktree).strip()
        if claude_code == 0 and not dirty:
            report(job, {"status": "no_change"})
            return worktree
        reason = (
            "Claude left changes uncommitted, so there is nothing to check or push."
            if dirty
            else f"Claude Code exited with code {claude_code} and made no commit."
        )
        raise JobError(f"{reason}\n\n{claude_out[-LOG_TAIL:]}")

    paths = git(
        "diff", "--name-only", "origin/main...HEAD", cwd=worktree
    ).splitlines()
    passed = []
    checks = checks_for(paths)
    for index, (area, check) in enumerate(checks):
        name = " ".join(check)
        log(f"check ({area}): {name}")
        progress(
            job,
            P_CHECKS + (P_COLLECT - P_CHECKS) * index // len(checks),
            f"Checking: {name}",
        )
        code, out = run(check, worktree / area, timeout=CHECK_TIMEOUT, env=env)
        if code != 0:
            raise JobError(
                f"Local check failed, so nothing was pushed: {name} (in {area}/)\n\n"
                f"{out[-LOG_TAIL:]}"
            )
        passed.append(f"{name} (in {area}/)")

    progress(job, P_COLLECT, "Checks passed; collecting the change")
    base_sha = git("rev-parse", "origin/main", cwd=worktree).strip()
    commit_sha = git("rev-parse", "HEAD", cwd=worktree).strip()
    diff = git("diff", "origin/main...HEAD", cwd=worktree)
    files = changed_files(worktree)

    log("checks passed; pushing and opening the pull request")
    progress(job, P_PUSH, "Pushing the branch")
    git("push", "-u", "origin", branch, cwd=worktree)
    progress(job, P_PR, "Opening the pull request")

    label = "User story" if job["kind"] == "story" else "Ticket"
    title = git("log", "-1", "--format=%s", cwd=worktree).strip()
    checks_text = (
        "\n".join(f"- `{c}`" for c in passed)
        if passed
        else "- None: the change touched neither `backend/` nor `frontend/`."
    )
    body = (
        f"{label} #{job['id']}: {job['title']}\n\n"
        f"{job['description'].strip()}\n\n"
        "## Local checks passed\n"
        f"{checks_text}\n\n"
        "Opened automatically by the local AI-fix runner once these passed on "
        "the developer's machine. CI was not waited on.\n"
    )
    code, out = run(
        [
            "gh", "pr", "create",
            "--base", "main",
            "--head", branch,
            "--title", title,
            "--body", body,
        ],
        worktree,
        timeout=120,
    )
    if code != 0:
        raise JobError(
            f"The branch {branch} was pushed, but opening the pull request "
            f"failed:\n{out[-LOG_TAIL:]}"
        )
    pr_url = next(
        (line.strip() for line in reversed(out.splitlines()) if "/pull/" in line),
        out.strip(),
    )
    report(
        job,
        {
            "status": "pr_opened",
            "diff": diff,
            "base_sha": base_sha,
            "files": files,
            "pr_url": pr_url,
            "branch": branch,
            "commit_sha": commit_sha,
        },
    )
    log(f"pull request opened: {pr_url}")
    return worktree


def handle(job):
    worktree = None
    try:
        worktree = run_job(job)
    except JobCanceled:
        # Nothing to report: the item already shows it as canceled, and the
        # server would ignore a result for it anyway.
        log(f"{job['kind']} #{job['id']} was canceled in the app; stopped")
    except JobError as exc:
        log(f"job failed: {str(exc).splitlines()[0]}")
        report(job, {"status": "error", "diff": str(exc)})
    except KeyboardInterrupt:
        report(job, {"status": "error", "diff": "The local runner was stopped mid-run."})
        raise
    except Exception as exc:  # noqa: BLE001 - report anything, keep the loop alive
        log(f"job crashed: {exc!r}")
        report(job, {"status": "error", "diff": f"The local runner crashed: {exc!r}"})
    if worktree is not None:
        # Finished cleanly (PR opened or nothing to do): the worktree has served
        # its purpose. A failed job's worktree is kept for a look.
        run(["git", "worktree", "remove", "--force", str(worktree)], REPO)


def preflight():
    if not RUNNER_TOKEN and not API_KEY:
        sys.exit(
            "Set AI_FIX_RUNNER_TOKEN (the same value the backend has), or "
            "WAYVE_API_KEY. See the top of this file."
        )
    missing = [t for t in ("git", "claude", "gh", "cargo", "npx") if not shutil.which(t)]
    if missing:
        sys.exit(f"Missing required tools on PATH: {', '.join(missing)}")

def claim():
    try:
        return api("POST", "/api/workspace-tickets/ai-fix-local/claim").get("job")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            sys.exit(
                "The backend is not in local runner mode. Start it with "
                "AI_FIX_RUNNER=local."
            )
        if exc.code in (401, 403):
            sys.exit(
                f"The backend refused the claim ({exc.code}). AI_FIX_RUNNER_TOKEN "
                "must match the backend's (at least 16 characters); a "
                "WAYVE_API_KEY must be an internal key whose user is platform "
                "staff with tickets:manage."
            )
        log(f"claim failed ({exc.code}); retrying")
    except OSError as exc:
        log(f"backend unreachable ({exc}); retrying")
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--once", action="store_true", help="run at most one job, then exit"
    )
    args = parser.parse_args()
    preflight()
    log(f"watching {BASE_URL} for queued fixes (repo {REPO})")
    try:
        while True:
            job = claim()
            if job:
                handle(job)
                if args.once:
                    return
            elif args.once:
                log("nothing queued")
                return
            else:
                time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        log("stopped")


if __name__ == "__main__":
    main()

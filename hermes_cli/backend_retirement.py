"""Process-owned admission fence for cooperative Desktop backend retirement.

The gate belongs to the process, not a profile or transport. Diagnostic ledgers alone cannot
close the check/use race: every source of new work must reserve admission before dispatch.
"""

from contextlib import contextmanager
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time


def live_kanban_runs(parent_pid=None):
    """Read the canonical boards' live runs owned by this process tree, without mutations.

    ``parent_pid`` lets external diagnostics ask about a gateway rather than their own CLI.
    Board pins and worker fingerprints remain owned by Kanban, not the retirement policy.
    """
    import psutil
    from hermes_cli.kanban_db import get_current_board, list_boards, pin_first_board_resolution
    from hermes_cli.kanban_db_dispatch import live_worker_runs

    parent_pid = os.getpid() if parent_pid is None else parent_pid
    runs, paths = [], set()
    with pin_first_board_resolution():
        boards = list_boards()
        current = get_current_board()
    # A pinned DB can appear under every slug. Attribute it to the canonical active board.
    boards.sort(key=lambda board: board["slug"] != current)
    for board in boards:
        path = Path(board["db_path"]).resolve()
        if path in paths or not path.exists():
            continue
        paths.add(path)
        conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
        conn.row_factory = sqlite3.Row
        try:
            candidates = live_worker_runs(conn)
        finally:
            conn.close()
        for run in candidates:
            try:
                if parent_pid not in {p.pid for p in psutil.Process(run["worker_pid"]).parents()}:
                    continue
            except psutil.NoSuchProcess:
                continue
            runs.append({**run, "board": board["slug"]})
    return runs


class RetirementFence:
    """Exclusive 30-second prepare permit; commit closes admission permanently.

    Tokens are random and recognized only by this process instance. A committed prepare
    returns the same token so a client can recover a lost commit response without reopening.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active = 0
        self._preparing = False
        self._token = None
        self._committed = False
        self._expires_at = 0.0
        self._now = time.monotonic
        self._worker_deferred_at = {}

    def _expire(self):
        if self._token is not None and not self._committed and self._now() >= self._expires_at:
            self._token = None

    def acquire(self):
        with self._lock:
            self._expire()
            if self._preparing or self._token is not None:
                return False
            self._active += 1
            return True

    def release(self):
        with self._lock:
            self._active -= 1

    def active_count(self):
        with self._lock:
            return self._active

    @contextmanager
    def work(self):
        admitted = self.acquire()
        try:
            yield admitted
        finally:
            if admitted:
                self.release()

    def reset_worker_deferral(self, *, reason="cooperative"):
        """A withdrawn retirement reason ends its continuous worker grace period."""
        with self._lock:
            self._worker_deferred_at.pop(reason, None)

    def prepare(self, *, reason="cooperative"):
        from hermes_cli.web_server_idle_proof import idle_proof

        with self._lock:
            self._expire()
            if self._committed:
                return {"ok": True, "idle": True, "token": self._token}
            if self._preparing or self._token is not None or self._active:
                return {"ok": False, "idle": False}
            self._preparing = True
        # No admissions can cross the freeze. Do not hold our lock while reading ledgers:
        # some callers already hold a session/cron lock when reserving their work.
        verdict = None
        try:
            proof = idle_proof()
            verdict = proof["idle"]
            if proof.get("reason") == "live_kanban_runs":
                with self._lock:
                    started = self._worker_deferred_at.setdefault(reason, self._now())
                    elapsed = self._now() - started
                limit = proof["max_runtime_seconds"]
                if elapsed >= limit:
                    logging.getLogger(__name__).warning(
                        "retiring after %.0fs worker deferral limit: %s live kanban runs",
                        limit, proof["live_kanban_runs"])
                    verdict = True
                else:
                    logging.getLogger(__name__).warning(
                        "deferring retirement: %s live kanban runs", proof["live_kanban_runs"])
            else:
                self.reset_worker_deferral(reason=reason)
        except Exception:
            logging.getLogger(__name__).warning("Retirement idle probe unavailable", exc_info=True)
        finally:
            with self._lock:
                self._preparing = False
                if verdict is True:
                    self._token = token = secrets.token_urlsafe(32)
                    self._expires_at = self._now() + 30.0
        if verdict is not True:
            return {"ok": False, "idle": verdict}
        return {"ok": True, "idle": True, "token": token}

    def commit(self, token):
        with self._lock:
            self._expire()
            if not token or token != self._token:
                return {"ok": False}
            self._committed = True
            return {"ok": True}

    def cancel(self, token):
        with self._lock:
            self._expire()
            if not token or token != self._token or self._committed:
                return {"ok": False}
            self._token = None
            return {"ok": True}


retirement = RetirementFence()

"""Retirement protects real descendant runs, not task status or stale PID rows."""

from concurrent.futures import ThreadPoolExecutor
import logging
import sqlite3
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("reason", ["skew", "idle"])
@pytest.mark.parametrize("finish", ["complete", "dead", "recycled"])
def test_watchdogs_wait_for_live_descendants_then_retire(tmp_path, monkeypatch, caplog, reason, finish):
    from hermes_cli import backend_retirement as br, kanban_db as kb, kanban_db_connect as db, kanban_db_dispatch as dispatch
    from hermes_cli.web_server_idle_exit import IdleClientTracker, start_idle_watchdog
    from hermes_cli.web_server_skew_exit import start_code_skew_watchdog

    monkeypatch.setenv("HERMES_KANBAN_HOME", str(tmp_path / "boards"))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    kb.create_board("scratch")
    conn = db.connect(board="scratch")
    task = kb.create_task(conn, title="retirement scratch", assignee="worker", initial_status="running",
                          completion_contract="local-only", max_runtime_seconds=60)
    kb.recompute_ready(conn)
    assert kb.claim_task(conn, task)
    run_id = conn.execute("SELECT current_run_id FROM tasks WHERE id = ?", (task,)).fetchone()[0]
    worker = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
    fence = br.RetirementFence()
    monkeypatch.setattr(br, "retirement", fence)
    caplog.set_level(logging.WARNING)
    server = SimpleNamespace(should_exit=False)

    def poll():
        if reason == "skew":
            return start_code_skew_watchdog(server, skew_fn=lambda: ("boot", "new"),
                                            update_probe=lambda: False, fence=fence,
                                            poll_s=0.001, max_polls=4)
        return start_idle_watchdog(server, IdleClientTracker(now=lambda: 0), grace_s=0,
                                   poll_s=0.001, fence=fence, max_polls=4)

    try:
        dispatch._set_worker_pid(conn, task, worker.pid)
        # An explicit DB pin can be outside the registry. Its original row must not
        # accidentally satisfy the descendant assertion when that pin is missed.
        external = tmp_path / "external.db"
        pinned = sqlite3.connect(external)
        pinned.row_factory = sqlite3.Row
        conn.backup(pinned)
        conn.execute("UPDATE task_runs SET worker_pid = NULL WHERE task_id = ?", (task,))
        conn.commit()
        conn.close()
        conn = pinned
        monkeypatch.setenv("HERMES_KANBAN_DB", str(external))
        # The shared board does not change with the active profile (A -> B -> A).
        for home in (tmp_path / "A", tmp_path / "B", tmp_path / "A"):
            monkeypatch.setenv("HERMES_HOME", str(home))
            assert [r["task_id"] for r in br.live_kanban_runs()] == [task]
        assert br.live_kanban_runs(parent_pid=worker.pid) == []  # not this worker's descendant
        poll().join(10)
        assert server.should_exit is False
        assert "deferring retirement: 1 live kanban runs" in caplog.text
        with fence.work() as admitted:
            assert admitted  # deferral did not strand admission
        if finish == "complete":
            assert kb.complete_task(conn, task, summary="scratch done", expected_run_id=run_id,
                                    fire_lifecycle_hook=False)
            assert worker.poll() is None  # ended run is excluded even before child exits
        elif finish == "dead":
            worker.communicate(timeout=10)  # unended row is a dead-PID zombie, not a live run
        else:
            conn.execute("UPDATE task_runs SET worker_started_at = ? WHERE task_id = ?",
                         ("foreign-boot|1", task))
            conn.commit()
        assert br.live_kanban_runs() == []
        poll().join(10)
        assert server.should_exit is True
        with fence.work() as admitted:
            assert not admitted  # committed before the server retires
    finally:
        if worker.poll() is None:
            worker.communicate(timeout=10)
        conn.close()


@pytest.mark.parametrize("runtime", [None, 30])
def test_worker_grace_is_bounded_but_dispatch_and_other_work_stay_fenced(tmp_path, monkeypatch, caplog, runtime):
    from hermes_cli import backend_retirement as br, kanban_db_connect as db, kanban_db_dispatch as dispatch
    from hermes_cli import web_server_idle_proof as proof

    monkeypatch.setenv("HERMES_KANBAN_HOME", str(tmp_path / "boards"))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    fence = br.RetirementFence()
    monkeypatch.setattr(br, "retirement", fence)
    now = [0.0]
    monkeypatch.setattr(fence, "_now", lambda: now[0])
    conn = db.connect()
    entered, release = threading.Event(), threading.Event()

    def tick(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return dispatch.DispatchResult()

    monkeypatch.setattr(dispatch, "_dispatch_once_locked", tick)
    # A tick with no PID yet still owns admission through its claim/spawn handoff.
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(dispatch.dispatch_once, conn)
        try:
            assert entered.wait(10)
            assert fence.prepare() == {"ok": False, "idle": False}
        finally:
            release.set()
        future.result(10)
    original = proof.idle_proof
    runs = [{"max_runtime_seconds": runtime}]
    pending = [0]
    monkeypatch.setattr(proof, "idle_proof", lambda: original(
        turn_probe=lambda: False, input_probe=lambda: pending[0], worker_probe=lambda: runs))
    caplog.set_level(logging.WARNING)
    assert not fence.prepare()["ok"]
    limit = runtime or 7200
    now[0] = limit - 1
    assert not fence.prepare()["ok"]
    fence.reset_worker_deferral()
    assert not fence.prepare()["ok"]
    now[0] += limit - 1
    assert not fence.prepare()["ok"]  # reason withdrawal restarted the grace period
    now[0] += 1
    pending[0] = 1
    assert not fence.prepare()["ok"]  # worker timeout cannot bypass human input
    pending[0] = 0
    assert not fence.prepare()["ok"]  # other busy work ended the continuous worker delay
    now[0] += limit
    # A connected idle watchdog cannot reset the stale-code watchdog's grace forever.
    fence.reset_worker_deferral(reason="other-watchdog")
    permit = fence.prepare()
    assert permit["ok"] and fence.commit(permit["token"])["ok"]
    assert "worker deferral limit" in caplog.text
    entered.clear()
    dispatch.dispatch_once(conn)
    assert not entered.is_set()  # a late dispatcher cannot create new children after prepare
    conn.close()

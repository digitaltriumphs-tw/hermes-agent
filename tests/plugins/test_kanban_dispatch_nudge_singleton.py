"""The dashboard ``POST /dispatch`` nudge must not become a second dispatcher.

The desktop app nudges after every board edit. When a gateway already holds the machine-wide
``.dispatcher.lock`` (the sole-dispatcher owner), a nudge that ran ``dispatch_once`` in the
dashboard process claimed tasks under a second ``host:pid`` and swept the gateway's workers with
its own liveness view, crashing live workers.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gateway.kanban_watchers_common import _acquire_singleton_lock, _release_singleton_lock, dispatcher_lock_path
from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd


def _load_plugin_module():
    plugin_file = Path(__file__).resolve().parents[2] / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_kanban_nudge_test", plugin_file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def client(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    app = FastAPI()
    app.include_router(_load_plugin_module().router, prefix="/api/plugins/kanban")
    return TestClient(app)


def test_nudge_does_not_dispatch_while_another_process_owns_the_dispatcher(client, monkeypatch):
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="ready job", assignee="worker")
    calls = []
    monkeypatch.setattr(kbd, "dispatch_once", lambda *a, **k: calls.append(1))
    owner, state = _acquire_singleton_lock(dispatcher_lock_path())
    assert state == "held"
    try:
        r = client.post("/api/plugins/kanban/dispatch")
    finally:
        _release_singleton_lock(owner)
    assert r.status_code == 200
    assert r.json()["spawned"] == [] and r.json()["skipped_dispatcher_owned"] is True
    assert calls == []
    with kbc.connect_closing() as conn:
        task = kb.get_task(conn, tid)
    assert task.status == "ready" and task.claim_lock is None


def test_nudge_dispatches_when_nobody_owns_the_dispatcher_and_releases_the_lock(client, monkeypatch):
    calls = []

    def fake_dispatch_once(conn, **kwargs):
        calls.append(kwargs)
        # The nudge holds the singleton for the tick: a rival cannot dispatch concurrently.
        rival, rival_state = _acquire_singleton_lock(dispatcher_lock_path())
        assert rival_state == "contended"
        return kbd.DispatchResult()

    monkeypatch.setattr(kbd, "dispatch_once", fake_dispatch_once)
    r = client.post("/api/plugins/kanban/dispatch")
    assert r.status_code == 200 and len(calls) == 1
    again, state = _acquire_singleton_lock(dispatcher_lock_path())
    assert state == "held"  # released after the tick
    _release_singleton_lock(again)


def test_dry_run_nudge_also_yields_to_the_dispatcher_owner(client):
    """dry_run still reclaims/promotes inside dispatch_once, so it is not exempt from the singleton."""
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="running job", assignee="worker")
        conn.execute("UPDATE tasks SET status='running', claim_lock='gateway:1', claim_expires=1 WHERE id=?", (tid,))
        conn.commit()
    owner, state = _acquire_singleton_lock(dispatcher_lock_path())
    assert state == "held"
    try:
        r = client.post("/api/plugins/kanban/dispatch?dry_run=true")
    finally:
        _release_singleton_lock(owner)
    assert r.status_code == 200 and r.json()["skipped_dispatcher_owned"] is True
    with kbc.connect_closing() as conn:
        task = kb.get_task(conn, tid)
    assert task.status == "running" and task.claim_lock == "gateway:1"


def test_dry_run_nudge_dispatches_when_nobody_owns_the_dispatcher(client, monkeypatch):
    calls = []
    monkeypatch.setattr(kbd, "dispatch_once", lambda conn, **k: calls.append(k) or kbd.DispatchResult())
    r = client.post("/api/plugins/kanban/dispatch?dry_run=true")
    assert r.status_code == 200 and len(calls) == 1 and calls[0]["dry_run"] is True

"""A Desktop-owned ``serve --isolated`` backend over SSH must retire itself once no client has been
connected for the grace window and no turn is running (#101626): it is detached from any parent on
purpose, so the client count IS its liveness signal."""

from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient

import hermes_cli.web_server as ws_mod
from hermes_cli.web_server_idle_exit import (
    IdleClientTracker, start_idle_watchdog, wrap_asgi_with_ws_tracking)


def test_ws_sessions_are_counted_at_the_asgi_boundary_for_any_route():
    app = FastAPI()

    @app.websocket("/api/anything")
    async def anything(ws: WebSocket):
        await ws.accept()
        await ws.receive_text()
        await ws.close()

    @app.websocket("/api/refused")
    async def refused(ws: WebSocket):
        await ws.close(code=4401)  # never accepted: must not count

    tracker = IdleClientTracker(now=lambda: 0.0)
    client = TestClient(wrap_asgi_with_ws_tracking(app, tracker))
    with client.websocket_connect("/api/anything") as a:
        with client.websocket_connect("/api/anything") as b:
            assert tracker.live_count() == 2
            b.send_text("bye")
        assert tracker.live_count() == 1
        a.send_text("bye")
    assert tracker.live_count() == 0
    try:
        with client.websocket_connect("/api/refused"):
            pass
    except Exception:
        pass
    assert tracker.live_count() == 0  # a refused (never accepted) upgrade is not a client


def test_exit_only_after_grace_with_no_client_and_fence_permission():
    from hermes_cli.backend_retirement import RetirementFence
    from types import SimpleNamespace

    clock = {"t": 0.0}
    tracker = IdleClientTracker(now=lambda: clock["t"])
    grace = 900.0

    def exits(fence=None):
        server = SimpleNamespace(should_exit=False)
        start_idle_watchdog(server, tracker, grace_s=grace, poll_s=0.001,
                            fence=fence or RetirementFence(), max_polls=3).join(5)
        return server.should_exit

    assert exits() is False
    clock["t"] = 901.0
    assert exits() is True
    busy = RetirementFence()
    with busy.work() as admitted:
        assert admitted
        assert exits(busy) is False
    tracker.on_open()
    clock["t"] = 5000.0
    assert exits() is False
    tracker.on_close()
    assert exits() is False
    clock["t"] = 5000.0 + grace + 1
    assert exits() is True


def test_watchdog_sets_should_exit_and_only_arms_for_ssh_isolated_backends(monkeypatch):
    class _Server:
        should_exit = False

    server = _Server()
    clock = iter([0.0, 0.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0])
    tracker = IdleClientTracker(now=lambda: next(clock, 10_000.0))
    from hermes_cli.backend_retirement import RetirementFence
    start_idle_watchdog(server, tracker, grace_s=1.0, poll_s=0.01, fence=RetirementFence()).join(timeout=5)
    assert server.should_exit is True

    # The uvicorn builder wraps the app + arms tunnel pings ONLY when a session token was handed over.
    monkeypatch.setattr(ws_mod.app.state, "auth_required", False, raising=False)
    plain, _ = ws_mod._build_uvicorn_server("127.0.0.1", 0)
    assert plain.ws_ping_interval is None and getattr(ws_mod.app.state, "ssh_isolated_clients", None) is None
    try:
        isolated, _ = ws_mod._build_uvicorn_server("127.0.0.1", 0, ssh_isolated=True)
        assert isolated.ws_ping_interval and isolated.ws_ping_timeout > isolated.ws_ping_interval
        assert isinstance(ws_mod.app.state.ssh_isolated_clients, IdleClientTracker)
    finally:
        ws_mod.app.state._state.pop("ssh_isolated_clients", None)  # process-global app: never leak the tracker


def test_turn_probe_counts_in_flight_cron_execution():
    """#107485: a cron job mid-run must keep the SSH-isolated backend alive; the run lives outside
    the dashboard session table, in the scheduler's running-job ledger."""
    import cron.scheduler as scheduler
    from hermes_cli.web_server_idle_exit import turn_in_flight

    assert turn_in_flight() is False
    with scheduler._running_lock:
        scheduler._running_job_ids.add("idle-exit-probe-job")
    try:
        assert turn_in_flight() is True
    finally:
        with scheduler._running_lock:
            scheduler._running_job_ids.discard("idle-exit-probe-job")

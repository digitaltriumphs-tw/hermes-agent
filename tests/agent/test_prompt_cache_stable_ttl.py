"""Cron fixed prefix uses the owner's 1h tier; variable output stays session-tier."""

import copy
from collections import OrderedDict
import pytest
import agent.prompt_cache_boundary as boundary
from agent.prompt_caching import build_prompt_cache_plan, effective_cache_ttl, _count_cache_markers

PREFIX = "skill scaffold\ncron wrapper\n"


@pytest.fixture(autouse=True)
def isolated_boundary(monkeypatch):
    monkeypatch.setattr(boundary, "_prefixes", OrderedDict())
    boundary.register_stable_prefix(PREFIX)


@pytest.mark.parametrize("source", ["cli", "cron", "subagent", "kanban", "api", None])
def test_owner_resolves_fixed_ttl_without_changing_other_defaults(source):
    assert effective_cache_ttl("5m", source=source, stable_prefix=True) == (
        "1h" if source == "cron" else "5m")
    assert effective_cache_ttl("5m", source=source) == "5m"
    assert effective_cache_ttl("1h", source=source) == "1h"


def test_existing_route_clamp_also_applies_to_cron_prefix():
    assert effective_cache_ttl("5m", source="cron", stable_prefix=True,
                               provider="alibaba", model="qwen") == "5m"


@pytest.mark.parametrize("tool_cache", [False, True])
@pytest.mark.parametrize("grow", [False, True])
def test_cron_tiers_roundtrip_idempotency_and_marker_budget(tool_cache, grow):
    messages = [{"role": "system", "content": "static\ncontext"},
                {"role": "user", "content": PREFIX + "Script Output\n你好 😀\n"}]
    if grow:
        messages += [{"role": "assistant", "content": "reply"},
                     {"role": "user", "content": "follow-up"}]
    original = copy.deepcopy(messages)
    tools = [{"type": "function", "function": {"name": "read", "parameters": {}}}]
    kwargs = dict(cache_ttl="5m", stable_cache_ttl=effective_cache_ttl(
        "5m", source="cron", stable_prefix=True), native_anthropic=True,
        static_system_prefix="static", direct_native_tool_cache=tool_cache)
    p1 = build_prompt_cache_plan(messages, tools, **kwargs)
    p2 = build_prompt_cache_plan(p1.messages, p1.tools, **kwargs)
    assert p1 == p2
    assert messages == original
    for before, after in zip(original, p1.messages):
        content = after["content"]
        assert (content if isinstance(content, str) else "".join(p["text"] for p in content)) == before["content"]
    assert p1.messages[1]["content"][0]["cache_control"]["ttl"] == "1h"
    assert _count_cache_markers(p1.messages, p1.tools) <= 4
    # Anthropic reads tools before system before messages: long-lived first.
    ttls = [t["cache_control"].get("ttl", "5m") for t in p1.tools if "cache_control" in t]
    for msg in p1.messages:
        for part in msg["content"] if isinstance(msg["content"], list) else []:
            if "cache_control" in part:
                ttls.append(part["cache_control"].get("ttl", "5m"))
    assert "1h" in ttls and "5m" in ttls
    assert ttls == sorted(ttls, key=lambda ttl: ttl != "1h")
    if not grow:
        assert p1.messages[1]["content"][1]["cache_control"] == {"type": "ephemeral"}


def test_existing_builder_declares_hint_without_changing_prompt(monkeypatch):
    from cron import scheduler_prompt as builder
    monkeypatch.setattr(builder, "_load_cron_skill_parts", lambda job, names: ["SKILL BODY"])
    monkeypatch.setattr(builder, "_scan_assembled_cron_prompt", lambda prompt, *args, **kw: prompt)
    job = {"id": "example", "prompt": "Act now", "skills": ["example"], "script": "unused"}
    first = builder._build_job_prompt(job, prerun_script=(True, "output A"))
    second = builder._build_job_prompt(job, prerun_script=(True, "output B"))
    from agent.skill_commands import append_user_instruction
    parts = ["SKILL BODY", ""]
    append_user_instruction(parts, builder._CRON_HINT + builder._prepend_context_block(
        "Act now", "Script Output", "The following data was collected by a pre-run script. Use it as context for your analysis.", "output A"))
    assert first == "\n".join(parts)
    prefix = boundary.find_stable_prefix(first)
    assert prefix is not None and prefix.endswith(builder._CRON_HINT)
    assert boundary.find_stable_prefix(second) == prefix
    assert "output A" not in prefix


@pytest.mark.parametrize("source,native,expected", [
    ("cron", True, "1h"), ("cli", True, "5m"), ("cron", False, "5m"),
])
def test_production_assembly_and_native_wire_keep_prefix_on_call_two(
    source, native, expected, monkeypatch, tmp_path,
):
    from tests.agent.test_anthropic_preserved_thinking_replay import (
        _agent, _assemble_and_wire, _patch_assembly_loop, _session_db,
    )
    _patch_assembly_loop(monkeypatch)
    monkeypatch.delenv("HERMES_SESSION_SOURCE", raising=False)
    monkeypatch.delenv("HERMES_SINGLE_QUERY_SESSION", raising=False)
    db = _session_db(tmp_path, "s1")
    agent = _agent(db)
    agent.platform = source
    agent._use_prompt_caching = True
    agent._use_native_cache_layout = native
    agent._cache_ttl = "5m"
    agent._direct_native_anthropic_tool_cache_capability = lambda: False
    first = [{"role": "user", "content": PREFIX + "output A"}]
    second = first + [{"role": "assistant", "content": "reply"},
                      {"role": "user", "content": "follow-up"}]
    try:
        _, wire1 = _assemble_and_wire(agent, first)
        _, wire2 = _assemble_and_wire(agent, second)
        p1, p2 = wire1[0]["content"], wire2[0]["content"]
        assert [p["text"] for p in p1] == [p["text"] for p in p2]
        assert "".join(p["text"] for p in p1) == first[0]["content"]
        assert p1[0]["cache_control"].get("ttl", "5m") == expected
        assert p1[0]["cache_control"] == p2[0]["cache_control"]
    finally:
        db.close()

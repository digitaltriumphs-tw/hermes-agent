"""A declared scaffold must retain its block shape across growing requests."""

import copy
import pytest
import agent.prompt_cache_boundary as boundary
from agent.prompt_caching import build_prompt_cache_plan, _count_cache_markers

SYSTEM = "static\ncontext"
PREFIX = "skill scaffold\n"


@pytest.fixture(autouse=True)
def isolated_boundary(monkeypatch):
    from collections import OrderedDict
    monkeypatch.setattr(boundary, "_prefixes", OrderedDict())
    boundary.register_stable_prefix(PREFIX)


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("tool_cache", [False, True])
def test_first_request_blocks_survive_second_request(native, tool_cache):
    first = [{"role": "system", "content": SYSTEM},
             {"role": "user", "content": PREFIX + "changing output"}]
    second = first + [{"role": "assistant", "content": "reply"},
                      {"role": "user", "content": "follow-up"}]
    tools = [{"type": "function", "function": {"name": "read", "parameters": {}}}]
    kwargs = dict(native_anthropic=native, static_system_prefix="static",
                  direct_native_tool_cache=tool_cache)
    p1 = build_prompt_cache_plan(first, tools, **kwargs)
    p2 = build_prompt_cache_plan(second, tools, **kwargs)
    # Compare actual block boundaries, not a fictional cache simulator: Anthropic's
    # lookback cannot find a prefix whose text blocks have changed shape.
    assert isinstance(p2.messages[1]["content"], list)
    assert [p["text"] for p in p1.messages[1]["content"]] == [
        p["text"] for p in p2.messages[1]["content"]]
    assert p1.messages[1]["content"][0]["cache_control"] == p2.messages[1]["content"][0]["cache_control"]
    assert _count_cache_markers(p2.messages, p2.tools) <= 4
    assert first == [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": PREFIX + "changing output"}]


def test_plain_messages_retain_legacy_layout():
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": "ordinary"},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "follow-up"}]
    plan = build_prompt_cache_plan(copy.deepcopy(messages), [], static_system_prefix="static")
    assert plan.messages[1]["content"] == "ordinary"
    assert "cache_control" in plan.messages[2]["content"][-1]
    assert "cache_control" in plan.messages[3]["content"][-1]

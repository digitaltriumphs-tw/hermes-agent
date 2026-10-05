"""A declared scaffold must retain its block shape across growing requests."""

import copy
import pytest
from agent.prompt_cache_boundary import register_stable_prefix
from agent.prompt_caching import build_prompt_cache_plan

SYSTEM = "static\ncontext"
PREFIX = "skill scaffold\n"


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("tool_cache", [False, True])
def test_first_request_blocks_survive_second_request(native, tool_cache):
    # Registration is idempotent; the canonical runner isolates this test file
    # in its own process. Use the public builder contract, not registry internals.
    register_stable_prefix(PREFIX)
    first = [{"role": "system", "content": SYSTEM},
             {"role": "user", "content": PREFIX + "Script Output\n你好 😀\r\n"}]
    # Call #2 follows a tool round, not another human turn. Only the last-N
    # marker selection moves: the transcript must keep every message and byte.
    second = first + [{"role": "assistant", "content": "inspect", "tool_calls": [
        {"id": "read-1", "type": "function", "function": {"name": "read", "arguments": "{}"}},
    ]}, {"role": "tool", "tool_call_id": "read-1", "content": "result"}]
    original = copy.deepcopy(second)
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
    for plan, transcript in [(p1, original[:2]), (p2, original)]:
        assert len(plan.messages) == len(transcript)
        for before, after in zip(transcript, plan.messages):
            assert isinstance(before["content"], str)
            content = after["content"]
            text = content if isinstance(content, str) else "".join(p["text"] for p in content)
            assert text.encode("utf-8") == before["content"].encode("utf-8")
        marked_items = list(plan.messages) + plan.tools + [
            part for msg in plan.messages if isinstance(msg.get("content"), list)
            for part in msg["content"]
        ]
        assert sum("cache_control" in item for item in marked_items) <= 4
    assert second == original


def test_plain_messages_retain_legacy_layout():
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": "ordinary"},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "follow-up"}]
    plan = build_prompt_cache_plan(copy.deepcopy(messages), [], static_system_prefix="static")
    assert plan.messages[1]["content"] == "ordinary"
    assert "cache_control" in plan.messages[2]["content"][-1]
    assert "cache_control" in plan.messages[3]["content"][-1]

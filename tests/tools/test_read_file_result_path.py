"""read_file results name the path they answer for, success and refusal alike.

When several reads run in one tool batch (or a refusal is relayed), the model must be able to
tell which file an error belongs to without matching it back by position.
"""
import json

from tools.file_tools import read_file_tool


def test_success_and_refusal_both_carry_the_requested_path(tmp_path):
    text = tmp_path / "notes.txt"
    text.write_text("hello\n")
    ok = json.loads(read_file_tool(str(text)))
    assert ok.get("path") == str(text)

    image = tmp_path / "pixel.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)
    refused = json.loads(read_file_tool(str(image)))
    assert refused.get("error")
    assert refused.get("path") == str(image)

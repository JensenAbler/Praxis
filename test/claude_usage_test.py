import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "claude-usage.py"
spec = importlib.util.spec_from_file_location("claude_usage", SCRIPT)
claude_usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claude_usage)

SCREEN = """
  Status   Config   Usage

  Current session
  \u2588\u2588\u2588\u2588\u2588\u2588\u258c                                            13% used
  Resets 6:40pm (America/Los_Angeles)

  Current week (all models)
  \u2588\u2588\u258c                                                5% used
  Resets Nov 11, 5am (America/Los_Angeles)

  Extra usage
  Extra usage not enabled \u00b7 /extra-usage to enable

  Esc to cancel
"""


class ParseUsageTest(unittest.TestCase):
    def test_parses_session_and_week(self):
        parsed = claude_usage.parse_usage(SCREEN)
        meters = parsed["meters"]
        self.assertEqual(meters["session"]["percentUsed"], 13)
        self.assertEqual(meters["session"]["resets"], "6:40pm (America/Los_Angeles)")
        self.assertEqual(meters["week_all_models"]["percentUsed"], 5)
        self.assertEqual(meters["week_all_models"]["resets"], "Nov 11, 5am (America/Los_Angeles)")
        self.assertIn("not enabled", parsed["extraUsage"])

    def test_empty_screen_has_no_meters(self):
        self.assertEqual(claude_usage.parse_usage("Select login method")["meters"], {})


if __name__ == "__main__":
    unittest.main()

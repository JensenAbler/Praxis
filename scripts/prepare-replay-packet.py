#!/usr/bin/env python3
"""Create private phone/API replay prompts without publishing task text.

Output is an exclusively created directory. Individual files are published
atomically without replacement; receipt.json is written last as the completion
marker. Repeating identical inputs accepts the same complete packet. A partial
or different existing packet is never overwritten. This does not run an agent.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = REPOSITORY_ROOT / "eval" / "catalog.json"
FROZEN_RELEASE = "coding-a41abbbbb51e"
SCENARIOS = ("standard", "handoff", "artifact")


class PacketError(ValueError):
    """An expected validation failure, with no private task content in its text."""


def _require(value, message):
    if not value:
        raise PacketError(message)


def _inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise PacketError("Cannot read a valid catalog JSON file") from error


def _prompt(case_directory, expected_hash):
    # Adapted cases retain original-prompt.txt for provenance, while their
    # worker-prompt.txt is the actual task whose hash appears in the catalog.
    selected = case_directory / "worker-prompt.txt"
    if not selected.exists():
        selected = case_directory / "prompt.txt"
    try:
        selected = selected.resolve(strict=True)
        _require(_inside(selected, case_directory), "Private task file escapes its case directory")
        _require(selected.stat().st_size <= 256 * 1024, "Private task file exceeds the packet size limit")
        data = selected.read_bytes()
        text = data.decode("utf-8")
    except (OSError, UnicodeError) as error:
        raise PacketError("Cannot read the private worker task as UTF-8") from error
    _require(text.strip() and not text.startswith("\ufeff"), "Private task is empty or has a UTF-8 byte-order mark")
    canonical = text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n") + "\n"
    _require(text == canonical, "Private task must use LF and exactly one final newline")
    _require(_sha(data) == expected_hash, "Private worker task hash does not match the catalog")
    return text


def _identity(case_id, run_id, scenario):
    _require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,49}", case_id), "Case ID has an invalid format")
    _require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}", run_id), "Run ID must be 1-32 letters, digits, dots, underscores, or hyphens")
    _require(scenario in SCENARIOS, "Unknown replay scenario")
    project = "discord-replay-" + case_id
    label = f"Praxis replay {case_id} / {run_id} / {scenario}"
    key = f"praxis:{case_id}:{run_id}:{scenario}:workspace"
    _require(len(project) <= 64, "Case ID is too long for its registered project")
    _require(len(label) <= 80 and len(key) <= 128, "Case and run ID are too long for the tool limits")
    return project, label, key


def _header(project, label, key, base, *, continuation=False):
    phase = "continue the existing" if continuation else "perform this"
    creation = (
        "A workspace must already exist for this continuation. If none matches, report that and stop; do not create a replacement."
        if continuation else
        f"If no workspace matches after complete listing pagination, create one for project {project} at baseRevision {base}, with label \"{label}\" and idempotencyKey {key}."
    )
    return f"""Use the connected Praxis tools to {phase} isolated coding replay.

Expected tool release: {FROZEN_RELEASE}
Registered project: {project}
Immutable base revision: {base}
Exact workspace label: {label}
Workspace creation idempotency key: {key}

Read capabilities and confirm the expected release before making changes. If the release differs or this registered project is unavailable, report the mismatch and stop. Inspect the project and its prepared validation commands.

First list existing workspaces, following pagination, and find the exact project AND label above. If exactly one matches, inspect its base/current revision, jobs, and mutation receipts before continuing. Its immutable base must match the revision above. If multiple match or the base differs, report the ambiguity and stop. {creation}

I authorize source edits and validation commands only in this isolated workspace. Use its prepared dependencies and registered validation commands. The historical request below is scoped to this disposable snapshot: no deployment, publishing, production operations, external network, credentials, or later repository history. Preserve the workspace and its results.

Keep job IDs, mutation receipts, and idempotency keys. Recover an uncertain submission from its persisted state; any retry must use identical inputs and the same key. Never recreate or rerun an ambiguously completed job. If a job is still active, observe that job before continuing. On a repeated prompt, continue from recorded progress and do not redo completed work merely because the conversation changed.

"""


def _task_block(task):
    return "Historical coding request (exact cataloged worker text):\n\n" + task + "\nEnd of historical coding request.\n\n"


def _finish():
    return """Run the relevant checks, inspect their actual final summaries and exit codes, and review the complete diff at a consistent revision. Report the workspace ID, base and current revisions, changed files, validation job IDs and actual outcomes, unavailable checks, and concrete tooling friction. Record retries and unexpected tool behavior as brief operational observations, without private reasoning traces. Leave everything available for recovery from a fresh conversation.
"""


def _recovery(project, label, base, scenario):
    artifact = (
        " Read the preserved replay-validation-summary.json artifact and compare its reported job outcomes with their persisted logs. Report the artifact's stored hash and whether you independently verified its content hash; do not claim verification from metadata alone."
        if scenario == "artifact" else ""
    )
    return f"""Use connected Praxis tools to recover an existing coding replay using read-only calls.

Expected release: {FROZEN_RELEASE}
Exact project: {project}
Exact workspace label: {label}
Expected immutable base: {base}

Do not create a workspace, start or repeat a command, apply edits, or remove anything. Read capabilities and report any release mismatch. List workspaces through all necessary pages and locate the exact project AND label above. If zero or multiple matches exist, report that without guessing. Inspect the matching workspace and verify its immutable base.

Recover all associated jobs and mutation receipts. Read existing validation results from persisted logs, following pagination and checking actual final summaries, lifecycle records, and exit codes. List preserved artifacts and read any present.{artifact} Review the complete workspace diff at one consistent revision. If a job is active, recover its metadata/logs and defer source/diff inspection until it becomes terminal; never restart it. Report interrupted or ambiguous work as recorded.

Report the workspace ID, base/current revision, changed files, job IDs and terminal or active outcomes, receipt/artifact/diff readability, and any missing or duplicate log sequences, truncation, errors, approval friction, or pagination surprises. Distinguish recovered evidence from anything you cannot establish. Do not claim continued model reasoning while the original conversation was away.
"""


def make_packet(*, case_id, run_id, private_root, output, catalog=DEFAULT_CATALOG, scenario="standard"):
    project, label, key = _identity(case_id, run_id, scenario)
    lexical_output = Path(os.path.abspath(output))
    output = lexical_output.resolve()
    _require(not _inside(lexical_output, REPOSITORY_ROOT) and not _inside(output, REPOSITORY_ROOT), "Private packet output must be outside the public Praxis repository")
    private_root = Path(private_root).resolve()
    _require(not _inside(private_root, REPOSITORY_ROOT), "Private task root must be outside the public Praxis repository")
    case_directory = (private_root / case_id).resolve()
    _require(_inside(case_directory, private_root), "Private case directory escapes its root")
    data = _read_json(Path(catalog))
    _require(isinstance(data, dict) and isinstance(data.get("cases"), list), "Catalog must contain a cases array")
    matching = [entry for entry in data["cases"] if isinstance(entry, dict) and entry.get("id") == case_id]
    _require(len(matching) == 1, "Catalog must contain exactly one matching case")
    entry = matching[0]
    expected_hash = entry.get("promptSha256", "")
    base = entry.get("baseCommit", "")
    _require(isinstance(expected_hash, str) and re.fullmatch(r"[0-9a-f]{64}", expected_hash), "Catalog worker prompt hash is invalid")
    _require(isinstance(base, str) and re.fullmatch(r"[0-9a-f]{40}", base), "Catalog base revision is invalid")
    task = _prompt(case_directory, expected_hash)
    header = _header(project, label, key, base)
    files = {}
    if scenario == "handoff":
        phase_one = """This is phase one of a fresh-conversation handoff test. Read the task to understand its scope, inspect the relevant source, and run the prepared baseline validation once. Save a brief REPLAY-HANDOFF.md note containing the task status, workspace/base/current revision, baseline job ID/outcome, files inspected, and next practical steps. The note is the only source change permitted during this phase; leave application code and tests unchanged. Recover an already completed baseline and existing note if this prompt is repeated. Stop after the note is saved and report its location and the durable IDs. Do not implement the historical request yet.

"""
        files["worker-prompt.txt"] = header + phase_one + _task_block(task)
        files["continuation-prompt.txt"] = (
            _header(project, label, key, base, continuation=True)
            + "This is phase two. Read REPLAY-HANDOFF.md and recover the existing baseline job and its logs. Continue implementing the task from that recorded state. Keep the handoff note identifiable in the final diff and report it separately from application changes.\n\n"
            + _task_block(task) + _finish()
        )
    else:
        files["worker-prompt.txt"] = header + _task_block(task)
        if scenario == "artifact":
            files["worker-prompt.txt"] += """Also exercise durable artifact recovery. After validation, run one small sandbox command that writes replay-validation-summary.json with the actual validation job IDs, statuses, exit codes, final test summaries, and unavailable checks you have recovered. Register that file through artifactPaths on the command job so it is preserved after completion. This is evidence metadata, not a replacement for test logs. Verify the artifact listing and record its artifact ID; recover the existing artifact job rather than repeating it after an uncertain response. Report this metadata file separately in the final diff.

"""
        files["worker-prompt.txt"] += _finish()
    files["recovery-prompt.txt"] = _recovery(project, label, base, scenario)
    encoded = {name: value.encode("utf-8") for name, value in files.items()}
    receipt = {
        "schemaVersion": 1, "caseId": case_id, "runId": run_id, "scenario": scenario,
        "release": FROZEN_RELEASE, "projectId": project, "workspaceLabel": label,
        "workspaceCreationIdempotencyKey": key, "baseCommit": base,
        "workerTaskSha256": expected_hash,
        "files": {name: {"sha256": _sha(value), "bytes": len(value)} for name, value in sorted(encoded.items())},
        "execution": "not-started",
    }
    encoded["receipt.json"] = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if output.exists():
        try:
            identical = output.is_dir() and {item.name for item in output.iterdir()} == set(encoded) and all(
                (output / name).is_file() and not (output / name).is_symlink() and (output / name).read_bytes() == value
                for name, value in encoded.items()
            )
        except OSError:
            identical = False
        _require(identical, "Output already exists and is not the same complete packet; nothing was overwritten")
        return {"created": False, "caseId": case_id, "runId": run_id, "scenario": scenario}
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".praxis-packet-", dir=output.parent) as temporary:
            staging = Path(temporary)
            for name, value in encoded.items():
                descriptor = os.open(staging / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(value)
                    stream.flush()
                    os.fsync(stream.fileno())
            # mkdir is exclusive; link publishes each whole file atomically and
            # cannot replace an existing name. The receipt is always last.
            output.mkdir(mode=0o700)
            for name in encoded:
                os.link(staging / name, output / name)
    except OSError as error:
        raise PacketError("Could not exclusively create the private packet; any existing or partial output was preserved") from error
    return {"created": True, "caseId": case_id, "runId": run_id, "scenario": scenario}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Create private replay and recovery prompts; never runs an agent or prints the private task.")
    parser.add_argument("--case", dest="case_id", required=True)
    parser.add_argument("--run-id", required=True, help="Stable identity for this run; reuse it for recovery, choose a new value only for an intentional new run")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Private packet directory outside this public repository")
    parser.add_argument("--scenario", choices=SCENARIOS, default="standard")
    arguments = parser.parse_args(argv)
    try:
        result = make_packet(**vars(arguments))
    except PacketError as error:
        print("Packet not created: " + str(error), file=sys.stderr)
        return 2
    except OSError:
        print("Packet not created: a private filesystem path could not be accessed", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

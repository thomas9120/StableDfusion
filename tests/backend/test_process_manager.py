"""Unit tests for process_manager arg flattening (PLAN.md §17)."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import process_manager  # noqa: E402


def test_flatten_launch_args_none():
    assert process_manager.flatten_launch_args(None) == []


def test_flatten_launch_args_flat_strings():
    assert process_manager.flatten_launch_args(["--steps", "20"]) == ["--steps", "20"]


def test_flatten_launch_args_stringifies_non_strings():
    assert process_manager.flatten_launch_args(["--seed", 42, "--cfg", 7.0]) == [
        "--seed",
        "42",
        "--cfg",
        "7.0",
    ]


def test_flatten_launch_args_nested_lists():
    # Generate flow builds args as a list of [flag, value] pairs.
    result = process_manager.flatten_launch_args([["-m", "model.safetensors"], ["--steps", 20]])
    assert result == ["-m", "model.safetensors", "--steps", "20"]


def test_flatten_launch_args_mixed_nested_and_flat():
    assert process_manager.flatten_launch_args(["--verbose", ["-o", "out.png"], "-t", 4]) == [
        "--verbose",
        "-o",
        "out.png",
        "-t",
        "4",
    ]

from __future__ import annotations


def test_import_package() -> None:
    import pyne_runtime

    assert pyne_runtime.__name__ == "pyne_runtime"

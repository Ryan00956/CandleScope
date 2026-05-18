"""Allow `python -m pyne_runtime` to run the CLI."""
from __future__ import annotations

from .cli import main


raise SystemExit(main())

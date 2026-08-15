"""Author-contract errors. These are not Host fill, ledger, or report errors."""

from __future__ import annotations


class PythonStrategyContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message

from __future__ import annotations

import hashlib
from pathlib import Path

FIXTURE_ROOT = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "plugin_platform_multi_runtime"
)

# Portable LF hashes of the original Phase 1–9 contract fixtures. N1 must not
# rewrite these files to hide later SDK wheel identity changes.
HISTORICAL_V1_FILE_SHA256 = {
    "phase0_contract_v1.json": "767161800430130318503631a0934798e827aae5b892b2fa8c45f3d2c24a2d60",
    "phase1_contract_v1.json": "9364ad74467a98ff789d1cf5d4217517c3cb80d05a9b94bc8a0953737a39e8ff",
    "phase2_contract_v1.json": "d907756b1e72ce1edcf399fad036211ef138713dd70f387b65f75cff2b569c7e",
    "phase3_contract_v1.json": "171023885bdf4049883d1415faf3c1be659075a1f792ce584427fe12932430a4",
    "phase4_contract_v1.json": "b2ef6b4a624b2f1910984e4535f0f022a9d1461783d4e8c70c3bbe87811bceea",
    "phase5_contract_v1.json": "aeea5ba29fbdc0fe730a875bdfa072d55f73f3b6a3a11efb49d69dad89a5e745",
    "phase6_contract_v1.json": "c9b5e173a6f7a2fc42741b5a39c9c64f4cd5ee23ffdb1807b857091bb165dc90",
    "phase7_contract_v1.json": "51a05c2e8c2da13b8c4ef9766a1b77f522757423b6868f20ef00f5920f796c44",
    "phase8_contract_v1.json": "94483c5bccc38a347f19393ee57d4b19d3d1e8eb608b814e08b43f9dee775f1c",
    "phase9_contract_v1.json": "e129fc40ee6d4a8eabfb6bb969d6aba226a50bbd10281eeefb72c244f2a691df",
}


def _portable_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def test_historical_phase_contract_v1_files_were_not_rewritten() -> None:
    for name, expected in HISTORICAL_V1_FILE_SHA256.items():
        path = FIXTURE_ROOT / name
        assert path.is_file(), name
        assert _portable_sha256(path) == expected, name

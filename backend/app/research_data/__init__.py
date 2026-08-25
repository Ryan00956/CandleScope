"""Product orchestration contracts for strategy research data sources."""

from .capabilities import (
    CAPABILITY_IDS,
    CapabilityDecision,
    CapabilitySummary,
    is_capability_available,
    project_capabilities,
)
from .contracts import (
    SOURCE_KINDS,
    FrozenResearchContext,
    ResearchDataError,
    ResearchSourceRef,
    assemble_frozen_research_context,
    frozen_context_canonical_json,
    frozen_context_hash,
    parse_frozen_research_context,
    parse_research_source_ref,
    source_ref_wire,
)

__all__ = [
    "CAPABILITY_IDS",
    "CapabilityDecision",
    "CapabilitySummary",
    "FrozenResearchContext",
    "ResearchDataError",
    "ResearchSourceRef",
    "SOURCE_KINDS",
    "assemble_frozen_research_context",
    "frozen_context_canonical_json",
    "frozen_context_hash",
    "is_capability_available",
    "parse_frozen_research_context",
    "parse_research_source_ref",
    "project_capabilities",
    "source_ref_wire",
]

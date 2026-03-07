"""
Dependency Resolver — DAG-based execution ordering for indicator chains.

Supports indicators that reference other indicators' outputs as inputs.
For example:
  - MA(MACD.hist, 5) → MA depends on MACD
  - RSI(MA(close, 10), 14) → RSI depends on MA

The resolver:
  1. Parses dependency declarations
  2. Builds a directed acyclic graph (DAG)
  3. Topologically sorts for execution order
  4. Detects circular dependencies

Usage::

    from app.indicator.dependency import DependencyGraph

    graph = DependencyGraph()
    macd_id = graph.add_node("MACD", params={"fast": 12, "slow": 26, "signal": 9})
    ma_id = graph.add_node("MA", params={"period": 5, "source": "close"})
    graph.add_edge(macd_id, ma_id, source_output="hist", target_input="close")

    order = graph.topological_sort()
    # → [macd_id, ma_id]  (MACD computed first, then MA reads its hist)
"""
from __future__ import annotations

import hashlib
import json
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from app.data_engine.data_manager.models import BarData

from .types import IndicatorKey, IndicatorResult, OutputPoint

logger = logging.getLogger("candlescope.indicator.dependency")


# ═══════════════════════════════════════════════════════════════
#  Data Structures
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class DependencyEdge:
    """A directed edge in the dependency graph.

    Represents: target indicator reads ``target_input`` field from
    ``source_output`` of the source indicator.

    Example: MA reads its ``close`` input from MACD's ``hist`` output.
      - source_node_id: "macd_001"
      - target_node_id: "ma_002"
      - source_output:  "hist"
      - target_input:   "close"
    """
    source_node_id: str
    target_node_id: str
    source_output: str = "value"    # which output of the source
    target_input: str = "close"     # which BarData field to override


@dataclass(slots=True)
class DependencyNode:
    """A node in the dependency graph — represents one indicator computation.

    Attributes:
        node_id:         Unique identifier within this graph
        indicator_name:  Registry name (e.g. "MA", "MACD")
        params:          Indicator parameters
        depends_on:      List of edges pointing INTO this node
        provides_to:     List of edges pointing OUT of this node
    """
    node_id: str
    indicator_name: str
    params: dict[str, Any] = field(default_factory=dict)
    depends_on: list[DependencyEdge] = field(default_factory=list)
    provides_to: list[DependencyEdge] = field(default_factory=list)


class CyclicDependencyError(Exception):
    """Raised when the dependency graph contains a cycle."""
    pass


class UnresolvedDependencyError(Exception):
    """Raised when a dependency references a non-existent node."""
    pass


# ═══════════════════════════════════════════════════════════════
#  Dependency Graph
# ═══════════════════════════════════════════════════════════════


class DependencyGraph:
    """Directed acyclic graph for indicator dependency resolution.

    Manages nodes (indicator computation units) and edges (data flow
    between indicators). Provides topological sorting and cycle detection.

    Example::

        graph = DependencyGraph()

        # EMA12 and EMA26 both read from raw bars (no dependencies)
        ema12 = graph.add_node("EMA", {"period": 12})
        ema26 = graph.add_node("EMA", {"period": 26})

        # MACD depends on both EMAs (hypothetical composite)
        macd = graph.add_node("MACD", {"fast": 12, "slow": 26, "signal": 9})

        # MA(5) of MACD histogram
        ma5 = graph.add_node("MA", {"period": 5})
        graph.add_edge(macd, ma5, source_output="hist", target_input="close")

        order = graph.topological_sort()
        # → [ema12, ema26, macd, ma5]
    """

    def __init__(self) -> None:
        self._nodes: dict[str, DependencyNode] = {}
        self._edges: list[DependencyEdge] = []
        self._counter: int = 0

    # ── Node Management ──────────────────────────────────────

    def add_node(
        self,
        indicator_name: str,
        params: dict[str, Any] | None = None,
        node_id: str | None = None,
    ) -> str:
        """Add an indicator computation node to the graph.

        Args:
            indicator_name: Registry name (e.g. "MA", "MACD")
            params:         Indicator parameters
            node_id:        Optional explicit ID. Auto-generated if None.

        Returns:
            The node ID (for use in add_edge).
        """
        if node_id is None:
            self._counter += 1
            node_id = f"{indicator_name.lower()}_{self._counter:03d}"

        if node_id in self._nodes:
            raise ValueError(f"Node '{node_id}' already exists in graph")

        node = DependencyNode(
            node_id=node_id,
            indicator_name=indicator_name.upper(),
            params=params or {},
        )
        self._nodes[node_id] = node
        logger.debug("Added node: %s (%s)", node_id, indicator_name)
        return node_id

    def get_node(self, node_id: str) -> DependencyNode | None:
        """Get a node by ID."""
        return self._nodes.get(node_id)

    def remove_node(self, node_id: str) -> None:
        """Remove a node and all its edges."""
        self._nodes.pop(node_id, None)
        self._edges = [
            e for e in self._edges
            if e.source_node_id != node_id and e.target_node_id != node_id
        ]
        # Update remaining nodes' edge lists
        for node in self._nodes.values():
            node.depends_on = [e for e in node.depends_on if e.source_node_id != node_id]
            node.provides_to = [e for e in node.provides_to if e.target_node_id != node_id]

    @property
    def nodes(self) -> dict[str, DependencyNode]:
        """All nodes in the graph."""
        return dict(self._nodes)

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    @property
    def edge_count(self) -> int:
        return len(self._edges)

    # ── Edge Management ──────────────────────────────────────

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        source_output: str = "value",
        target_input: str = "close",
    ) -> DependencyEdge:
        """Add a data-flow edge: target reads from source's output.

        Args:
            source_id:     Node that produces the data
            target_id:     Node that consumes the data
            source_output: Which output field of source to read
            target_input:  Which input field of target to override

        Returns:
            The created DependencyEdge.

        Raises:
            UnresolvedDependencyError: If source or target doesn't exist.
            CyclicDependencyError: If this edge would create a cycle.
        """
        if source_id not in self._nodes:
            raise UnresolvedDependencyError(
                f"Source node '{source_id}' not found in graph"
            )
        if target_id not in self._nodes:
            raise UnresolvedDependencyError(
                f"Target node '{target_id}' not found in graph"
            )
        if source_id == target_id:
            raise CyclicDependencyError(
                f"Self-referencing edge: {source_id} → {target_id}"
            )

        edge = DependencyEdge(
            source_node_id=source_id,
            target_node_id=target_id,
            source_output=source_output,
            target_input=target_input,
        )

        # Tentatively add and check for cycles
        self._edges.append(edge)
        self._nodes[target_id].depends_on.append(edge)
        self._nodes[source_id].provides_to.append(edge)

        if self._has_cycle():
            # Rollback
            self._edges.pop()
            self._nodes[target_id].depends_on.pop()
            self._nodes[source_id].provides_to.pop()
            raise CyclicDependencyError(
                f"Adding edge {source_id} → {target_id} would create a cycle"
            )

        logger.debug(
            "Added edge: %s.%s → %s.%s",
            source_id, source_output, target_id, target_input,
        )
        return edge

    # ── Topological Sort ─────────────────────────────────────

    def topological_sort(self) -> list[str]:
        """Return node IDs in topological (execution) order.

        Nodes with no dependencies come first. Nodes that depend on
        others come after their dependencies.

        Returns:
            List of node IDs in execution order.

        Raises:
            CyclicDependencyError: If the graph contains a cycle.
        """
        if not self._nodes:
            return []

        # Kahn's algorithm
        in_degree: dict[str, int] = {nid: 0 for nid in self._nodes}
        for edge in self._edges:
            in_degree[edge.target_node_id] += 1

        queue: deque[str] = deque()
        for nid, deg in in_degree.items():
            if deg == 0:
                queue.append(nid)

        result: list[str] = []
        while queue:
            node_id = queue.popleft()
            result.append(node_id)

            node = self._nodes[node_id]
            for edge in node.provides_to:
                in_degree[edge.target_node_id] -= 1
                if in_degree[edge.target_node_id] == 0:
                    queue.append(edge.target_node_id)

        if len(result) != len(self._nodes):
            raise CyclicDependencyError(
                f"Graph contains a cycle. Sorted {len(result)}/{len(self._nodes)} nodes."
            )

        return result

    def get_execution_levels(self) -> list[list[str]]:
        """Return nodes grouped by execution level.

        Level 0: nodes with no dependencies (can run in parallel)
        Level 1: nodes that depend only on level-0 nodes (can run in parallel)
        ...etc.

        This enables parallel execution within each level.
        """
        if not self._nodes:
            return []

        in_degree: dict[str, int] = {nid: 0 for nid in self._nodes}
        for edge in self._edges:
            in_degree[edge.target_node_id] += 1

        levels: list[list[str]] = []
        current_level = [nid for nid, deg in in_degree.items() if deg == 0]

        while current_level:
            levels.append(current_level)
            next_level_candidates: set[str] = set()

            for node_id in current_level:
                node = self._nodes[node_id]
                for edge in node.provides_to:
                    in_degree[edge.target_node_id] -= 1
                    if in_degree[edge.target_node_id] == 0:
                        next_level_candidates.add(edge.target_node_id)

            current_level = sorted(next_level_candidates)

        return levels

    # ── Dependency Queries ───────────────────────────────────

    def get_dependencies(self, node_id: str) -> list[str]:
        """Get direct dependency node IDs for a given node."""
        node = self._nodes.get(node_id)
        if node is None:
            return []
        return [e.source_node_id for e in node.depends_on]

    def get_dependents(self, node_id: str) -> list[str]:
        """Get nodes that directly depend on the given node."""
        node = self._nodes.get(node_id)
        if node is None:
            return []
        return [e.target_node_id for e in node.provides_to]

    def get_all_ancestors(self, node_id: str) -> set[str]:
        """Get all transitive dependencies (ancestors) of a node."""
        visited: set[str] = set()
        stack = [node_id]
        while stack:
            nid = stack.pop()
            for dep_id in self.get_dependencies(nid):
                if dep_id not in visited:
                    visited.add(dep_id)
                    stack.append(dep_id)
        return visited

    def get_all_descendants(self, node_id: str) -> set[str]:
        """Get all transitive dependents (descendants) of a node."""
        visited: set[str] = set()
        stack = [node_id]
        while stack:
            nid = stack.pop()
            for dep_id in self.get_dependents(nid):
                if dep_id not in visited:
                    visited.add(dep_id)
                    stack.append(dep_id)
        return visited

    def get_root_nodes(self) -> list[str]:
        """Get nodes with no dependencies (entry points)."""
        return [
            nid for nid, node in self._nodes.items()
            if not node.depends_on
        ]

    def get_leaf_nodes(self) -> list[str]:
        """Get nodes with no dependents (outputs)."""
        return [
            nid for nid, node in self._nodes.items()
            if not node.provides_to
        ]

    # ── Cycle Detection ──────────────────────────────────────

    def _has_cycle(self) -> bool:
        """Detect if the graph contains a cycle using DFS."""
        WHITE, GREY, BLACK = 0, 1, 2
        color: dict[str, int] = {nid: WHITE for nid in self._nodes}

        def dfs(nid: str) -> bool:
            color[nid] = GREY
            node = self._nodes[nid]
            for edge in node.provides_to:
                target = edge.target_node_id
                if color[target] == GREY:
                    return True  # back edge → cycle
                if color[target] == WHITE and dfs(target):
                    return True
            color[nid] = BLACK
            return False

        for nid in self._nodes:
            if color[nid] == WHITE:
                if dfs(nid):
                    return True
        return False

    def validate(self) -> list[str]:
        """Validate the graph and return a list of issues (empty = valid)."""
        issues: list[str] = []

        # Check for cycles
        if self._has_cycle():
            issues.append("Graph contains a circular dependency")

        # Check for unresolved references
        node_ids = set(self._nodes.keys())
        for edge in self._edges:
            if edge.source_node_id not in node_ids:
                issues.append(f"Edge references missing source: {edge.source_node_id}")
            if edge.target_node_id not in node_ids:
                issues.append(f"Edge references missing target: {edge.target_node_id}")

        return issues

    # ── Utility ──────────────────────────────────────────────

    def clear(self) -> None:
        """Remove all nodes and edges."""
        self._nodes.clear()
        self._edges.clear()
        self._counter = 0

    def snapshot(self) -> dict:
        """JSON-serializable diagnostic snapshot."""
        return {
            "node_count": len(self._nodes),
            "edge_count": len(self._edges),
            "nodes": {
                nid: {
                    "indicator": node.indicator_name,
                    "params": node.params,
                    "depends_on": [e.source_node_id for e in node.depends_on],
                    "provides_to": [e.target_node_id for e in node.provides_to],
                }
                for nid, node in self._nodes.items()
            },
            "edges": [
                {
                    "source": e.source_node_id,
                    "target": e.target_node_id,
                    "source_output": e.source_output,
                    "target_input": e.target_input,
                }
                for e in self._edges
            ],
            "execution_order": self.topological_sort() if not self._has_cycle() else [],
        }

    def __repr__(self) -> str:
        return (
            f"DependencyGraph(nodes={len(self._nodes)}, edges={len(self._edges)})"
        )


# ═══════════════════════════════════════════════════════════════
#  Helper: Build synthetic bars from indicator output
# ═══════════════════════════════════════════════════════════════


def build_synthetic_bars(
    original_bars: list[BarData],
    result: IndicatorResult,
    source_output: str,
    target_input: str = "close",
) -> list[BarData]:
    """Create synthetic BarData list by replacing a field with indicator output.

    For example, if we want to compute MA(5) of MACD's histogram:
      1. Compute MACD → get hist output series
      2. Build synthetic bars where bar.close = MACD.hist value
      3. Feed synthetic bars into MA(5)

    Args:
        original_bars:  The original OHLCV bars (for timestamps and other fields)
        result:         The upstream indicator's result
        source_output:  Which output to read from the result (e.g. "hist")
        target_input:   Which BarData field to replace (e.g. "close")

    Returns:
        List of synthetic BarData with the target field overridden.
    """
    output = result.outputs.get(source_output)
    if output is None:
        raise ValueError(
            f"Output '{source_output}' not found in indicator {result.key.indicator_name}. "
            f"Available: {list(result.outputs.keys())}"
        )

    # Build timestamp → value map from the output
    value_map: dict[int, float | None] = {}
    for point in output.data:
        value_map[point.timestamp] = point.value

    # Create synthetic bars
    synthetic: list[BarData] = []
    for bar in original_bars:
        val = value_map.get(bar.time)
        if val is None:
            # Use 0.0 for None values (indicator warmup period)
            val = 0.0

        # Clone bar and override the target field
        new_bar = BarData(
            time=bar.time,
            open=bar.open,
            high=bar.high,
            low=bar.low,
            close=bar.close,
            volume=bar.volume,
        )

        if target_input == "close":
            new_bar.close = val
        elif target_input == "open":
            new_bar.open = val
        elif target_input == "high":
            new_bar.high = val
        elif target_input == "low":
            new_bar.low = val
        elif target_input == "volume":
            new_bar.volume = val
        else:
            # For derived fields (hl2, hlc3, etc.) we override close
            new_bar.close = val

        synthetic.append(new_bar)

    return synthetic

"""Pine-like mutable collection helpers."""
from __future__ import annotations

from types import ModuleType
from typing import Any, Iterable

from .security import PyneSecurityError
from .values import is_na_value


class OrderNamespace:
    """Pine-like sort order constants."""

    ascending = "ascending"
    descending = "descending"


class PyneArray:
    """Mutable Pine-like array value."""

    def __init__(
        self,
        values: Iterable[Any] | None = None,
        *,
        max_size: int | None = None,
        max_depth: int | None = None,
    ) -> None:
        self._max_size = _normalize_limit(max_size)
        self._max_depth = _normalize_limit(max_depth)
        self._values = list(values) if values is not None else []
        _enforce_limit("array size", len(self._values), self._max_size)
        for item in self._values:
            _validate_collection_assignment(self, item, self._max_depth)

    def __len__(self) -> int:
        return len(self._values)

    def __iter__(self):
        return iter(self._values)

    def __repr__(self) -> str:
        return f"PyneArray({self._values!r})"

    def to_list(self) -> list[Any]:
        return list(self._values)

    def copy(self) -> PyneArray:
        return PyneArray(self._values, max_size=self._max_size, max_depth=self._max_depth)

    def snapshot(self) -> PyneArray:
        return _snapshot_array(self, set())

    def size(self) -> int:
        return len(self._values)

    def get(self, index: int) -> Any:
        return self._values[_resolve_index(index, len(self._values))]

    def first(self) -> Any:
        return self.get(0)

    def last(self) -> Any:
        return self.get(-1)

    def set(self, index: int, value: Any) -> None:
        _validate_collection_assignment(self, value, self._max_depth)
        self._values[_resolve_index(index, len(self._values))] = value

    def push(self, value: Any) -> None:
        _enforce_limit("array size", len(self._values) + 1, self._max_size)
        _validate_collection_assignment(self, value, self._max_depth)
        self._values.append(value)

    def pop(self) -> Any:
        if not self._values:
            raise IndexError("array.pop() cannot pop from an empty array")
        return self._values.pop()

    def unshift(self, value: Any) -> None:
        _enforce_limit("array size", len(self._values) + 1, self._max_size)
        _validate_collection_assignment(self, value, self._max_depth)
        self._values.insert(0, value)

    def shift(self) -> Any:
        if not self._values:
            raise IndexError("array.shift() cannot shift from an empty array")
        return self._values.pop(0)

    def insert(self, index: int, value: Any) -> None:
        idx = int(index)
        if idx < 0 or idx > len(self._values):
            raise IndexError(f"array index {idx} is out of bounds")
        _enforce_limit("array size", len(self._values) + 1, self._max_size)
        _validate_collection_assignment(self, value, self._max_depth)
        self._values.insert(idx, value)

    def remove(self, index: int) -> Any:
        return self._values.pop(_resolve_index(index, len(self._values)))

    def clear(self) -> None:
        self._values.clear()

    def includes(self, value: Any) -> bool:
        return any(_values_equal(item, value) for item in self._values)

    def indexof(self, value: Any) -> int:
        for idx, item in enumerate(self._values):
            if _values_equal(item, value):
                return idx
        return -1

    def lastindexof(self, value: Any) -> int:
        for idx in range(len(self._values) - 1, -1, -1):
            if _values_equal(self._values[idx], value):
                return idx
        return -1

    def slice(self, index_from: int, index_to: int | None = None) -> PyneArray:
        start = int(index_from)
        stop = None if index_to is None else int(index_to)
        return PyneArray(
            self._values[start:stop],
            max_size=self._max_size,
            max_depth=self._max_depth,
        )

    def fill(self, value: Any, index_from: int = 0, index_to: int | None = None) -> None:
        _validate_collection_assignment(self, value, self._max_depth)
        start = max(int(index_from), 0)
        stop = len(self._values) if index_to is None else min(int(index_to), len(self._values))
        for idx in range(start, stop):
            self._values[idx] = value

    def reverse(self) -> None:
        self._values.reverse()

    def sort(self, order: str | None = None, *, reverse: bool = False) -> None:
        descending = _sort_descending(order, reverse)
        self._values.sort(reverse=descending)

    def sort_indices(self, order: str | None = None, *, reverse: bool = False) -> PyneArray:
        descending = _sort_descending(order, reverse)
        indices = sorted(range(len(self._values)), key=self._values.__getitem__, reverse=descending)
        return PyneArray(indices, max_size=self._max_size, max_depth=self._max_depth)

    def join(self, separator: str = ",") -> str:
        return str(separator).join("" if is_na_value(item) else str(item) for item in self._values)

    def sum(self) -> float | None:
        numbers = _numeric_values(self._values)
        return float(sum(numbers)) if numbers else None

    def avg(self) -> float | None:
        numbers = _numeric_values(self._values)
        return float(sum(numbers) / len(numbers)) if numbers else None

    def min(self) -> float | None:
        numbers = _numeric_values(self._values)
        return float(min(numbers)) if numbers else None

    def max(self) -> float | None:
        numbers = _numeric_values(self._values)
        return float(max(numbers)) if numbers else None


class PyneMap:
    """Mutable Pine-like key/value map."""

    def __init__(
        self,
        values: dict[Any, Any] | None = None,
        *,
        max_size: int | None = None,
        array_max_size: int | None = None,
        max_depth: int | None = None,
    ) -> None:
        self._max_size = _normalize_limit(max_size)
        self._array_max_size = _normalize_limit(array_max_size)
        self._max_depth = _normalize_limit(max_depth)
        self._values: dict[Any, Any] = {}
        for key, value in dict(values or {}).items():
            _validate_map_key(key)
            _validate_collection_assignment(self, value, self._max_depth)
            self._values[key] = value
        _enforce_limit("map size", len(self._values), self._max_size)

    def __len__(self) -> int:
        return len(self._values)

    def __iter__(self):
        return iter(self._values)

    def __repr__(self) -> str:
        return f"PyneMap({self._values!r})"

    def to_dict(self) -> dict[Any, Any]:
        return dict(self._values)

    def copy(self) -> PyneMap:
        return PyneMap(
            self._values,
            max_size=self._max_size,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def snapshot(self) -> PyneMap:
        return _snapshot_map(self, set())

    def size(self) -> int:
        return len(self._values)

    def put(self, key: Any, value: Any) -> None:
        _validate_map_key(key)
        if key not in self._values:
            _enforce_limit("map size", len(self._values) + 1, self._max_size)
        _validate_collection_assignment(self, value, self._max_depth)
        self._values[key] = value

    def put_all(self, other: PyneMap) -> None:
        for key, value in _map(other).to_dict().items():
            self.put(key, value)

    def get(self, key: Any, default: Any = None) -> Any:
        _validate_map_key(key)
        return self._values.get(key, default)

    def contains(self, key: Any) -> bool:
        _validate_map_key(key)
        return key in self._values

    def remove(self, key: Any) -> Any:
        _validate_map_key(key)
        return self._values.pop(key, None)

    def clear(self) -> None:
        self._values.clear()

    def keys(self) -> PyneArray:
        return PyneArray(
            self._values.keys(),
            max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def values(self) -> PyneArray:
        return PyneArray(
            self._values.values(),
            max_size=self._array_max_size,
            max_depth=self._max_depth,
        )


class PyneMatrix:
    """Mutable Pine-like two-dimensional matrix."""

    def __init__(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: Any = None,
        *,
        max_cells: int | None = None,
        array_max_size: int | None = None,
        max_depth: int | None = None,
    ) -> None:
        self._max_cells = _normalize_limit(max_cells)
        self._array_max_size = _normalize_limit(array_max_size)
        self._max_depth = _normalize_limit(max_depth)
        row_count = _matrix_dimension(rows, "matrix rows")
        column_count = _matrix_dimension(columns, "matrix columns")
        _enforce_limit("matrix cells", row_count * column_count, self._max_cells)
        _validate_collection_assignment(self, initial_value, self._max_depth)
        self._values = [
            [initial_value for _ in range(column_count)]
            for _ in range(row_count)
        ]

    @classmethod
    def from_rows(
        cls,
        rows: Iterable[Iterable[Any]],
        *,
        max_cells: int | None = None,
        array_max_size: int | None = None,
        max_depth: int | None = None,
    ) -> PyneMatrix:
        values = [list(row) for row in rows]
        if values:
            width = len(values[0])
            if any(len(row) != width for row in values):
                raise ValueError("matrix rows must all have the same length")
        cell_count = len(values) * (len(values[0]) if values else 0)
        normalized_limit = _normalize_limit(max_cells)
        normalized_depth = _normalize_limit(max_depth)
        _enforce_limit("matrix cells", cell_count, normalized_limit)
        for row in values:
            for item in row:
                _validate_stored_value(item)
                _enforce_acyclic_collection_value(item)
                _enforce_child_depth(item, normalized_depth)
        matrix = cls(
            max_cells=normalized_limit,
            array_max_size=array_max_size,
            max_depth=normalized_depth,
        )
        matrix._values = values
        return matrix

    def __repr__(self) -> str:
        return f"PyneMatrix({self._values!r})"

    def to_list(self) -> list[list[Any]]:
        return [list(row) for row in self._values]

    def copy(self) -> PyneMatrix:
        return PyneMatrix.from_rows(
            self._values,
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def snapshot(self) -> PyneMatrix:
        return _snapshot_matrix(self, set())

    def rows(self) -> int:
        return len(self._values)

    def columns(self) -> int:
        return len(self._values[0]) if self._values else 0

    def elements_count(self) -> int:
        return self.rows() * self.columns()

    def get(self, row: int, column: int) -> Any:
        row_idx, column_idx = self._resolve_cell(row, column)
        return self._values[row_idx][column_idx]

    def set(self, row: int, column: int, value: Any) -> None:
        row_idx, column_idx = self._resolve_cell(row, column)
        _validate_collection_assignment(self, value, self._max_depth)
        self._values[row_idx][column_idx] = value

    def fill(self, value: Any) -> None:
        _validate_collection_assignment(self, value, self._max_depth)
        for row_idx in range(self.rows()):
            for column_idx in range(self.columns()):
                self._values[row_idx][column_idx] = value

    def row(self, row: int) -> PyneArray:
        row_idx = _resolve_index(row, self.rows(), name="matrix row")
        return PyneArray(
            self._values[row_idx],
            max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def col(self, column: int) -> PyneArray:
        column_idx = _resolve_index(column, self.columns(), name="matrix column")
        return PyneArray(
            (row[column_idx] for row in self._values),
            max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def transpose(self) -> PyneMatrix:
        if not self._values:
            return PyneMatrix(
                max_cells=self._max_cells,
                array_max_size=self._array_max_size,
                max_depth=self._max_depth,
            )
        return PyneMatrix.from_rows(
            zip(*self._values),
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def reshape(self, rows: int, columns: int) -> PyneMatrix:
        row_count = _matrix_dimension(rows, "matrix rows")
        column_count = _matrix_dimension(columns, "matrix columns")
        flat = [item for row in self._values for item in row]
        if row_count * column_count != len(flat):
            raise ValueError("matrix.reshape() cannot change element count")
        _enforce_limit("matrix cells", row_count * column_count, self._max_cells)
        rebuilt = [
            flat[idx * column_count:(idx + 1) * column_count]
            for idx in range(row_count)
        ]
        return PyneMatrix.from_rows(
            rebuilt,
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def add(self, other: Any) -> PyneMatrix:
        return self._binary(other, lambda left, right: left + right)

    def sub(self, other: Any) -> PyneMatrix:
        return self._binary(other, lambda left, right: left - right)

    def mult(self, other: Any) -> PyneMatrix:
        if isinstance(other, PyneMatrix):
            return self._matrix_mult(other)
        return self._binary(other, lambda left, right: left * right)

    def sum(self) -> float | None:
        return _sum_values(self._flatten())

    def avg(self) -> float | None:
        numbers = _numeric_values(self._flatten())
        return float(sum(numbers) / len(numbers)) if numbers else None

    def min(self) -> float | None:
        numbers = _numeric_values(self._flatten())
        return float(min(numbers)) if numbers else None

    def max(self) -> float | None:
        numbers = _numeric_values(self._flatten())
        return float(max(numbers)) if numbers else None

    def _resolve_cell(self, row: int, column: int) -> tuple[int, int]:
        return (
            _resolve_index(row, self.rows(), name="matrix row"),
            _resolve_index(column, self.columns(), name="matrix column"),
        )

    def _flatten(self) -> list[Any]:
        return [item for row in self._values for item in row]

    def _binary(self, other: Any, op: Any) -> PyneMatrix:
        if isinstance(other, PyneMatrix):
            if self.rows() != other.rows() or self.columns() != other.columns():
                raise ValueError("matrix dimensions must match")
            return PyneMatrix.from_rows(
                [
                    [op(self._values[row][column], other._values[row][column])
                     for column in range(self.columns())]
                    for row in range(self.rows())
                ],
                max_cells=self._max_cells,
                array_max_size=self._array_max_size,
                max_depth=self._max_depth,
            )
        return PyneMatrix.from_rows(
            [[op(item, other) for item in row] for row in self._values],
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def _matrix_mult(self, other: PyneMatrix) -> PyneMatrix:
        if self.columns() != other.rows():
            raise ValueError("matrix dimensions are incompatible for multiplication")
        values: list[list[Any]] = []
        for row in range(self.rows()):
            output_row = []
            for column in range(other.columns()):
                total = 0.0
                for idx in range(self.columns()):
                    total += float(self._values[row][idx]) * float(other._values[idx][column])
                output_row.append(total)
            values.append(output_row)
        return PyneMatrix.from_rows(
            values,
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )


class ArrayNamespace:
    """Pine-like ``array.*`` namespace."""

    def __init__(self, *, max_size: int | None = None, max_depth: int | None = None) -> None:
        self._max_size = _normalize_limit(max_size)
        self._max_depth = _normalize_limit(max_depth)

    def new(self, size: int = 0, initial_value: Any = None) -> PyneArray:
        size_count = _array_size(size)
        return PyneArray(
            [initial_value for _ in range(size_count)],
            max_size=self._max_size,
            max_depth=self._max_depth,
        )

    def new_float(self, size: int = 0, initial_value: float | None = None) -> PyneArray:
        return self.new(size, initial_value)

    def new_int(self, size: int = 0, initial_value: int | None = None) -> PyneArray:
        return self.new(size, initial_value)

    def new_bool(self, size: int = 0, initial_value: bool | None = None) -> PyneArray:
        return self.new(size, initial_value)

    def new_string(self, size: int = 0, initial_value: str | None = None) -> PyneArray:
        return self.new(size, initial_value)

    def new_color(self, size: int = 0, initial_value: str | None = None) -> PyneArray:
        return self.new(size, initial_value)

    def from_values(self, *values: Any) -> PyneArray:
        return PyneArray(values, max_size=self._max_size, max_depth=self._max_depth)

    def from_list(self, values: Iterable[Any]) -> PyneArray:
        return PyneArray(values, max_size=self._max_size, max_depth=self._max_depth)

    def copy(self, arr: PyneArray) -> PyneArray:
        return _array(arr).copy()

    def snapshot(self, arr: PyneArray) -> PyneArray:
        return _array(arr).snapshot()

    def size(self, arr: PyneArray) -> int:
        return _array(arr).size()

    def get(self, arr: PyneArray, index: int) -> Any:
        return _array(arr).get(index)

    def first(self, arr: PyneArray) -> Any:
        return _array(arr).first()

    def last(self, arr: PyneArray) -> Any:
        return _array(arr).last()

    def set(self, arr: PyneArray, index: int, value: Any) -> None:
        _array(arr).set(index, value)

    def push(self, arr: PyneArray, value: Any) -> None:
        _array(arr).push(value)

    def pop(self, arr: PyneArray) -> Any:
        return _array(arr).pop()

    def unshift(self, arr: PyneArray, value: Any) -> None:
        _array(arr).unshift(value)

    def shift(self, arr: PyneArray) -> Any:
        return _array(arr).shift()

    def insert(self, arr: PyneArray, index: int, value: Any) -> None:
        _array(arr).insert(index, value)

    def remove(self, arr: PyneArray, index: int) -> Any:
        return _array(arr).remove(index)

    def clear(self, arr: PyneArray) -> None:
        _array(arr).clear()

    def includes(self, arr: PyneArray, value: Any) -> bool:
        return _array(arr).includes(value)

    def indexof(self, arr: PyneArray, value: Any) -> int:
        return _array(arr).indexof(value)

    def lastindexof(self, arr: PyneArray, value: Any) -> int:
        return _array(arr).lastindexof(value)

    def slice(self, arr: PyneArray, index_from: int, index_to: int | None = None) -> PyneArray:
        return _array(arr).slice(index_from, index_to)

    def fill(
        self,
        arr: PyneArray,
        value: Any,
        index_from: int = 0,
        index_to: int | None = None,
    ) -> None:
        _array(arr).fill(value, index_from, index_to)

    def reverse(self, arr: PyneArray) -> None:
        _array(arr).reverse()

    def sort(self, arr: PyneArray, order: str | None = None, *, reverse: bool = False) -> None:
        _array(arr).sort(order, reverse=reverse)

    def sort_indices(
        self,
        arr: PyneArray,
        order: str | None = None,
        *,
        reverse: bool = False,
    ) -> PyneArray:
        return _array(arr).sort_indices(order, reverse=reverse)

    def join(self, arr: PyneArray, separator: str = ",") -> str:
        return _array(arr).join(separator)

    def sum(self, arr: PyneArray) -> float | None:
        return _array(arr).sum()

    def avg(self, arr: PyneArray) -> float | None:
        return _array(arr).avg()

    def min(self, arr: PyneArray) -> float | None:
        return _array(arr).min()

    def max(self, arr: PyneArray) -> float | None:
        return _array(arr).max()


class MapNamespace:
    """Pine-like ``map.*`` namespace."""

    def __init__(
        self,
        *,
        max_size: int | None = None,
        array_max_size: int | None = None,
        max_depth: int | None = None,
    ) -> None:
        self._max_size = _normalize_limit(max_size)
        self._array_max_size = _normalize_limit(array_max_size)
        self._max_depth = _normalize_limit(max_depth)

    def new(self) -> PyneMap:
        return PyneMap(
            max_size=self._max_size,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def from_values(self, *items: Any) -> PyneMap:
        if len(items) % 2 != 0:
            raise ValueError("map.from_values() expects key/value pairs")
        result = PyneMap(
            max_size=self._max_size,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )
        for idx in range(0, len(items), 2):
            result.put(items[idx], items[idx + 1])
        return result

    def from_dict(self, values: dict[Any, Any]) -> PyneMap:
        return PyneMap(
            values,
            max_size=self._max_size,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def copy(self, m: PyneMap) -> PyneMap:
        return _map(m).copy()

    def snapshot(self, m: PyneMap) -> PyneMap:
        return _map(m).snapshot()

    def size(self, m: PyneMap) -> int:
        return _map(m).size()

    def put(self, m: PyneMap, key: Any, value: Any) -> None:
        _map(m).put(key, value)

    def put_all(self, m: PyneMap, other: PyneMap) -> None:
        _map(m).put_all(other)

    def get(self, m: PyneMap, key: Any, default: Any = None) -> Any:
        return _map(m).get(key, default)

    def contains(self, m: PyneMap, key: Any) -> bool:
        return _map(m).contains(key)

    def remove(self, m: PyneMap, key: Any) -> Any:
        return _map(m).remove(key)

    def clear(self, m: PyneMap) -> None:
        _map(m).clear()

    def keys(self, m: PyneMap) -> PyneArray:
        return _map(m).keys()

    def values(self, m: PyneMap) -> PyneArray:
        return _map(m).values()


class MatrixNamespace:
    """Pine-like ``matrix.*`` namespace."""

    def __init__(
        self,
        *,
        max_cells: int | None = None,
        array_max_size: int | None = None,
        max_depth: int | None = None,
    ) -> None:
        self._max_cells = _normalize_limit(max_cells)
        self._array_max_size = _normalize_limit(array_max_size)
        self._max_depth = _normalize_limit(max_depth)

    def new(self, rows: int = 0, columns: int = 0, initial_value: Any = None) -> PyneMatrix:
        return PyneMatrix(
            rows,
            columns,
            initial_value,
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def new_float(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: float | None = None,
    ) -> PyneMatrix:
        return self.new(rows, columns, initial_value)

    def new_int(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: int | None = None,
    ) -> PyneMatrix:
        return self.new(rows, columns, initial_value)

    def new_bool(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: bool | None = None,
    ) -> PyneMatrix:
        return self.new(rows, columns, initial_value)

    def new_string(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: str | None = None,
    ) -> PyneMatrix:
        return self.new(rows, columns, initial_value)

    def new_color(
        self,
        rows: int = 0,
        columns: int = 0,
        initial_value: str | None = None,
    ) -> PyneMatrix:
        return self.new(rows, columns, initial_value)

    def from_rows(self, rows: Iterable[Iterable[Any]]) -> PyneMatrix:
        return PyneMatrix.from_rows(
            rows,
            max_cells=self._max_cells,
            array_max_size=self._array_max_size,
            max_depth=self._max_depth,
        )

    def copy(self, m: PyneMatrix) -> PyneMatrix:
        return _matrix(m).copy()

    def snapshot(self, m: PyneMatrix) -> PyneMatrix:
        return _matrix(m).snapshot()

    def rows(self, m: PyneMatrix) -> int:
        return _matrix(m).rows()

    def columns(self, m: PyneMatrix) -> int:
        return _matrix(m).columns()

    def elements_count(self, m: PyneMatrix) -> int:
        return _matrix(m).elements_count()

    def get(self, m: PyneMatrix, row: int, column: int) -> Any:
        return _matrix(m).get(row, column)

    def set(self, m: PyneMatrix, row: int, column: int, value: Any) -> None:
        _matrix(m).set(row, column, value)

    def fill(self, m: PyneMatrix, value: Any) -> None:
        _matrix(m).fill(value)

    def row(self, m: PyneMatrix, row: int) -> PyneArray:
        return _matrix(m).row(row)

    def col(self, m: PyneMatrix, column: int) -> PyneArray:
        return _matrix(m).col(column)

    def transpose(self, m: PyneMatrix) -> PyneMatrix:
        return _matrix(m).transpose()

    def reshape(self, m: PyneMatrix, rows: int, columns: int) -> PyneMatrix:
        return _matrix(m).reshape(rows, columns)

    def add(self, left: PyneMatrix, right: Any) -> PyneMatrix:
        return _matrix(left).add(right)

    def sub(self, left: PyneMatrix, right: Any) -> PyneMatrix:
        return _matrix(left).sub(right)

    def mult(self, left: PyneMatrix, right: Any) -> PyneMatrix:
        return _matrix(left).mult(right)

    def sum(self, m: PyneMatrix) -> float | None:
        return _matrix(m).sum()

    def avg(self, m: PyneMatrix) -> float | None:
        return _matrix(m).avg()

    def min(self, m: PyneMatrix) -> float | None:
        return _matrix(m).min()

    def max(self, m: PyneMatrix) -> float | None:
        return _matrix(m).max()


def _array(value: PyneArray) -> PyneArray:
    if not isinstance(value, PyneArray):
        raise TypeError("array.* expects a PyneArray created by array.new_*()")
    return value


def _map(value: PyneMap) -> PyneMap:
    if not isinstance(value, PyneMap):
        raise TypeError("map.* expects a PyneMap created by map.new()")
    return value


def _matrix(value: PyneMatrix) -> PyneMatrix:
    if not isinstance(value, PyneMatrix):
        raise TypeError("matrix.* expects a PyneMatrix created by matrix.new_*()")
    return value


def _resolve_index(index: int, length: int, *, name: str = "array index") -> int:
    idx = int(index)
    if idx < 0:
        idx = length + idx
    if idx < 0 or idx >= length:
        raise IndexError(f"{name} {int(index)} is out of bounds")
    return idx


def _matrix_dimension(value: int, label: str) -> int:
    normalized = int(value)
    if normalized < 0:
        raise ValueError(f"{label} must be non-negative")
    return normalized


def _array_size(value: int) -> int:
    normalized = int(value)
    if normalized < 0:
        raise ValueError("array size must be non-negative")
    return normalized


def _normalize_limit(limit: int | None) -> int | None:
    if limit is None:
        return None
    return max(int(limit), 1)


def _enforce_limit(label: str, size: int, limit: int | None) -> None:
    if limit is not None and size > limit:
        raise PyneSecurityError(f"{label} {size} exceeds limit {limit}")


def _validate_map_key(key: Any) -> None:
    if isinstance(key, (PyneArray, PyneMap, PyneMatrix)):
        raise ValueError("map keys must be scalar hashable values; collection keys are unsupported")
    try:
        hash(key)
    except TypeError as exc:
        raise ValueError("map key must be hashable") from exc


def _validate_stored_value(value: Any) -> None:
    if is_na_value(value):
        return
    if isinstance(value, ModuleType) or callable(value):
        raise ValueError(
            "collection values must be stable script values; "
            "callable and module values are unsupported"
        )


def _validate_collection_assignment(
    container: PyneArray | PyneMap | PyneMatrix,
    value: Any,
    max_depth: int | None,
) -> None:
    _validate_stored_value(value)
    _enforce_no_recursive_collection_value(container, value)
    _enforce_child_depth(value, max_depth)


def _enforce_acyclic_collection_value(value: Any) -> None:
    if _collection_has_cycle(value):
        raise PyneSecurityError("recursive collection values are unsupported")


def _enforce_no_recursive_collection_value(
    container: PyneArray | PyneMap | PyneMatrix,
    value: Any,
) -> None:
    if _collection_references(value, id(container)) or _collection_has_cycle(value):
        raise PyneSecurityError("recursive collection values are unsupported")


def _snapshot_value(value: Any, seen: set[int]) -> Any:
    if isinstance(value, PyneArray):
        return _snapshot_array(value, seen)
    if isinstance(value, PyneMap):
        return _snapshot_map(value, seen)
    if isinstance(value, PyneMatrix):
        return _snapshot_matrix(value, seen)
    return value


def _snapshot_array(value: PyneArray, seen: set[int]) -> PyneArray:
    identity = id(value)
    if identity in seen:
        raise PyneSecurityError("recursive collection snapshots are not supported")
    child_seen = {*seen, identity}
    return PyneArray(
        (_snapshot_value(item, child_seen) for item in value.to_list()),
        max_size=value._max_size,
        max_depth=value._max_depth,
    )


def _snapshot_map(value: PyneMap, seen: set[int]) -> PyneMap:
    identity = id(value)
    if identity in seen:
        raise PyneSecurityError("recursive collection snapshots are not supported")
    child_seen = {*seen, identity}
    return PyneMap(
        {key: _snapshot_value(item, child_seen) for key, item in value.to_dict().items()},
        max_size=value._max_size,
        array_max_size=value._array_max_size,
        max_depth=value._max_depth,
    )


def _snapshot_matrix(value: PyneMatrix, seen: set[int]) -> PyneMatrix:
    identity = id(value)
    if identity in seen:
        raise PyneSecurityError("recursive collection snapshots are not supported")
    child_seen = {*seen, identity}
    return PyneMatrix.from_rows(
        [
            [_snapshot_value(item, child_seen) for item in row]
            for row in value.to_list()
        ],
        max_cells=value._max_cells,
        array_max_size=value._array_max_size,
        max_depth=value._max_depth,
    )


def _enforce_child_depth(value: Any, limit: int | None) -> None:
    if limit is None:
        return
    depth = 1 + _collection_depth(value)
    if depth > limit:
        raise PyneSecurityError(f"collection nesting depth {depth} exceeds limit {limit}")


def _collection_depth(value: Any, seen: set[int] | None = None) -> int:
    seen = seen or set()
    if isinstance(value, PyneArray):
        identity = id(value)
        if identity in seen:
            return 1
        seen.add(identity)
        children = value.to_list()
        return 1 + _max_collection_depth(children, seen)
    if isinstance(value, PyneMap):
        identity = id(value)
        if identity in seen:
            return 1
        seen.add(identity)
        children = value.to_dict().values()
        return 1 + _max_collection_depth(children, seen)
    if isinstance(value, PyneMatrix):
        identity = id(value)
        if identity in seen:
            return 1
        seen.add(identity)
        children = (item for row in value.to_list() for item in row)
        return 1 + _max_collection_depth(children, seen)
    return 0


def _collection_references(value: Any, target_id: int, seen: set[int] | None = None) -> bool:
    seen = seen or set()
    if isinstance(value, PyneArray):
        identity = id(value)
        if identity == target_id:
            return True
        if identity in seen:
            return False
        seen.add(identity)
        return any(_collection_references(item, target_id, set(seen)) for item in value.to_list())
    if isinstance(value, PyneMap):
        identity = id(value)
        if identity == target_id:
            return True
        if identity in seen:
            return False
        seen.add(identity)
        return any(
            _collection_references(item, target_id, set(seen))
            for item in value.to_dict().values()
        )
    if isinstance(value, PyneMatrix):
        identity = id(value)
        if identity == target_id:
            return True
        if identity in seen:
            return False
        seen.add(identity)
        return any(
            _collection_references(item, target_id, set(seen))
            for row in value.to_list()
            for item in row
        )
    return False


def _collection_has_cycle(value: Any, path: set[int] | None = None) -> bool:
    path = path or set()
    if isinstance(value, PyneArray):
        identity = id(value)
        if identity in path:
            return True
        child_path = {*path, identity}
        return any(_collection_has_cycle(item, child_path) for item in value.to_list())
    if isinstance(value, PyneMap):
        identity = id(value)
        if identity in path:
            return True
        child_path = {*path, identity}
        return any(_collection_has_cycle(item, child_path) for item in value.to_dict().values())
    if isinstance(value, PyneMatrix):
        identity = id(value)
        if identity in path:
            return True
        child_path = {*path, identity}
        return any(
            _collection_has_cycle(item, child_path)
            for row in value.to_list()
            for item in row
        )
    return False


def _max_collection_depth(values: Iterable[Any], seen: set[int] | None = None) -> int:
    return max((_collection_depth(value, set(seen or set())) for value in values), default=0)


def _numeric_values(values: Iterable[Any]) -> list[float]:
    numbers: list[float] = []
    for item in values:
        if is_na_value(item):
            continue
        try:
            numbers.append(float(item))
        except (TypeError, ValueError):
            continue
    return numbers


def _sum_values(values: Iterable[Any]) -> float | None:
    numbers = _numeric_values(values)
    return float(sum(numbers)) if numbers else None


def _sort_descending(order: str | None, reverse: bool) -> bool:
    if order is None:
        return bool(reverse)
    normalized = str(order).strip().lower()
    if normalized == OrderNamespace.ascending:
        return False
    if normalized == OrderNamespace.descending:
        return True
    raise ValueError("array.sort() order must be order.ascending or order.descending")


def _values_equal(left: Any, right: Any) -> bool:
    if is_na_value(left) and is_na_value(right):
        return True
    return left == right


order_namespace = OrderNamespace()
array_namespace = ArrayNamespace()
map_namespace = MapNamespace()
matrix_namespace = MatrixNamespace()

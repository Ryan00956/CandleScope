from __future__ import annotations

import math

import numpy as np

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_array_namespace_core_mutations_and_accessors() -> None:
    result = pn.run(
        """
prices = array.new_float(2, 1.5)
array.push(prices, 3.5)
array.set(prices, 1, 2.5)
array.unshift(prices, 0.5)
removed = array.remove(prices, 0)
popped = array.pop(prices)
array.insert(prices, 2, 4.5)

plot(array.size(prices), "Size")
plot(array.get(prices, 0), "First")
plot(array.get(prices, -1), "Last")
plot(array.first(prices), "First Helper")
plot(array.last(prices), "Last Helper")
plot(removed, "Removed")
plot(popped, "Popped")
plot(array.indexof(prices, 4.5), "Index")
plot(array.includes(prices, 2.5), "Includes")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Size") == [3.0, 3.0, 3.0]
    assert result.values("First") == [1.5, 1.5, 1.5]
    assert result.values("Last") == [4.5, 4.5, 4.5]
    assert result.values("First Helper") == [1.5, 1.5, 1.5]
    assert result.values("Last Helper") == [4.5, 4.5, 4.5]
    assert result.values("Removed") == [0.5, 0.5, 0.5]
    assert result.values("Popped") == [3.5, 3.5, 3.5]
    assert result.values("Index") == [2.0, 2.0, 2.0]
    assert result.values("Includes") == [1.0, 1.0, 1.0]


def test_array_accepts_numpy_values_and_matches_nan_members() -> None:
    values = pn.PyneArray(np.array([1.0, math.nan, 3.0]))

    assert values.to_list()[0] == 1.0
    assert values.includes(math.nan)
    assert values.indexof(math.nan) == 1
    assert values.lastindexof(math.nan) == 1


def test_array_object_methods_copy_slice_fill_and_numeric_reducers() -> None:
    result = pn.run(
        """
values = array.from_values(1, 2, 3, 4)
copy = values.copy()
copy.fill(9, 1, 3)
window = copy.slice(1, 3)
array.reverse(window)

plot(values.sum(), "Sum")
plot(values.avg(), "Avg")
plot(values.min(), "Min")
plot(values.max(), "Max")
plot(copy.get(1), "Copy Changed")
plot(values.get(1), "Original Kept")
plot(window.get(0), "Window First")
plot(window.first(), "Object First")
plot(window.last(), "Object Last")
plot(array.lastindexof(copy, 9), "Last Index")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Sum") == [10.0, 10.0, 10.0]
    assert result.values("Avg") == [2.5, 2.5, 2.5]
    assert result.values("Min") == [1.0, 1.0, 1.0]
    assert result.values("Max") == [4.0, 4.0, 4.0]
    assert result.values("Copy Changed") == [9.0, 9.0, 9.0]
    assert result.values("Original Kept") == [2.0, 2.0, 2.0]
    assert result.values("Window First") == [9.0, 9.0, 9.0]
    assert result.values("Object First") == [9.0, 9.0, 9.0]
    assert result.values("Object Last") == [9.0, 9.0, 9.0]
    assert result.values("Last Index") == [2.0, 2.0, 2.0]


def test_array_sort_accepts_pine_like_order_constants() -> None:
    result = pn.run(
        """
descending = array.from_values(1, 3, 2)
array.sort(descending, order.descending)
ascending = descending.copy()
ascending.sort(order.ascending)
legacy = array.from_values(1, 3, 2)
array.sort(legacy, reverse=True)

label(array.join(descending, ","))
label(array.join(ascending, ","))
label(array.join(legacy, ","))
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "3,2,1",
        "1,2,3",
        "3,2,1",
    ]


def test_array_sort_indices_returns_sorted_original_positions() -> None:
    result = pn.run(
        """
values = array.from_values(20, 10, 30)
ascending = array.sort_indices(values)
descending = values.sort_indices(order.descending)

label(array.join(ascending, ","))
label(array.join(descending, ","))
label(array.join(values, ","))
plot(array.get(ascending, 0), "First Ascending Index")
plot(array.get(descending, 0), "First Descending Index")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "1,0,2",
        "2,0,1",
        "20,10,30",
    ]
    assert result.values("First Ascending Index") == [1.0, 1.0, 1.0]
    assert result.values("First Descending Index") == [2.0, 2.0, 2.0]


def test_array_snapshot_freezes_nested_collection_values() -> None:
    result = pn.run(
        """
inner = array.from_values(1)
outer = array.from_values(inner)
snap = array.snapshot(outer)
array.push(inner, 2)

snap_inner = array.get(snap, 0)
live_inner = array.get(outer, 0)
plot(array.size(snap_inner), "Snapshot Size")
plot(array.size(live_inner), "Live Size")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Snapshot Size") == [1.0, 1.0, 1.0]
    assert result.values("Live Size") == [2.0, 2.0, 2.0]


def test_collection_value_boundary_allows_supported_script_values() -> None:
    result = pn.run(
        """
values = array.new()
array.push(values, close)
array.push(values, color.red)
level = line.new(0, close[0], 1, close[1])
array.push(values, level)
nested = array.from_values(1)
array.push(values, nested)
array.push(values, na)

stored_close = array.get(values, 0)
stored_color = array.get(values, 1)
stored_line = array.get(values, 2)
stored_nested = array.get(values, 3)
stored_na = array.get(values, 4)

line.set_color(stored_line, stored_color)
plot(stored_close, "Stored Close")
plot(array.size(stored_nested), "Nested Size")
plot(nz(stored_na, 9), "Stored Na")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Stored Close") == [1.5, 2.5, 3.5]
    assert result.values("Nested Size") == [1.0, 1.0, 1.0]
    assert result.values("Stored Na") == [9.0, 9.0, 9.0]
    assert result.output["objects"]["lines"][0]["color"] == "#ef5350"


def test_collection_rejects_callable_values_with_actionable_error() -> None:
    result = pn.run(
        """
values = array.new()
array.push(values, lambda x: x)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "callable and module values are unsupported" in str(result.error)


def test_collection_rejects_module_values_with_actionable_error() -> None:
    result = pn.run(
        """
values = array.new()
array.push(values, np)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "callable and module values are unsupported" in str(result.error)


def test_array_rejects_recursive_collection_values_on_mutation() -> None:
    result = pn.run(
        """
values = array.new()
array.push(values, values)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "recursive collection values are unsupported" in str(result.error)


def test_map_rejects_recursive_collection_values_on_mutation() -> None:
    result = pn.run(
        """
levels = map.new()
map.put(levels, "self", levels)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "recursive collection values are unsupported" in str(result.error)


def test_matrix_rejects_recursive_collection_values_on_mutation() -> None:
    result = pn.run(
        """
grid = matrix.new(1, 1)
matrix.set(grid, 0, 0, grid)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "recursive collection values are unsupported" in str(result.error)


def test_array_join_and_clear_support_non_numeric_payloads() -> None:
    result = pn.run(
        """
names = array.new_string()
array.push(names, "fast")
array.push(names, "slow")
joined = array.join(names, "/")
array.clear(names)

label(joined)
plot(array.size(names), "Cleared Size")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["labels"][0]["text"] == "fast/slow"
    assert result.values("Cleared Size") == [0.0, 0.0, 0.0]


def test_array_out_of_bounds_errors_are_actionable() -> None:
    result = pn.run(
        """
values = array.new_float(1, 1.0)
array.get(values, 3)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "array index 3 is out of bounds" in str(result.error)


def test_array_rejects_pop_and_shift_on_empty_arrays() -> None:
    pop_result = pn.run(
        """
values = array.new()
array.pop(values)
""",
        _bars(),
        executor_mode="inline",
    )

    shift_result = pn.run(
        """
values = array.new()
array.shift(values)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not pop_result.ok
    assert pop_result.code == "PYNE_RUNTIME_ERROR"
    assert "array.pop() cannot pop from an empty array" in str(pop_result.error)
    assert not shift_result.ok
    assert shift_result.code == "PYNE_RUNTIME_ERROR"
    assert "array.shift() cannot shift from an empty array" in str(shift_result.error)


def test_array_limit_rejects_growth_past_settings_limit() -> None:
    result = pn.run(
        """
values = array.new_float(2, 1.0)
array.push(values, 3.0)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_array_size=2),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "array size 3 exceeds limit 2" in str(result.error)


def test_array_rejects_negative_constructor_size() -> None:
    result = pn.run(
        """
array.new_float(-1, 1.0)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "array size must be non-negative" in str(result.error)


def test_collection_depth_limit_allows_nested_values_within_limit() -> None:
    result = pn.run(
        """
inner = array.from_values(1, 2)
outer = array.new()
array.push(outer, inner)
nested = array.get(outer, 0)

plot(array.size(nested), "Nested Size")
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_collection_depth=2),
    )

    assert result.ok, result.error
    assert result.values("Nested Size") == [2.0, 2.0, 2.0]


def test_map_namespace_core_key_value_semantics() -> None:
    result = pn.run(
        """
levels = map.new()
map.put(levels, "fast", 10)
map.put(levels, "slow", 20)
removed = map.remove(levels, "fast")
map.put(levels, "signal", 9)

plot(map.size(levels), "Map Size")
plot(map.get(levels, "slow"), "Slow")
plot(map.get(levels, "missing", 42), "Default")
plot(map.contains(levels, "signal"), "Contains")
plot(removed, "Removed")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Map Size") == [2.0, 2.0, 2.0]
    assert result.values("Slow") == [20.0, 20.0, 20.0]
    assert result.values("Default") == [42.0, 42.0, 42.0]
    assert result.values("Contains") == [1.0, 1.0, 1.0]
    assert result.values("Removed") == [10.0, 10.0, 10.0]


def test_map_methods_copy_keys_and_values_interoperate_with_arrays() -> None:
    result = pn.run(
        """
weights = map.from_values("fast", 2, "slow", 4)
copy = weights.copy()
copy.put("signal", 8)
map.clear(weights)

keys = copy.keys()
vals = map.values(copy)

label(array.join(keys, "|"))
plot(weights.size(), "Original Size")
plot(copy.size(), "Copy Size")
plot(vals.sum(), "Value Sum")
plot(copy.get("signal"), "Signal")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["labels"][0]["text"] == "fast|slow|signal"
    assert result.values("Original Size") == [0.0, 0.0, 0.0]
    assert result.values("Copy Size") == [3.0, 3.0, 3.0]
    assert result.values("Value Sum") == [14.0, 14.0, 14.0]
    assert result.values("Signal") == [8.0, 8.0, 8.0]


def test_map_put_all_merges_source_map_and_overwrites_existing_keys() -> None:
    result = pn.run(
        """
target = map.from_values("fast", 2, "slow", 4)
source = map.from_values("slow", 8, "signal", 9)
map.put_all(target, source)
object_target = map.from_values("base", 1)
object_target.put_all(source)

label(array.join(map.keys(target), "|"))
plot(map.size(target), "Merged Size")
plot(map.get(target, "fast"), "Fast")
plot(map.get(target, "slow"), "Slow")
plot(map.get(target, "signal"), "Signal")
plot(object_target.get("signal"), "Object Signal")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["labels"][0]["text"] == "fast|slow|signal"
    assert result.values("Merged Size") == [3.0, 3.0, 3.0]
    assert result.values("Fast") == [2.0, 2.0, 2.0]
    assert result.values("Slow") == [8.0, 8.0, 8.0]
    assert result.values("Signal") == [9.0, 9.0, 9.0]
    assert result.values("Object Signal") == [9.0, 9.0, 9.0]


def test_map_snapshot_freezes_nested_collection_values() -> None:
    result = pn.run(
        """
inner = map.from_values("fast", 1)
outer = map.from_values("child", inner)
snap = map.snapshot(outer)
map.put(inner, "slow", 2)

snap_child = map.get(snap, "child")
live_child = map.get(outer, "child")
plot(map.size(snap_child), "Snapshot Size")
plot(map.size(live_child), "Live Size")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Snapshot Size") == [1.0, 1.0, 1.0]
    assert result.values("Live Size") == [2.0, 2.0, 2.0]


def test_map_from_values_requires_key_value_pairs() -> None:
    result = pn.run(
        """
map.from_values("fast", 1, "slow")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "map.from_values() expects key/value pairs" in str(result.error)


def test_map_rejects_unhashable_keys_with_actionable_error() -> None:
    result = pn.run(
        """
levels = map.new()
map.put(levels, ["fast"], 10)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "map key must be hashable" in str(result.error)


def test_map_rejects_collection_keys_with_actionable_error() -> None:
    result = pn.run(
        """
levels = map.new()
key = array.from_values("fast")
map.put(levels, key, 10)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "collection keys are unsupported" in str(result.error)


def test_map_limit_rejects_new_keys_past_settings_limit() -> None:
    result = pn.run(
        """
levels = map.new()
map.put(levels, "fast", 10)
map.put(levels, "slow", 20)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_map_size=1),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "map size 2 exceeds limit 1" in str(result.error)


def test_map_put_all_rejects_growth_past_settings_limit() -> None:
    result = pn.run(
        """
target = map.from_values("fast", 1)
source = map.from_values("slow", 2)
map.put_all(target, source)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_map_size=1),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "map size 2 exceeds limit 1" in str(result.error)


def test_map_limit_rejects_nested_values_past_depth_limit() -> None:
    result = pn.run(
        """
leaf = array.from_values(1)
middle = array.new()
array.push(middle, leaf)
levels = map.new()
map.put(levels, "too_deep", middle)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_collection_depth=2),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "collection nesting depth 3 exceeds limit 2" in str(result.error)


def test_matrix_namespace_core_accessors_and_mutations() -> None:
    result = pn.run(
        """
m = matrix.new_float(2, 3, 1.0)
matrix.set(m, 0, 1, 2.0)
matrix.set(m, 1, 2, 6.0)
row = matrix.row(m, 1)
col = matrix.col(m, 1)

plot(matrix.rows(m), "Rows")
plot(matrix.columns(m), "Columns")
plot(matrix.elements_count(m), "Elements")
plot(matrix.get(m, 0, 1), "Cell")
plot(array.sum(row), "Row Sum")
plot(array.sum(col), "Col Sum")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Rows") == [2.0, 2.0, 2.0]
    assert result.values("Columns") == [3.0, 3.0, 3.0]
    assert result.values("Elements") == [6.0, 6.0, 6.0]
    assert result.values("Cell") == [2.0, 2.0, 2.0]
    assert result.values("Row Sum") == [8.0, 8.0, 8.0]
    assert result.values("Col Sum") == [3.0, 3.0, 3.0]


def test_matrix_typed_constructors_support_bool_string_and_color_values() -> None:
    result = pn.run(
        """
flags = matrix.new_bool(1, 2, True)
names = matrix.new_string(1, 1, "fast")
colors = matrix.new_color(1, 1, color.red)

label(matrix.get(names, 0, 0))
plot(matrix.get(flags, 0, 1), "Flag")
plot(color.r(matrix.get(colors, 0, 0)), "Color R")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["labels"][0]["text"] == "fast"
    assert result.values("Flag") == [1.0, 1.0, 1.0]
    assert result.values("Color R") == [239.0, 239.0, 239.0]


def test_matrix_methods_copy_transpose_reshape_and_reducers() -> None:
    result = pn.run(
        """
m = matrix.from_rows([[1, 2, 3], [4, 5, 6]])
copy = m.copy()
copy.set(0, 0, 9)
t = m.transpose()
r = m.reshape(3, 2)

plot(m.get(0, 0), "Original")
plot(copy.get(0, 0), "Copy")
plot(t.get(2, 1), "Transpose Cell")
plot(r.get(2, 1), "Reshape Cell")
plot(m.sum(), "Sum")
plot(m.avg(), "Avg")
plot(m.min(), "Min")
plot(m.max(), "Max")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Original") == [1.0, 1.0, 1.0]
    assert result.values("Copy") == [9.0, 9.0, 9.0]
    assert result.values("Transpose Cell") == [6.0, 6.0, 6.0]
    assert result.values("Reshape Cell") == [6.0, 6.0, 6.0]
    assert result.values("Sum") == [21.0, 21.0, 21.0]
    assert result.values("Avg") == [3.5, 3.5, 3.5]
    assert result.values("Min") == [1.0, 1.0, 1.0]
    assert result.values("Max") == [6.0, 6.0, 6.0]


def test_matrix_snapshot_freezes_nested_collection_values() -> None:
    result = pn.run(
        """
inner = array.from_values(1)
m = matrix.new(1, 1, inner)
snap = matrix.snapshot(m)
array.push(inner, 2)

snap_inner = matrix.get(snap, 0, 0)
live_inner = matrix.get(m, 0, 0)
plot(array.size(snap_inner), "Snapshot Size")
plot(array.size(live_inner), "Live Size")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Snapshot Size") == [1.0, 1.0, 1.0]
    assert result.values("Live Size") == [2.0, 2.0, 2.0]


def test_matrix_add_sub_and_mult_support_scalars_and_matrices() -> None:
    result = pn.run(
        """
a = matrix.from_rows([[1, 2], [3, 4]])
b = matrix.from_rows([[5, 6], [7, 8]])
added = matrix.add(a, b)
scaled = matrix.mult(a, 2)
product = matrix.mult(a, b)
diff = matrix.sub(b, a)

plot(added.get(1, 1), "Added")
plot(scaled.get(1, 0), "Scaled")
plot(product.get(0, 1), "Product")
plot(diff.get(0, 0), "Diff")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Added") == [12.0, 12.0, 12.0]
    assert result.values("Scaled") == [6.0, 6.0, 6.0]
    assert result.values("Product") == [22.0, 22.0, 22.0]
    assert result.values("Diff") == [4.0, 4.0, 4.0]


def test_matrix_dimension_errors_are_actionable() -> None:
    result = pn.run(
        """
m = matrix.from_rows([[1, 2], [3, 4]])
matrix.reshape(m, 3, 3)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "matrix.reshape() cannot change element count" in str(result.error)


def test_matrix_rejects_negative_constructor_dimensions() -> None:
    result = pn.run(
        """
matrix.new_float(-1, 2, 0.0)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "matrix rows must be non-negative" in str(result.error)


def test_matrix_rejects_negative_reshape_dimensions() -> None:
    result = pn.run(
        """
m = matrix.from_rows([[1, 2], [3, 4]])
matrix.reshape(m, -1, 4)
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "matrix rows must be non-negative" in str(result.error)


def test_matrix_limit_rejects_cells_past_settings_limit() -> None:
    result = pn.run(
        """
matrix.new_float(2, 2, 0.0)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_matrix_cells=3),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "matrix cells 4 exceeds limit 3" in str(result.error)


def test_matrix_limit_rejects_initial_value_past_depth_limit() -> None:
    result = pn.run(
        """
leaf = array.from_values(1)
middle = array.new()
array.push(middle, leaf)
matrix.new(1, 1, middle)
""",
        _bars(),
        executor_mode="inline",
        settings=pn.PyneSettings(max_collection_depth=2),
    )

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "collection nesting depth 3 exceeds limit 2" in str(result.error)

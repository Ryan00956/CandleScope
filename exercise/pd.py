import pandas as pd

data = {
    "name": ["Alice", "Bob", "Carol", "David", "Eve"],
    "class": ["A", "A", "B", "B", "B"],
    "math": [90, 75, 95, 60, 88],
    "english": [85, 80, 92, 70, 84],
    "physics": [89, 73, 99, 66, 91],
}
a = pd.DataFrame(data)
b=a.groupby("class")[["math","english","physics"]].mean().reset_index()
print(b)

print(a)
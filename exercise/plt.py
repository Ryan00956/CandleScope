import matplotlib.pyplot as plt
import pandas as pd
import matplotlib.dates as mdates

# 创建示例数据
dates = pd.date_range("2025-10-01", periods=15)
prices = [100 + i + (i%3)*2 for i in range(15)]

plt.plot(dates, prices, marker='o')
plt.title("Formatted Date Axis")

# 设置日期格式
plt.gca().xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
plt.gca().xaxis.set_major_locator(mdates.DayLocator(interval=2))  # 每2天显示一个日期
plt.grid(True)
plt.show()


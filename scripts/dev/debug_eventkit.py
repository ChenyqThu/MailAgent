#!/usr/bin/env python3
"""调试脚本 - 查看 EventKit 返回的原始数据"""

from datetime import datetime, timedelta
import EventKit
from Foundation import NSDate

# 创建事件存储
store = EventKit.EKEventStore.alloc().init()

# 请求权限
import threading
done = threading.Event()
granted = [False]

def handler(g, e):
    granted[0] = g
    done.set()

store.requestAccessToEntityType_completion_(EventKit.EKEntityTypeEvent, handler)
done.wait(10)

if not granted[0]:
    print("未授权")
    exit(1)

# 找到 Exchange 日历
calendars = store.calendarsForEntityType_(EventKit.EKEntityTypeEvent)
target_cal = None
for cal in calendars:
    if cal.title() == "日历" and cal.source().sourceType() == 1:
        target_cal = cal
        break

if not target_cal:
    print("未找到日历")
    exit(1)

print(f"日历: {target_cal.title()}")
print("=" * 60)

# 获取最近几个事件
now = datetime.now()
start = now - timedelta(days=1)
end = now + timedelta(days=7)

start_ns = NSDate.dateWithTimeIntervalSince1970_(start.timestamp())
end_ns = NSDate.dateWithTimeIntervalSince1970_(end.timestamp())

predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
    start_ns, end_ns, [target_cal]
)
events = store.eventsMatchingPredicate_(predicate)

print(f"找到 {len(events)} 个事件\n")

# 显示前 3 个事件的详细信息
for i, event in enumerate(events[:3], 1):
    print(f"[事件 {i}]")
    print(f"  标题: {event.title()}")

    # 时间 - 原始 NSDate
    start_date = event.startDate()
    end_date = event.endDate()
    print(f"  开始 (NSDate): {start_date}")
    print(f"  结束 (NSDate): {end_date}")

    # 时间戳
    start_ts = start_date.timeIntervalSince1970()
    end_ts = end_date.timeIntervalSince1970()
    print(f"  开始时间戳: {start_ts}")
    print(f"  结束时间戳: {end_ts}")

    # 转换为本地时间
    import time
    start_local = time.localtime(start_ts)
    print(f"  开始 localtime: {time.strftime('%Y-%m-%d %H:%M:%S %Z', start_local)}")
    print(f"  tm_isdst: {start_local.tm_isdst}")

    # 时区信息
    print(f"  time.timezone: {time.timezone} ({time.timezone/3600}h)")
    print(f"  time.altzone: {time.altzone} ({time.altzone/3600}h)")
    print(f"  time.daylight: {time.daylight}")

    # Status - 原始值
    status = event.status()
    status_map = {0: "none", 1: "confirmed", 2: "tentative", 3: "cancelled"}
    print(f"  Status (raw): {status} -> {status_map.get(status, 'unknown')}")

    # Description/Notes - 原始格式
    notes = event.notes()
    print(f"  Notes type: {type(notes)}")
    if notes:
        print(f"  Notes (前500字符):")
        print("  ---")
        preview = notes[:500] if len(notes) > 500 else notes
        for line in preview.split('\n')[:10]:
            print(f"    {repr(line)}")
        print("  ---")
    else:
        print("  Notes: (空)")

    # 是否全天
    print(f"  全天事件: {event.isAllDay()}")

    # 时区属性（如果有）
    tz = event.timeZone()
    if tz:
        print(f"  事件时区: {tz.name()} (offset: {tz.secondsFromGMT()/3600}h)")
    else:
        print(f"  事件时区: (无)")

    print()

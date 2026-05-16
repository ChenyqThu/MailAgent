#!/usr/bin/env python3
"""
使用 EventKit (pyobjc) 读取日历
这是 Apple 官方推荐的日历访问方式，性能比 AppleScript 好得多
"""

import sys
from datetime import datetime, timedelta

def check_dependencies():
    """检查依赖"""
    try:
        import EventKit
        import Foundation
        return True
    except ImportError:
        print("需要安装 pyobjc-framework-EventKit")
        print("运行: pip install pyobjc-framework-EventKit pyobjc-framework-Cocoa")
        return False

def main():
    if not check_dependencies():
        return

    import EventKit
    from Foundation import NSDate

    print("=" * 60)
    print("EventKit 日历读取测试")
    print("=" * 60)

    # 创建事件存储
    store = EventKit.EKEventStore.alloc().init()

    # 请求访问权限（macOS 会弹出授权对话框）
    print("\n[1] 请求日历访问权限...")
    print("    如果弹出系统授权对话框，请点击'允许'")

    # 同步方式请求权限
    import threading
    access_granted = [None]
    access_error = [None]
    done_event = threading.Event()

    def completion_handler(granted, error):
        access_granted[0] = granted
        access_error[0] = error
        done_event.set()

    store.requestAccessToEntityType_completion_(
        EventKit.EKEntityTypeEvent,
        completion_handler
    )

    # 等待授权结果
    done_event.wait(timeout=30)

    if not access_granted[0]:
        print(f"❌ 日历访问被拒绝")
        if access_error[0]:
            print(f"   错误: {access_error[0]}")
        print("\n请在 系统设置 > 隐私与安全 > 日历 中允许终端/Python 访问日历")
        return

    print("✅ 日历访问已授权")

    # 获取所有日历
    print("\n[2] 获取所有日历...")
    calendars = store.calendarsForEntityType_(EventKit.EKEntityTypeEvent)

    print(f"找到 {len(calendars)} 个日历:\n")
    exchange_calendar = None

    for i, cal in enumerate(calendars, 1):
        cal_title = cal.title()
        cal_id = cal.calendarIdentifier()
        source = cal.source()
        source_title = source.title() if source else "Unknown"
        source_type = source.sourceType() if source else -1

        # 源类型: 0=Local, 1=Exchange, 2=CalDAV, 3=MobileMe, 4=Subscribed, 5=Birthdays
        source_type_name = {
            0: "Local",
            1: "Exchange",
            2: "CalDAV",
            3: "MobileMe",
            4: "Subscribed",
            5: "Birthdays"
        }.get(source_type, f"Unknown({source_type})")

        print(f"  {i}. {cal_title}")
        print(f"     源: {source_title} ({source_type_name})")
        print(f"     ID: {cal_id[:30]}...")

        # 查找 Exchange 日历（优先选择名为"日历"的）
        if source_type == 1:  # Exchange
            print(f"     ⭐ 这是 Exchange 日历!")
            # 优先选择名为"日历"的 Exchange 日历
            if cal_title == "日历":
                exchange_calendar = cal
            elif exchange_calendar is None:
                exchange_calendar = cal

    # 如果没找到 Exchange，使用第一个非系统日历
    if not exchange_calendar:
        print("\n未找到 Exchange 日历，使用第一个可用日历...")
        for cal in calendars:
            source_type = cal.source().sourceType() if cal.source() else -1
            if source_type not in [5]:  # 排除生日日历
                exchange_calendar = cal
                break

    if not exchange_calendar:
        print("❌ 没有可用的日历")
        return

    target_cal = exchange_calendar
    print(f"\n[3] 读取日历 '{target_cal.title()}' 的事件...")

    # 设置时间范围
    now = datetime.now()
    start = now - timedelta(days=1)
    end = now + timedelta(days=7)

    # 转换为 NSDate
    start_ns = NSDate.dateWithTimeIntervalSince1970_(start.timestamp())
    end_ns = NSDate.dateWithTimeIntervalSince1970_(end.timestamp())

    # 创建查询谓词
    predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
        start_ns, end_ns, [target_cal]
    )

    # 获取事件
    events = store.eventsMatchingPredicate_(predicate)

    print(f"找到 {len(events)} 个事件 (过去1天 + 未来7天):\n")

    for i, event in enumerate(events[:20], 1):  # 显示前20个
        print(f"  事件 {i}:")
        print(f"    📌 标题: {event.title()}")

        # 开始时间
        start_date = event.startDate()
        if start_date:
            start_ts = start_date.timeIntervalSince1970()
            start_dt = datetime.fromtimestamp(start_ts)
            print(f"    🕐 开始: {start_dt.strftime('%Y-%m-%d %H:%M')}")

        # 结束时间
        end_date = event.endDate()
        if end_date:
            end_ts = end_date.timeIntervalSince1970()
            end_dt = datetime.fromtimestamp(end_ts)
            print(f"    🕑 结束: {end_dt.strftime('%Y-%m-%d %H:%M')}")

        # 全天事件
        print(f"    📅 全天: {event.isAllDay()}")

        # 地点
        location = event.location()
        print(f"    📍 地点: {location or '(无)'}")

        # 事件标识符
        event_id = event.eventIdentifier()
        print(f"    🔑 Event ID: {event_id}")

        # Calendar Item ID (更稳定的标识符)
        calendar_item_id = event.calendarItemIdentifier()
        print(f"    🔑 Calendar Item ID: {calendar_item_id}")

        # 状态
        status = event.status()
        status_name = {0: "none", 1: "confirmed", 2: "tentative", 3: "cancelled"}.get(status, str(status))
        print(f"    📋 状态: {status_name}")

        # 组织者
        organizer = event.organizer()
        if organizer:
            org_name = organizer.name() or ""
            org_email = organizer.emailAddress() or ""
            print(f"    👤 组织者: {org_name} <{org_email}>")

        # 参与者
        attendees = event.attendees()
        if attendees and len(attendees) > 0:
            att_list = []
            for att in attendees[:5]:  # 最多显示5个
                att_name = att.name() or att.emailAddress() or "Unknown"
                part_status = att.participantStatus()
                status_str = {0: "unknown", 1: "pending", 2: "accepted",
                              3: "declined", 4: "tentative"}.get(part_status, str(part_status))
                att_list.append(f"{att_name}({status_str})")
            print(f"    👥 参与者: {', '.join(att_list)}")
            if len(attendees) > 5:
                print(f"       ... 还有 {len(attendees) - 5} 人")

        # 备注
        notes = event.notes()
        if notes:
            notes_preview = notes[:100] + "..." if len(notes) > 100 else notes
            notes_preview = notes_preview.replace('\n', ' ')
            print(f"    📝 备注: {notes_preview}")

        # URL
        url = event.URL()
        if url:
            print(f"    🔗 URL: {url.absoluteString()}")

        # 重复规则
        if event.hasRecurrenceRules():
            rules = event.recurrenceRules()
            if rules:
                print(f"    🔄 重复: 是 ({len(rules)} 条规则)")

        # 最后修改日期
        last_modified = event.lastModifiedDate()
        if last_modified:
            mod_ts = last_modified.timeIntervalSince1970()
            mod_dt = datetime.fromtimestamp(mod_ts)
            print(f"    ✏️  修改时间: {mod_dt.strftime('%Y-%m-%d %H:%M')}")

        print()

    if len(events) > 20:
        print(f"  ... 还有 {len(events) - 20} 个事件")

    # 总结
    print("\n" + "=" * 60)
    print("测试摘要")
    print("=" * 60)
    print(f"""
✅ 日历访问: 成功
✅ 目标日历: {target_cal.title()}
✅ 事件数量: {len(events)}

可获取的字段:
  - Event ID / Calendar Item ID ✓ (用于去重)
  - 标题 ✓
  - 开始/结束时间 ✓
  - 全天事件标记 ✓
  - 地点 ✓
  - 备注/描述 ✓
  - 状态 (confirmed/tentative/cancelled) ✓
  - 组织者 ✓
  - 参与者列表 ✓
  - 重复规则 ✓
  - 最后修改时间 ✓
  - URL ✓

🎉 EventKit 方案验证成功！

下一步:
  1. 在 Notion 中创建日历数据库
  2. 将 Database ID 添加到 .env
  3. 开始实现完整同步
""")

if __name__ == "__main__":
    main()

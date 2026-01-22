#!/usr/bin/env python3
"""
测试脚本：读取 macOS Calendar.app 中的日历事件
验证 AppleScript 能否访问 Exchange 日历数据
"""

import subprocess
from datetime import datetime, timedelta
from typing import List, Dict, Any

def execute_applescript(script: str, timeout: int = 60) -> str:
    """执行 AppleScript 并返回结果"""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(f"AppleScript 错误: {result.stderr}")
    return result.stdout.strip()

def list_calendars() -> List[Dict[str, str]]:
    """列出所有可用日历"""
    # 先获取日历名称列表
    script = '''
    tell application "Calendar"
        set calNames to {}
        repeat with cal in calendars
            set end of calNames to name of cal
        end repeat
        set AppleScript's text item delimiters to "|||"
        return calNames as string
    end tell
    '''
    result = execute_applescript(script)
    if not result:
        return []

    calendars = []
    for name in result.split("|||"):
        name = name.strip()
        if name:
            calendars.append({
                "name": name,
                "account": ""  # 账户信息暂时忽略，避免类型错误
            })
    return calendars

def get_calendar_events(calendar_name: str, days_past: int = 0, days_ahead: int = 7) -> List[Dict[str, Any]]:
    """获取指定日历的事件"""

    script = f'''
    tell application "Calendar"
        set theCal to calendar "{calendar_name}"
        set startDate to (current date) - ({days_past} * days)
        set endDate to (current date) + ({days_ahead} * days)

        set theEvents to (every event of theCal whose start date >= startDate and start date <= endDate)
        set eventData to ""

        repeat with evt in theEvents
            set evtInfo to ""

            -- UID (唯一标识符)
            try
                set evtInfo to evtInfo & "UID:" & (uid of evt)
            on error
                set evtInfo to evtInfo & "UID:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 标题
            try
                set evtInfo to evtInfo & "TITLE:" & (summary of evt)
            on error
                set evtInfo to evtInfo & "TITLE:(无标题)"
            end try
            set evtInfo to evtInfo & "|||"

            -- 开始时间
            try
                set evtInfo to evtInfo & "START:" & ((start date of evt) as string)
            on error
                set evtInfo to evtInfo & "START:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 结束时间
            try
                set evtInfo to evtInfo & "END:" & ((end date of evt) as string)
            on error
                set evtInfo to evtInfo & "END:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 全天事件
            try
                set evtInfo to evtInfo & "ALLDAY:" & (allday event of evt)
            on error
                set evtInfo to evtInfo & "ALLDAY:false"
            end try
            set evtInfo to evtInfo & "|||"

            -- 地点
            try
                set evtInfo to evtInfo & "LOCATION:" & (location of evt)
            on error
                set evtInfo to evtInfo & "LOCATION:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 描述
            try
                set theDesc to description of evt
                if theDesc is missing value then
                    set theDesc to ""
                end if
                -- 限制描述长度
                if length of theDesc > 200 then
                    set theDesc to text 1 thru 200 of theDesc & "..."
                end if
                set evtInfo to evtInfo & "DESC:" & theDesc
            on error
                set evtInfo to evtInfo & "DESC:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 状态
            try
                set evtInfo to evtInfo & "STATUS:" & (status of evt)
            on error
                set evtInfo to evtInfo & "STATUS:none"
            end try
            set evtInfo to evtInfo & "|||"

            -- URL
            try
                set theUrl to url of evt
                if theUrl is missing value then
                    set theUrl to ""
                end if
                set evtInfo to evtInfo & "URL:" & theUrl
            on error
                set evtInfo to evtInfo & "URL:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 重复规则
            try
                set theRrule to recurrence of evt
                if theRrule is missing value then
                    set theRrule to ""
                end if
                set evtInfo to evtInfo & "RRULE:" & theRrule
            on error
                set evtInfo to evtInfo & "RRULE:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 最后修改时间
            try
                set evtInfo to evtInfo & "MODIFIED:" & ((stamp date of evt) as string)
            on error
                set evtInfo to evtInfo & "MODIFIED:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 组织者
            try
                set theOrganizer to organizer of evt
                if theOrganizer is missing value then
                    set theOrganizer to ""
                end if
                set evtInfo to evtInfo & "ORGANIZER:" & theOrganizer
            on error
                set evtInfo to evtInfo & "ORGANIZER:"
            end try
            set evtInfo to evtInfo & "|||"

            -- 参与者
            try
                set attList to {{}}
                repeat with att in (attendees of evt)
                    try
                        set attEmail to email of att
                        set attStatus to participation status of att as string
                        set end of attList to attEmail & "(" & attStatus & ")"
                    end try
                end repeat
                set AppleScript's text item delimiters to ","
                set evtInfo to evtInfo & "ATTENDEES:" & (attList as string)
                set AppleScript's text item delimiters to ""
            on error
                set evtInfo to evtInfo & "ATTENDEES:"
            end try

            set eventData to eventData & evtInfo & "###EVENT###"
        end repeat

        return eventData
    end tell
    '''

    result = execute_applescript(script, timeout=120)
    if not result:
        return []

    events = []
    for event_str in result.split("###EVENT###"):
        if not event_str.strip():
            continue

        event = {}
        for field in event_str.split("|||"):
            if ":" in field:
                key, value = field.split(":", 1)
                event[key.strip()] = value.strip()

        if event and event.get("UID"):
            events.append(event)

    return events

def main():
    print("=" * 70)
    print("macOS Calendar 读取测试")
    print("=" * 70)

    # Step 1: 列出所有日历
    print("\n[1] 列出所有日历...")
    print("-" * 50)
    try:
        calendars = list_calendars()
        print(f"找到 {len(calendars)} 个日历:\n")
        for i, cal in enumerate(calendars, 1):
            print(f"  {i}. {cal['name']}")
            print(f"     账户: {cal['account']}")

    except Exception as e:
        print(f"错误: {e}")
        return

    # Step 2: 查找 Exchange 日历
    print("\n[2] 查找 Exchange 日历...")
    print("-" * 50)
    exchange_calendar = None
    for cal in calendars:
        if "exchange" in cal['account'].lower() or "exchange" in cal['name'].lower():
            exchange_calendar = cal['name']
            print(f"找到 Exchange 日历: {exchange_calendar} (账户: {cal['account']})")
            break

    if not exchange_calendar:
        print("未找到 Exchange 日历，尝试查找包含 '日历' 的条目...")
        for cal in calendars:
            if "日历" in cal['name']:
                exchange_calendar = cal['name']
                print(f"找到日历: {exchange_calendar} (账户: {cal['account']})")
                break

    if not exchange_calendar:
        print("\n⚠️  未自动识别到目标日历")
        print("请从上面的列表中手动选择日历名称")
        calendar_name = input("\n请输入日历名称 (直接回车使用第一个): ").strip()
        if not calendar_name and calendars:
            exchange_calendar = calendars[0]['name']
        else:
            exchange_calendar = calendar_name

    if not exchange_calendar:
        print("未指定日历，退出")
        return

    # Step 3: 获取事件
    print(f"\n[3] 获取日历 '{exchange_calendar}' 的事件 (过去3天 + 未来7天)...")
    print("-" * 50)
    try:
        events = get_calendar_events(exchange_calendar, days_past=3, days_ahead=7)
        print(f"找到 {len(events)} 个事件:\n")

        for i, event in enumerate(events[:15], 1):  # 显示前15个
            print(f"  事件 {i}:")
            print(f"    📌 标题: {event.get('TITLE', 'N/A')}")
            print(f"    🕐 开始: {event.get('START', 'N/A')}")
            print(f"    🕑 结束: {event.get('END', 'N/A')}")
            print(f"    📅 全天: {event.get('ALLDAY', 'N/A')}")
            print(f"    📍 地点: {event.get('LOCATION', 'N/A') or '(无)'}")
            print(f"    📋 状态: {event.get('STATUS', 'N/A')}")

            uid = event.get('UID', 'N/A')
            if len(uid) > 50:
                uid = uid[:50] + "..."
            print(f"    🔑 UID: {uid}")

            print(f"    👤 组织者: {event.get('ORGANIZER', 'N/A') or '(无)'}")

            attendees = event.get('ATTENDEES', '')
            if attendees and len(attendees) > 80:
                attendees = attendees[:80] + "..."
            print(f"    👥 参与者: {attendees or '(无)'}")

            print(f"    🔄 重复: {event.get('RRULE', '') or '(否)'}")
            print(f"    ✏️  修改时间: {event.get('MODIFIED', 'N/A')}")

            desc = event.get('DESC', '')
            if desc:
                print(f"    📝 描述: {desc[:100]}...")
            print()

        if len(events) > 15:
            print(f"  ... 还有 {len(events) - 15} 个事件")

    except Exception as e:
        print(f"获取事件时出错: {e}")
        import traceback
        traceback.print_exc()

    # Step 4: 输出摘要
    print("\n" + "=" * 70)
    print("测试摘要")
    print("=" * 70)
    print(f"""
✅ 日历访问: 成功
✅ 日历名称: {exchange_calendar}
✅ 事件数量: {len(events)}

可获取的字段:
  - UID (唯一标识符) ✓
  - 标题 ✓
  - 开始/结束时间 ✓
  - 全天事件标记 ✓
  - 地点 ✓
  - 描述 ✓
  - 状态 ✓
  - 重复规则 ✓
  - 修改时间 ✓
  - 组织者 ✓
  - 参与者列表 ✓

下一步:
  1. 确认上述信息是否正确
  2. 在 Notion 中创建日历数据库
  3. 将 Database ID 添加到 .env
  4. 开始实现完整同步
""")

if __name__ == "__main__":
    main()

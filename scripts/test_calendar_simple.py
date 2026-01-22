#!/usr/bin/env python3
"""
简化版日历测试 - 逐步验证 AppleScript 能力
"""

import subprocess

def run_applescript(script: str, timeout: int = 30) -> str:
    """执行 AppleScript"""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=timeout
    )
    if result.returncode != 0:
        print(f"错误: {result.stderr}")
        return ""
    return result.stdout.strip()

def main():
    print("=" * 60)
    print("日历测试 - 简化版")
    print("=" * 60)

    # Step 1: 获取所有日历的详细信息
    print("\n[1] 获取日历详细信息...")
    script = '''
    tell application "Calendar"
        set output to ""
        set calIndex to 1
        repeat with cal in calendars
            set calName to name of cal
            set calId to uid of cal
            set output to output & calIndex & ". " & calName & " | ID: " & calId & linefeed
            set calIndex to calIndex + 1
        end repeat
        return output
    end tell
    '''
    result = run_applescript(script)
    print(result)

    # Step 2: 尝试获取第一个"日历"的事件数量
    print("\n[2] 获取每个日历的事件数量...")
    script = '''
    tell application "Calendar"
        set output to ""
        repeat with cal in calendars
            set calName to name of cal
            try
                set eventCount to count of events of cal
                set output to output & calName & ": " & eventCount & " 个事件" & linefeed
            on error
                set output to output & calName & ": 无法获取" & linefeed
            end try
        end repeat
        return output
    end tell
    '''
    result = run_applescript(script, timeout=60)
    print(result)

    # Step 3: 获取最近 1 天的事件（简化版，只获取标题和时间）
    print("\n[3] 获取未来1天的事件（简化版）...")
    script = '''
    tell application "Calendar"
        set output to ""
        set startDate to current date
        set endDate to startDate + (1 * days)

        repeat with cal in calendars
            set calName to name of cal
            try
                set theEvents to (every event of cal whose start date >= startDate and start date <= endDate)
                if (count of theEvents) > 0 then
                    set output to output & "【" & calName & "】" & linefeed
                    repeat with evt in theEvents
                        set evtTitle to summary of evt
                        set evtStart to start date of evt
                        set output to output & "  - " & evtTitle & " @ " & (evtStart as string) & linefeed
                    end repeat
                end if
            on error errMsg
                set output to output & calName & ": 错误 - " & errMsg & linefeed
            end try
        end repeat
        return output
    end tell
    '''
    result = run_applescript(script, timeout=60)
    if result:
        print(result)
    else:
        print("未获取到事件或出错")

    # Step 4: 尝试获取单个事件的完整信息
    print("\n[4] 获取第一个日历的第一个事件详情...")
    script = '''
    tell application "Calendar"
        set cal to first calendar
        set calName to name of cal
        set output to "日历: " & calName & linefeed

        try
            set evt to first event of cal
            set output to output & "标题: " & (summary of evt) & linefeed
            set output to output & "开始: " & ((start date of evt) as string) & linefeed
            set output to output & "结束: " & ((end date of evt) as string) & linefeed
            set output to output & "UID: " & (uid of evt) & linefeed

            try
                set output to output & "地点: " & (location of evt) & linefeed
            end try

            try
                set output to output & "全天: " & (allday event of evt) & linefeed
            end try

            try
                set evtStatus to status of evt
                set output to output & "状态: " & evtStatus & linefeed
            end try

        on error errMsg
            set output to output & "错误: " & errMsg & linefeed
        end try

        return output
    end tell
    '''
    result = run_applescript(script, timeout=30)
    print(result)

    # Step 5: 测试按日历 UID 获取（更精确）
    print("\n[5] 按 UID 区分同名日历...")
    script = '''
    tell application "Calendar"
        set output to ""
        repeat with cal in calendars
            if name of cal is "日历" then
                set calId to uid of cal
                set eventCount to count of events of cal
                set output to output & "日历 (UID: " & calId & ") - " & eventCount & " 个事件" & linefeed
            end if
        end repeat
        return output
    end tell
    '''
    result = run_applescript(script, timeout=30)
    print(result)

    print("\n" + "=" * 60)
    print("测试完成")
    print("=" * 60)

if __name__ == "__main__":
    main()

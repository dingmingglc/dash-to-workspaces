#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rebuild zh_CN .po with correct UTF-8 Chinese, then compile .mo."""
import re
import subprocess

TRANS = {
    "Dash to Workspaces has been updated!": "Dash to Workspaces 已更新！",
    "You are now running version": "您当前运行的版本为",
    "See what's new": "查看更新内容",
    "Top Bar": "顶栏",
    "Show Desktop button height (px)": "显示桌面按钮高度（像素）",
    "Show Desktop button width (px)": "显示桌面按钮宽度（像素）",
    "Left": "左",
    "Center": "中",
    "Right": "右",
    "Top": "上",
    "Middle": "中",
    "Bottom": "下",
    "Start": "起始",
    "End": "末尾",
    "Show Applications button": "显示应用程序按钮",
    "Activities button": "活动按钮",
    "Taskbar": "任务栏",
    "Date menu": "日期菜单",
    "System menu": "系统菜单",
    "Left box": "左侧区域",
    "Center box": "中间区域",
    "Right box": "右侧区域",
    "Desktop button": "桌面按钮",
    "Move up": "上移",
    "Move down": "下移",
    "Visible": "可见",
    "Select element position": "选择元素位置",
    "Stacked to top": "靠上堆叠",
    "Stacked to left": "靠左堆叠",
    "Stacked to bottom": "靠下堆叠",
    "Stacked to right": "靠右堆叠",
    "Centered": "居中",
    "Monitor Center": "显示器中央",
    "More options": "更多选项",
    "Reset to defaults": "恢复默认",
    "Show Applications options": "显示应用程序选项",
    "Open icon": "打开图标",
    "Show Desktop options": "显示桌面选项",
    "Primary monitor": "主显示器",
    "Monitor ": "显示器 ",
    "Running Indicator Options": "运行指示器选项",
    "Dynamic opacity options": "动态透明度选项",
    "Intellihide options": "智能隐藏选项",
    "Window preview options": "窗口预览选项",
    "Isolate Workspaces options": "工作区隔离选项",
    "Isolate monitors options": "显示器隔离选项",
    "Ungrouped application options": "未分组应用选项",
    "Customize middle-click behavior": "自定义中键点击行为",
    "Text": "文本",
    "Command": "命令",
    "Remove": "移除",
    "Customize panel scroll behavior": "自定义面板滚动行为",
    "Customize icon scroll behavior": "自定义图标滚动行为",
    "Advanced hotkeys options": "高级快捷键选项",
    "Secondary Menu Options": "次级菜单选项",
    "%d ms": "%d 毫秒",
    "%d °": "%d °",
    "%d %%": "%d %%",
    "%.1f": "%.1f",
    "%d icon": "%d 个图标",
    "App icon animation options": "应用图标动画选项",
    "App icon highlight options": "应用图标高亮选项",
    "Export settings": "导出设置",
    "Import settings": "导入设置",
    "Quit": "退出",
    "Quit %d Window": "退出 %d 个窗口",
    "Power options": "电源选项",
    "Event logs": "事件日志",
    "System": "系统",
    "Device Management": "设备管理",
    "Disk Management": "磁盘管理",
    "Unlock taskbar": "解锁任务栏",
    "Lock taskbar": "锁定任务栏",
    "Gnome Settings": "GNOME 设置",
    "Dash to Workspaces Settings": "Dash to Workspaces 设置",
    "Restore Windows": "恢复窗口",
    "Show Desktop": "显示桌面",
    "No favorites": "无收藏",
    "New Window": "新建窗口",
    "Empty": "空",
    "Move to current Workspace": "移动到当前工作区",
}

def main():
    with open("dash-to-workspaces.pot", "r", encoding="utf-8") as f:
        content = f.read()

    # Fix header for zh_CN
    content = content.replace('"Language: \\n"', '"Language: zh_CN\\n"', 1)
    content = content.replace(
        '"Plural-Forms: nplurals=INTEGER; plural=EXPRESSION;\\n"',
        '"Plural-Forms: nplurals=1; plural=0;\\n"',
        1,
    )
    content = re.sub(
        r"# SOME DESCRIPTIVE TITLE\..*?#, fuzzy\n",
        "# Dash to Workspaces - Simplified Chinese\n# Copyright (C) 2026\n#\n",
        content,
        count=1,
        flags=re.DOTALL,
    )

    # Replace each msgstr "" with translation (escape backslash and quote in msgstr)
    for msgid, msgstr in TRANS.items():
        escaped_id = re.escape(msgid)
        escaped_str = msgstr.replace("\\", "\\\\").replace('"', '\\"')
        if "%d" in msgid or "%.1f" in msgid:
            pattern = r'(msgid "' + escaped_id + r'"\nmsgstr )""'
        else:
            pattern = r'(msgid "' + escaped_id + r'"\nmsgstr )""'
        content = re.sub(pattern, r'\1"' + escaped_str + '"', content, count=1)

    # Plural: Chinese uses only msgstr[0]
    content = re.sub(
        r'(msgid "%d icon"\nmsgid_plural "%d icons"\n)msgstr\[0\] ""\nmsgstr\[1\] ""',
        r'\1msgstr[0] "%d 个图标"',
        content,
    )
    content = re.sub(
        r'(msgid "Quit %d Window"\nmsgid_plural "Quit %d Windows"\n)msgstr\[0\] ""\nmsgstr\[1\] ""',
        r'\1msgstr[0] "退出 %d 个窗口"',
        content,
    )

    out_path = "locale/zh_CN/LC_MESSAGES/dash-to-workspaces.po"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("Wrote", out_path)

    # Compile .mo
    r = subprocess.run(
        [
            "msgfmt",
            "-o",
            "locale/zh_CN/LC_MESSAGES/dash-to-workspaces.mo",
            out_path,
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print("msgfmt stderr:", r.stderr)
        raise SystemExit(1)
    print("Compiled dash-to-workspaces.mo")

if __name__ == "__main__":
    main()

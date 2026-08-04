"""IM 对话接入（08-01 阶段 2）—— MVP 平台 = 飞书。

模块分工：

| 模块 | 职责 |
|---|---|
| ``state`` | ``im.feishu.*`` sync_state 键**常量单源** + 读写门面（读侧必须 import 勿手抄） |
| ``credentials`` | env 首次 seed → ``external_credential`` 行权威；bot 身份回填 metadata |
| ``pairing`` | 一次性绑定码（CLI 出码 → 飞书私聊发码 → 落 owner ``open_id``） |
| ``preflight`` | 建连前的多实例互斥检测（pm2 ``mail-sync`` × 打包 ``.app``） |
| ``connection`` | lark WS 长连接的**线程宿主** + 优雅停机（🔴 lark 全局 loop 的坑都在这里） |
| ``lark_api`` | lark HTTP 面的唯一封装（发消息 / bot 身份 / 事件解析） |
| ``delivery`` | 分块 + 重试 + 显式成败日志（不认识 lark，可离线测） |
| ``dedupe`` | ``event_id`` 有界 LRU（飞书超时重推不重复执行） |
| ``executor`` | daemon 线程 + 有界队列（3 秒 ACK 的「甩出去」那一端） |
| ``handler`` | 事件路由（私聊/去重/绑定三道门）+ ``handle_owner_message`` PR-3 接缝（生产由 worker 注入 bridge） |
| ``worker`` | 常驻 worker：闸 → 建连 → 监控 → 状态落盘 → episode 告警 + **PR-3 桥接线** |
| ``bridge`` | **PR-3 本体**：消息→gateway ``im_chat`` run→回投 + 飞书内审批闭环（卡片/decide/repaused 补卡） |
| ``gateway_client`` | gateway loopback HTTP 面（im-chat SSE drain / pending / decide / stop，typed 结果不抛） |
| ``history`` | CHAT_DB 行 → UIMessage 历史重建 + 预算裁剪（多轮连续的关键——gateway 不自动拼历史） |
| ``cards`` | 通用审批卡 JSON（Q13=B；schema 2.0 + callback 按钮 + PATCH 终态卡） |
| ``logfmt`` | 日志摘要化（🔴 绝不整体转储 SDK 错误对象 / 用户正文） |

🔴 **本包顶层不 import lark_oapi**（连间接都不行）—— 见 ``connection`` 模块 docstring：
lark 的 ws 客户端在 import 期抓一个全局 event loop，在服务主循环线程上 import 会把它
抓成主 loop，之后 ``start()`` 当场 RuntimeError。所有 lark import 都在函数体内。
"""

from src.im.worker import FeishuImWorker, feishu_im_ready

__all__ = ["FeishuImWorker", "feishu_im_ready"]

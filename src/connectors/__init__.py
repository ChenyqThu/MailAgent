"""MCP connector（外部服务接入 harness，阶段 1 PR1）—— Python serve-api 持有 MCP **client**。

与 ``src/mcp/``（我们对外交付 skill 的 MCP **server** 侧）语义分离：本包是「MailAgent 作为
客户端去连 Notion / Atlassian 等远程 MCP 服务」的那条腿（OAuth 2.1 + PKCE + DCR、token
保管、工具清单同步）。命名 ``connectors`` 避免与 server 侧撞名（排雷报告 §六 / 风险 9）。

模块分工：
  - ``registry``       已知 connector 常量表（server_url / namespace / 展示名）
  - ``token_storage``  MCP SDK ``TokenStorage`` protocol → ``agent_config.credentials`` 适配器
  - ``oauth_flow``     OAuth 回调 rendezvous（state → 单次消费 + TTL）+ 每 connector 在途流状态
  - ``gate``           按 namespace 的单飞闸（罩 tool-call **与** token 刷新，风险 3）
  - ``client``         ConnectorClient：三层装配 provider → httpx2.AsyncClient → streamable http

灰度开关 ``MAILAGENT_MCP_CONNECTORS``（pydantic ``mcp_connectors_enabled``，默认 off）；
off 时 ``/api/connector/*`` 除 callback 外全部 409，本包不被任何常驻路径 import。
"""

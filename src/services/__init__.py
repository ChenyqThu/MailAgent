"""Transport-neutral application service layer.

「把领域对象 (NotionSync / EmailRepository / SyncStore / OutboxRepository /
backend) 编排成一个写操作」+「守卫 (auth / pm2 / 校验)」的单一真源。CLI (typer)
与 FastAPI (serve-api) 退化成「解析 → 调 service → 格式化」的薄适配器,不再靠
fork CLI 跨传输复用 (见 docs/reference/architecture/ 后端服务化方案 / plan cli-streamed-brook.md)。
"""

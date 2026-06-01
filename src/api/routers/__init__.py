"""FastAPI 路由包。

app.py 末尾统一 import + include 这些 router (下沉 import 打破 envelope helper 的循环依赖)。

已实现端点 (Sprint 1/1B): email / attachment / llm / admin。
Phase B 待填充骨架: calendar / folder / ai / email_views (空 APIRouter，prefix 已定，
挂载即生效，端点逻辑见 handoff §2 矩阵)。
"""

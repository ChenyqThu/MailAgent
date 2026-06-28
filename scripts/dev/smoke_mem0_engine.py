"""M1a smoke：真连 CRS + fastembed + FAISS 端到端抽取一次（manual，不进 CI）。

跑前提：.env 有 LLM_API_KEY；首次会下载 bge-small ONNX 权重到 DATA_ROOT/mem0/fastembed_cache
（首次联网，之后离线）。验证 mem0 anthropic provider 经 CRS 的 anthropic 腿（/v1/messages，
claude 标准格式）端到端抽取 + fastembed 编码 + FAISS 召回全链路。

  venv/bin/python scripts/dev/smoke_mem0_engine.py
"""
import json

from src.memory import get_mem0_engine


def main() -> None:
    eng = get_mem0_engine()
    turn = [
        {"role": "user", "content": "以后给我的邮件回复都用简洁的中文，不要寒暄。"},
        {"role": "assistant", "content": "好的，已记住：回复用简洁中文、省略寒暄。"},
    ]
    print("[smoke] add (触发抽取 LLM + embedder 下载/编码 + FAISS 落盘)...")
    res = eng.add(turn, user_id="smoke-user", metadata={"source": "auto_capture"})
    print("[smoke] add result:")
    print(json.dumps(res, ensure_ascii=False, indent=2))

    print("\n[smoke] search '回复风格偏好' ...")
    res2 = eng.search("回复风格偏好", user_id="smoke-user", limit=5)
    print(json.dumps(res2, ensure_ascii=False, indent=2))

    print("\n[smoke] OK — anthropic/CRS 腿 + fastembed + faiss 全链路通")


if __name__ == "__main__":
    main()

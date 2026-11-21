#!/usr/bin/env python3
"""Step 4A Apple Silicon Real-Machine Local Embedding PoC & Benchmark.

Tests candidate local embedding models (public ungated availability, disk size,
CoreML 2-token dummy-forward probe in an isolated subprocess vs CPU fallback,
single-query p50/p95 latency, batch indexing throughput, MRL + BQ Recall@10,
and noise-floor calibration), plus probes local Ollama / LM Studio servers.

Usage:
    ./venv/bin/python scripts/dev/poc_local_embeddings.py --json-out /tmp/mailagent-embed-poc/results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

CACHE_ROOT = Path(os.environ.get("POC_CACHE_DIR", "/tmp/mailagent-embed-poc/models"))
DEFAULT_ENDPOINTS = [
    *(
        [os.environ["HF_ENDPOINT"].strip().rstrip("/")]
        if os.environ.get("HF_ENDPOINT", "").strip()
        else []
    ),
    "https://huggingface.co",
    "https://hf-mirror.com",
]

_POPCOUNT_LUT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    repo: str
    onnx_candidates: tuple[str, ...]
    full_dim: int
    pooling: str  # "mean" | "cls" | "last_token"
    query_prefix: str
    doc_prefix: str
    mrl_dims: tuple[int, ...]
    append_eos: bool = False
    max_tokens: int = 512


CANDIDATES: tuple[ModelSpec, ...] = (
    ModelSpec(
        model_id="embeddinggemma-300m-onnx",
        repo="onnx-community/embeddinggemma-300m-ONNX",
        onnx_candidates=(
            "onnx/model_q4.onnx",
            "onnx/model_q4f16.onnx",
            "onnx/model_quantized.onnx",
            "onnx/model_int8.onnx",
        ),
        full_dim=768,
        pooling="mean",
        query_prefix="task: search result | query: ",
        doc_prefix="title: none | text: ",
        mrl_dims=(768, 512, 256),
        max_tokens=512,
    ),
    ModelSpec(
        model_id="multilingual-e5-small-int8",
        repo="Xenova/multilingual-e5-small",
        onnx_candidates=("onnx/model_quantized.onnx", "onnx/model_int8.onnx"),
        full_dim=384,
        pooling="mean",
        query_prefix="query: ",
        doc_prefix="passage: ",
        mrl_dims=(384, 256),
        max_tokens=512,
    ),
    ModelSpec(
        model_id="bge-small-zh-v1.5-int8",
        repo="Xenova/bge-small-zh-v1.5",
        onnx_candidates=("onnx/model_quantized.onnx", "onnx/model.onnx"),
        full_dim=512,
        pooling="cls",
        query_prefix="为这个句子生成表示以用于检索相关文章：",
        doc_prefix="",
        mrl_dims=(512, 256),
        max_tokens=512,
    ),
    ModelSpec(
        model_id="qwen3-embedding-0.6b-int8",
        repo="onnx-community/Qwen3-Embedding-0.6B-ONNX",
        onnx_candidates=("onnx/model_int8.onnx",),
        full_dim=1024,
        pooling="last_token",
        query_prefix=(
            "Instruct: Given a search query, retrieve relevant documents from the personal library\n"
            "Query: "
        ),
        doc_prefix="",
        mrl_dims=(1024, 512, 256),
        append_eos=True,
        max_tokens=640,
    ),
)


# ---------------------------------------------------------------------------
# Reproducible bilingual corpus (150 docs + 30 labeled queries + 6 noise queries)
# ---------------------------------------------------------------------------


def build_eval_corpus() -> tuple[list[dict[str, str]], list[dict[str, Any]], list[str]]:
    """Return (docs, labeled_queries, noise_queries)."""
    anchored_topics: list[dict[str, Any]] = [
        # 10 exact/near-exact bilingual technical & business docs
        {
            "id": "d01",
            "bucket": "exact",
            "title": "企业版年度续约条款与违约金上限说明",
            "body": "本协议明确企业客户年度自动续约窗口为到期前三十天。若提前终止合同，违约金上限不超过剩余服务费的百分之十五，且续约条款支持按席位阶梯折扣。",
            "query": "续约条款 违约金",
        },
        {
            "id": "d02",
            "bucket": "exact",
            "title": "SOC2 Type II Audit Checklist 2026",
            "body": "Prepare access control logs, quarterly permission reviews, KMS key rotation evidence, and production SSH bastion audit trails before the SOC2 Type II auditor fieldwork begins.",
            "query": "SOC2 Type II checklist",
        },
        {
            "id": "d03",
            "bucket": "exact",
            "title": "DavMail Exchange OAuth2 令牌失效排查手册",
            "body": "当 Exchange 账号出现 LOGIN 认证失败时，优先检查 token.dat 是否过期、刷新令牌是否被租户管理员撤销，并通过 DavMail Reauth 弹窗重新完成认证。",
            "query": "DavMail 认证失效",
        },
        {
            "id": "d04",
            "bucket": "exact",
            "title": "Q4 华东区市场投放预算分配表",
            "body": "第四季度华东区线索获取总预算为 120 万元，其中线上信息流投放占 55%，线下行业峰会占 30%，合作伙伴联合推广占 15%。",
            "query": "Q4 预算分配",
        },
        {
            "id": "d05",
            "bucket": "exact",
            "title": "Cloudflare Tunnel Zero Trust 域名绑定规范",
            "body": "本地 FastAPI 仅监听 127.0.0.1:8200，通过 cloudflared 隧道暴露至公网域名，并强制开启 Access JWT 校验与邮件白名单。",
            "query": "Cloudflare Tunnel JWT",
        },
        {
            "id": "d06",
            "bucket": "exact",
            "title": "Omada Pro EAP783 三频吸顶 AP 固件升级公告",
            "body": "EAP783 v1.2.4 固件修复了 6GHz MLO 多链路漫游偶发丢包问题，建议校园网与高密办公场景在维护窗口统一升级。",
            "query": "EAP783 固件",
        },
        {
            "id": "d07",
            "bucket": "exact",
            "title": "SQLite WAL 模式长事务锁超时应对指南",
            "body": "执行向量推理或大附件抽取时切勿持有 BEGIN IMMEDIATE 写锁，应先读后计算再开短事务落盘，并配置 busy_timeout=30000。",
            "query": "SQLite WAL 锁超时",
        },
        {
            "id": "d08",
            "bucket": "exact",
            "title": "Electron Notarization Developer ID Signing Steps",
            "body": "Archive the arm64 app bundle with hardened runtime enabled, embed provisioning profile, submit to Apple notarytool, and staple the ticket before DMG packaging.",
            "query": "Developer ID notarytool",
        },
        {
            "id": "d09",
            "bucket": "exact",
            "title": "客户退款审批 SLA 与财务对账周期",
            "body": "标准退款工单须在两个工作日内完成业务初审，财务系统每周三统一触发原路退回批处理并生成对账流水号。",
            "query": "退款审批 SLA",
        },
        {
            "id": "d10",
            "bucket": "exact",
            "title": "Airbnb 与酒店差旅发票报销抬头要求",
            "body": "国内差旅住宿需开具增值税专用发票，税号与公司全称必须与财务系统备案完全一致；境外差旅保留行程单与电子收据即可。",
            "query": "差旅发票抬头",
        },
        # 10 Chinese semantic paraphrase docs (ZERO keyword overlap with query)
        {
            "id": "d11",
            "bucket": "semantic_zh",
            "title": "年度福利：员工体检合作机构与费用标准",
            "body": "正式入职满三个月即可预约三甲医院或爱康国宾年度健康筛查，基础套餐额度八百元，直系家属可享六折团购优待。",
            "query": "打工人去医院做身体检查公司能报多少",
        },
        {
            "id": "d12",
            "bucket": "semantic_zh",
            "title": "北京出差往返交通工具选择细则",
            "body": "单程里程一千二百公里以内优先乘高铁二等座；跨越该里程可预订经济舱折扣机票，夜间红眼航班额外补贴打车费。",
            "query": "出差坐火车还是坐飞机怎么定标准",
        },
        {
            "id": "d13",
            "bucket": "semantic_zh",
            "title": "办公园区地下车库月卡办理流程",
            "body": "在行政服务台登记行驶证照片并缴纳每月三百元停车费后，次日门禁道闸即可自动识别车牌抬杆放行。",
            "query": "开车上班怎么申请楼下停放车辆",
        },
        {
            "id": "d14",
            "bucket": "semantic_zh",
            "title": "研发笔记本电脑五年以旧换新政策",
            "body": "工作站服役满三年可申请加装内存，满五年经 IT 评估电池健康度低于百分之七十可申领全新 Apple Silicon 机型。",
            "query": "电脑太卡了什么时候能换一台新 MacBook",
        },
        {
            "id": "d15",
            "bucket": "semantic_zh",
            "title": "核心系统紧急故障夜间值班响应机制",
            "body": "生产环境凌晨出现 P0 宕机时，PagerDuty 将在六十秒内连续电话呼叫主值班与备岗工程师，务必十五分钟内上线定位。",
            "query": "半夜线上服务挂了联系谁来处理",
        },
        {
            "id": "d16",
            "bucket": "semantic_zh",
            "title": "开源第三方组件许可证法务合规清单",
            "body": "商业闭源分发产物严禁静态链接 GPLv3 强传染代码，引入 MIT、Apache-2.0 或 BSD 协议库需保留版权声明文件。",
            "query": "写代码能不能直接抄 GPL 协议的库",
        },
        {
            "id": "d17",
            "bucket": "semantic_zh",
            "title": "新员工试用期转正述职答辩指引",
            "body": "入职第五个月底须提交试用期总结报告，并由直属导师、部门负责人及 HRBP 共同组成评审小组进行现场问答考核。",
            "query": "新人什么时候转正要准备什么汇报",
        },
        {
            "id": "d18",
            "bucket": "semantic_zh",
            "title": "办公室饮水机滤芯更换与咖啡豆补货记录",
            "body": "物业保洁每周二上午清洗茶水间全自动咖啡机奶管，行政每月一号定时更换直饮水 RO 反渗透滤芯并粘贴检测标签。",
            "query": "茶水间的咖啡和饮用水平时谁维护",
        },
        {
            "id": "d19",
            "bucket": "semantic_zh",
            "title": "离职交接期间邮箱归档与代码仓权限回收",
            "body": "员工提出离职后，IT 会在最后工作日下午六点统一吊销 GitHub、VPN 与内网单点登录凭证，工作邮件只读移交主管。",
            "query": "同事要走了账号权限什么时候收回来",
        },
        {
            "id": "d20",
            "bucket": "semantic_zh",
            "title": "双十一促销期间弹性扩容与限流预案",
            "body": "大促前一周完成 Redis 集群分片预热与网关令牌桶限流压测，确保峰值 QPS 翻三倍时核心下单接口 P99 低于两百毫秒。",
            "query": "流量突然暴涨三倍系统怎么扛住不崩",
        },
        # 10 cross-lingual ZH<->EN retrieval pairs
        {
            "id": "d21",
            "bucket": "cross_lingual",
            "title": "Webhook 签名密钥定期轮换与双密钥过渡指南",
            "body": "每九十天生成新 HMAC-SHA256 密钥并保留旧密钥二十四小时并行验签窗口，以实现业务零中断无缝平滑切换。",
            "query": "how to rotate webhook signing secret without downtime",
        },
        {
            "id": "d22",
            "bucket": "cross_lingual",
            "title": "Quarterly Revenue Recognition Accounting Policy",
            "body": "Annual upfront SaaS prepayments must be amortized straight-line over twelve months as deferred revenue on the balance sheet rather than recognized immediately.",
            "query": "按月摊销递延收入的财务确认规则是什么",
        },
        {
            "id": "d23",
            "bucket": "cross_lingual",
            "title": "供应商信息安全问卷与 GDPR 数据处理附录",
            "body": "所有涉及欧盟个人数据的外包厂商必须签署标准合同条款 SCC 并明确数据跨境传输加密措施与七十二小时泄露通报义务。",
            "query": "vendor GDPR DPA data breach notification timeline",
        },
        {
            "id": "d24",
            "bucket": "cross_lingual",
            "title": "Kubernetes Pod OOMKilled Memory Limit Tuning",
            "body": "Increase container memory limits beyond peak RSS working set, configure heap dump on exit, and enable vertical pod autoscaler recommendations.",
            "query": "容器内存溢出被杀掉怎么调优",
        },
        {
            "id": "d25",
            "bucket": "cross_lingual",
            "title": "专利申请前技术交底书撰写模板",
            "body": "交底书应重点阐述现有技术的技术瓶颈、本发明的核心创新点对比、系统结构图与至少两个可执行的具体实施例。",
            "query": "patent disclosure template prior art innovation embodiments",
        },
        {
            "id": "d26",
            "bucket": "cross_lingual",
            "title": "Customer Escalation War Room Protocol",
            "body": "For Sev-1 outages impacting flagship enterprise accounts, assign an Incident Commander, post hourly status updates, and schedule a blameless postmortem within 48 hours.",
            "query": "大客户一级故障响应和复盘流程",
        },
        {
            "id": "d27",
            "bucket": "cross_lingual",
            "title": "家庭宠物寄养补贴与弹性居家办公安排",
            "body": "团队成员携猫狗前往兽医复诊时，可提前半天在日历标注远程办公状态，无需扣减带薪年假额度。",
            "query": "pet veterinary visit remote work flexible policy",
        },
        {
            "id": "d28",
            "bucket": "cross_lingual",
            "title": "Hardware Supply Chain Lead Time & Safety Stock",
            "body": "Due to Wi-Fi 7 RF front-end IC allocation constraints, maintain 8 weeks of safety stock buffer and qualify a secondary foundry source.",
            "query": "芯片交期变长后安全库存和备选供应商策略",
        },
        {
            "id": "d29",
            "bucket": "cross_lingual",
            "title": "邮件附件 OCR 与扫描件 PDF 文本抽取降级方案",
            "body": "遇到纯图片扫描件时先走本地 Vision OCR 识别文字层，超时或低置信度再回退多模态模型提取关键表格。",
            "query": "scanned PDF OCR fallback extraction pipeline",
        },
        {
            "id": "d30",
            "bucket": "cross_lingual",
            "title": "UX Typography Contrast & Minimum Font Size Spec",
            "body": "Chinese interface copy must maintain at least 14px body/aux sizing and WCAG AA 4.5:1 contrast ratio across both light and dark themes.",
            "query": "中文字体最小字号与对比度设计规范",
        },
    ]

    docs: list[dict[str, str]] = [
        {"id": t["id"], "text": f"{t['title']}\n\n{t['body']}"} for t in anchored_topics
    ]
    queries: list[dict[str, Any]] = [
        {"id": f"q_{t['id']}", "bucket": t["bucket"], "target": t["id"], "query": t["query"]}
        for t in anchored_topics
    ]

    # 120 realistic bilingual distractors across adjacent office/engineering subjects
    distractor_templates = [
        ("周会纪要 #{i}：项目排期与跨团队协同", "本周各小组同步研发进度，确认下周联调接口清单、测试环境部署窗口以及风险跟踪事项。"),
        ("Monthly Infrastructure Cost Report #{i}", "EC2 compute spend rose 4% due to staging load tests; reserved instance coverage remains at 78% across production clusters."),
        ("关于调整 {i} 月份团建活动集合时间的通知", "请各位同事本周五下午两点准时在园区东门大巴乘车点集合，记得携带身份证件与防晒用品。"),
        ("Firmware Release Notes v4.{i}.0 (Internal QA)", "Updated bootloader checksum validation, fixed SNMP trap formatting edge cases, and reduced idle power draw by 6%."),
        ("产品需求评审会邀请：第 {i} 期工作流优化", "议程包括桌面端快捷键冲突排查、搜索结果分组排序调整、以及夜间同步静默策略讨论。"),
        ("Weekly Security Vulnerability Digest #{i}", "No critical CVEs affected base Alpine images; scheduled routine npm audit patch updates for next Tuesday."),
    ]
    for idx in range(120):
        title_tmpl, body_tmpl = distractor_templates[idx % len(distractor_templates)]
        n = idx + 1
        docs.append(
            {
                "id": f"bg_{n:03d}",
                "text": f"{title_tmpl.format(i=n)}\n\n{body_tmpl.format(i=n)}",
            }
        )

    noise_queries = [
        "asdfgh",
        "zxcvbnm qwerty",
        "％＄＃＠",
        "今天天气怎么样",
        "qwertyuiop123",
        "哈哈哈哈哈",
    ]
    return docs, queries, noise_queries


def sample_real_email_summaries(max_rows: int = 50) -> list[str]:
    """Read-only sample of email subjects+bodies strictly for latency benchmarking (never logged/saved)."""
    db_path = Path("data/sync_store.db")
    if not db_path.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
        rows = conn.execute(
            "SELECT COALESCE(m.subject, ''), COALESCE(m.sender, ''), "
            "substr(COALESCE(NULLIF(m.snippet, ''), b.body_markdown, ''), 1, 300) "
            "FROM email_metadata m "
            "LEFT JOIN email_body b ON b.internal_id = m.internal_id "
            "ORDER BY m.internal_id DESC LIMIT ?",
            (int(max_rows),),
        ).fetchall()
        conn.close()
        out = []
        for subj, sender, snippet in rows:
            s = f"{subj}\nFrom: {sender}\n{snippet}".strip()
            if s:
                out.append(s)
        return out
    except Exception:
        return []


# ---------------------------------------------------------------------------
# HuggingFace probing & resumable downloader (unauthenticated = real user check)
# ---------------------------------------------------------------------------


def probe_remote_onnx_files(repo: str, onnx_candidates: Sequence[str]) -> dict[str, Any]:
    """Check whether repo + onnx file + tokenizer are publicly downloadable without HF_TOKEN."""
    import requests

    for base in DEFAULT_ENDPOINTS:
        chosen_onnx: str | None = None
        onnx_bytes = 0
        external_data: str | None = None
        external_bytes = 0
        last_status = None
        for cand in onnx_candidates:
            url = f"{base}/{repo}/resolve/main/{cand}"
            try:
                resp = requests.head(url, allow_redirects=True, timeout=12)
                last_status = resp.status_code
                if resp.status_code == 200:
                    chosen_onnx = cand
                    onnx_bytes = int(resp.headers.get("content-length") or 0)
                    break
                if resp.status_code in (401, 403):
                    return {
                        "accessible": False,
                        "status": resp.status_code,
                        "endpoint": base,
                        "reason": "gated_or_forbidden",
                    }
            except Exception as exc:
                last_status = str(exc)
        if chosen_onnx is None:
            continue

        # Also check optional external tensor data file (`model_*.onnx_data`)
        data_cand = chosen_onnx + "_data"
        try:
            dresp = requests.head(f"{base}/{repo}/resolve/main/{data_cand}", allow_redirects=True, timeout=10)
            if dresp.status_code == 200:
                external_data = data_cand
                external_bytes = int(dresp.headers.get("content-length") or 0)
        except Exception:
            pass

        tok_ok = False
        try:
            tresp = requests.head(f"{base}/{repo}/resolve/main/tokenizer.json", allow_redirects=True, timeout=10)
            tok_ok = tresp.status_code == 200
        except Exception:
            pass

        if tok_ok:
            return {
                "accessible": True,
                "endpoint": base,
                "onnx_path": chosen_onnx,
                "onnx_bytes": onnx_bytes,
                "external_data_path": external_data,
                "external_bytes": external_bytes,
                "total_model_bytes": onnx_bytes + external_bytes,
            }

    return {"accessible": False, "status": last_status, "reason": "unreachable_or_missing_files"}


def download_if_missing(repo: str, model_id: str, remote_paths: Sequence[str], endpoint: str) -> Path:
    """Download required files into CACHE_ROOT/<model_id>, flattening onnx/ or keeping onnx_data side-by-side."""
    import requests

    target_dir = CACHE_ROOT / model_id
    target_dir.mkdir(parents=True, exist_ok=True)
    # Reuse existing library qwen3 cache if present to avoid re-downloading 614 MB
    if model_id == "qwen3-embedding-0.6b-int8":
        existing = Path("data/library/embed_cache/qwen3-embedding-0.6b-int8")
        if (existing / "model_int8.onnx").is_file() and (existing / "tokenizer.json").is_file():
            return existing

    for rel in remote_paths:
        if not rel:
            continue
        dest = target_dir / Path(rel).name
        if dest.is_file() and dest.stat().st_size > 0:
            continue
        part = dest.with_suffix(dest.suffix + ".part")
        mirrors = [endpoint] + [m for m in DEFAULT_ENDPOINTS if m != endpoint]
        downloaded = False
        for base in mirrors:
            url = f"{base}/{repo}/resolve/main/{rel}"
            resume_pos = part.stat().st_size if part.is_file() else 0
            headers = {"Range": f"bytes={resume_pos}-"} if resume_pos > 0 else {}
            try:
                print(f"  -> downloading {repo}/{rel} from {base}...", flush=True)
                with requests.get(url, headers=headers, stream=True, timeout=(10, 60)) as resp:
                    if resp.status_code == 416 and resume_pos > 0:
                        os.replace(part, dest)
                        downloaded = True
                        break
                    resp.raise_for_status()
                    mode = "ab" if (resp.status_code == 206 and resume_pos > 0) else "wb"
                    with open(part, mode) as fh:
                        for chunk in resp.iter_content(chunk_size=1 << 20):
                            if chunk:
                                fh.write(chunk)
                    os.replace(part, dest)
                    downloaded = True
                    break
            except Exception as exc:
                print(f"  [warn] download {repo}/{rel} via {base} failed: {exc}", file=sys.stderr)
        if not downloaded:
            raise RuntimeError(f"failed to download {repo}/{rel}")
    return target_dir


# ---------------------------------------------------------------------------
# Subprocess-isolated CoreML 2-token dummy forward probe + latency benchmark
# ---------------------------------------------------------------------------

_COREML_PROBE_CODE = r"""
import json, os, sys, time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

model_dir, onnx_name, pooling, append_eos, max_tokens = sys.argv[1:6]
append_eos = append_eos == "1"
max_tokens = int(max_tokens)
ep = sys.argv[6]

t0 = time.perf_counter()
tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
tok.no_padding()
tok.enable_truncation(max_length=max(8, max_tokens - 1))
eos_id = tok.token_to_id("<|endoftext|>")
pad_id = tok.token_to_id("<pad>") or (eos_id if eos_id is not None else 0)

wanted = [ep] if ep == "CPUExecutionProvider" else [ep, "CPUExecutionProvider"]
opts = ort.SessionOptions()
opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
sess = ort.InferenceSession(os.path.join(model_dir, onnx_name), sess_options=opts, providers=wanted)
load_ms = (time.perf_counter() - t0) * 1000.0
active_providers = list(sess.get_providers())
inputs_meta = {i.name: i for i in sess.get_inputs()}
dtypes = {"tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(int64)": np.int64}

def make_feeds(texts):
    encoded = tok.encode_batch(texts)
    seqs = []
    for enc in encoded:
        ids = list(enc.ids)
        if append_eos and eos_id is not None and (not ids or ids[-1] != eos_id):
            ids.append(eos_id)
        seqs.append(ids or [pad_id])
    w = max(len(s) for s in seqs)
    b = len(seqs)
    input_ids = np.full((b, w), pad_id, dtype=np.int64)
    mask = np.zeros((b, w), dtype=np.int64)
    for i, s in enumerate(seqs):
        input_ids[i, :len(s)] = s
        mask[i, :len(s)] = 1
    feeds = {}
    for name, spec in inputs_meta.items():
        if name == "input_ids":
            feeds[name] = input_ids
        elif name == "attention_mask":
            feeds[name] = mask
        elif name == "token_type_ids":
            feeds[name] = np.zeros((b, w), dtype=np.int64)
        elif name == "position_ids":
            feeds[name] = np.tile(np.arange(w, dtype=np.int64), (b, 1))
        else:
            dt = dtypes.get(spec.type, np.float32)
            shape = [b if isinstance(d, str) and "batch" in d else (0 if isinstance(d, str) else int(d)) for d in spec.shape]
            feeds[name] = np.zeros(shape, dtype=dt)
    return feeds

# Dummy forward #1: length=4
_ = sess.run(None, make_feeds(["hello world test"]))
# Dummy forward #2: dynamic length change check
_ = sess.run(None, make_feeds(["longer query to test dynamic shape support on apple silicon runtime"]))

# Single query latency test (3 warmup + 25 timed)
queries = [
    "续约条款 违约金",
    "how to rotate webhook signing secret without downtime",
    "打工人去医院做身体检查公司能报多少",
    "Cloudflare Tunnel JWT access policy setup",
    "中文字体最小字号与对比度设计规范",
]
for i in range(3):
    _ = sess.run(None, make_feeds([queries[i % len(queries)]]))

times = []
for i in range(25):
    q = queries[i % len(queries)]
    ts = time.perf_counter()
    _ = sess.run(None, make_feeds([q]))
    times.append((time.perf_counter() - ts) * 1000.0)

times_sorted = sorted(times)
p50 = times_sorted[len(times_sorted) // 2]
p95 = times_sorted[int(len(times_sorted) * 0.95)]
print(json.dumps({
    "ok": True,
    "load_ms": round(load_ms, 1),
    "providers": active_providers,
    "p50_ms": round(p50, 2),
    "p95_ms": round(p95, 2),
}))
"""


def run_ep_probe(model_dir: Path, onnx_name: str, spec: ModelSpec, ep: str) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                _COREML_PROBE_CODE,
                str(model_dir),
                onnx_name,
                spec.pooling,
                "1" if spec.append_eos else "0",
                str(spec.max_tokens),
                ep,
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "timeout_180s"}

    if proc.returncode != 0:
        err_tail = (proc.stderr or proc.stdout or "").strip()[-400:]
        sig_note = f"signal={-proc.returncode}" if proc.returncode < 0 else f"exit={proc.returncode}"
        return {"ok": False, "reason": f"{sig_note}: {err_tail}"}

    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    return {"ok": False, "reason": f"unexpected_stdout: {proc.stdout[-200:]}"}


# ---------------------------------------------------------------------------
# In-process CPU encoder for Accuracy / MRL / BQ evaluation
# ---------------------------------------------------------------------------


def l2_norm(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=-1, keepdims=True)
    return mat / np.maximum(norms, 1e-12)


def pack_bq(mat: np.ndarray) -> np.ndarray:
    bits = (mat > 0.0).astype(np.uint8)
    return np.packbits(bits, axis=-1)


def quantize_int8(mat: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(mat * 127.0), -127, 127).astype(np.int8)


def dequantize_int8(qmat: np.ndarray) -> np.ndarray:
    return qmat.astype(np.float32) / 127.0


class EvalOnnxModel:
    def __init__(self, model_dir: Path, onnx_name: str, spec: ModelSpec) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.spec = spec
        self.tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tok.no_padding()
        self.tok.enable_truncation(max_length=max(8, spec.max_tokens - 1))
        self.eos_id = self.tok.token_to_id("<|endoftext|>")
        self.pad_id = self.tok.token_to_id("<pad>") or (self.eos_id if self.eos_id is not None else 0)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(
            str(model_dir / onnx_name), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.inputs_meta = {i.name: i for i in self.sess.get_inputs()}
        self.output_names = [o.name for o in self.sess.get_outputs()]
        self._dtypes = {"tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(int64)": np.int64}

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> np.ndarray:
        chunks: list[np.ndarray] = []
        for s in range(0, len(texts), batch_size):
            batch = list(texts[s : s + batch_size])
            encoded = self.tok.encode_batch(batch)
            seqs = []
            for enc in encoded:
                ids = list(enc.ids)
                if self.spec.append_eos and self.eos_id is not None and (not ids or ids[-1] != self.eos_id):
                    ids.append(self.eos_id)
                seqs.append(ids or [self.pad_id])
            width = max(len(x) for x in seqs)
            b = len(seqs)
            input_ids = np.full((b, width), self.pad_id, dtype=np.int64)
            mask = np.zeros((b, width), dtype=np.int64)
            for i, seq in enumerate(seqs):
                input_ids[i, : len(seq)] = seq
                mask[i, : len(seq)] = 1
            feeds: dict[str, np.ndarray] = {}
            for name, mspec in self.inputs_meta.items():
                if name == "input_ids":
                    feeds[name] = input_ids
                elif name == "attention_mask":
                    feeds[name] = mask
                elif name == "token_type_ids":
                    feeds[name] = np.zeros((b, width), dtype=np.int64)
                elif name == "position_ids":
                    feeds[name] = np.tile(np.arange(width, dtype=np.int64), (b, 1))
                else:
                    dt = self._dtypes.get(mspec.type, np.float32)
                    shape = [
                        b if isinstance(d, str) and "batch" in d else (0 if isinstance(d, str) else int(d))
                        for d in mspec.shape
                    ]
                    feeds[name] = np.zeros(shape, dtype=dt)
            outputs = self.sess.run(None, feeds)
            picked = None
            for i, oname in enumerate(self.output_names):
                if oname in ("sentence_embedding", "last_hidden_state") or outputs[i].ndim in (2, 3):
                    picked = np.asarray(outputs[i], dtype=np.float32)
                    if picked.ndim in (2, 3):
                        break
            if picked is None:
                picked = np.asarray(outputs[0], dtype=np.float32)
            if picked.ndim == 2:
                pooled = picked
            elif self.spec.pooling == "cls":
                pooled = picked[:, 0, :]
            elif self.spec.pooling == "last_token":
                last = np.maximum(mask.sum(axis=1) - 1, 0)
                pooled = picked[np.arange(picked.shape[0]), last]
            else:  # mean pooling
                mask_f = mask.astype(np.float32)[..., None]
                pooled = (picked * mask_f).sum(axis=1) / np.maximum(mask_f.sum(axis=1), 1e-9)
            chunks.append(l2_norm(pooled))
        return np.concatenate(chunks, axis=0)


def compute_recall_metrics(
    doc_mat_f32: np.ndarray,
    q_mat_f32: np.ndarray,
    queries: Sequence[dict[str, Any]],
    doc_ids: Sequence[str],
    noise_q_mat_f32: np.ndarray,
    dims: Sequence[int],
) -> dict[str, Any]:
    id_to_idx = {did: i for i, did in enumerate(doc_ids)}
    results: dict[str, Any] = {}
    for dim in dims:
        if dim > doc_mat_f32.shape[1]:
            continue
        d_sub = l2_norm(doc_mat_f32[:, :dim])
        q_sub = l2_norm(q_mat_f32[:, :dim])
        nq_sub = l2_norm(noise_q_mat_f32[:, :dim])

        # Exact float32
        f32_scores = q_sub @ d_sub.T

        # Int8 quantized
        d_i8 = quantize_int8(d_sub)
        d_deq = dequantize_int8(d_i8)
        i8_scores = q_sub @ d_deq.T

        # BQ Hamming Top-100 -> int8 rerank
        d_bq = pack_bq(d_sub)
        q_bq = pack_bq(q_sub)

        def eval_scores(score_fn: Callable[[int], tuple[list[int], float]]) -> dict[str, Any]:
            hits_at_10 = 0
            hits_at_1 = 0
            by_bucket: dict[str, list[int]] = {"exact": [], "semantic_zh": [], "cross_lingual": []}
            true_target_scores: list[float] = []
            for qi, qinfo in enumerate(queries):
                top_idx, target_score = score_fn(qi)
                t_idx = id_to_idx[qinfo["target"]]
                ok10 = int(t_idx in top_idx[:10])
                ok1 = int(top_idx[0] == t_idx) if top_idx else 0
                hits_at_10 += ok10
                hits_at_1 += ok1
                by_bucket[qinfo["bucket"]].append(ok10)
                true_target_scores.append(target_score)
            return {
                "recall@10": round(hits_at_10 / len(queries), 4),
                "recall@1": round(hits_at_1 / len(queries), 4),
                "buckets": {b: f"{sum(v)}/{len(v)}" for b, v in by_bucket.items()},
                "true_target_score_min": round(float(min(true_target_scores)), 4),
                "true_target_score_p10": round(float(np.percentile(true_target_scores, 10)), 4),
                "true_target_score_median": round(float(np.median(true_target_scores)), 4),
            }

        def f32_fn(qi: int) -> tuple[list[int], float]:
            row = f32_scores[qi]
            order = np.argsort(-row)[:10].tolist()
            return order, float(row[id_to_idx[queries[qi]["target"]]])

        def i8_fn(qi: int) -> tuple[list[int], float]:
            row = i8_scores[qi]
            order = np.argsort(-row)[:10].tolist()
            return order, float(row[id_to_idx[queries[qi]["target"]]])

        def bq_i8_fn(qi: int) -> tuple[list[int], float]:
            xor = np.bitwise_xor(d_bq, q_bq[qi])
            hamming = _POPCOUNT_LUT[xor].sum(axis=1)
            top_cand = np.argpartition(hamming, min(100, len(hamming) - 1))[:100]
            sub_scores = d_deq[top_cand] @ q_sub[qi]
            sub_order = np.argsort(-sub_scores)[:10]
            order = [int(top_cand[j]) for j in sub_order]
            return order, float((d_deq[id_to_idx[queries[qi]["target"]]] @ q_sub[qi]))

        # Noise scores (max across docs per noise query)
        noise_max_per_q = (nq_sub @ d_deq.T).max(axis=1)

        # Synthetic 10,000-vector BQ+int8 scan micro-benchmark
        rng = np.random.default_rng(42)
        syn_bq = rng.integers(0, 256, size=(10000, dim // 8), dtype=np.uint8)
        syn_i8 = rng.integers(-127, 127, size=(10000, dim), dtype=np.int8)
        qv_bq = q_bq[0]
        qv_f32 = q_sub[0]
        t_scan = time.perf_counter()
        for _ in range(20):
            xor = np.bitwise_xor(syn_bq, qv_bq)
            ham = _POPCOUNT_LUT[xor].sum(axis=1)
            cands = np.argpartition(ham, 100)[:100]
            _ = (syn_i8[cands].astype(np.float32) / 127.0) @ qv_f32
        bq_10k_ms = ((time.perf_counter() - t_scan) / 20.0) * 1000.0

        results[f"{dim}d"] = {
            "f32": eval_scores(f32_fn),
            "int8": eval_scores(i8_fn),
            "bq_top100_int8": eval_scores(bq_i8_fn),
            "noise_max": round(float(noise_max_per_q.max()), 4),
            "noise_p95": round(float(np.percentile(noise_max_per_q, 95)), 4),
            "scan_10k_bq_i8_ms": round(bq_10k_ms, 2),
        }
    return results


def probe_local_servers() -> list[dict[str, Any]]:
    import requests

    servers: list[dict[str, Any]] = []
    # Ollama
    try:
        r = requests.get("http://127.0.0.1:11434/api/tags", timeout=1.5)
        if r.ok:
            models = [m.get("name") for m in r.json().get("models", []) if m.get("name")]
            servers.append({"provider": "ollama", "url": "http://127.0.0.1:11434", "running": True, "models": models})
        else:
            servers.append({"provider": "ollama", "url": "http://127.0.0.1:11434", "running": False})
    except Exception as exc:
        servers.append({"provider": "ollama", "url": "http://127.0.0.1:11434", "running": False, "error": type(exc).__name__})
    # LM Studio
    try:
        r = requests.get("http://127.0.0.1:1234/v1/models", timeout=1.5)
        if r.ok:
            models = [m.get("id") for m in r.json().get("data", []) if m.get("id")]
            servers.append({"provider": "lmstudio", "url": "http://127.0.0.1:1234", "running": True, "models": models})
        else:
            servers.append({"provider": "lmstudio", "url": "http://127.0.0.1:1234", "running": False})
    except Exception as exc:
        servers.append({"provider": "lmstudio", "url": "http://127.0.0.1:1234", "running": False, "error": type(exc).__name__})
    return servers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    import onnxruntime as ort

    docs, queries, noise_queries = build_eval_corpus()
    real_emails = sample_real_email_summaries(50)
    print(f"ORT {ort.__version__} providers={ort.get_available_providers()}")
    print(f"Eval corpus: {len(docs)} synthetic docs, {len(queries)} labeled queries, {len(noise_queries)} noise queries, {len(real_emails)} real email samples (latency only)")

    servers = probe_local_servers()
    print("Local embedding servers:", json.dumps(servers, ensure_ascii=False))

    report: dict[str, Any] = {
        "ort_version": ort.__version__,
        "ort_providers": ort.get_available_providers(),
        "local_servers": servers,
        "corpus": {
            "synthetic_docs": len(docs),
            "labeled_queries": len(queries),
            "noise_queries": len(noise_queries),
            "real_email_samples": len(real_emails),
        },
        "models": {},
    }

    for spec in CANDIDATES:
        print(f"\n=== Probing {spec.model_id} ({spec.repo}) ===")
        probe = probe_remote_onnx_files(spec.repo, spec.onnx_candidates)
        print("  Remote probe:", json.dumps(probe))
        if not probe.get("accessible"):
            report["models"][spec.model_id] = {"remote": probe}
            continue

        model_dir = download_if_missing(
            spec.repo,
            spec.model_id,
            [probe["onnx_path"], probe.get("external_data_path") or "", "tokenizer.json", "config.json"],
            probe["endpoint"],
        )
        onnx_name = Path(probe["onnx_path"]).name
        disk_mb = round(sum(f.stat().st_size for f in model_dir.iterdir() if f.is_file() and not f.name.endswith(".part")) / (1024 * 1024), 1)
        print(f"  Model dir: {model_dir} ({disk_mb} MB)")

        coreml_res = run_ep_probe(model_dir, onnx_name, spec, "CoreMLExecutionProvider")
        cpu_res = run_ep_probe(model_dir, onnx_name, spec, "CPUExecutionProvider")
        print("  CoreML probe:", json.dumps(coreml_res))
        print("  CPU probe:   ", json.dumps(cpu_res))

        # Accuracy & throughput evaluation in-process on CPU
        encoder = EvalOnnxModel(model_dir, onnx_name, spec)
        doc_texts = [spec.doc_prefix + d["text"] for d in docs]
        t_idx = time.perf_counter()
        doc_mat = encoder.encode(doc_texts, batch_size=8)
        idx_elapsed = time.perf_counter() - t_idx
        docs_per_sec = round(len(doc_texts) / max(idx_elapsed, 1e-6), 2)

        q_texts = [spec.query_prefix + q["query"] for q in queries]
        q_mat = encoder.encode(q_texts, batch_size=8)
        nq_texts = [spec.query_prefix + nq for nq in noise_queries]
        nq_mat = encoder.encode(nq_texts, batch_size=8)

        real_throughput = None
        if real_emails:
            real_inputs = [spec.doc_prefix + x for x in real_emails]
            t_r = time.perf_counter()
            _ = encoder.encode(real_inputs, batch_size=8)
            dt_r = time.perf_counter() - t_r
            real_throughput = {
                "count": len(real_emails),
                "total_ms": round(dt_r * 1000.0, 1),
                "ms_per_email": round((dt_r * 1000.0) / len(real_emails), 2),
                "docs_per_sec": round(len(real_emails) / max(dt_r, 1e-6), 2),
            }

        acc = compute_recall_metrics(
            doc_mat, q_mat, queries, [d["id"] for d in docs], nq_mat, spec.mrl_dims
        )
        model_entry = {
            "remote": probe,
            "disk_mb": disk_mb,
            "coreml_probe": coreml_res,
            "cpu_probe": cpu_res,
            "docs_per_sec": docs_per_sec,
            "real_email_throughput": real_throughput,
            "accuracy": acc,
        }
        report["models"][spec.model_id] = model_entry
        print("  Accuracy:", json.dumps(acc, ensure_ascii=False))

    if args.json_out:
        out_p = Path(args.json_out)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(f"\nSaved JSON results to {out_p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

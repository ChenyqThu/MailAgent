"""Agent eval/trace runner (Phase 0).

Pure-stdlib, zero-LLM rule gate + report generator. The judge module is the ONLY
component that touches an LLM and it is never imported by the rule-gate path, so
CI can run validate/rules/baseline with zero token cost.

Schema contract: ../schema.md (schema_version 1.0, frozen 2026-06-22, baseline v0.13.0).
"""

SCHEMA_VERSION = "1.0"
TRACE_VERSION = "1.0"

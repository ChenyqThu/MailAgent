#!/usr/bin/env python3
"""Re-judge existing eval-raw.json with updated judge_scenario logic.
Saves $0.42 by not re-calling the LLM gateway."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / 'scripts' / 'dev'))

from eval_chat_scenarios_simple import (  # type: ignore
    judge_scenario, write_report, OUTPUT_RAW, OUTPUT_REPORT
)


def main() -> None:
    if not OUTPUT_RAW.exists():
        print(f'[rejudge] raw missing: {OUTPUT_RAW}', file=sys.stderr)
        sys.exit(1)
    raw = json.loads(OUTPUT_RAW.read_text(encoding='utf-8'))
    results = raw.get('results') or []
    print(f'[rejudge] {len(results)} scenarios', flush=True)
    for r in results:
        scenario = r['scenario']
        rs = r.get('response_summary', {})
        # Reconstruct partial Anthropic response shape for judge_scenario.
        if rs.get('error'):
            response: dict = {'error': rs['error']}
        else:
            response = {
                'content': rs.get('content') or [],
                'stop_reason': rs.get('stop_reason'),
            }
        r['judgment'] = judge_scenario(scenario, response)

    OUTPUT_RAW.write_text(
        json.dumps(raw, indent=2, ensure_ascii=False), encoding='utf-8'
    )
    write_report(results, raw.get('total_cost_usd', 0.0), raw.get('wall_seconds', 0.0), raw.get('model', '?'))

    p1_pass = sum(
        1 for r in results
        if r['scenario'].get('phase') == 'P1' and r['judgment']['scenario_pass']
    )
    p1_total = sum(1 for r in results if r['scenario'].get('phase') == 'P1')
    print(f'[rejudge] DONE   P1={p1_pass}/{p1_total}', flush=True)
    print(f'[rejudge]   report: {OUTPUT_REPORT}', flush=True)


if __name__ == '__main__':
    main()

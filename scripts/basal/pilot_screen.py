#!/usr/bin/env python3
"""Replay synthetic typed decisions against an explicitly selected local Basal server.

This is a behavior screen, not a calibration fit or permission to execute tools.
Uses the standard library. Never reads operator memory, credentials or .env.
"""

import argparse
import hashlib
import json
import math
import pathlib
import statistics
import time
import urllib.parse
import urllib.request


def evaluate(case, response, elapsed_ms, calibration):
    question = case['body']['questions']['decision']
    answer = response['answers']['decision']
    kind = question['type']
    if answer['type'] != kind:
        raise ValueError('Response question type mismatch')
    probabilities = answer['probabilities']
    values = list(probabilities.values())
    if not values or not all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in values):
        raise ValueError('Non-finite or invalid probabilities')
    if abs(sum(values) - 1) > 1e-4:
        raise ValueError('Probabilities do not sum to one')
    confidence = answer['confidence']
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or abs(confidence - max(values)) > 1e-4:
        raise ValueError('Confidence disagrees with probabilities')
    prediction = max(probabilities, key=probabilities.get)
    criteria = question['criteria']
    if kind == 'noul':
        value = answer.get('noul')
        if (set(probabilities) != {'true', 'false'} or type(value) not in (int, float)
                or not math.isfinite(value) or abs(value - probabilities['true']) > 1e-4):
            raise ValueError('Invalid canonical Boolean response')
        prediction = probabilities['true'] >= 0.5
    else:
        keys = list(criteria) if isinstance(criteria, dict) else [str(i) for i in range(len(criteria))]
        if set(probabilities) != set(keys):
            raise ValueError('Response options differ from the request')
        if kind == 'choice' and answer['choice'] != prediction:
            raise ValueError('Choice disagrees with probabilities')
        if kind == 'score':
            if keys != [str(i) for i in range(len(keys))]:
                raise ValueError('Score criteria need explicit ordinal keys')
            expected = sum(int(k) * value for k, value in probabilities.items())
            value = answer.get('score')
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value - expected) > 1e-4:
                raise ValueError('Score disagrees with expected ordinal value')
    policies = {}
    service_allows_eligibility = not answer.get('deferred', False) and answer.get('calibration') not in (
        'unvalidated', 'text',
    )
    for target in ('0.01', '0.05'):
        entry = calibration.get('thresholds', {}).get(target, {}).get('per_type', {}).get(kind, {})
        threshold = entry.get('confidence')
        if threshold is not None and (type(threshold) not in (int, float) or not math.isfinite(threshold)
                                      or not 0 <= threshold <= 1):
            raise ValueError('Invalid per-type calibration threshold')
        policies[target] = {'threshold': threshold,
                            'eligible': service_allows_eligibility and threshold is not None and confidence >= threshold}
    return {'id': case['id'], 'group': case['group'], 'type': kind,
            'gold': case['gold'], 'prediction': prediction, 'correct': prediction == case['gold'],
            'critical': case.get('critical', False), 'confidence': confidence,
            'latency_ms': elapsed_ms, 'producer_thresholds': policies, 'response': response}


def metrics(rows):
    if not rows:
        return {'n': 0}
    times = sorted(row['latency_ms'] for row in rows)
    result = {'n': len(rows), 'correct': sum(row['correct'] for row in rows),
              'accuracy': statistics.mean(row['correct'] for row in rows),
              'latency_p50_ms': statistics.median(times),
              'latency_p95_nearest_rank_ms': times[math.ceil(0.95 * len(times)) - 1],
              'critical_errors': [row['id'] for row in rows if row['critical'] and not row['correct']],
              'producer_threshold_policies': {}}
    for target in ('0.01', '0.05'):
        eligible = [row for row in rows if row['producer_thresholds'][target]['eligible']]
        result['producer_threshold_policies'][target] = {
            'eligible': len(eligible), 'coverage': len(eligible) / len(rows),
            'errors': sum(not row['correct'] for row in eligible),
            'error_ids': [row['id'] for row in eligible if not row['correct']],
        }
    return result


def local_endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/')):
        raise argparse.ArgumentTypeError('Use an unauthenticated localhost HTTP origin, e.g. http://127.0.0.1:8002')
    return value.rstrip('/')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True, type=local_endpoint)
    parser.add_argument('--calibration', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path, help='New directory; existing paths are refused')
    parser.add_argument('--cases', type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parents[2] / 'tests/fixtures/basal-pico-screen.pl.jsonl')
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--limit', type=int, help='Smoke subset only; report records the actual count')
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 300:
        parser.error('--timeout must be finite and within (0, 300] seconds')
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit must be positive')
    raw = args.cases.read_bytes()
    calibration_bytes = args.calibration.read_bytes()
    calibration = json.loads(calibration_bytes)
    if calibration.get('prompt') != 2 or calibration.get('orders') != 1:
        parser.error('This screen requires format-2 calibration fitted for one option order')
    cases = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not cases or len({c['id'] for c in cases}) != len(cases):
        parser.error('Case IDs must be present and unique')
    if args.limit is not None:
        cases = cases[:args.limit]
    # Refuse overwrite; a fresh output directory preserves each measured run.
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    metadata = {'endpoint': args.endpoint, 'cases_sha256': hashlib.sha256(raw).hexdigest(),
                'calibration_sha256': hashlib.sha256(calibration_bytes).hexdigest(),
                'requested_count': len(cases), 'timeout_seconds': args.timeout,
                'producer_thresholds_are_advisory': True, 'operator_memory_read': False}
    for path in ('health', 'v1/models'):
        with urllib.request.urlopen(args.endpoint + '/' + path, timeout=5) as response:
            metadata[path] = json.load(response)
    model = metadata['v1/models']['models'][0]
    if model.get('prompt_format') != 2 or model.get('orders') != 1 or model.get('mode') != 'gguf':
        raise ValueError('Selected server must report GGUF, prompt format 2 and one option order')
    fitted = calibration.get('fitted_on')
    fitted_layout = (fitted.get('layout') if isinstance(fitted, dict) else None) or calibration.get('layout', 'canonical')
    if model.get('layout', 'canonical') != fitted_layout or model.get('calibration_warning'):
        raise ValueError('Server layout or calibration provenance differs from the supplied calibration')
    if model.get('temperature_per_prim') != calibration.get('temperature_per_prim'):
        raise ValueError('Server temperatures differ from the supplied calibration')
    (args.output / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    results, failure = [], None
    try:
        with (args.output / 'results.jsonl').open('x') as output:
            for case in cases:
                request = urllib.request.Request(args.endpoint + '/v1/systemone',
                                                data=json.dumps(case['body'], ensure_ascii=False).encode(),
                                                headers={'Content-Type': 'application/json'})
                start = time.perf_counter()
                with urllib.request.urlopen(request, timeout=args.timeout) as response:
                    payload = response.read(65537)
                elapsed = (time.perf_counter() - start) * 1000
                if len(payload) > 65536:
                    raise ValueError('Response exceeds 64 KiB')
                decoded = json.loads(payload)
                if decoded.get('model') != model['name']:
                    raise ValueError('Model identity changed during the run')
                result = evaluate(case, decoded, elapsed, calibration)
                results.append(result)
                output.write(json.dumps(result, ensure_ascii=False) + '\n')
                output.flush()
                print(json.dumps({k: result[k] for k in ('id', 'correct', 'latency_ms')}), flush=True)
    except Exception as exc:
        failure = {'type': type(exc).__name__, 'message': str(exc)[:300]}
    report = {'completed': failure is None and len(results) == len(cases), 'failure': failure,
              'aggregate': metrics(results),
              'groups': {group: metrics([r for r in results if r['group'] == group])
                         for group in sorted({case['group'] for case in cases})},
              'limitations': 'Synthetic compatibility screen; no domain-calibrated error guarantee or execution authority.'}
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return 0 if report['completed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

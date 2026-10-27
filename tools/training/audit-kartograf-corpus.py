#!/usr/bin/env python3
"""Validate actual corpus bytes and optionally retain a private hash manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from kartograf_train.corpus_contract import CorpusContractError, validate_corpus


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--require-pairs', action='store_true')
    parser.add_argument('--require-eval', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        result = validate_corpus(args.corpus, require_pairs=args.require_pairs, require_eval=args.require_eval)
    except CorpusContractError as error:
        print(f'Corpus validation failed: {error}', file=sys.stderr)
        return 1
    names = ['train.jsonl', 'eval.jsonl', 'zone-labels.json', 'license-audit.json', 'corpus-v1-summary.json']
    if args.require_pairs:
        names += ['pairs.jsonl', 'eval-pairs.jsonl']
    result['files'] = {name: hashlib.sha256((args.corpus / name).read_bytes()).hexdigest() for name in names}
    result['validator_sha256'] = hashlib.sha256((Path(__file__).parent / 'kartograf_train/corpus_contract.py').read_bytes()).hexdigest()
    if args.report:
        with args.report.open('x', encoding='utf-8') as report:
            args.report.chmod(0o600)
            json.dump(result, report, indent=2)
            report.write('\n')
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Pair tooling preserves existing candidates and keeps dry-run caches read-only."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

TRAINING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TRAINING))
spec = importlib.util.spec_from_file_location('pair_miner_contract_tests', TRAINING / 'kartograf-pair-miner.py')
miner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = miner
spec.loader.exec_module(miner)


class PairMinerControlTests(unittest.TestCase):
    def test_dry_run_does_not_write_a_git_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / 'cache.json'
            with patch.object(miner, '_git_head_sha', return_value='synthetic-fixture'):
                self.assertEqual(miner.collect_git_history(root, [], cache, write_cache=False), {})
            self.assertFalse(cache.exists())

    def test_existing_pair_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'pairs.jsonl'
            path.write_text('synthetic existing candidate')
            with patch.object(sys, 'argv', ['miner', '--corpus', temp]):
                with self.assertRaisesRegex(SystemExit, 'already exists'):
                    miner.main()
            self.assertEqual(path.read_text(), 'synthetic existing candidate')


if __name__ == '__main__':
    unittest.main()

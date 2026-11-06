from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fetch_baseline', Path(__file__).with_name('fetch-baseline.py'))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='baseline-test-', dir=ROOT / '.local/tmp')
        self.root = Path(temporary.name)
        assert self.root.resolve().is_relative_to(ROOT)
        self.addCleanup(temporary.cleanup)
        metadata = json.loads((ROOT / 'packaging/baseline.json').read_text(encoding='utf-8-sig'))
        self.data = b'synthetic baseline'
        metadata.update(size=len(self.data), sha256=sha256(self.data).hexdigest())
        (self.root / 'packaging').mkdir()
        (self.root / 'packaging/baseline.json').write_text(json.dumps(metadata), encoding='utf-8')
        self.archive = self.root / 'archives' / metadata['filename']
        self.sums = self.root / 'archives/SHA256SUMS'

    def test_valid_download_and_repeat_preserve_existing_files(self):
        with patch.object(baseline, 'download', return_value=self.data) as download:
            baseline.fetch(self.root)
            download.assert_called_once()
        before = [(path.read_bytes(), path.stat().st_mtime_ns) for path in [self.archive, self.sums]]
        with patch.object(baseline, 'download') as download:
            baseline.fetch(self.root)
            download.assert_not_called()
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_mtime_ns) for path in [self.archive, self.sums]])

    def test_bad_download_is_rejected_before_any_final_file(self):
        with patch.object(baseline, 'download', return_value=b'x' * len(self.data)):
            with self.assertRaisesRegex(RuntimeError, 'SHA-256/size mismatch'):
                baseline.fetch(self.root)
        self.assertFalse(self.archive.exists())
        self.assertFalse(self.sums.exists())

    def test_existing_bad_archive_is_never_overwritten(self):
        self.archive.parent.mkdir()
        self.archive.write_bytes(b'keep this existing file')
        with patch.object(baseline, 'download') as download:
            with self.assertRaises(RuntimeError):
                baseline.fetch(self.root)
            download.assert_not_called()
        self.assertEqual(self.archive.read_bytes(), b'keep this existing file')

    def test_missing_checksum_is_recreated_from_pin_without_download(self):
        self.archive.parent.mkdir()
        self.archive.write_bytes(self.data)
        with patch.object(baseline, 'download') as download:
            baseline.fetch(self.root)
            download.assert_not_called()
        self.assertEqual(self.sums.read_text().split()[0], sha256(self.data).hexdigest())

    def test_unexpected_download_host_is_rejected_before_network(self):
        with patch.object(baseline.http.client, 'HTTPSConnection') as connection:
            with self.assertRaises(RuntimeError):
                baseline.download('https://example.com/baseline.zip', 10)
            connection.assert_not_called()


if __name__ == '__main__':
    unittest.main()

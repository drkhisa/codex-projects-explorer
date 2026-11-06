import importlib.util
from pathlib import Path
from hashlib import sha256
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish_release', Path(__file__).with_name('publish-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublicationTests(unittest.TestCase):
    def test_historical_baseline_cannot_replace_latest(self):
        with patch.object(release, 'Client') as client:
            with self.assertRaisesRegex(RuntimeError, 'cannot become Latest'):
                release.publish('0.5.2', '6f908b0', latest=True, baseline=True)
            client.assert_not_called()

    def test_existing_asset_requires_downloaded_hash_and_size(self):
        data = b'synthetic package'
        asset = {'state': 'uploaded', 'size': len(data), 'digest': 'sha256:' + sha256(data).hexdigest(),
                 'browser_download_url': 'https://github.com/drkhisa/codex-projects-explorer/releases/download/v0.0.0/test.zip'}
        with patch.object(release, 'download', return_value=data):
            release.verify_asset(asset, data)
        with patch.object(release, 'download', return_value=b'x' * len(data)):
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                release.verify_asset(asset, data)
        with patch.object(release, 'download', return_value=b'short'):
            with self.assertRaisesRegex(RuntimeError, 'size/SHA-256 mismatch'):
                release.verify_asset(asset, data)
        with patch.object(release, 'download') as download:
            with self.assertRaisesRegex(RuntimeError, 'state/size mismatch'):
                release.verify_asset({**asset, 'size': 0}, data)
            download.assert_not_called()

    def test_unknown_download_hosts_are_rejected_before_network(self):
        with patch.object(release, 'exchange') as request:
            for url in ['https://example.com/asset', 'http://github.com/asset',
                        'https://github.com/other/repository', 'https://user:secret@github.com/asset']:
                with self.assertRaises(RuntimeError):
                    release.download(url)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()

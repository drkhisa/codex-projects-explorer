"""Fetch the pinned original release into local archives/ without overwriting files."""
from hashlib import sha256
import http.client
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
REPO = 'drkhisa/codex-projects-explorer'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def download(url, size):
    for _ in range(5):
        target = urlsplit(url)
        require(target.scheme == 'https' and target.port in (None, 443) and not target.username and not target.password and
                target.hostname in ('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'),
                'Unexpected baseline download host')
        if target.hostname == 'github.com':
            require(target.path.startswith(f'/{REPO}/releases/download/'), 'Unexpected baseline download path')
        connection = http.client.HTTPSConnection(target.hostname, timeout=60)
        try:
            connection.request('GET', target.path + ('?' + target.query if target.query else ''),
                               headers={'User-Agent': 'Codex-Projects-Explorer'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                url = response.getheader('Location')
                require(bool(url), 'Baseline redirect has no destination')
                continue
            require(response.status == 200, f'Baseline download HTTP {response.status}')
            data = response.read(size + 1)
            require(len(data) == size, 'Downloaded baseline size mismatch')
            return data
        finally:
            connection.close()
    raise RuntimeError('Too many baseline redirects')


def fetch(root):
    metadata = json.loads((root / 'packaging/baseline.json').read_text(encoding='utf-8-sig'))
    name, expected = metadata['filename'], metadata['sha256']
    require(bool(re.fullmatch(r'Codex-Projects-All-\d+\.\d+\.\d+\.zip', name)), 'Invalid baseline filename')
    require(bool(re.fullmatch(r'[a-f0-9]{64}', expected)) and metadata['size'] > 0, 'Invalid baseline pin')
    require(metadata['url'] == f"https://github.com/{REPO}/releases/download/v{metadata['version']}/{name}", 'Unexpected baseline URL')
    directory = root / 'archives'
    require(not directory.is_symlink() and directory.resolve().is_relative_to(root.resolve()), 'Unsafe archives directory')
    archive, sums = directory / name, directory / 'SHA256SUMS'
    require(not archive.is_symlink() and not sums.is_symlink(), 'Symlink in baseline files')
    if sums.exists():
        require(sums.read_text(encoding='utf-8').split() == [expected, name], 'Existing SHA256SUMS differs from pin')
    if archive.exists():
        data = archive.read_bytes()
    else:
        data = download(metadata['url'], metadata['size'])
    require(len(data) == metadata['size'] and sha256(data).hexdigest() == expected, 'Baseline SHA-256/size mismatch; no overwrite performed')
    directory.mkdir(exist_ok=True)
    if not archive.exists():
        with archive.open('xb') as output:
            output.write(data)
    if not sums.exists():
        with sums.open('xb') as output:
            # Match the unchanged checksum asset's Windows line ending on every OS.
            output.write(f'{expected}  {name}\r\n'.encode())
    print(f'OK: baseline {metadata["version"]}, {len(data)} bytes, SHA-256 {expected}')


if __name__ == '__main__':
    try:
        fetch(ROOT)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Baseline fetch failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)

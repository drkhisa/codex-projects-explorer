"""Publish verified local packages; credentials and downloaded assets stay in memory."""
import argparse
from hashlib import sha256
import http.client
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote, urlsplit
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
REPO = 'drkhisa/codex-projects-explorer'
API = f'/repos/{REPO}'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True)
    require(result.returncode == 0, 'Git source verification failed')
    return result.stdout


def exchange(host, method, path, body=None, headers=None):
    connection = http.client.HTTPSConnection(host, timeout=60)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def download(url):
    # Never forward the GitHub credential to asset redirects or signed CDN URLs.
    for _ in range(5):
        target = urlsplit(url)
        require(target.scheme == 'https' and target.port in (None, 443) and
                target.hostname in ('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com') and
                not target.username and not target.password, 'Unexpected asset download host')
        if target.hostname == 'github.com':
            require(target.path.startswith(f'/{REPO}/releases/download/'), 'Unexpected asset download path')
        status, headers, data = exchange(target.hostname, 'GET', target.path + ('?' + target.query if target.query else ''),
                                         headers={'User-Agent': 'Codex-Projects-Explorer'})
        if status in (301, 302, 303, 307, 308):
            url = headers.get('Location') or headers.get('location')
            require(bool(url), 'Asset redirect has no destination')
            continue
        require(status == 200, f'Asset download HTTP {status}')
        return data
    raise RuntimeError('Too many asset redirects')


def verify_asset(asset, data):
    require(asset['state'] == 'uploaded' and asset['size'] == len(data), 'Existing asset state/size mismatch')
    expected = sha256(data).hexdigest()
    if asset.get('digest'):
        require(asset['digest'] == 'sha256:' + expected, 'Existing asset digest mismatch')
    downloaded = download(asset['browser_download_url'])
    require(len(downloaded) == len(data) and sha256(downloaded).hexdigest() == expected,
            'Downloaded asset size/SHA-256 mismatch; existing asset was not overwritten')


class Client:
    def __init__(self):
        env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never',
                   GIT_TRACE='0', GIT_TRACE_CURL='0', GIT_CURL_VERBOSE='0')
        result = subprocess.run(['git', 'credential', 'fill'], cwd=ROOT,
                                input=f'protocol=https\nhost=github.com\npath={REPO}.git\n\n',
                                text=True, capture_output=True, env=env, timeout=30)
        require(result.returncode == 0, 'Existing GitHub credential unavailable')
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        self.token = fields.get('password')
        require(bool(self.token), 'Existing GitHub credential has no token')

    def request(self, method, path, data=None, missing=False, upload=False):
        require(path.startswith(API + '/'), 'Unexpected GitHub repository path')
        headers = {'Authorization': 'Bearer ' + self.token, 'User-Agent': 'Codex-Projects-Explorer',
                   'Accept': 'application/vnd.github+json',
                   'Content-Type': 'application/octet-stream' if upload else 'application/json'}
        body = data if upload else json.dumps(data).encode() if data is not None else None
        status, _, payload = exchange('uploads.github.com' if upload else 'api.github.com', method, path, body, headers)
        if missing and status == 404:
            return None
        require(status in (200, 201), f'GitHub API {method}: HTTP {status}')
        return json.loads(payload)

    def pages(self, path):
        result = []
        for page in range(1, 101):
            rows = self.request('GET', f'{path}?per_page=100&page={page}')
            result.extend(rows)
            if len(rows) < 100:
                return result
        raise RuntimeError('GitHub pagination limit exceeded')


def packages(version, source):
    require(bool(re.fullmatch(r'\d+\.\d+\.\d+', version)), 'Invalid version')
    require(bool(re.fullmatch(r'[a-f0-9]{7,40}', source)), 'Expected a source commit hash')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    pkg = json.loads(git('show', source + ':extension/package.json'))
    require(pkg['version'] == version, 'Source commit has a different version')
    output = ROOT / 'builds' / version
    names = {f'Codex-Projects-All-{version}.zip', f'Codex-Projects-Browser-{version}.zip',
             f'codex-projects-explorer-{version}.vsix', 'SHA256SUMS'}
    require({p.name for p in output.iterdir()} == names and not output.is_symlink(), 'Unexpected release files')
    require(all(not (output / name).is_symlink() for name in names), 'Symlink in release files')
    files = {name: (output / name).read_bytes() for name in sorted(names)}
    sums = {}
    for line in files['SHA256SUMS'].decode().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (\S+)', line)
        require(bool(match) and match[2] not in sums, 'Invalid or duplicate SHA256SUMS entry')
        sums[match[2]] = match[1]
    require(set(sums) == names - {'SHA256SUMS'}, 'SHA256SUMS file list mismatch')
    for name, expected in sums.items():
        require(sha256(files[name]).hexdigest() == expected, f'Local SHA-256 mismatch: {name}')
    vsix_name = f'codex-projects-explorer-{version}.vsix'
    browser_name = f'Codex-Projects-Browser-{version}.zip'
    with ZipFile(BytesIO(files[vsix_name])) as vsix:
        require(vsix.testzip() is None, 'VSIX CRC mismatch')
        for name in vsix.namelist():
            require(name.startswith('extension/') or name in ('extension.vsixmanifest', '[Content_Types].xml'), 'Unexpected VSIX entry')
            path = name if name.startswith('extension/') else 'packaging/' + name
            require(vsix.read(name).replace(b'\r\n', b'\n') == git('show', source + ':' + path).replace(b'\r\n', b'\n'),
                    f'VSIX differs from source commit: {name}')
    with ZipFile(BytesIO(files[f'Codex-Projects-All-{version}.zip'])) as bundle:
        require(bundle.testzip() is None, 'Bundle CRC mismatch')
        for platform in ('Windows', 'Mac'):
            require(bundle.read(f'{platform}/{vsix_name}') == files[vsix_name], 'Bundled VSIX mismatch')
            require(bundle.read(f'{platform}/{browser_name}') == files[browser_name], 'Bundled browser ZIP mismatch')
        metadata = json.loads(bundle.read('Windows/installer.json'))
        require(metadata['version'] == version and metadata['sha256'] == sums[vsix_name], 'Installer metadata mismatch')
    changelog = git('show', source + ':extension/changelog.md').decode('utf-8-sig')
    notes = re.search(r'(?ms)^## ' + re.escape(version) + r'[^\n]*\n(.*?)(?=^## |\Z)', changelog)
    require(notes is not None, 'Source changelog has no release notes')
    return source, files, notes[1].strip()


def tag_commit(client, tag):
    ref = client.request('GET', API + '/git/ref/tags/' + tag, missing=True)
    if ref is None:
        return None
    obj = ref['object']
    for _ in range(5):
        if obj['type'] == 'commit':
            return obj['sha']
        require(obj['type'] == 'tag', 'Tag does not point to a commit')
        obj = client.request('GET', API + '/git/tags/' + obj['sha'])['object']
    raise RuntimeError('Too many annotated tag levels')


def publish(version, source, latest=False):
    source, files, notes = packages(version, source)
    client = Client()
    remote = client.request('GET', API + '/compare/' + source + '...main')
    require(remote['status'] in ('ahead', 'identical'), 'Source commit is not published on main')
    tag = 'v' + version
    existing_tag = tag_commit(client, tag)
    require(existing_tag in (None, source), 'Existing tag points to another commit')
    releases = [r for r in client.pages(API + '/releases') if r['tag_name'] == tag]
    require(len(releases) <= 1, 'Duplicate release tags')
    if releases:
        release = releases[0]
        require(not release['prerelease'], 'Existing release is a prerelease')
        require(existing_tag == source or release['draft'] and release['target_commitish'] == source,
                'Existing release source mismatch')
    else:
        body = notes + f'\n\nИсходный коммит: `{source}`.\n\nГотовые пакеты — в Assets ниже; проверяйте SHA-256 по `SHA256SUMS`. Рекомендуется последняя версия выпуска.'
        release = client.request('POST', API + '/releases', {'tag_name': tag, 'target_commitish': source,
                                 'name': 'Codex Projects Explorer ' + version, 'body': body,
                                 'draft': True, 'prerelease': False})
    release_path = API + '/releases/' + str(release['id'])
    assets = client.pages(release_path + '/assets')
    for name, data in files.items():
        matches = [a for a in assets if a['name'] == name]
        require(len(matches) <= 1, 'Duplicate asset names')
        if matches:
            # Public downloads of a draft are unavailable; use digest until publication.
            asset = matches[0]
            if release['draft']:
                require(asset['size'] == len(data) and asset.get('digest') == 'sha256:' + sha256(data).hexdigest(),
                        'Draft asset mismatch; no overwrite performed')
            else:
                verify_asset(asset, data)
        else:
            asset = client.request('POST', release_path + '/assets?name=' + quote(name), data, upload=True)
            require(asset['size'] == len(data) and asset.get('digest') == 'sha256:' + sha256(data).hexdigest(),
                    'Uploaded asset digest/size mismatch')
    if release['draft']:
        release = client.request('PATCH', release_path, {'draft': False, 'make_latest': 'true' if latest else 'false'})
    elif latest:
        current = client.request('GET', API + '/releases/latest', missing=True)
        if current is None or current['id'] != release['id']:
            client.request('PATCH', release_path, {'make_latest': 'true'})
    require(tag_commit(client, tag) == source, 'Published tag source mismatch')
    assets = client.pages(release_path + '/assets')
    for name, data in files.items():
        matches = [a for a in assets if a['name'] == name]
        require(len(matches) == 1, 'Published asset missing/duplicated')
        verify_asset(matches[0], data)
        print(f'{name}: {sha256(data).hexdigest()} {matches[0]["browser_download_url"]}', flush=True)
    if latest:
        require(client.request('GET', API + '/releases/latest')['id'] == release['id'], 'Latest release mismatch')
    print('OK: ' + release['html_url'] + ' source=' + source, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('source_commit')
    parser.add_argument('--latest', action='store_true')
    args = parser.parse_args()
    try:
        publish(args.version, args.source_commit, args.latest)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Publication failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)

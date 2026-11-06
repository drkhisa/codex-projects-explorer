"""Package the release using only Python's standard library; never run installers."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import stat
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent


def read(name):
    path = ROOT / name
    assert path.resolve().is_relative_to(ROOT), f'File outside project: {name}'
    assert not path.is_symlink(), f'Symlink in package: {name}'
    return path.read_bytes()


def read_json(name):
    return json.loads(read(name).decode('utf-8-sig'))


def zip_bytes(files):
    output = BytesIO()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = 0o755 if name.endswith('.command') else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    result = output.getvalue()
    with ZipFile(BytesIO(result)) as archive:
        assert archive.testzip() is None, 'ZIP CRC verification failed'
        assert set(archive.namelist()) == set(files)
        for name, data in files.items():
            assert archive.read(name) == data, f'ZIP content mismatch: {name}'
            if name.endswith('.command'):
                assert (archive.getinfo(name).external_attr >> 16) & 0o111
    return result


def main():
    # Explicit release manifests prevent caches, credentials and history entering ZIPs.
    original = read('archives/Codex-Projects-All-0.5.2.zip')
    expected, filename = read('archives/SHA256SUMS').decode().split()
    assert filename == 'Codex-Projects-All-0.5.2.zip'
    assert sha256(original).hexdigest() == expected, 'Original archive changed'
    with ZipFile(BytesIO(original)) as archive:
        original_files = set(archive.namelist())
        old_vsix = archive.read('Windows/codex-projects-explorer-0.5.2.vsix')
    with ZipFile(BytesIO(old_vsix)) as archive:
        vsix_names = set(archive.namelist())

    pkg = read_json('extension/package.json')
    version = pkg['version']
    assert re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version'
    assert read_json('extension/browser-bridge/manifest.json')['version'] == version
    metadata = read_json('installers/Windows/installer.json')
    vsix_name = f'codex-projects-explorer-{version}.vsix'
    browser_name = f'Codex-Projects-Browser-{version}.zip'
    assert metadata['version'] == version and metadata['vsix'] == vsix_name
    assert metadata['extensionId'] == f"{pkg['publisher']}.{pkg['name']}"
    manifest = ET.fromstring(read('packaging/extension.vsixmanifest'))
    identity = manifest.find('{*}Metadata/{*}Identity')
    assert identity.attrib['Version'] == version
    assert identity.attrib['Id'] == pkg['name']
    assert identity.attrib['Publisher'] == pkg['publisher']

    vsix_files = {name: read(name if name.startswith('extension/') else f'packaging/{name}')
                  for name in vsix_names}
    actual_files = {'extension/' + name for name in
                    ['.gitignore', 'changelog.md', 'LICENSE.txt', 'readme.md', 'package.json']}
    for directory in ['src', 'media', 'browser-bridge']:
        actual_files.update(path.relative_to(ROOT).as_posix()
                            for path in (ROOT / 'extension' / directory).rglob('*') if path.is_file())
    assert actual_files == {name for name in vsix_names if name.startswith('extension/')}, \
        'Extension file list changed; review the release manifest before packaging'
    vsix = zip_bytes(vsix_files)
    metadata['sha256'] = sha256(vsix).hexdigest()
    browser_files = {name.removeprefix('extension/browser-bridge/'): data
                     for name, data in vsix_files.items() if name.startswith('extension/browser-bridge/')}
    browser = zip_bytes(browser_files)

    files = {'СНАЧАЛА ПРОЧИТАЙ.txt': read('packaging/СНАЧАЛА ПРОЧИТАЙ.txt')}
    for platform, names in {
        'Windows': ['installer.ps1', 'Установить.cmd', 'ПРОЧИТАЙ.txt', 'Инструкция-Windows.txt'],
        'Mac': ['Установить.command', 'Инструкция-Mac.txt'],
    }.items():
        files.update({f'{platform}/{name}': read(f'installers/{platform}/{name}') for name in names})
        files[f'{platform}/{vsix_name}'] = vsix
        files[f'{platform}/{browser_name}'] = browser
        files.update({f'{platform}/browser-bridge/{name}': data for name, data in browser_files.items()})
    files['Windows/installer.json'] = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode()
    assert set(files) == {name.replace('0.5.2', version) for name in original_files}, \
        'Release layout differs from the original Windows/Mac bundle'
    for name, data in files.items():
        if name.endswith('.txt'):
            text = data.decode('utf-8-sig')
            assert version in text, f'Missing release version in {name}'
            assert '0.5.2' not in text, f'Stale instructions: {name}'
    bundle = zip_bytes(files)
    with ZipFile(BytesIO(bundle)) as archive:
        packaged = json.loads(archive.read('Windows/installer.json'))
        assert packaged['sha256'] == sha256(archive.read(f'Windows/{vsix_name}')).hexdigest()
        assert archive.read(f'Mac/{vsix_name}') == archive.read(f'Windows/{vsix_name}')

    artifacts = {vsix_name: vsix, browser_name: browser, f'Codex-Projects-All-{version}.zip': bundle}
    checksums = ''.join(f'{sha256(data).hexdigest()}  {name}\n' for name, data in sorted(artifacts.items()))
    output = ROOT / 'builds' / version
    output.mkdir()  # Refuse to overwrite an existing release.
    for name, data in {**artifacts, 'SHA256SUMS': checksums.encode()}.items():
        (output / name).write_bytes(data)
    print(f'OK: versions, original SHA-256, ZIP contents/CRC, installer hash, Mac execute permission; {len(files)} bundle files')
    print(checksums, end='')
    print(f'Output: {output}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Build the local scanner VSIX and install pinned Open VSX language extensions."""
import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


def curl(url, destination):
    subprocess.run(['curl', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '600',
                    '--silent', '--show-error', url, '-o', str(destination)], check=True)


def package_local(source, destination):
    manifest = json.loads((source / 'package.json').read_text())
    publisher, name, version = (manifest[key] for key in ('publisher', 'name', 'version'))
    xml = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Id="{escape(name)}" Version="{escape(version)}" Publisher="{escape(publisher)}"/>
<DisplayName>{escape(manifest['displayName'])}</DisplayName><Description xml:space="preserve">{escape(manifest['description'])}</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(manifest['engines']['vscode'])}"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets>
</PackageManifest>'''
    content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/>
<Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>'''
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('extension.vsixmanifest', xml)
        archive.writestr('[Content_Types].xml', content_types)
        for filename in ('package.json', 'extension.js', 'scanner.js', 'README.md', 'LICENSE'):
            archive.write(source / filename, 'extension/' + filename)


def digest(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--server', type=Path, required=True)
    args = parser.parse_args()
    state = args.cache / 'preview'
    common = [str(args.server), '--user-data-dir', str(state / 'user-data'), '--extensions-dir', str(state / 'extensions')]
    installed = subprocess.check_output(common + ['--list-extensions', '--show-versions'], text=True)
    versions = dict(line.strip().lower().split('@', 1) for line in installed.splitlines() if re.fullmatch(r'[\w-]+\.[\w-]+@\S+', line.strip()))
    bundles = args.source / 'extension-bundles'
    bundles.mkdir(exist_ok=True)
    # This source fingerprint avoids reinstalling the local extension on every build.
    local_source = args.source / 'extensions/elevator-smart-workspace'
    local_key = hashlib.sha256(b''.join((local_source / name).read_bytes() for name in
                                       ('package.json', 'extension.js', 'scanner.js', 'README.md', 'LICENSE'))).hexdigest()
    stamp = args.cache / 'smart-extension-key'
    if versions.get('elevator.smart-workspace') != '0.1.0' or not stamp.exists() or stamp.read_text() != local_key:
        local_vsix = bundles / 'elevator.smart-workspace-0.1.0.vsix'
        package_local(local_source, local_vsix)
        subprocess.run(common + ['--install-extension', str(local_vsix), '--force'], check=True)
        stamp.write_text(local_key)

    manifest = json.loads((args.source / 'ci/dev/preview-extensions.json').read_text())
    for item in manifest['extensions']:
        extension_id, version = item['id'], item['version']
        platform = item.get('platform', 'universal')
        platform_segment = f'/{platform}' if platform != 'universal' else ''
        filename = bundles / f'{extension_id}-{version}{"@" + platform if platform_segment else ""}.vsix'
        checksum_file = filename.with_suffix('.vsix.sha256')
        expected = item.get('sha256') or (checksum_file.read_text().strip() if checksum_file.exists() else None)
        if not filename.exists() or not expected or digest(filename) != expected:
            metadata_file = args.cache / 'extension-metadata.json'
            checksum_download = args.cache / 'extension-sha256.txt'
            api = f'https://open-vsx.org/api/{extension_id.replace(".", "/", 1)}{platform_segment}/{version}'
            curl(api, metadata_file)
            metadata = json.loads(metadata_file.read_text())
            if metadata.get('version') != version or not metadata.get('files', {}).get('sha256'):
                raise RuntimeError(f'No verified package found: {extension_id}@{version}')
            curl(metadata['files']['sha256'], checksum_download)
            downloaded_hash = checksum_download.read_text().split()[0].lower()
            if not re.fullmatch('[0-9a-f]{64}', downloaded_hash) or (expected and downloaded_hash != expected):
                raise RuntimeError(f'Package checksum changed: {extension_id}@{version}')
            temporary = filename.with_suffix('.vsix.download')
            print(f'Downloading: {extension_id}@{version} ({platform})', flush=True)
            curl(metadata['files']['download'], temporary)
            if digest(temporary) != downloaded_hash:
                raise RuntimeError(f'Invalid VSIX checksum: {extension_id}')
            temporary.replace(filename)
            checksum_file.write_text(downloaded_hash + '\n')
        if versions.get(extension_id.lower()) == version:
            print(f'Already installed: {extension_id}@{version}', flush=True)
        else:
            # The pinned manifest already lists the wanted pack members. Avoid
            # fetching optional unpinned members (notably proprietary Pylance).
            subprocess.run(common + ['--install-extension', str(filename), '--force', '--do-not-include-pack-dependencies'], check=True)


if __name__ == '__main__':
    main()

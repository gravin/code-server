#!/usr/bin/env python3
"""Convert the user's project list into a WSL multi-root workspace."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def load_folders(config):
    data = json.loads(config.read_text(encoding='utf-8-sig'))
    if not isinstance(data, dict) or not isinstance(data.get('projects'), list):
        raise ValueError('Expected an object with a projects array.')
    folders, identities, names = [], set(), set()
    for index, project in enumerate(data['projects'], start=1):
        label = f'projects[{index}]'
        if not isinstance(project, dict):
            raise ValueError(f'{label}: expected an object.')
        if not isinstance(project.get('enabled'), bool):
            raise ValueError(f'{label}: enabled must be true or false.')
        if not project['enabled']:
            continue
        raw = project.get('path')
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f'{label}: path must be a non-empty string.')
        if re.match(r'^[A-Za-z]:[\\/]', raw):
            converted = subprocess.run(['wslpath', '-u', raw], check=True,
                                       capture_output=True, text=True).stdout.strip()
            directory = Path(converted).resolve()
        elif re.match(r'^[A-Za-z]:', raw) or raw.startswith('\\\\'):
            raise ValueError(f'{label}: use an absolute drive path such as D:/project.')
        else:
            directory = Path(raw.replace('\\', '/'))
            if not directory.is_absolute():
                directory = config.parent / directory
            directory = directory.resolve()
        if not directory.is_dir():
            raise ValueError(f'{label}: enabled project directory does not exist: {raw}')
        name = project.get('name', directory.name)
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f'{label}: name must be a non-empty string.')
        identity = (directory.stat().st_dev, directory.stat().st_ino)
        if identity in identities:
            raise ValueError(f'{label}: directory is already enabled: {raw}')
        if name in names:
            raise ValueError(f'{label}: display name is already used: {name}')
        identities.add(identity)
        names.add(name)
        folders.append({'name': name, 'path': str(directory)})
    if not folders:
        raise ValueError('Enable at least one project in projects.json.')
    return folders


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        folders = load_folders(args.config.resolve())
        workspace = args.workspace.resolve()
        if not args.check:
            workspace.parent.mkdir(parents=True, exist_ok=True)
            # Validate every folder before replacing the previous workspace.
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                                 dir=workspace.parent, delete=False) as stream:
                    temporary = stream.name
                    json.dump({'folders': folders, 'settings': {}}, stream,
                              ensure_ascii=False, indent=2)
                    stream.write('\n')
                os.replace(temporary, workspace)
                temporary = None
            finally:
                if temporary is not None:
                    Path(temporary).unlink(missing_ok=True)
        print(f'Enabled projects: {len(folders)}', file=sys.stderr)
        for folder in folders:
            print(f"  {folder['name']}: {folder['path']}", file=sys.stderr)
        print(workspace)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Project list error ({args.config}): {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Copy CI-built WASM into the public site and write an SHA256 inventory.

Only executed after Rust tests + builds. Publishes no secrets.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / 'admin/public/artifacts'
output.mkdir(parents=True, exist_ok=True)
packages = {'factory': 'near_curve_factory', 'token': 'near_curve_token'}
manifest = {
    'network': 'testnet',
    'version': '0.1.0',
    'sourceCommit': os.environ.get('GITHUB_SHA', '').lower(),
}
if len(manifest['sourceCommit']) != 40 or any(c not in '0123456789abcdef' for c in manifest['sourceCommit']):
    raise RuntimeError('Must be called in a GitHub Actions checkout with full commit SHA')
for logical, crate in packages.items():
    folder = root / 'contracts' / ('factory' if logical == 'factory' else 'curve-token')
    candidates = [p for p in folder.rglob(crate + '.wasm') if 'target' in p.parts and ('near' in p.parts or 'release' in p.parts)]
    if not candidates:
        raise RuntimeError(f'cargo-near did not produce {crate}.wasm under {folder}')
    preferred = sorted(candidates, key=lambda p: (('near' not in p.parts), len(p.parts), str(p)))[0]
    data = preferred.read_bytes()
    if not data.startswith(b'\0asm\x01\0\0\0'):
        raise RuntimeError(f'{preferred} has invalid WASM magic/version')
    limit = 1_000_000 if logical == 'token' else 4_000_000
    if not 8 <= len(data) <= limit:
        raise RuntimeError(f'{preferred} is too large for v0.1 ({len(data)} bytes)')
    target_name = logical + '.wasm'
    shutil.copy2(preferred, output / target_name)
    manifest[logical] = {'file': target_name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes':len(data)}
    print(logical, len(data), 'bytes', manifest[logical]['sha256'])
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print('Published manifest for commit', manifest['sourceCommit'])

#!/usr/bin/env python3
"""Read-only OSV audit of Cargo.lock; sends public package names/versions only."""
import json
import pathlib
import tomllib
import urllib.request
from datetime import datetime, timezone

root = pathlib.Path(__file__).resolve().parents[1]
packages = [p for p in tomllib.loads((root / 'Cargo.lock').read_text())['package'] if p.get('source', '').startswith('registry+')]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
queries = [{'package': {'ecosystem': 'crates.io', 'name': p['name']}, 'version': p['version']} for p in packages]
request = urllib.request.Request('https://api.osv.dev/v1/querybatch', data=json.dumps({'queries': queries}).encode(), headers={'Content-Type': 'application/json'})
with opener.open(request, timeout=60) as response:
    results = json.load(response)['results']
findings = []
for package, result in zip(packages, results):
    if result.get('vulns'):
        findings.append({'name': package['name'], 'version': package['version'], 'advisories': [v['id'] for v in result['vulns']]})
report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'registry_packages': len(packages), 'findings': findings}
output = root / 'outputs/security-fix-20261023/cargo-osv.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))

"""Codex 0.161 permission profiles: bounded files, loopback/npm-only command networking."""
import json
from pathlib import Path


def options(worktree, scratch, readonly):
    filesystem = {'/': 'read', str(scratch): 'write'}
    if not readonly:
        filesystem[str(worktree)] = 'write'
        filesystem[str(Path(worktree) / '.git')] = 'read'
    toml = '{' + ','.join(f'{json.dumps(k)}={json.dumps(v)}' for k, v in filesystem.items()) + '}'
    values = [f'permissions.supervisor.filesystem={toml}',
              'permissions.supervisor.network.enabled=true',
              'features.network_proxy.enabled=true',
              'features.network_proxy.domains={"localhost"="allow","127.0.0.1"="allow","::1"="allow","registry.npmjs.org"="allow"}',
              'features.network_proxy.allow_upstream_proxy=false',
              'approval_policy="never"', 'shell_environment_policy.inherit="none"',
              'shell_environment_policy.set={PATH="/usr/local/bin:/usr/bin:/bin",'
              f'TMPDIR={json.dumps(str(scratch))},NO_PROXY="localhost,127.0.0.1,::1"}}']
    return [item for value in values for item in ('-c', value)]

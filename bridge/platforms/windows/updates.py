"""Read-only checks and bounded explicit stops for runtime processes that lock an installation."""
import os
from pathlib import Path
import time
from types import SimpleNamespace

from . import codex_quit, force_exit
from .desktop import process_inventory
from .zcode_pipe import _identity, identity, process_args

_CODEX_ROLES = ('app-server', 'exec-server', 'codex-desktop-launch', 'codex-desktop-runtime')
_PROVIDER_MESSAGES = {
    'codex': '请先结束任务并正常退出 Codex，再更新网关。',
    'zcode': '请先结束任务并正常退出 ZCode，再更新网关。',
}


def inspect_update_blockers(worker):
    worker = Path(worker).resolve(strict=True)
    expected = os.path.normcase(str(worker))
    inventory = process_inventory([worker])[worker]
    blockers = []
    for pid in inventory['pids']:
        try:
            before = identity(pid)
            if before['image'] != expected:
                continue
            argv = process_args(pid)
            if identity(pid) != before:
                raise ValueError('网关运行实例已变化，请重试更新。')
            if argv and os.path.normcase(argv[0]) == expected and any(
                    role in argv[1:] for role in _CODEX_ROLES):
                blockers.append({'provider': 'codex', 'pid': pid, 'argv': argv})
                continue
            if (len(argv) != 6 or os.path.normcase(argv[0]) != expected or
                    argv[1:3] != ['zcode-pipe-host', '--data-dir'] or argv[4] != '--application'):
                continue
        except ProcessLookupError:
            continue
        except OSError as error:
            if getattr(error, 'winerror', None) == 87:
                continue
            raise
        blockers.append({'provider': 'zcode', 'pid': pid, 'argv': argv})
    return blockers


def require_update_ready(worker):
    blockers = inspect_update_blockers(worker)
    if blockers:
        raise ValueError(_PROVIDER_MESSAGES[blockers[0]['provider']])


def _blocker_hosts(blockers, worker_path):
    """Identify exact parent ChatGPT/Codex/ZCode host executables owning locked workers."""
    expected_worker = os.path.normcase(str(worker_path))
    hosts = []
    seen = set()
    for blocker in blockers:
        current = blocker['pid']
        visited = set()
        for _ in range(12):
            if not current or current in visited:
                break
            visited.add(current)
            try:
                info = _identity(current, parent=True)
            except (OSError, PermissionError, ProcessLookupError, ValueError):
                break
            image = info.get('image') or ''
            leaf = Path(image).name.lower() if image else ''
            if image == expected_worker or leaf == 'codex-launcher.exe':
                current = info.get('parent')
                continue
            if blocker['provider'] == 'codex' and leaf in ('chatgpt.exe', 'codex.exe'):
                key = ('codex', os.path.normcase(image))
                if key not in seen:
                    seen.add(key)
                    hosts.append(('codex', Path(image)))
            elif blocker['provider'] == 'zcode' and leaf == 'zcode.exe':
                key = ('zcode', os.path.normcase(image))
                if key not in seen:
                    seen.add(key)
                    hosts.append(('zcode', Path(image)))
            break
    return hosts


def _force_terminate_image(executable):
    resolved = Path(executable).resolve()
    expected = force_exit._path(resolved)
    state = process_inventory([resolved]).get(resolved, {})
    pids = list(state.get('pids') or [])
    if not pids:
        return
    commands = state.get('commands') or {}
    main_pids = []
    for pid in pids:
        command = commands.get(pid) or ''
        if '--type=' not in command and '--type ' not in command:
            main_pids.append(pid)
    descriptor = {'id': 'zcode' if resolved.name.lower() == 'zcode.exe' else 'codex',
                  'installed': True, 'executable': str(resolved)}
    if len(main_pids) <= 1 and all(isinstance(commands.get(pid), str) and commands.get(pid).strip() for pid in pids):
        try:
            force_exit.force_stop_client(descriptor, state={'unknown': False, 'pids': pids, 'mainPids': main_pids})
            return
        except ValueError:
            pass
    native = force_exit._Native()
    if expected in native.protected_paths:
        raise ValueError(force_exit.PROTECTED)
    held = []
    try:
        for pid in pids:
            if pid in native.protected_pids:
                raise ValueError(force_exit.PROTECTED)
            try:
                handle = native.open(pid, terminate=True)
            except OSError as exc:
                if getattr(exc, 'winerror', None) == 87:
                    continue
                raise
            try:
                info = native.identity(handle)
                if info['image'] != expected or info['session'] != native.session:
                    native.close(handle)
                    continue
                if info['image'] in native.protected_paths:
                    native.close(handle)
                    raise ValueError(force_exit.PROTECTED)
                held.append(handle)
            except Exception:
                native.close(handle)
                raise
        for handle in held:
            if native.alive(handle):
                native.terminate(handle)
    finally:
        for handle in held:
            native.close(handle)


def stop_update_blockers(worker, *, force=False, timeout=10.0):
    worker_path = Path(worker).resolve(strict=True)
    blockers = inspect_update_blockers(worker_path)
    if not blockers:
        return {'stopped': [], 'ready': True}
    hosts = _blocker_hosts(blockers, worker_path)
    for provider, executable in hosts:
        app = SimpleNamespace(executable=executable)
        try:
            if provider == 'zcode':
                codex_quit.stop_zcode(app)
            else:
                codex_quit.stop_codex(app)
        except ValueError:
            if not force:
                raise
            _force_terminate_image(executable)
    deadline = time.monotonic() + timeout
    while True:
        remaining = inspect_update_blockers(worker_path)
        if not remaining:
            return {'stopped': sorted({p for p, _ in hosts} or {b['provider'] for b in blockers}), 'ready': True}
        if time.monotonic() >= deadline:
            require_update_ready(worker_path)
        time.sleep(min(0.25, max(0.01, deadline - time.monotonic())))

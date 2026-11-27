"""Desktop-owned Windows stdio runtime with a private metadata-only endpoint."""
import contextlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import uuid
from types import SimpleNamespace

from bridge.clients.local_rpc import LocalService, LocalRequestNotSent, read_packet, write_packet
from .app_server import (AppServerError, AppServerUnavailable, AppServerUnknownResult,
                         AppServerRequestNotSent, response_result)
from .desktop_runtime import (VERSION, _read, _write, directory, exclusive_lock,
                              process_identity, require_inactive, server_arguments, verify_record)
from .desktop_runtime_host import _forward_input
from .desktop_stdio import DesktopStdio, MAX_LINE, METADATA_METHODS


NAME = 'codex-desktop'
_AUXILIARY_CLI_COMMANDS = frozenset(('app-server', 'exec-server', 'mcp', 'mcp-server', 'sandbox'))


def _same_path(left, right):
    if not left or not right:
        return False
    try:
        return (os.path.normcase(str(Path(left).expanduser().resolve()))
                == os.path.normcase(str(Path(right).expanduser().resolve())))
    except (OSError, RuntimeError, ValueError):
        return False


def _child_env(config, source=None):
    env = dict(os.environ if source is None else source)
    env.pop('CMB_CODEX_DESKTOP_CONFIGURATION', None)
    if env.get('CODEX_CLI_PATH') and _same_path(env['CODEX_CLI_PATH'], sys.executable):
        env['CODEX_CLI_PATH'] = config['cli']
    # Desktop's override bootstrap removes this variable. Preserve the exact
    # registered package identity instead of weakening its native sandbox.
    if config.get('sandboxFamily'):
        env['CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'] = config['sandboxFamily']
    return env


def _passthrough_call(cli, arguments, env):
    # Windows CRT process overlay can crash before forwarding startup output.
    return subprocess.call([cli, *arguments], env=env, stdin=sys.stdin, stdout=sys.stdout,
                           stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)


def _write_all(stream, data):
    view = memoryview(data)
    while view:
        written = stream.write(view)
        if not written:
            break
        view = view[written:]


def _passthrough_stdio(cli, arguments, env, first):
    """Preserve an auxiliary stdio caller after examining its first message."""
    child = subprocess.Popen([cli, *arguments], env=env, stdin=subprocess.PIPE,
                             stdout=sys.stdout, stderr=sys.stderr, bufsize=0,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    reader = sys.stdin.buffer

    def forward():
        try:
            if first:
                _write_all(child.stdin, first)
            while True:
                chunk = reader.read1(65536) if hasattr(reader, 'read1') else reader.read(65536)
                if not chunk:
                    break
                _write_all(child.stdin, chunk)
        except (OSError, ValueError):
            pass
        finally:
            with contextlib.suppress(OSError, ValueError):
                child.stdin.close()

    threading.Thread(target=forward, daemon=True).start()
    return child.wait()


def _is_codex_cli_invocation(arguments):
    args = list(arguments)
    if args in (['--version'], ['-V']):
        return True
    if server_arguments(args, Path('unused.sock')) is not None:
        return True
    index = 0
    while index < len(args):
        token = args[index]
        if token in ('-c', '--config') and index + 1 < len(args):
            index += 2
        elif token.startswith('--config='):
            index += 1
        else:
            break
    return index < len(args) and args[index] in _AUXILIARY_CLI_COMMANDS


def _candidate_homes():
    seen = set()
    candidates = []
    configured = (os.environ.get('CODEX_HOME') or '').strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    try:
        candidates.append(Path.home() / '.codex')
    except (OSError, RuntimeError, ValueError):
        pass
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        yield resolved


def _verified_passthrough_config():
    for home in _candidate_homes():
        path = directory(home) / 'settings.json'
        if not path.exists() and not path.is_symlink():
            continue
        try:
            config = _read(path)
            config_home = Path(config['home']).resolve()
            if (config.get('version') != VERSION
                    or not _same_path(path, directory(config_home) / 'settings.json')
                    or not _same_path(config.get('launcher'), sys.executable)):
                continue
            cli = config.get('cli')
            if (not isinstance(cli, str) or not cli.strip()
                    or _same_path(cli, sys.executable) or not Path(cli).is_file()):
                continue
            return config
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return None


def run_cli_passthrough(arguments):
    """Forward auxiliary Codex CLI calls when env wrapper vars were dropped."""
    if not arguments:
        return None
    via_env = _same_path(os.environ.get('CODEX_CLI_PATH'), sys.executable)
    if not via_env and not _is_codex_cli_invocation(arguments):
        return None
    config = _verified_passthrough_config()
    if config is None:
        return None
    return _passthrough_call(config['cli'], arguments, _child_env(config))


def _verify(record):
    if _read(directory(record['home']) / 'active.json') != record:
        raise ValueError('Codex 原生连接记录已变化')
    verify_record(record)


class MetadataClient:
    def __init__(self, profile, record):
        self.service = LocalService(profile, NAME)
        self.record = record
        self.closed = False

    def connect(self):
        try:
            value = self.service._exchange({'command': 'status'}, timeout=5)
            if (value.get('generation') != self.record['generation'] or value.get('ready') is not True
                    or value.get('home') != self.record['home']):
                raise ValueError('原生连接身份不匹配')
            _verify(self.record)
        except (OSError, ValueError, EOFError, KeyError, TypeError) as exc:
            raise AppServerUnavailable('Codex 原生连接尚未就绪，请重新初始化连接') from exc

    def request(self, method, params, timeout=90):
        if self.closed or method not in METADATA_METHODS or not isinstance(params, dict):
            raise AppServerRequestNotSent('原生元数据连接不可用')
        try:
            _verify(self.record)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise AppServerRequestNotSent('Codex 原生连接已变化') from exc
        try:
            response = self.service._exchange({'command': 'call', 'generation': self.record['generation'],
                                               'method': method, 'params': params}, timeout=timeout)
        except LocalRequestNotSent as exc:
            raise AppServerRequestNotSent(str(exc)) from exc
        except (OSError, ValueError, EOFError, KeyError, TypeError) as exc:
            raise AppServerUnknownResult(str(exc) or '原生操作结果尚未确认，不会重复提交') from exc
        return response_result(method, params, response)

    def close(self):
        self.closed = True  # The App, not this Bridge connection, owns native stdin.


def ordinary_run(configuration, arguments):
    """Validate the immutable dispatcher and the caller before sharing stdio."""
    from bridge.platforms.windows import codex_launch
    from .desktop_runtime import initialization_lock
    path = Path(configuration).resolve()
    config = _read(path)
    home = Path(config['home']).resolve()
    if path != directory(home)/'settings.json' or config.get('version') != VERSION:
        raise ValueError('原生普通启动配置不匹配')
    record = _read(directory(home)/'ordinary-launch.json')
    dispatcher = process_identity(os.getppid())
    if not codex_launch.owned_launcher(dispatcher['image'], directory(home)):
        raise ValueError('普通启动分派器不匹配')
    import hashlib
    helper = Path(dispatcher['image'])
    if hashlib.sha256(helper.read_bytes()).hexdigest() != helper.parent.name:
        raise ValueError('普通启动分派器身份已变化')
    parent = process_identity(dispatcher['parent'])
    cli = codex_launch.bundled_cli(parent['image'], record.get('cliRelative'))
    selected_app = codex_launch.selected_application(parent['image'], record)
    if selected_app and record.get('cliRelative') is None:
        from bridge.platforms.windows.discovery import cached_runtime_candidates
        candidates=cached_runtime_candidates(record['cli'])
        cli=str(candidates[0].resolve()) if candidates else record['cli']
    current_home = Path(os.environ.get('CODEX_HOME') or Path(os.environ['USERPROFILE'])/'.codex').resolve()
    sqlite_home = Path(os.environ.get('CODEX_SQLITE_HOME') or current_home).resolve()
    if current_home != home or sqlite_home != home or not selected_app:
        env = {k:v for k,v in os.environ.items() if k != 'CMB_CODEX_DESKTOP_CONFIGURATION'}
        return subprocess.call([cli, *arguments], env=env, stdin=sys.stdin, stdout=sys.stdout,
                               stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    from .desktop_runtime import desktop_owner
    desktop_owner(parent, parent['image'])
    if (config['application'] != parent['image'] or config['cli'] != cli or
            Path(config['launcher']).resolve() != Path(sys.executable).resolve()):
        # Store updates move the install directory. Match the registered AUMID,
        # not a version path, and never replace a still-running previous writer.
        with initialization_lock(home):
            active = directory(home)/'active.json'
            if active.exists():
                require_inactive(_read(active))
            updated = {**config, 'application': parent['image'], 'cli': cli,
                       'launcher': str(Path(sys.executable).resolve())}
            _write(path, json.dumps(updated))
    if process_identity(dispatcher['pid']) != dispatcher or process_identity(parent['pid']) != parent:
        raise ValueError('普通启动进程已变化')
    os.environ['CODEX_HOME'] = str(home)
    return run(configuration, arguments, dispatcher=dispatcher)


def run(configuration, arguments, *, dispatcher=None):
    from bridge.platforms.windows import local_service as native
    import msvcrt
    for stream in (sys.stdin, sys.stdout):
        msvcrt.setmode(stream.fileno(), os.O_BINARY)
    path = Path(configuration).resolve()
    config = _read(path)
    home = Path(config['home']).resolve()
    if (config.get('version') != VERSION or not _same_path(path, directory(home) / 'settings.json')
            or not _same_path(config.get('launcher'), sys.executable)):
        raise ValueError('原生共享连接配置不匹配')
    env = _child_env(config)
    cli = config['cli']
    if server_arguments(arguments, Path('unused.sock')) is None:
        return _passthrough_call(cli, arguments, env)
    if (not env.get('CODEX_HOME') or not _same_path(env['CODEX_HOME'], home)
            or (env.get('CODEX_SQLITE_HOME') and not _same_path(env['CODEX_SQLITE_HOME'], home))):
        return _passthrough_call(cli, arguments, env)
    from .desktop_runtime import desktop_owner
    parent = process_identity(dispatcher['parent'] if dispatcher else os.getppid())
    try:
        app, host = desktop_owner(parent, config['application'])
    except (OSError, ValueError):
        if dispatcher is not None:
            raise
        return _passthrough_call(cli, arguments, env)
    first = sys.stdin.buffer.readline(MAX_LINE + 2)
    if len(first) > MAX_LINE + 1:
        raise ValueError('原生初始化消息过大')
    try:
        initialize = json.loads(first)
    except (ValueError, UnicodeError):
        initialize = None
    if not (isinstance(initialize, dict) and initialize.get('method') == 'initialize'
            and initialize.get('params', {}).get('clientInfo', {}).get('name') == 'Codex Desktop'):
        return _passthrough_stdio(cli, arguments, env, first)
    with exclusive_lock(home, 'runtime'):
        if host is not None:
            from .desktop_host import serve
            return serve(config, app, host, arguments, initialize, env, dispatcher=dispatcher)
        return _serve(config, app, arguments, initialize, env, native, dispatcher=dispatcher)


def _serve(config, app, arguments, initialize, env, native, *, dispatcher=None):
    root = directory(config['home'])
    active = root / 'active.json'
    if active.exists():
        require_inactive(_read(active))
    generation = str(uuid.uuid4())
    record = {'version': VERSION, 'ready': False, 'home': config['home'], 'cli': config['cli'],
              'app': app, 'adapter': process_identity(os.getpid()), 'runtime': None, 'generation': generation}
    if dispatcher is not None:
        record['dispatcher'] = dispatcher
    _write(active, json.dumps(record))
    child = None
    listener = None
    rpc_record = root / '.local-services' / NAME / 'ipc.json'
    token = secrets.token_hex(32)
    stopped = threading.Event()
    output_lock = threading.Lock()
    slots = threading.BoundedSemaphore(8)

    def emit(message):
        with output_lock:
            sys.stdout.buffer.write(json.dumps(message, ensure_ascii=False).encode('utf-8') + b'\n')
            sys.stdout.buffer.flush()

    def write(data):
        offset = 0
        while offset < len(data):
            count = child.stdin.write(data[offset:])
            if not count:
                raise EOFError('原生桌面连接已关闭')
            offset += count

    def initialized(result):
        if Path(result.get('codexHome', '')).resolve() != Path(config['home']).resolve():
            raise ValueError('原生运行时使用了其他配置目录')
        _verify(record)
        record['ready'] = True
        _write(active, json.dumps(record))

    router = DesktopStdio(write, emit, initialized)

    def handle(connection):
        try:
            with connection:
                native.require_peer(connection, server=True)
                pipe = native.byte_stream(connection)
                deadline = time.monotonic() + 95
                message = read_packet(lambda size: pipe.recv(size, timeout=deadline-time.monotonic()))
                supplied = message.get('token')
                if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
                    return
                dispatched = False
                try:
                    _verify(record)
                    request = message.get('request')
                    if stopped.is_set() or not isinstance(request, dict):
                        raise ValueError('原生桌面连接已关闭')
                    if request.get('command') == 'status':
                        value = {'generation': generation, 'home': config['home'], 'ready': router.ready}
                    elif request.get('command') == 'call' and request.get('generation') == generation:
                        dispatched = True
                        value = router.request_packet(request.get('method'), request.get('params'), timeout=max(.01, deadline-time.monotonic()))
                    else:
                        raise ValueError('原生元数据请求无效')
                    response = {'ok': True, 'value': value}
                except (OSError, ValueError, AppServerError, EOFError) as exc:
                    response = {'ok': False, 'error': str(exc), 'notSent': not dispatched or isinstance(exc, AppServerRequestNotSent)}
                write_packet(lambda data: pipe.send(data, timeout=5), response)
        except (OSError, ValueError, EOFError, KeyError, TypeError):
            pass
        finally:
            slots.release()

    def accept():
        while not stopped.is_set():
            try:
                connection = listener.accept()
            except (OSError, EOFError):
                return
            if not slots.acquire(blocking=False):
                connection.close()
                continue
            threading.Thread(target=handle, args=(connection,), daemon=True).start()

    def output():
        try:
            while not stopped.is_set():
                line = child.stdout.readline(MAX_LINE + 2)
                if not line:
                    return
                if len(line.rstrip(b'\r\n')) > MAX_LINE:
                    raise ValueError('原生回执超过消息大小限制')
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError('原生回执格式无效')
                router.from_native(message)
        except (OSError, ValueError, AppServerError):
            pass
        finally:
            stopped.set()

    def input():
        try:
            router.from_app(initialize)
            _forward_input(sys.stdin.buffer, SimpleNamespace(send=router.from_app), emit, stopped)
        except (OSError, ValueError, AppServerError):
            pass
        finally:
            stopped.set()

    try:
        # No UDS daemon: the wrapper is the only holder of native stdin. Even
        # Desktop's Windows TerminateProcess(wrapper) closes this write handle,
        # causing native connection cleanup without a force-kill of the runtime.
        child = subprocess.Popen([config['cli'], *arguments], env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, bufsize=0, close_fds=True,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        record['runtime'] = process_identity(child.pid)
        if record['runtime']['parent'] != os.getpid() or record['runtime']['image'] != os.path.normcase(config['cli']):
            raise ValueError('原生运行时子进程身份不匹配')
        _write(active, json.dumps(record))
        endpoint = '\\\\.\\pipe\\cmb-rpc-' + NAME + '-' + secrets.token_hex(16)
        listener = native.listener(endpoint)
        native.write_record(rpc_record, {'endpoint': endpoint, 'token': token, 'owner': record['adapter'],
                                         'profile': str(root.resolve()), 'name': NAME})
        threading.Thread(target=accept, daemon=True).start()
        threading.Thread(target=output, daemon=True).start()
        threading.Thread(target=input, daemon=True).start()
        stopped.wait()
    finally:
        stopped.set()
        router.close()
        if listener is not None:
            with contextlib.suppress(OSError): listener.close()
        with contextlib.suppress(OSError, ValueError, KeyError):
            if native.read_record(rpc_record).get('token') == token: rpc_record.unlink()
        if child is not None:
            with contextlib.suppress(OSError): child.stdin.close()
            try:
                child.wait(timeout=25)
            except subprocess.TimeoutExpired:
                print('原生运行时仍在正常退出，保留连接记录供下次核验', file=sys.stderr)
                return 1
        if child is not None and active.exists() and _read(active) == record:
            active.unlink()
    return child.returncode if child is not None else 1

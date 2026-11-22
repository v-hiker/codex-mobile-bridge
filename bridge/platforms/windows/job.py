"""Windows Job Object binding so child tunnels cannot survive gateway crashes."""
import ctypes as C
from ctypes import wintypes as W
import logging
import os
import threading

LOG = logging.getLogger(__name__)

JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001

_KERNEL32 = None
_KERNEL32_LOCK = threading.Lock()


class JOB_BASIC_LIMITS(C.Structure):
    _fields_ = [
        ('process_time', C.c_int64),
        ('job_time', C.c_int64),
        ('flags', W.DWORD),
        ('minimum', C.c_size_t),
        ('maximum', C.c_size_t),
        ('active', W.DWORD),
        ('affinity', C.c_size_t),
        ('priority', W.DWORD),
        ('scheduling', W.DWORD),
    ]


class JOB_IO_COUNTERS(C.Structure):
    _fields_ = [(name, C.c_uint64) for name in (
        'reads', 'writes', 'other', 'read_bytes', 'write_bytes', 'other_bytes')]


class JOB_EXTENDED_LIMITS(C.Structure):
    _fields_ = [
        ('basic', JOB_BASIC_LIMITS),
        ('io', JOB_IO_COUNTERS),
        ('process_memory', C.c_size_t),
        ('job_memory', C.c_size_t),
        ('peak_process_memory', C.c_size_t),
        ('peak_job_memory', C.c_size_t),
    ]


def _kernel32():
    global _KERNEL32
    with _KERNEL32_LOCK:
        if _KERNEL32 is not None:
            return _KERNEL32
        kernel = C.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreateJobObjectW': (W.HANDLE, [C.c_void_p, W.LPCWSTR]),
            'SetInformationJobObject': (W.BOOL, [W.HANDLE, C.c_int, C.c_void_p, W.DWORD]),
            'AssignProcessToJobObject': (W.BOOL, [W.HANDLE, W.HANDLE]),
            'OpenProcess': (W.HANDLE, [W.DWORD, W.BOOL, W.DWORD]),
            'CloseHandle': (W.BOOL, [W.HANDLE]),
        }
        for name, (restype, argtypes) in signatures.items():
            fn = getattr(kernel, name)
            fn.restype = restype
            fn.argtypes = argtypes
        _KERNEL32 = kernel
        return kernel


class ProcessJob:
    """Thread-safe, idempotent owner of a Windows Job Object handle."""

    def __init__(self, handle, kernel=None):
        self._handle = int(handle) if handle else None
        self._kernel = kernel
        self._lock = threading.Lock()

    def close(self):
        """Close the job handle; the kernel terminates assigned processes on last handle close."""
        with self._lock:
            handle = self._handle
            self._handle = None
        if handle:
            kernel = self._kernel or _kernel32()
            kernel.CloseHandle(handle)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def bind_kill_on_close(process):
    """Assign a Windows subprocess to an unnamed KILL_ON_JOB_CLOSE job object."""
    if os.name != 'nt' or process is None:
        return None
    raw_handle = getattr(process, '_handle', None)
    owned_proc_handle = False
    kernel = None
    if isinstance(raw_handle, int) and not isinstance(raw_handle, bool) and int(raw_handle) > 0:
        proc_handle = int(raw_handle)
    else:
        pid = getattr(process, 'pid', None)
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            return None
        kernel = _kernel32()
        proc_handle = kernel.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not proc_handle:
            return None
        owned_proc_handle = True

    if kernel is None:
        kernel = _kernel32()

    job = None
    try:
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise C.WinError(C.get_last_error())
        limits = JOB_EXTENDED_LIMITS()
        limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(
                job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, C.byref(limits), C.sizeof(limits)):
            raise C.WinError(C.get_last_error())
        if not kernel.AssignProcessToJobObject(job, proc_handle):
            raise C.WinError(C.get_last_error())
        assigned = ProcessJob(job, kernel)
        job = None
        return assigned
    except OSError as exc:
        poll = getattr(process, 'poll', None)
        alive = callable(poll) and poll() is None
        if alive:
            LOG.warning('Failed to bind Windows kill-on-close job object to pid=%s: %s',
                        getattr(process, 'pid', '?'), exc)
        else:
            LOG.debug('Skipped binding Windows job object after process exit pid=%s: %s',
                      getattr(process, 'pid', '?'), exc)
        return None
    finally:
        if job:
            kernel.CloseHandle(job)
        if owned_proc_handle and proc_handle:
            kernel.CloseHandle(proc_handle)


def close_job(job):
    """Close a job handle if present."""
    if job is not None:
        job.close()

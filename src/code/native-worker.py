#!/usr/bin/python3
"""Durable root native job worker. Run only by the per-job systemd service.

The authorized command receives ordinary host access and networking. This worker
does not impose a sandbox, command allowlist, or output retention limit.
"""
import codecs
import datetime
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic(path, value):
    pending = path.with_name(path.name + '.next-' + str(os.getpid()))
    with pending.open('x', encoding='utf8') as stream:
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, path)
    sync_directory(path.parent)


def write_all(stream, data):
    remaining = memoryview(data)
    while remaining:
        count = stream.write(remaining)
        if not count:
            raise OSError('Native job output write made no progress')
        remaining = remaining[count:]


def main(directory):
    directory = Path(directory)
    request = json.loads((directory / 'request.json').read_text())
    if not (directory / 'start-intent.json').is_file():
        raise RuntimeError('Native job has no durable launch intent')
    # Remain fail-closed if an operator accidentally starts the same service
    # twice, including after a worker crash between intent and Popen.
    with (directory / 'execution-claimed.json').open('x') as stream:
        json.dump({'pid': os.getpid(), 'claimedAt': utc()}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(directory)
    started = time.monotonic()
    state = {'name': request['name'], 'pid': os.getpid(), 'startedAt': utc(),
             'terminal': False, 'invocationId': os.environ.get('INVOCATION_ID')}
    atomic(directory / 'state.json', state)
    interrupted = [None]

    def stop(signum, _frame):
        if interrupted[0] is None:
            interrupted[0] = signum

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = None
    reason = 'exit'
    exit_code = None
    termination_signal = None
    stop_at = None
    selector = selectors.DefaultSelector()
    streams = {}
    output = (directory / 'output.log').open('ab', buffering=0)

    def capture(label, data, final=False):
        raw, decoder = streams[label]
        if data:
            write_all(raw, data)
            os.fsync(raw.fileno())
        text = decoder.decode(data, final=final)
        if not text:
            return
        parts = text.split('\n')
        for index, value in enumerate(parts):
            complete = index < len(parts) - 1
            if not complete and not value:
                continue
            write_all(output, (utc() + ' ' + label + (' F ' if complete else ' P ') + value + '\n').encode('utf8'))
        os.fsync(output.fileno())

    try:
        child = subprocess.Popen(request['argv'], cwd=request['cwd'], env=request['env'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        state['childPid'] = child.pid
        atomic(directory / 'state.json', state)
        for label in ('stdout', 'stderr'):
            pipe = getattr(child, label)
            os.set_blocking(pipe.fileno(), False)
            streams[label] = ((directory / (label + '.raw')).open('ab', buffering=0), codecs.getincrementaldecoder('utf8')('replace'))
            selector.register(pipe, selectors.EVENT_READ, label)
        while selector.get_map() or child.poll() is None:
            now = time.monotonic()
            timed_out = request['timeoutSeconds'] > 0 and now - started >= request['timeoutSeconds']
            if stop_at is None and (interrupted[0] is not None or timed_out):
                reason = 'timeout' if timed_out else 'cancelled'
                stop_at = now
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if stop_at is not None and now - stop_at >= 2:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for key, _events in selector.select(0.1):
                data = os.read(key.fd, 65536)
                if data:
                    capture(key.data, data)
                else:
                    capture(key.data, b'', final=True)
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
        result = child.wait()
        # systemd signals the entire cgroup at once. The child and its pipes can
        # close before the loop body observes our signal handler's flag.
        if reason == 'exit' and interrupted[0] is not None:
            reason = 'cancelled'
        exit_code = result if result >= 0 else None
        termination_signal = signal.Signals(-result).name if result < 0 else None
    except Exception as error:
        reason = 'worker_error'
        state['workerError'] = {'type': type(error).__name__, 'message': str(error)}
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        if child is None:
            exit_code = 127
    finally:
        selector.close()
        for raw, _decoder in streams.values():
            raw.flush()
            os.fsync(raw.fileno())
            raw.close()
        output.flush()
        os.fsync(output.fileno())
        output.close()
        state.update(terminal=True, exitCode=exit_code, signal=termination_signal,
                     reason=reason, finishedAt=utc())
        atomic(directory / 'state.json', state)
    return 0 if reason != 'worker_error' else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Expected one native job directory')
    raise SystemExit(main(sys.argv[1]))

#!/usr/bin/env python3
"""Bounded CONNECT transport: public package registries, pinned public IPs only.

TLS is end-to-end between the sandbox package manager and registry. This service
has no credentials, cannot execute code, and never accepts host paths or URLs.
"""
import ipaddress
import os
import re
import selectors
import socket
import socketserver
import threading
import time

HOSTS = frozenset(('registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'))
MAX_BYTES = 512 * 1024 * 1024
MAX_SECONDS = 300
SEMAPHORE = threading.BoundedSemaphore(16)


def destination(first_line):
    match = re.fullmatch(rb'CONNECT ([a-z0-9.-]+):443 HTTP/1\.[01]', first_line)
    if not match or match[1].decode('ascii') not in HOSTS:
        raise ValueError('Only HTTPS public package registries are permitted')
    return match[1].decode('ascii')


def public_addresses(host, resolver=socket.getaddrinfo):
    addresses = resolver(host, 443, type=socket.SOCK_STREAM)
    if not addresses or len(addresses) > 32:
        raise ValueError('Registry DNS response is unavailable or unbounded')
    for family, socktype, proto, canonical, address in addresses:
        ip = ipaddress.ip_address(address[0])
        if not ip.is_global or ip.is_multicast or ip.is_unspecified or getattr(ip, 'ipv4_mapped', None):
            raise ValueError('Registry DNS resolved to a prohibited address')
    return addresses


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not SEMAPHORE.acquire(blocking=False):
            self.request.sendall(b'HTTP/1.1 503 Busy\r\nConnection: close\r\n\r\n')
            return
        try:
            self.serve()
        except (OSError, ValueError, TimeoutError):
            try:
                self.request.sendall(b'HTTP/1.1 403 Registry access refused\r\nConnection: close\r\n\r\n')
            except OSError:
                pass
        finally:
            SEMAPHORE.release()

    def serve(self):
        client = self.request
        client.settimeout(10)
        header = bytearray()
        header_deadline = time.monotonic() + 10
        # No over-read: bytes after CONNECT are TLS and must be forwarded intact.
        while not header.endswith(b'\r\n\r\n'):
            part = client.recv(1)
            if not part or len(header) >= 8192 or time.monotonic() >= header_deadline:
                raise ValueError('Invalid CONNECT header')
            header.extend(part)
        host = destination(bytes(header).split(b'\r\n', 1)[0])
        upstream = None
        for family, socktype, proto, _, address in public_addresses(host):
            connection = socket.socket(family, socktype, proto)
            connection.settimeout(10)
            try:
                connection.connect(address)  # DNS result is pinned, never resolved twice.
                upstream = connection
                break
            except OSError:
                connection.close()
        if upstream is None:
            raise ValueError('Registry connection failed')
        with upstream, selectors.DefaultSelector() as events:
            client.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            events.register(client, selectors.EVENT_READ, upstream)
            events.register(upstream, selectors.EVENT_READ, client)
            total, started = 0, time.monotonic()
            while time.monotonic() - started < MAX_SECONDS:
                ready = events.select(15)
                if not ready:
                    return
                for event, _ in ready:
                    data = event.fileobj.recv(65536)
                    if not data:
                        return
                    total += len(data)
                    if total > MAX_BYTES:
                        return
                    event.data.sendall(data)


class Server(socketserver.ThreadingMixIn, getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer)):
    daemon_threads = True
    request_queue_size = 16


if __name__ == '__main__':
    if not hasattr(socketserver, 'UnixStreamServer'):
        raise SystemExit('Registry transport requires a Unix socket host')
    path = '/run/praxis-dependencies/proxy.sock'
    if os.path.lexists(path):
        if not __import__('stat').S_ISSOCK(os.lstat(path).st_mode):
            raise SystemExit('Refusing to replace a non-socket path')
        os.unlink(path)
    with Server(path, Handler) as server:
        os.chmod(path, 0o660)
        server.serve_forever()

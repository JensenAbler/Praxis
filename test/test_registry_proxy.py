import importlib.util
from pathlib import Path
import socket
import unittest

SPEC = importlib.util.spec_from_file_location('registry_proxy', Path(__file__).resolve().parents[1] / 'deploy' / 'registry-proxy.py')
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class RegistryPolicy(unittest.TestCase):
    def test_only_exact_https_registry_authorities(self):
        for host in proxy.HOSTS:
            self.assertEqual(proxy.destination(f'CONNECT {host}:443 HTTP/1.1'.encode()), host)
        for target in ('registry.npmjs.org:80', 'registry.npmjs.org.evil.example:443', 'localhost:443',
                       '127.0.0.1:443', '[::1]:443', '169.254.169.254:443', 'github.com:443',
                       'user@registry.npmjs.org:443', 'registry.npmjs.org.:443'):
            with self.assertRaises(ValueError):
                proxy.destination(f'CONNECT {target} HTTP/1.1'.encode())
        with self.assertRaises(ValueError):
            proxy.destination(b'GET https://registry.npmjs.org/package HTTP/1.1')

    def test_private_rebinding_and_mapped_addresses_rejected(self):
        for address in ('127.0.0.1', '10.0.0.5', '169.254.169.254', '172.16.0.1', '192.168.0.1',
                        '100.100.100.200', '::1', 'fc00::1', 'fe80::1', '::ffff:1.1.1.1', '224.0.0.1'):
            with self.assertRaises(ValueError, msg=address):
                proxy.public_addresses('registry.npmjs.org', resolver=lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))])

    def test_all_addresses_checked_before_any_connection(self):
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.0.0.1', 443))]
        with self.assertRaises(ValueError):
            proxy.public_addresses('pypi.org', resolver=lambda *args, **kwargs: rows)
        allowed = [rows[0]]
        self.assertEqual(proxy.public_addresses('pypi.org', resolver=lambda *args, **kwargs: allowed), allowed)


if __name__ == '__main__':
    unittest.main()

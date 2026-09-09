#!/usr/bin/python3
"""Installed owner-controlled updater. Candidate code is never imported here.

The stdin API performs bounded admission/status only. A separately supervised
worker executes durable operations. All paths/policies come from root config.
"""
import contextlib
import datetime
try:
    import fcntl
except ImportError:  # Pure state-machine fixtures also run on Windows.
    fcntl = None
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys
import time
import uuid

CONFIG = pathlib.Path('/etc/praxis-updater/config.json')
TERMINAL = {'ready', 'completed', 'failed', 'rolled_back'}
CONFIRMED = {'activation_confirmed': ('completed', 'completed'),
             'restoration_confirmed': ('rolled_back', 'restored')}


class UpdateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(value, code, message):
    if not value:
        raise UpdateError(code, message)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def ordinary_id(value):
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def validate_input(args):
    require(isinstance(args, dict), 'INVALID_ARGUMENT', 'An object is required.')
    fields = {
        'plan': {'operationId', 'owner', 'idempotencyKey', 'exportId', 'sourceCommit', 'sourceDigest', 'expectedRelease'},
        'apply': {'operationId', 'owner', 'idempotencyKey', 'planId', 'planDigest', 'expectedRelease'},
        'rollback': {'operationId', 'owner', 'idempotencyKey', 'deploymentOperationId', 'expectedRelease'},
        'status': {'owner', 'operationId'}, 'history': {'owner', 'cursor', 'limit'},
    }
    action = args.get('action')
    require(action in fields and not set(args) - fields[action] - {'action'}, 'INVALID_ARGUMENT', 'Unsupported updater action or fields.')
    require(args.get('owner') == 'jensen', 'FORBIDDEN', 'Registered owner required.')
    for key in ('operationId', 'exportId', 'planId', 'deploymentOperationId'):
        if key in args:
            require(ordinary_id(args[key]), 'INVALID_ARGUMENT', 'Identifiers must be canonical UUIDs.')
    if action in ('plan', 'apply', 'rollback'):
        require(fields[action] <= set(args), 'INVALID_ARGUMENT', 'Missing release inputs.')
        require(re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', args['idempotencyKey'] or ''), 'INVALID_ARGUMENT', 'Invalid idempotency key.')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', args['expectedRelease'] or ''), 'INVALID_ARGUMENT', 'Invalid expected release.')
    if action == 'plan':
        require(re.fullmatch('[a-f0-9]{40}', args['sourceCommit'] or '') and re.fullmatch('[a-f0-9]{64}', args['sourceDigest'] or ''), 'INVALID_ARGUMENT', 'Exact source identifiers required.')
    if action == 'apply':
        require(re.fullmatch('[a-f0-9]{64}', args['planDigest'] or ''), 'INVALID_ARGUMENT', 'Exact plan digest required.')
    if action == 'history':
        require(type(args.get('cursor', 0)) is int and args.get('cursor', 0) >= 0 and type(args.get('limit', 20)) is int and 1 <= args.get('limit', 20) <= 50,
                'INVALID_ARGUMENT', 'Invalid history page.')
    return args


class Updater:
    def __init__(self, directory, host, clock=time.time):
        self.directory = pathlib.Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.host, self.clock = host, clock
        self.db = sqlite3.connect(self.directory / 'releases.sqlite', timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS releases (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            owner TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, request TEXT NOT NULL,
            status TEXT NOT NULL, phase TEXT NOT NULL, result TEXT, error TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner,key));''')
        os.chmod(self.directory / 'releases.sqlite', 0o600)

    def close(self):
        self.db.close()

    def row(self, identifier, owner='jensen'):
        row = self.db.execute('SELECT * FROM releases WHERE id=? AND owner=?', (identifier, owner)).fetchone()
        require(row, 'NOT_FOUND', 'Release operation not found.')
        return row

    @staticmethod
    def receipt(row):
        return dict(operationId=row['id'], kind=row['kind'], status=row['status'], phase=row['phase'],
                    result=json.loads(row['result']) if row['result'] else None,
                    error=json.loads(row['error']) if row['error'] else None,
                    createdAt=row['created_at'], updatedAt=row['updated_at'])

    def save(self, row, status, phase, result=None, error=None):
        self.db.execute('UPDATE releases SET status=?,phase=?,result=?,error=?,updated_at=? WHERE id=?',
                        (status, phase, json.dumps(result) if result is not None else row['result'],
                         json.dumps(error) if error else None, stamp(), row['id']))
        return self.row(row['id'])

    def call(self, args):
        validate_input(args)
        action, owner = args['action'], args['owner']
        if action == 'status':
            value = {'active': self.host.active()}
            if args.get('operationId'):
                row = self.row(args['operationId'], owner)
                value['operation'] = self.receipt(row)
                if row['kind'] == 'plan' and hasattr(self.host, 'diagnostics'):
                    value['diagnostics'] = self.host.diagnostics(row['id'])
            return value
        if action == 'history':
            cursor, limit = args.get('cursor', 0), args.get('limit', 20)
            rows = self.db.execute('SELECT * FROM releases WHERE owner=? AND (?=0 OR sequence<?) ORDER BY sequence DESC LIMIT ?',
                                   (owner, cursor, cursor, limit + 1)).fetchall()
            return dict(operations=[self.receipt(row) for row in rows[:limit]], nextCursor=rows[limit-1]['sequence'] if len(rows) > limit else None)
        encoded = json.dumps(args, sort_keys=True)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            existing = self.db.execute('SELECT * FROM releases WHERE owner=? AND key=?', (owner, args['idempotencyKey'])).fetchone()
            if existing:
                require(existing['request'] == encoded, 'IDEMPOTENCY_CONFLICT', 'The release key belongs to different inputs.')
                if (action in ('apply', 'rollback') and existing['status'] == 'failed'
                        and existing['phase'] == 'restoration_failed'):
                    # An explicit identical owner retry resumes restoration of
                    # this operation's previous release. It never activates the
                    # failed candidate again or changes the reserved target.
                    value = json.loads(existing['result'])
                    value['recoveryAttempts'] = value.get('recoveryAttempts', 0) + 1
                    value['lastRestorationError'] = json.loads(existing['error']) if existing['error'] else None
                    existing = self.save(existing, 'queued', 'rollback_intent', value)
                self.db.commit()
                return self.receipt(existing)
            require(self.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0] < 1000, 'RETENTION_LIMIT', 'Archive release history before admitting more releases.')
            require(not self.db.execute('SELECT 1 FROM releases WHERE id=?', (args['operationId'],)).fetchone(), 'IDEMPOTENCY_CONFLICT', 'Operation ID already exists.')
            require(self.host.active()['release'] == args['expectedRelease'], 'RELEASE_CONFLICT', 'The active release changed; inspect its status.')
            if action == 'apply':
                plan = self.row(args['planId'], owner)
                value = json.loads(plan['result']) if plan['result'] else {}
                require(plan['kind'] == 'plan' and plan['status'] == 'ready', 'PLAN_NOT_READY', 'Release preparation must finish successfully.')
                require(value.get('planDigest') == args['planDigest'] and value.get('expectedRelease') == args['expectedRelease'], 'PLAN_CONFLICT', 'The exact prepared plan and expected release are required.')
                require(value.get('expiresAtEpoch', 0) > self.clock(), 'PLAN_EXPIRED', 'Prepare a new release plan.')
            if action == 'rollback':
                prior = self.row(args['deploymentOperationId'], owner)
                value = json.loads(prior['result']) if prior['result'] else {}
                require(prior['kind'] in ('apply', 'rollback') and prior['status'] == 'completed' and value.get('release') == args['expectedRelease'],
                        'ROLLBACK_CONFLICT', 'Select the completed activation of the current release.')
            created = stamp()
            self.db.execute('INSERT INTO releases(id,owner,key,kind,request,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                            (args['operationId'], owner, args['idempotencyKey'], action, encoded, 'queued', 'prepared', created, created))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return self.receipt(self.row(args['operationId'], owner))

    def tick(self):
        # OS flock is held by the independent worker for its whole lifetime.
        row = self.db.execute("SELECT * FROM releases WHERE status IN ('queued','running','waiting') ORDER BY sequence LIMIT 1").fetchone()
        if not row:
            return False
        args = json.loads(row['request'])
        try:
            if row['kind'] == 'plan':
                if row['phase'] == 'building':
                    value = self.host.recover_preparation(row['id'], args)
                else:
                    row = self.save(row, 'running', 'building')
                    value = self.host.prepare(row['id'], args)
                value.update(expectedRelease=args['expectedRelease'], sourceCommit=args['sourceCommit'],
                             expiresAtEpoch=self.clock() + 24 * 3600)
                value['planDigest'] = digest(value)
                self.save(row, 'ready', 'tested', value)
                return True
            value = json.loads(row['result']) if row['result'] else None
            if row['phase'] in CONFIRMED:
                return self.finish_decision(row)
            if row['phase'] in ('drain_intent', 'switch_intent', 'switched', 'rollback_intent'):
                # Recovery observes the target before choosing restoration. A
                # lost response never triggers an additional blind restart.
                require(value, 'CORRUPT_OPERATION', 'Activation intent has no recorded target.')
                return self.recover(row, value)
            current = self.host.active()
            require(current['release'] == args['expectedRelease'], 'RELEASE_CONFLICT', 'Active release changed before activation.')
            if row['kind'] == 'apply':
                plan = self.row(args['planId'], row['owner'])
                prepared = json.loads(plan['result'])
                require(prepared['planDigest'] == args['planDigest'] and prepared['expiresAtEpoch'] > self.clock(), 'PLAN_EXPIRED', 'Prepared release plan expired or changed.')
                target = prepared['release']
            else:
                prior = json.loads(self.row(args['deploymentOperationId'], row['owner'])['result'])
                target = prior['previousRelease']
            value = {'release': target, 'previousRelease': current['release'], 'sourceCommit': self.host.release_source(target), 'restoresDatabase': False}
            # reserve() may stop the old application while holding both DB
            # admission leases. Persist that effect's recovery target first.
            row = self.save(row, 'running', 'drain_intent', value)
            try:
                reserved = self.host.reserve(row['id'])
            except Exception as error:
                if self.host.reservation_held(row['id']):
                    return self.restore(row, value, error)
                raise
            if not reserved:
                self.save(row, 'waiting', 'waiting_for_idle', {**value, 'nextStep': 'Existing coding jobs or publication operations must finish; do not restart them.'})
                return False
            try:
                row = self.save(row, 'running', 'switch_intent', value)
                self.host.switch(target, row['id'])
                row = self.save(row, 'running', 'switched', value)
                health = self.host.health(target)
                value['health'] = health
                require(health.get('ok'), 'CANDIDATE_UNHEALTHY', 'Activated application failed authenticated readiness.')
            except Exception as error:
                return self.restore(row, value, error)
            return self.confirm(row, 'activation_confirmed', value)
        except Exception as error:
            # A durable completion decision may already have opened admission.
            # Leave it recoverable; never re-health or restore over newer work.
            persisted = self.row(row['id'])
            if persisted['phase'] in CONFIRMED:
                return False
            # An uncertain drain/switch must retain its fence. Only explicit
            # successful health/recovery opens it after these phases begin.
            if row['phase'] not in ('drain_intent', 'switch_intent', 'switched', 'rollback_intent'):
                self.host.release_reservation(row['id'])
            self.save(row, 'failed', row['phase'], error={'code': getattr(error, 'code', 'UPDATE_FAILED'), 'message': str(error)[:500]})
            return True

    def recover(self, row, value):
        if row['phase'] == 'rollback_intent':
            return self.restore(row, value, UpdateError('INTERRUPTED_ACTIVATION', 'Activation was interrupted while restoring the previous release.'))
        if row['phase'] == 'drain_intent' and not self.host.reservation_held(row['id']):
            # The worker was interrupted before acquiring its fence, or after
            # finding outstanding work. It never switched a candidate here.
            self.save(row, 'failed', 'drain_not_acquired', value,
                      {'code': 'INTERRUPTED_DRAIN', 'message': 'Drain was interrupted without a held reservation; inspect current state before a new activation.'})
            return True
        try:
            active = self.host.active()
            health = None
            if row['phase'] != 'drain_intent' and active['release'] == value['release']:
                health = self.host.health(value['release'])
        except Exception as error:
            return self.restore(row, value, error)
        if health and health.get('ok'):
            return self.confirm(row, 'activation_confirmed', {**value, 'health': health, 'reconciled': True})
        return self.restore(row, value, UpdateError('INTERRUPTED_ACTIVATION', 'Interrupted activation could not establish candidate readiness.'))

    def restore(self, row, value, error):
        row = self.save(row, 'running', 'rollback_intent', value)
        try:
            if self.host.active()['release'] != value['previousRelease'] or not self.host.health(value['previousRelease']).get('ok'):
                self.host.restore(value['previousRelease'], row['id'])
            health = self.host.health(value['previousRelease'])
            require(health.get('ok'), 'RESTORATION_FAILED', 'Previous application did not pass authenticated readiness; protected recovery tools remain available.')
        except Exception as restore_error:
            self.save(row, 'failed', 'restoration_failed', value,
                      {'code': 'RESTORATION_FAILED', 'message': str(restore_error)[:500]})
            return True
        return self.confirm(row, 'restoration_confirmed',
                            {**value, 'activeRelease': value['previousRelease'], 'restorationHealth': health},
                            {'code': getattr(error, 'code', 'ACTIVATION_FAILED'), 'message': str(error)[:500]})

    def confirm(self, row, phase, value, error=None):
        # Commit the health-backed decision before admitting any new work. A
        # restart after open must finish this decision, not inspect health again.
        row = self.save(row, 'running', phase, value, error)
        return self.finish_decision(row)

    def finish_decision(self, row):
        status, phase = CONFIRMED[row['phase']]
        value = json.loads(row['result'])
        error = json.loads(row['error']) if row['error'] else None
        try:
            # Host.open is idempotent for an already-active owned fence and
            # performs no service restart, drain, or authenticated health check.
            self.host.open(row['id'])
        except Exception as open_error:
            value['finalizationError'] = {'code': 'FENCE_OPEN_PENDING', 'message': str(open_error)[:500]}
            self.save(row, 'running', row['phase'], value, error)
            return False
        value.pop('finalizationError', None)
        self.save(row, status, phase, value, error)
        return True


def load_config():
    info = CONFIG.lstat()
    require(CONFIG.is_file() and not CONFIG.is_symlink() and info.st_uid == 0 and info.st_mode & 0o022 == 0,
            'FORBIDDEN', 'Expected protected updater configuration.')
    return json.loads(CONFIG.read_text())


def main():
    require(os.getuid() == 0, 'FORBIDDEN', 'Only the installed updater entrypoint may run this operation.')
    from praxis_updater_host import Host
    config = load_config()
    directory = pathlib.Path(config['dataDirectory'])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    host = Host(config)
    updater = Updater(directory, host)
    try:
        if sys.argv[1:] == ['--worker']:
            require(fcntl is not None, 'UNSUPPORTED_HOST', 'The updater requires Linux.')
            with open(directory / 'worker.lock', 'a') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                while True:
                    updater.tick()
                    time.sleep(1)
        else:
            require(not sys.argv[1:], 'INVALID_ARGUMENT', 'Updater helper accepts stdin only.')
            raw = sys.stdin.buffer.read(32769)
            require(len(raw) <= 32768, 'INVALID_ARGUMENT', 'Updater request is too large.')
            print(json.dumps({'ok': True, 'data': updater.call(json.loads(raw))}))
    finally:
        updater.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'code': getattr(error, 'code', 'UPDATER_ERROR'), 'message': str(error)[:500]}))
        sys.exit(1)

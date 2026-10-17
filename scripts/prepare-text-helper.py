"""Private filesystem operations for prepare-text; JSON protocol, never print paths."""
import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys

LIMIT = 20_000_000


class Rejected(Exception):
    pass


def reject(code):
    raise Rejected(code)


def strict_json(data, code):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                reject(code)
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique,
                          parse_constant=lambda _: reject(code))
    except (ValueError, UnicodeError):
        reject(code)


def directory(parts, base=None, create=False):
    fd = os.dup(base) if base is not None else os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts:
            if not part or part in ('.', '..') or '/' in part or '\x00' in part:
                reject('unsafe_path')
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError:
                reject('unsafe_path')
            os.close(fd)
            fd = child
            if create and stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
                reject('output_permissions')
        return fd
    except BaseException:
        os.close(fd)
        raise


def parts(absolute):
    if not isinstance(absolute, str) or not absolute.startswith('/') or '\x00' in absolute:
        reject('unsafe_path')
    return absolute.split('/')[1:]


def open_absolute(filename):
    components = parts(filename)
    parent = directory(components[:-1])
    try:
        return os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError:
        reject('unsafe_path')
    finally:
        os.close(parent)


def snapshot(s):
    return {key: str(value) for key, value in {
        'bytes': s.st_size, 'mtimeNs': s.st_mtime_ns, 'ctimeNs': s.st_ctime_ns,
        'device': s.st_dev, 'inode': s.st_ino,
    }.items()}


def read_limited(fd, limit=LIMIT):
    output = bytearray()
    while True:
        block = os.read(fd, min(65536, limit + 1 - len(output)))
        if not block:
            return bytes(output)
        output.extend(block)
        if len(output) > limit:
            reject('size_limit')


def source(request):
    root = request['root']
    filename = request['path']
    root_parts = parts(root)
    file_parts = parts(filename)
    if file_parts[:len(root_parts)] != root_parts or len(file_parts) <= len(root_parts):
        reject('source_outside_root')
    root_fd = directory(root_parts)
    parent = None
    fd = None
    try:
        parent = directory(file_parts[len(root_parts):-1], base=root_fd)
        try:
            fd = os.open(file_parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except OSError:
            reject('unsafe_path')
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            reject('source_not_file')
        if before.st_size <= 0:
            reject('empty_source')
        if before.st_size > LIMIT:
            reject('source_too_large')
        observed = snapshot(before)
        if str(before.st_size) != str(request['bytes']) or str(before.st_mtime_ns) != request['mtimeNs']:
            reject('source_changed')
        if request.get('expected') is not None and request['expected'] != observed:
            reject('source_changed')
        result = {'snapshot': observed}
        if request['operation'] == 'read':
            data = read_limited(fd)
            if observed != snapshot(os.fstat(fd)) or len(data) != before.st_size:
                reject('source_changed')
            result['data'] = base64.b64encode(data).decode('ascii')
        # Confirm the name still identifies this file within the held source directory.
        if observed != snapshot(os.stat(file_parts[-1], dir_fd=parent, follow_symlinks=False)):
            reject('source_changed')
        return result
    finally:
        for held in (fd, parent, root_fd):
            if held is not None:
                os.close(held)


def publish(request):
    if not re.fullmatch(r'file_[a-f0-9]{16}', request['fileId']) or not re.fullmatch(r'[a-f0-9]{64}', request['versionHash']):
        reject('unsafe_path')
    root = directory(parts(request['projectRoot']))
    target = None
    temp = None
    try:
        target = directory(['.local', 'prepared-text', request['fileId']], base=root, create=True)
        filename = request['versionHash'] + '.json'
        data = request['package'].encode('utf-8')
        if len(data) > LIMIT:
            reject('package_too_large')
        def existing():
            try:
                fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=target)
            except FileNotFoundError:
                return False
            except OSError:
                reject('existing_package_invalid')
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                    reject('existing_package_invalid')
                if info.st_size != len(data) or read_limited(fd) != data or snapshot(info) != snapshot(os.fstat(fd)):
                    reject('existing_package_invalid')
                return True
            finally:
                os.close(fd)
        if existing():
            return {'status': 'reused'}
        temp = '.pending-' + secrets.token_hex(16)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        try:
            # Hard-link publication is atomic and cannot replace an existing artifact.
            os.link(temp, filename, src_dir_fd=target, dst_dir_fd=target, follow_symlinks=False)
        except FileExistsError:
            if existing():
                return {'status': 'reused'}
            reject('existing_package_invalid')
        os.fsync(target)
        return {'status': 'prepared'}
    finally:
        if temp is not None and target is not None:
            os.unlink(temp, dir_fd=target)
        if target is not None:
            os.close(target)
        os.close(root)


def private_directory(state_dir, children=(), create=False, optional=False):
    """Follow no symlinks, including ancestors; enforce privacy from state_dir down."""
    fd = directory(parts(state_dir))
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
            reject('prepared_permissions')
        for child in children:
            if not child or child in ('.', '..') or '/' in child:
                reject('prepared_unsafe_path')
            if create:
                try:
                    os.mkdir(child, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                next_fd = os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if optional:
                    return None
                reject('prepared_package_unavailable')
            except OSError:
                reject('prepared_unsafe_path')
            os.close(fd)
            fd = next_fd
            if stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
                reject('prepared_permissions')
        result, fd = fd, None
        return result
    finally:
        if fd is not None:
            os.close(fd)


def private_bytes(parent, filename, limit=LIMIT, optional=False):
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        if optional:
            return None
        reject('prepared_package_unavailable')
    except OSError:
        reject('prepared_unsafe_path')
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            reject('prepared_unsafe_path')
        if stat.S_IMODE(before.st_mode) != 0o600:
            reject('prepared_permissions')
        if before.st_size > limit:
            reject('size_limit')
        data = read_limited(fd, limit)
        if snapshot(before) != snapshot(os.fstat(fd)) or len(data) != before.st_size:
            reject('prepared_changed')
        if snapshot(before) != snapshot(os.stat(filename, dir_fd=parent, follow_symlinks=False)):
            reject('prepared_changed')
        return data
    finally:
        os.close(fd)


def prepared_read(request):
    operation = request['operation']
    if operation == 'prepared-read':
        if not re.fullmatch(r'file_[a-f0-9]{16}', request['fileId']) or not re.fullmatch(r'[a-f0-9]{64}', request['versionHash']):
            reject('prepared_pin_invalid')
        children = ['prepared-text', request['fileId']]
        filename, limit, optional = request['versionHash'] + '.json', LIMIT, False
    else:
        children = ['prepared-text']
        filename, limit, optional = 'pins.json', 2_000_000, True
    parent = private_directory(request['stateDir'], children, optional=optional)
    if parent is None:
        return {'data': None, 'sha256': None}
    try:
        data = private_bytes(parent, filename, limit, optional)
        if operation == 'pins-read' and data is not None:
            strict_json(data, 'prepared_pin_invalid')
        return {'data': base64.b64encode(data).decode('ascii') if data is not None else None,
                'sha256': hashlib.sha256(data).hexdigest() if data is not None else None}
    finally:
        os.close(parent)


def pins_commit(request):
    """Nonblocking process lock plus whole-file CAS prevents lost updates."""
    parent = private_directory(request['stateDir'], ['prepared-text'])
    lock_fd, temp = None, None
    try:
        try:
            lock_fd = os.open('.pins.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        except OSError:
            reject('prepared_unsafe_path')
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            reject('prepared_permissions')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            reject('prepared_selection_conflict')
        current = private_bytes(parent, 'pins.json', 2_000_000, True)
        current_hash = hashlib.sha256(current).hexdigest() if current is not None else None
        if current_hash != request.get('expectedHash'):
            reject('prepared_selection_conflict')
        data = request['pins'].encode('utf-8')
        strict_json(data, 'prepared_pin_invalid')
        if len(data) > 2_000_000:
            reject('size_limit')
        temp = '.pins-pending-' + secrets.token_hex(16)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, 'pins.json', src_dir_fd=parent, dst_dir_fd=parent)
        temp = None
        os.fsync(parent)
        return {'status': 'selected'}
    finally:
        if temp is not None:
            os.unlink(temp, dir_fd=parent)
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(parent)


def main():
    # A 20MB serialized package is nested as a JSON string: escaping may double it.
    raw = sys.stdin.buffer.read(41_000_001)
    if len(raw) > 41_000_000:
        reject('size_limit')
    request = json.loads(raw)
    operation = request.get('operation')
    if operation in ('inspect', 'read', 'verify'):
        return source(request)
    if operation == 'manifest':
        fd = open_absolute(request['path'])
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                reject('manifest_invalid')
            return {'manifest': strict_json(read_limited(fd), 'manifest_invalid')}
        finally:
            os.close(fd)
    if operation == 'publish':
        return publish(request)
    if operation in ('prepared-read', 'pins-read'):
        return prepared_read(request)
    if operation == 'pins-commit':
        return pins_commit(request)
    reject('invalid_operation')


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=True, separators=(',', ':')))
    except Rejected as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
    except Exception:
        print('{"error":"local_io_failed"}')
        sys.exit(1)

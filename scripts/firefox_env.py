"""Environment for disposable Firefox runs, never the user's agent socket."""

from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import tempfile


@contextmanager
def firefox_environment(scratch):
    scratch = Path(scratch).resolve()
    anchors = [p for p in (scratch, *scratch.parents)
               if p.name == 'scratch' and p.parent.name == '.spider']
    if not anchors:
        raise ValueError('Firefox scratch must be under .spider/scratch')
    scratch.mkdir(parents=True, exist_ok=True)
    temp = scratch / 'tmp'
    temp.mkdir(exist_ok=True)
    with ExitStack() as stack:
        sock = scratch / 's'
        if len(str(sock).encode()) >= 104:
            # A short alias still resolves into this run, not a shared socket.
            anchor = min(anchors, key=lambda p: len(str(p).encode()))
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='a-', dir=anchor)))
            alias = directory / 'r'
            alias.symlink_to(scratch, target_is_directory=True)
            sock = alias / 's'
        if len(str(sock).encode()) >= 104:
            raise ValueError('Scratch root is too long for a Unix socket')
        yield {**os.environ, 'TMPDIR': str(temp), 'TMP': str(temp), 'TEMP': str(temp),
               'FOXY_AGENT_SOCK': str(sock)}

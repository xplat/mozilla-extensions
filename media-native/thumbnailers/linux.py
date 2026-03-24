"""Linux thumbnail support – delegates entirely to the XDG desktop backend."""

from . import xdg as _xdg


def get_backend():
    return _xdg.get_backend()

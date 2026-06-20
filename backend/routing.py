"""Declarative route dispatch table.

Generic plumbing: exact and prefix (path-parameter) matching. Routes receive
``(request, response, ctx)``.
"""

from collections import namedtuple

RouteMatch = namedtuple("RouteMatch", ["handler", "params"])


class Router:
    def __init__(self) -> None:
        self._exact: dict[tuple[str, str], object] = {}
        self._prefixes: list[tuple[str, str, str, object]] = []

    def add(self, method: str, path: str, handler) -> "Router":
        self._exact[(method.upper(), path)] = handler
        return self

    def add_prefix(self, method: str, prefix: str, handler, param_name: str = "id") -> "Router":
        # ``prefix`` must end with "/", e.g. "/api/presets/".
        if not prefix.endswith("/"):
            prefix += "/"
        self._prefixes.append((method.upper(), prefix, param_name, handler))
        return self

    def match(self, method: str, path: str) -> RouteMatch | None:
        method = method.upper()
        handler = self._exact.get((method, path))
        if handler is not None:
            return RouteMatch(handler, {})
        for route_method, prefix, param_name, route_handler in self._prefixes:
            if method == route_method and path.startswith(prefix):
                return RouteMatch(route_handler, {param_name: path[len(prefix) :]})
        return None

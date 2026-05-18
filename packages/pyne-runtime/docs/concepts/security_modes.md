# Security Modes

Pyne has three security modes:

- `safe`: blocks imports and uses a restricted builtins set.
- `research`: allows imports from an explicit allowlist.
- `unsafe`: allows full Python builtins and imports.

Safe mode is a restricted execution environment, not a strong multi-tenant sandbox.

Example:

```python
import pyne_runtime as pn

settings = pn.PyneSettings(security_mode="research", allowed_imports=("math",))
result = pn.run("import math\nplot([math.sqrt(x) for x in close])", data, settings=settings)
```


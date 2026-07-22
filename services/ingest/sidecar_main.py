"""Sprint 6 Pass 3 — the packaged ingest sidecar's single entrypoint.

Every worker in this service has always been invoked as `python -m
<module.path> [args...]` (14 distinct entrypoints — run_scan, the various
analyze.* modules, funding/crawl.*, etc.), not one script. A PyInstaller
build needs exactly one entrypoint, so this file IS that entrypoint: a
thin multi-call dispatcher (the same pattern tools like busybox use) that
takes the module path as argv[1] and runs it exactly as `python -m` would
— runpy.run_module(..., run_name="__main__") is literally what `-m` does
internally, so every module's own `if __name__ == "__main__": main()`
block runs completely unchanged. apps/api/src/pythonRunner.ts's packaged-
mode branch calls this exe with the same (module, *args) shape it already
uses for `python -m` in dev — no route file needed to know which mode it's
running in.

PyInstaller's static import analysis can't see the module named in
argv[1] at build time (it's a runtime string, not an import statement), so
every entrypoint module is imported directly and unconditionally below —
dead code at runtime (this function never actually calls them), but it's
what makes PyInstaller's analysis bundle them and their dependencies into
the frozen build. Keep this list in sync with pythonRunner.ts's callers if
a new entrypoint module is added."""
from __future__ import annotations
import runpy
import sys


def _register_entrypoints_for_pyinstaller() -> None:
    """Never called — exists only so PyInstaller's analysis phase sees
    these imports and bundles them. See module docstring."""
    import scriptorium_ingest.run_scan  # noqa: F401
    import scriptorium_ingest.analyze.trends  # noqa: F401
    import scriptorium_ingest.analyze.paper_analyst  # noqa: F401
    import scriptorium_ingest.analyze.corpus_ingest  # noqa: F401
    import scriptorium_ingest.analyze.ask_corpus  # noqa: F401
    import scriptorium_ingest.analyze.focus_extractor  # noqa: F401
    import scriptorium_ingest.analyze.draft_editor  # noqa: F401
    import scriptorium_ingest.analyze.export_proposal  # noqa: F401
    import scriptorium_ingest.analyze.embed  # noqa: F401
    import scriptorium_ingest.library.watch_folder  # noqa: F401
    import scriptorium_ingest.crawl.crawl_literature  # noqa: F401
    import scriptorium_ingest.crawl.politeness  # noqa: F401
    import scriptorium_ingest.funding.crawl_funding  # noqa: F401
    import scriptorium_ingest.llm.provider_config  # noqa: F401
    import scriptorium_ingest.knowledge.ingest  # noqa: F401


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: scriptorium-ingest <module.path> [args...]", file=sys.stderr)
        sys.exit(2)
    module_name = sys.argv[1]
    # Reshape argv so the target module's own argparse sees exactly what it
    # would under `python -m <module> <rest>` — argv[0] conventionally
    # holds the program name, not the dispatcher's own.
    sys.argv = [module_name, *sys.argv[2:]]
    runpy.run_module(module_name, run_name="__main__")


if __name__ == "__main__":
    main()

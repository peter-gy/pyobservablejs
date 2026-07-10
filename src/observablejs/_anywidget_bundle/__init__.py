"""Manifest-based bundle support for Vite-built anywidget frontends."""

from ._bundle import Bundle, BundleArtifactError, BundledWidget, BundleModuleError

__all__ = [
    "Bundle",
    "BundleArtifactError",
    "BundledWidget",
    "BundleModuleError",
]

# Offline extension packages

`build-and-start.bat` downloads the pinned Open VSX packages here and builds the
local Smart Workspace package here. They are installed into this checkout's WSL
preview profile. Keep this directory when copying the checkout for offline reuse
on the same Linux CPU architecture. VSIX files are excluded from Git; fresh Git
downloads fetch them automatically on first build/start.

Versions and platform choices are maintained in `ci/dev/preview-extensions.json`.
The current native Java and Python debugger packages target WSL Linux x64.

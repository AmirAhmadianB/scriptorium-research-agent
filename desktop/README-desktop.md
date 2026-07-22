# Desktop launchers

**Windows** — `powershell -ExecutionPolicy Bypass -File desktop\windows\Install-DesktopShortcut.ps1`
puts a Scriptorium icon on the Desktop; double-click boots Docker services +
`pnpm dev` and opens http://localhost:5173.

**Linux** — edit the two paths in `desktop/linux/scriptorium.desktop`, copy it
to `~/.local/share/applications/`.

**macOS** — quickest: make `launch.command` with the Linux Exec line (swap
`xdg-open` for `open`), `chmod +x`, then set the icon via Get Info by pasting
`icon-512.png`. 

If you later want a real windowed app instead of a browser tab, wrap the
dashboard in Tauri — the icon assets here drop straight in.

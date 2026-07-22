; Sprint 6 Pass 5 — "the uninstaller removes the app and asks whether to
; keep or delete the data directory." $APPDATA is NSIS's built-in constant
; for the current user's Roaming AppData folder — the exact same value
; process.env.APPDATA resolves to on the Node side (apps/api/src/dataDir.ts's
; platformAppDataRoot()), so this targets the identical directory the app
; itself writes to. Runs pre-uninstall (before any files are removed) so a
; "no" answer leaves everything, including the app's own files, untouched.
!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Delete your Scriptorium data too?$\n$\nThis removes your corpus database, research focus, drafts, and configuration from:$\n$APPDATA\Scriptorium$\n$\nChoose No to keep this data (e.g. if you plan to reinstall later)." \
    IDYES delete_data IDNO keep_data
  delete_data:
    RMDir /r "$APPDATA\Scriptorium"
    Goto uninstall_data_done
  keep_data:
  uninstall_data_done:
!macroend

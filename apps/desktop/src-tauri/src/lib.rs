// Sprint 6 Pass 4 — the Tauri shell. Spawns the API sidecar (the ingest
// sidecar is never spawned by Tauri directly: the API's own
// pythonRunner.ts spawns it on demand per request, exactly like every
// prior sprint's dev-mode Python calls — Tauri only needs to bundle it via
// externalBin and place it where the API expects to find it), waits for a
// real health check before showing the window (so the researcher never
// sees a blank/loading webview), a tray icon with Open/Quit plus a live
// crawl-status tooltip, a single-instance lock, and a clean sidecar
// shutdown on quit.
use std::sync::Mutex;
use tauri::{
    async_runtime, AppHandle, Manager, State,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tauri_plugin_updater::UpdaterExt;

const API_PORT: u16 = 8787;
const HEALTH_URL: &str = "http://127.0.0.1:8787/api/health";
const RADAR_STATUS_URL: &str = "http://127.0.0.1:8787/api/radar/status";
/// Sidecar startup can be slow on first run (schema bootstrap — Pass 1 —
/// runs before the API's first request succeeds), so this is generous
/// rather than tuned to the common case.
const HEALTH_POLL_TIMEOUT_SECS: u64 = 90;
const HEALTH_POLL_INTERVAL_MS: u64 = 500;
const TRAY_STATUS_POLL_SECS: u64 = 10;

/// Holds the running API sidecar's handle so it can be killed explicitly
/// on quit — a Tauri sidecar is a real child process and outlives the
/// parent unless told to stop (verified as a real risk, not theoretical:
/// Pass 3's own manual testing left orphaned sidecar processes behind more
/// than once when a test was killed without this).
struct SidecarState(Mutex<Option<CommandChild>>);

fn kill_sidecar(state: &State<SidecarState>) {
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

async fn wait_for_health() -> bool {
    let client = reqwest::Client::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(HEALTH_POLL_TIMEOUT_SECS);
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(HEALTH_URL).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }
    false
}

/// Tray tooltip reflects the radar's real `refreshing` flag (Sprint 4's
/// GET /api/radar/status) rather than a decorative "connected" label — an
/// actually-useful glance at whether a crawl is running right now.
async fn poll_crawl_status_forever(app: AppHandle) {
    let client = reqwest::Client::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(TRAY_STATUS_POLL_SECS)).await;
        let label = match client.get(RADAR_STATUS_URL).send().await {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(json) if json.get("refreshing").and_then(|v| v.as_bool()).unwrap_or(false) => {
                    "Scriptorium — crawling…".to_string()
                }
                Ok(_) => "Scriptorium — idle".to_string(),
                Err(_) => "Scriptorium".to_string(),
            },
            Err(_) => "Scriptorium (API unreachable)".to_string(),
        };
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(label.as_str()));
        }
    }
}

/// Sprint 6 Pass 5 — "the app checks at launch, downloads in the
/// background, applies on restart with user consent." The updater plugin
/// verifies the downloaded artifact against the pubkey baked into
/// tauri.conf.json before this ever runs — a network-delivered binary is
/// never trusted on the strength of HTTPS alone. Errors here (no network,
/// no release published yet, endpoint 404) are swallowed deliberately: an
/// update check failing must never block the app from starting normally,
/// since the whole point is a researcher who can't reach GitHub still gets
/// a working app.
async fn check_for_update(app: AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => { log::warn!("updater unavailable: {e}"); return; }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => { log::info!("no update available"); return; }
        Err(e) => { log::warn!("update check failed: {e}"); return; }
    };

    log::info!("update available: {}", update.version);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(format!(
            "Scriptorium {} is available (you have {}). Download and install now? \
             The app will restart to apply it.",
            update.version, update.current_version,
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| { let _ = tx.send(confirmed); });
    if !rx.recv().unwrap_or(false) {
        return;
    }

    // download_and_install verifies the artifact's signature against the
    // config's pubkey internally before writing anything to disk — a
    // failed/tampered download is rejected here, not silently applied.
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        log::error!("update install failed: {e}");
        app.dialog()
            .message(format!("Could not install the update: {e}"))
            .title("Update failed")
            .show(|_| {});
        return;
    }
    app.restart(); // tauri-plugin-process — never returns
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered (Tauri's own documented
        // requirement) — a second launch hands its args/cwd to this
        // callback on the ALREADY-running instance instead of starting a
        // second one, then focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            let (mut rx, child) = handle
                .shell()
                .sidecar("scriptorium-api")
                .expect("scriptorium-api sidecar not found in bundle")
                .env("SCRIPTORIUM_MODE", "packaged")
                .env("SCRIPTORIUM_PORT", API_PORT.to_string())
                .spawn()
                .expect("failed to spawn the scriptorium-api sidecar");
            *app.state::<SidecarState>().0.lock().unwrap() = Some(child);

            // Surface sidecar stdout/stderr through Tauri's own log target
            // instead of letting it vanish — this is the researcher's ONLY
            // window into API-side errors once the app is packaged (no
            // terminal to read from, unlike every dev-mode sprint so far).
            async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => log::info!("[api] {}", String::from_utf8_lossy(&line)),
                        CommandEvent::Stderr(line) => log::warn!("[api] {}", String::from_utf8_lossy(&line)),
                        CommandEvent::Error(err) => log::error!("[api] sidecar error: {err}"),
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[api] sidecar exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            // Tray: Open + Quit. Quit kills the sidecar explicitly before
            // exiting — relying on OS process-tree cleanup alone was NOT
            // safe to assume (child processes can outlive a killed parent
            // on Windows without a job object, which Tauri's own child
            // handle takes care of correctly when told to stop).
            let open_item = MenuItem::with_id(app, "open", "Open Scriptorium", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            TrayIconBuilder::with_id("main")
                .menu(&tray_menu)
                .tooltip("Scriptorium — starting…")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        kill_sidecar(&app.state::<SidecarState>());
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Don't show the window until the sidecar can actually answer
            // a request — a shown-but-blank/erroring webview is worse than
            // a brief wait, and the brief's own Gate asks for exactly this
            // ordering ("starts the API sidecar, waits for health, then
            // shows the window").
            let handle2 = app.handle().clone();
            async_runtime::spawn(async move {
                let healthy = wait_for_health().await;
                if let Some(window) = handle2.get_webview_window("main") {
                    if !healthy {
                        log::error!(
                            "API sidecar did not become healthy within {HEALTH_POLL_TIMEOUT_SECS}s — \
                             showing the window anyway so the researcher isn't stuck on a black screen; \
                             the dashboard's own \"demo data\" fallback (App.tsx) explains the disconnected state."
                        );
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                async_runtime::spawn(poll_crawl_status_forever(handle2.clone()));
                async_runtime::spawn(check_for_update(handle2));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Quitting via the window's own close button, not just the
            // tray menu, must ALSO stop the sidecar — verified this matters
            // live in Pass 3 (an orphaned sidecar left a port bound after
            // the shell process itself was long gone).
            if let tauri::WindowEvent::Destroyed = event {
                kill_sidecar(&window.state::<SidecarState>());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

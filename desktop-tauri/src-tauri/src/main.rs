#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rand::{distributions::Alphanumeric, Rng};
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct InspectorState {
    url: Mutex<String>,
    child: Mutex<Option<Child>>,
}

impl Default for InspectorState {
    fn default() -> Self {
        Self {
            url: Mutex::new(String::new()),
            child: Mutex::new(None),
        }
    }
}

fn log_dir(app: &tauri::App) -> PathBuf {
    let base_dir = app
        .path_resolver()
        .app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("polymcp-inspector"));
    let log_dir = base_dir.join("logs");
    if create_dir_all(&log_dir).is_err() {
        return std::env::temp_dir();
    }
    log_dir
}

fn backend_state_dir(app: &tauri::App) -> PathBuf {
    let base_dir = app
        .path_resolver()
        .app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("polymcp-inspector"));
    let state_dir = base_dir.join("state");
    if create_dir_all(&state_dir).is_err() {
        return std::env::temp_dir().join("polymcp-inspector-state");
    }
    state_dir
}

fn log_line(app: &tauri::App, msg: &str) {
    let log_path = log_dir(app).join("polymcp-inspector.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "{}", msg);
        return;
    }
    // Fallback to Windows temp
    let fallback = std::path::PathBuf::from(r"C:\Windows\Temp\polymcp-inspector.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(fallback) {
        let _ = writeln!(f, "{}", msg);
    }
}

fn backend_stdio(app: &tauri::App) -> (Stdio, Stdio) {
    let logs = log_dir(app);
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("polymcp-inspector-backend-stdout.log"))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("polymcp-inspector-backend-stderr.log"))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    (stdout, stderr)
}

fn configure_child_process(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[tauri::command]
fn get_inspector_url(state: State<InspectorState>) -> Result<String, String> {
    let url = state.url.lock().map_err(|_| "State lock error")?.clone();
    if url.is_empty() {
        return Err("Inspector URL not ready".to_string());
    }
    Ok(url)
}

fn random_api_key() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn find_sidecar_backend(app: &tauri::App) -> Option<PathBuf> {
    if let Some(resource_dir) = app.path_resolver().resource_dir() {
        let candidates = vec![
            resource_dir.join("polymcp-inspector-backend.exe"),
            resource_dir.join("bin").join("polymcp-inspector-backend.exe"),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }
    None
}

fn strip_extended_windows_path_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

fn find_sidecar_static_dir(app: &tauri::App, sidecar_path: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = sidecar_path.parent() {
        candidates.push(parent.join("static"));
    }
    if let Some(resource_dir) = app.path_resolver().resource_dir() {
        candidates.push(resource_dir.join("static"));
        candidates.push(resource_dir.join("bin").join("static"));
    }
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn find_local_project_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        candidates.push(cwd.join(".."));
        candidates.push(cwd.join("../.."));
        candidates.push(cwd.join("../../.."));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
            candidates.push(parent.join(".."));
            candidates.push(parent.join("../.."));
            candidates.push(parent.join("../../.."));
            candidates.push(parent.join("../../../.."));
        }
    }
    for root in candidates {
        let normalized = root.canonicalize().unwrap_or(root.clone());
        let script = normalized.join("scripts").join("inspector_entry.py");
        let module = normalized.join("polymcp_inspector").join("server.py");
        if script.exists() && module.exists() {
            return Some(normalized);
        }
    }
    None
}

fn find_local_ts_backend_dist() -> Option<(PathBuf, PathBuf)> {
    let root = find_local_project_root()?;
    let dist_script = root.join("ts-backend").join("dist").join("server.js");
    if dist_script.exists() {
        return Some((root, dist_script));
    }
    None
}

fn pick_open_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
        .unwrap_or(6274)
}

fn spawn_backend(app: &tauri::App, api_key: &str, port: u16) -> Result<Child, String> {
    let mut args = vec![
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--secure".to_string(),
        "--api-key".to_string(),
        api_key.to_string(),
        "--no-browser".to_string(),
    ];

    if let Some(sidecar) = find_sidecar_backend(app) {
        let spawn_path = strip_extended_windows_path_prefix(&sidecar);
        log_line(app, &format!("Using sidecar backend: {}", spawn_path.display()));
        let (stdout, stderr) = backend_stdio(app);
        let state_dir = backend_state_dir(app).to_string_lossy().to_string();
        let mut cmd = Command::new(&spawn_path);
        configure_child_process(&mut cmd);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir)
            .env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
        if let Some(static_dir) = find_sidecar_static_dir(app, &spawn_path) {
            log_line(
                app,
                &format!("Detected sidecar static dir: {}", static_dir.display()),
            );
            cmd.env(
                "POLYMCP_INSPECTOR_STATIC_DIR",
                static_dir.to_string_lossy().to_string(),
            );
        } else {
            log_line(app, "No sidecar static dir detected; backend will use internal defaults");
        }
        return cmd
            .spawn()
            .map_err(|e| format!("Failed to start sidecar backend: {e}"));
    }

    if let Ok(explicit) = std::env::var("POLYMCP_INSPECTOR_BACKEND") {
        log_line(app, &format!("Using explicit backend: {explicit}"));
        let (stdout, stderr) = backend_stdio(app);
        let state_dir = backend_state_dir(app).to_string_lossy().to_string();
        let mut cmd = Command::new(explicit);
        configure_child_process(&mut cmd);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir)
            .env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
        return cmd
            .spawn()
            .map_err(|e| format!("Failed to start explicit backend: {e}"));
    }

    args.insert(0, "-m".to_string());
    args.insert(1, "polymcp_inspector".to_string());

    log_line(app, "Using Python module backend: python -m polymcp_inspector");
    let (stdout, stderr) = backend_stdio(app);
    let state_dir = backend_state_dir(app).to_string_lossy().to_string();
    let mut cmd = Command::new("python");
    configure_child_process(&mut cmd);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir)
        .env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
    cmd.spawn().map_err(|e| {
        format!("Failed to start Python backend (install polymcp-inspector or set POLYMCP_INSPECTOR_BACKEND): {e}")
    })
}

fn spawn_ts_backend_only(app: &tauri::App, api_key: &str, port: u16) -> Result<Child, String> {
    let Some((project_root, dist_script)) = find_local_ts_backend_dist() else {
        return Err("TS backend dist not found. Build it first with: cd ts-backend && npm install && npm run build".to_string());
    };

    let args = vec![
        dist_script.to_string_lossy().to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--secure".to_string(),
        "--api-key".to_string(),
        api_key.to_string(),
    ];

    let static_dir = project_root.join("polymcp_inspector").join("static");
    log_line(
        app,
        &format!(
            "TS backend attempt: node {} --host 127.0.0.1 --port {} --secure --api-key ***",
            dist_script.display(),
            port
        ),
    );
    let (stdout, stderr) = backend_stdio(app);
    let state_dir = backend_state_dir(app).to_string_lossy().to_string();
    let mut cmd = Command::new("node");
    configure_child_process(&mut cmd);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir);
    cmd.env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
    if static_dir.exists() {
        cmd.env("POLYMCP_INSPECTOR_STATIC_DIR", static_dir.to_string_lossy().to_string());
    }
    cmd.spawn()
        .map_err(|e| format!("TS backend failed to start: {e}"))
}

fn spawn_python_backend_only(app: &tauri::App, api_key: &str, port: u16) -> Result<Child, String> {
    let common_args = vec![
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--secure".to_string(),
        "--api-key".to_string(),
        api_key.to_string(),
        "--no-browser".to_string(),
    ];

    // Dev/source fallback: run entry script directly without requiring pip install.
    if let Some(project_root) = find_local_project_root() {
        let script_path = project_root.join("scripts").join("inspector_entry.py");
        let mut args = vec![script_path.to_string_lossy().to_string()];
        args.extend(common_args.clone());
        log_line(
            app,
            &format!(
                "Fallback backend attempt: python {} (PYTHONPATH={})",
                script_path.display(),
                project_root.display()
            ),
        );
        let (stdout, stderr) = backend_stdio(app);
        let state_dir = backend_state_dir(app).to_string_lossy().to_string();
        let mut cmd = Command::new("python");
        configure_child_process(&mut cmd);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .env("PYTHONPATH", project_root.to_string_lossy().to_string())
            .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir)
            .env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
        let static_dir = project_root.join("polymcp_inspector").join("static");
        if static_dir.exists() {
            cmd.env(
                "POLYMCP_INSPECTOR_STATIC_DIR",
                static_dir.to_string_lossy().to_string(),
            );
        }
        return cmd
            .spawn()
            .map_err(|e| format!("Fallback Python script backend failed to start: {e}"));
    }

    let mut args = vec!["-m".to_string(), "polymcp_inspector".to_string()];
    args.extend(common_args);
    log_line(app, "Fallback backend attempt: python -m polymcp_inspector");
    let (stdout, stderr) = backend_stdio(app);
    let state_dir = backend_state_dir(app).to_string_lossy().to_string();
    let mut cmd = Command::new("python");
    configure_child_process(&mut cmd);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .env("POLYMCP_INSPECTOR_STATE_DIR", state_dir)
        .env_remove("POLYMCP_INSPECTOR_STATIC_DIR");
    cmd.spawn()
        .map_err(|e| format!("Fallback Python module backend failed to start: {e}"))
}

fn parse_http_status(response_head: &str) -> Option<u16> {
    let mut parts = response_head.lines().next()?.split_whitespace();
    let _http = parts.next()?;
    let code = parts.next()?.parse::<u16>().ok()?;
    Some(code)
}

fn probe_backend_status(port: u16, api_key: &str) -> Option<u16> {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect(addr).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Inspector-API-Key: {api_key}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut buffer = [0u8; 1024];
    let n = stream.read(&mut buffer).ok()?;
    if n == 0 {
        return None;
    }
    let head = String::from_utf8_lossy(&buffer[..n]);
    parse_http_status(&head)
}

fn wait_for_backend(
    port: u16,
    api_key: &str,
    timeout: Duration,
    mut child: Option<&mut Child>,
) -> Result<(), String> {
    let started = Instant::now();
    let mut last_probe = String::from("no successful TCP response");
    while started.elapsed() < timeout {
        if let Some(child_process) = child.as_deref_mut() {
            if let Ok(Some(status)) = child_process.try_wait() {
                return Err(format!("Backend exited early with status: {status}"));
            }
        }

        if let Some(status) = probe_backend_status(port, api_key) {
            last_probe = format!("HTTP {status}");
            if status < 500 || status == 401 {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "Backend did not become healthy within {}s (last probe: {last_probe})",
        timeout.as_secs(),
    ))
}

fn main() {
    tauri::Builder::default()
        .manage(InspectorState::default())
        .setup(|app| {
            log_line(app, "Starting PolyMCP Inspector desktop...");
            let port: u16 = pick_open_port();
            let api_key = random_api_key();
            log_line(app, &format!("Selected backend port: {port}"));
            let mut child: Option<Child> = None;
            let mut healthy = false;
            let backend_mode = std::env::var("POLYMCP_INSPECTOR_BACKEND_MODE")
                .unwrap_or_else(|_| "auto".to_string())
                .to_lowercase();
            log_line(app, &format!("Backend mode: {backend_mode}"));
            let force_python = std::env::var("POLYMCP_INSPECTOR_FORCE_PYTHON")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let has_sidecar = find_sidecar_backend(app).is_some();
            let has_local_project = find_local_project_root().is_some();
            log_line(
                app,
                &format!("Runtime detection: has_sidecar={has_sidecar} has_local_project={has_local_project}"),
            );
            let prefer_python = force_python
                || backend_mode == "python"
                || (backend_mode == "auto" && has_local_project && !has_sidecar);
            let prefer_ts = backend_mode == "ts";

            if prefer_ts {
                log_line(app, "Trying TS backend first");
                match spawn_ts_backend_only(app, &api_key, port) {
                    Ok(mut ts_child) => match wait_for_backend(
                        port,
                        &api_key,
                        Duration::from_secs(30),
                        Some(&mut ts_child),
                    ) {
                        Ok(()) => {
                            log_line(app, "TS backend is healthy");
                            child = Some(ts_child);
                            healthy = true;
                        }
                        Err(err) => {
                            log_line(app, &format!("TS backend startup failed: {err}"));
                            let _ = ts_child.kill();
                        }
                    },
                    Err(e) => {
                        log_line(app, &format!("{e}"));
                    }
                }
            }

            // In source/dev runs the Python script backend is faster and more reliable than sidecar.
            if !healthy && prefer_python {
                log_line(app, "Trying Python backend first (dev/source mode)");
                match spawn_python_backend_only(app, &api_key, port) {
                    Ok(mut py_child) => match wait_for_backend(
                        port,
                        &api_key,
                        Duration::from_secs(25),
                        Some(&mut py_child),
                    ) {
                        Ok(()) => {
                            log_line(app, "Python backend is healthy");
                            child = Some(py_child);
                            healthy = true;
                        }
                        Err(err) => {
                            log_line(app, &format!("Python backend startup failed: {err}"));
                            let _ = py_child.kill();
                        }
                    },
                    Err(e) => {
                        log_line(app, &format!("{e}"));
                    }
                }
            }

            if !healthy {
                log_line(app, "Trying sidecar backend");
                match spawn_backend(app, &api_key, port) {
                    Ok(mut sidecar_child) => {
                        log_line(app, "Spawned backend sidecar");
                        match wait_for_backend(
                            port,
                            &api_key,
                            Duration::from_secs(if prefer_python { 15 } else { 30 }),
                            Some(&mut sidecar_child),
                        ) {
                            Ok(()) => {
                                log_line(app, "Sidecar backend is healthy");
                                child = Some(sidecar_child);
                                healthy = true;
                            }
                            Err(err) => {
                                log_line(app, &format!("Sidecar backend startup failed: {err}"));
                                let _ = sidecar_child.kill();
                            }
                        }
                    }
                    Err(e) => {
                        log_line(app, &format!("Failed to spawn backend: {e}"));
                    }
                }
            }

            // In packaged mode, sidecar is still primary. If it fails, try module fallback.
            if !healthy && !prefer_python && !prefer_ts {
                log_line(app, "Sidecar failed, trying Python fallback...");
                match spawn_python_backend_only(app, &api_key, port) {
                    Ok(mut py_child) => match wait_for_backend(
                        port,
                        &api_key,
                        Duration::from_secs(25),
                        Some(&mut py_child),
                    ) {
                        Ok(()) => {
                            log_line(app, "Fallback Python backend is healthy");
                            child = Some(py_child);
                            healthy = true;
                        }
                        Err(err) => {
                            log_line(app, &format!("Fallback Python backend startup failed: {err}"));
                            let _ = py_child.kill();
                        }
                    },
                    Err(e) => {
                        log_line(app, &format!("{e}"));
                    }
                }
            }

            if !healthy {
                log_line(app, "No backend became healthy");
                if let Some(mut c) = child.take() {
                    let _ = c.kill();
                }
                // Do not abort app; UI will show error state
                return Ok(());
            }

            let url = format!("http://127.0.0.1:{port}/?api_key={api_key}");
            let state = app.state::<InspectorState>();
            *state.url.lock().map_err(|_| "State lock error")? = url;
            *state.child.lock().map_err(|_| "State lock error")? = child;
            Ok(())
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event.event() {
                let state = event.window().state::<InspectorState>();
                {
                    let mut guard = match state.child.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_inspector_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

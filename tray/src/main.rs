// TokenHUD tray shell. Lives in the system tray, owns two windows that show the local web UI:
//  - "mini": frameless always-on-top popover, shown while hovering the tray icon (route #/mini)
//  - "main": the full dashboard, opened by clicking the tray icon
// The Node data server (server/server.mjs) is started here when it is not already running.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Theme, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::{StateFlags, WindowExt};

const PORT: u16 = 4317;
const MINI_W: f64 = 360.0;
const MINI_H: f64 = 344.0;
const HOVER_IN: Duration = Duration::from_millis(150);
const HOVER_OUT: Duration = Duration::from_millis(400);
const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

#[derive(Default)]
struct Shared {
    pinned: AtomicBool,
    /// Last known tray icon rectangle (physical px): x, y, w, h.
    icon: Mutex<Option<(f64, f64, f64, f64)>>,
    /// Hover popover is held off until the cursor has left the icon (after a click or the menu).
    suppress: AtomicBool,
}

struct Menus {
    pin: CheckMenuItem<tauri::Wry>,
}

// ---------- tiny HTTP client for the local server (no extra crates) ----------
fn http(method: &str, path: &str, body: &str) -> Option<String> {
    let addr = format!("127.0.0.1:{PORT}").parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(4))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nx-tokenhud: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    let (a, b) = (out.find('{')?, out.rfind('}')?);
    Some(out[a..=b].to_string())
}

fn health() -> Option<serde_json::Value> {
    serde_json::from_str(&http("GET", "/api/health", "")?).ok()
}

fn project_root() -> Option<PathBuf> {
    if let Ok(r) = std::env::var("TOKENHUD_ROOT") {
        return Some(PathBuf::from(r));
    }
    let mut dir = std::env::current_exe().ok()?;
    while dir.pop() {
        if dir.join("server").join("server.mjs").exists() {
            return Some(dir);
        }
    }
    None
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("TokenHUD")
}

fn ensure_server() -> bool {
    if health().is_some() {
        return true;
    }
    let Some(root) = project_root() else { return false };
    let _ = std::fs::create_dir_all(data_dir());
    let log = std::fs::File::create(data_dir().join("server.log")).ok();
    let mut cmd = Command::new("node");
    cmd.arg("server/server.mjs").current_dir(&root).creation_flags(NO_WINDOW).stdin(Stdio::null());
    if let Some(f) = log {
        if let Ok(f2) = f.try_clone() {
            cmd.stderr(Stdio::from(f2));
        }
        cmd.stdout(Stdio::from(f));
    }
    cmd.spawn().is_ok()
}

// ---------- tray icon drawing (X glyph + status dot) ----------
fn seg(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let t = (((px - a.0) * dx + (py - a.1) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    (t, ((px - a.0 - t * dx).powi(2) + (py - a.1 - t * dy).powi(2)).sqrt())
}
fn mixc(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn sample(x: f32, y: f32, dot: [f32; 3]) -> [f32; 4] {
    let d = ((x - 0.74).powi(2) + (y - 0.74).powi(2)).sqrt();
    if d <= 0.2 {
        return [dot[0], dot[1], dot[2], 1.0];
    }
    if d <= 0.29 {
        return [1.0, 18.0, 28.0, 1.0];
    }
    let (t2, d2) = seg(x, y, (0.84, 0.16), (0.16, 0.84));
    if d2 <= 0.1 {
        let c = mixc([144.0, 88.0, 248.0], [194.0, 107.0, 255.0], t2);
        return [c[0], c[1], c[2], 1.0];
    }
    let (t1, d1) = seg(x, y, (0.16, 0.16), (0.84, 0.84));
    if d1 <= 0.1 {
        let c = mixc([38.0, 237.0, 243.0], [0.0, 160.0, 248.0], t1);
        return [c[0], c[1], c[2], 1.0];
    }
    [0.0; 4]
}
fn tray_image(dot: [f32; 3]) -> Image<'static> {
    const N: usize = 64;
    const SS: usize = 4;
    let mut px = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let c = sample(
                        (x as f32 + (sx as f32 + 0.5) / SS as f32) / N as f32,
                        (y as f32 + (sy as f32 + 0.5) / SS as f32) / N as f32,
                        dot,
                    );
                    r += c[0] * c[3];
                    g += c[1] * c[3];
                    b += c[2] * c[3];
                    a += c[3];
                }
            }
            let o = (y * N + x) * 4;
            if a > 0.0 {
                px[o] = (r / a).round() as u8;
                px[o + 1] = (g / a).round() as u8;
                px[o + 2] = (b / a).round() as u8;
            }
            px[o + 3] = (a / (SS * SS) as f32 * 255.0).round() as u8;
        }
    }
    Image::new_owned(px, N as u32, N as u32)
}
fn level_color(level: &str) -> [f32; 3] {
    match level {
        "live" => [0.0, 216.0, 144.0],
        "warn" => [240.0, 160.0, 56.0],
        "over" => [232.0, 64.0, 104.0],
        _ => [120.0, 140.0, 165.0],
    }
}

// ---------- windows ----------
fn show_main(app: &AppHandle) {
    if let Some(m) = app.get_webview_window("mini") {
        if !app.state::<Arc<Shared>>().pinned.load(Ordering::Relaxed) {
            let _ = m.hide();
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
    }
    show_main(app);
}

fn set_pinned(app: &AppHandle, on: bool) {
    let sh = app.state::<Arc<Shared>>();
    sh.pinned.store(on, Ordering::Relaxed);
    let _ = app.state::<Menus>().pin.set_checked(on);
    if let Some(m) = app.get_webview_window("mini") {
        if on {
            if !m.is_visible().unwrap_or(false) {
                place_mini(app);
            }
            let _ = m.show();
        } else if !cursor_near(app, &sh) {
            let _ = m.hide();
        }
    }
}

/// Position the popover above (or below) the tray icon, on the monitor that holds the icon.
fn place_mini(app: &AppHandle) {
    let Some(m) = app.get_webview_window("mini") else { return };
    let sh = app.state::<Arc<Shared>>();
    let icon = sh.icon.lock().unwrap().unwrap_or((0.0, 0.0, 0.0, 0.0));
    let (ix, iy, iw, ih) = icon;
    let _ = m.set_size(LogicalSize::new(MINI_W, MINI_H));
    let size = m.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((MINI_W, MINI_H));
    let pad = 10.0 * m.scale_factor().unwrap_or(1.0);
    let (cx, cy) = (ix + iw / 2.0, iy + ih / 2.0);
    let mut area = (0.0, 0.0, 1920.0, 1080.0);
    if let Ok(mons) = app.available_monitors() {
        for mon in mons {
            let (p, s) = (mon.position(), mon.size());
            let (x, y, w, h) = (p.x as f64, p.y as f64, s.width as f64, s.height as f64);
            if cx >= x && cx < x + w && cy >= y && cy < y + h {
                area = (x, y, w, h);
            }
        }
    }
    let mut x = cx - size.0 / 2.0;
    x = x.clamp(area.0 + pad, (area.0 + area.2 - size.0 - pad).max(area.0 + pad));
    let mut y = iy - size.1 - pad;
    if y < area.1 + pad {
        y = iy + ih + pad; // taskbar at the top
    }
    let _ = m.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn cursor_near(app: &AppHandle, sh: &Shared) -> bool {
    let Ok(c) = app.cursor_position() else { return false };
    let inside = |x: f64, y: f64, w: f64, h: f64, pad: f64| c.x >= x - pad && c.x <= x + w + pad && c.y >= y - pad && c.y <= y + h + pad;
    if let Some((x, y, w, h)) = *sh.icon.lock().unwrap() {
        if inside(x, y, w, h, 2.0) {
            return true;
        }
    }
    if let Some(m) = app.get_webview_window("mini") {
        if m.is_visible().unwrap_or(false) {
            if let (Ok(p), Ok(s)) = (m.outer_position(), m.outer_size()) {
                // include the gap between icon and popover so the cursor can travel to it
                if inside(p.x as f64, p.y as f64, s.width as f64, s.height as f64 + 16.0, 6.0) {
                    return true;
                }
            }
        }
    }
    false
}

fn over_icon(app: &AppHandle, sh: &Shared) -> bool {
    let (Ok(c), Some((x, y, w, h))) = (app.cursor_position(), *sh.icon.lock().unwrap()) else { return false };
    c.x >= x - 2.0 && c.x <= x + w + 2.0 && c.y >= y - 2.0 && c.y <= y + h + 2.0
}

/// Shows the popover after the cursor rests on the icon for ~150 ms, hides it ~400 ms after it leaves.
fn hover_loop(app: AppHandle) {
    let sh = app.state::<Arc<Shared>>().inner().clone();
    let mut enter: Option<Instant> = None;
    let mut leave: Option<Instant> = None;
    loop {
        std::thread::sleep(Duration::from_millis(40));
        let Some(mini) = app.get_webview_window("mini") else { continue };
        let on_icon = over_icon(&app, &sh);
        if !on_icon {
            sh.suppress.store(false, Ordering::Relaxed);
            enter = None;
        } else if enter.is_none() {
            enter = Some(Instant::now());
        }
        let visible = mini.is_visible().unwrap_or(false);
        if !visible {
            leave = None;
            let main_up = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
            if on_icon && !sh.suppress.load(Ordering::Relaxed) && !main_up && enter.map(|t| t.elapsed() >= HOVER_IN).unwrap_or(false) {
                place_mini(&app);
                let _ = mini.show();
                if let Some(t) = app.tray_by_id("main") { let _ = t.set_tooltip(Some("")); } // no tooltip over the popover
            }
        } else if !sh.pinned.load(Ordering::Relaxed) {
            if cursor_near(&app, &sh) {
                leave = None;
            } else {
                let t = *leave.get_or_insert_with(Instant::now);
                if t.elapsed() >= HOVER_OUT {
                    let _ = mini.hide();
                    leave = None;
                }
            }
        }
    }
}

// ---------- live tooltip + status dot ----------
fn compact(n: f64) -> String {
    if n >= 1e6 { format!("{:.1}M", n / 1e6) } else if n >= 1e3 { format!("{:.1}K", n / 1e3) } else { format!("{:.0}", n) }
}

fn status_loop(app: AppHandle) {
    let mut last_level = String::new();
    let mut fails = 0;
    loop {
        match http("GET", "/api/tray", "").and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok()) {
            Some(v) => {
                fails = 0;
                let level = v["level"].as_str().unwrap_or("idle").to_string();
                let word = match level.as_str() {
                    "live" => "live",
                    "warn" => "near limit",
                    "over" => "over limit",
                    _ => "idle",
                };
                let paused = v["paused"].as_bool().unwrap_or(false);
                let mut tip = format!(
                    "TokenHUD: {}{} | {}/min out | {} live | today {} tokens, ${:.2}",
                    word,
                    if paused { " (paused)" } else { "" },
                    compact(v["tokPerMin"].as_f64().unwrap_or(0.0)),
                    v["liveSessions"].as_u64().unwrap_or(0),
                    compact(v["todayOut"].as_f64().unwrap_or(0.0)),
                    v["todayCost"].as_f64().unwrap_or(0.0)
                );
                if let Some(p) = v["plan5h"].as_f64() {
                    tip.push_str(&format!(" | 5h {:.0}%", p));
                }
                // The native tooltip draws over the open popover, so it stays blank while the popover is shown.
                let popover = app.get_webview_window("mini").map(|m| m.is_visible().unwrap_or(false)).unwrap_or(false);
                if let Some(t) = app.tray_by_id("main") {
                    let _ = t.set_tooltip(Some(if popover { String::new() } else { tip }));
                    if level != last_level {
                        let _ = t.set_icon(Some(tray_image(level_color(&level))));
                        last_level = level;
                    }
                }
            }
            None => {
                fails += 1;
                if fails >= 2 {
                    ensure_server(); // server died: bring it back
                    fails = 0;
                }
            }
        }
        std::thread::sleep(Duration::from_secs(4));
    }
}

// ---------- commands callable from the web UI ----------
#[tauri::command]
fn open_dashboard(app: AppHandle) {
    show_main(&app);
}
#[tauri::command]
fn set_mini_pinned(app: AppHandle, on: bool) {
    set_pinned(&app, on);
}
#[tauri::command]
fn set_main_pinned(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on);
    }
}
#[tauri::command]
fn hide_mini(app: AppHandle) {
    if let Some(m) = app.get_webview_window("mini") {
        let _ = m.hide();
    }
    set_pinned(&app, false);
}

fn build_windows(app: &AppHandle) {
    let base = format!("http://127.0.0.1:{PORT}");
    let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("{base}/#/").parse().unwrap()))
        .title("TokenHUD")
        .inner_size(1500.0, 960.0)
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .theme(Some(Theme::Dark))
        .visible(false)
        .build();
    if let Ok(w) = main {
        let _ = w.restore_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
        let a = app.clone();
        w.on_window_event(move |e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                if let Some(w) = a.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        });
    }
    let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::External(format!("{base}/#/mini").parse().unwrap()))
        .title("TokenHUD Mini")
        .inner_size(MINI_W, MINI_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
}

fn main() {
    let open_at_start = std::env::args().any(|a| a == "--open");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["mini"])
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![open_dashboard, set_mini_pinned, hide_mini, set_main_pinned])
        .setup(move |app| {
            let shared = Arc::new(Shared::default());
            app.manage(shared.clone());

            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let pin = CheckMenuItem::with_id(app, "pin", "Pin mini window", true, false, None::<&str>)?;
            let pause = CheckMenuItem::with_id(app, "pause", "Pause live updates", true, false, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "auto", "Start with Windows", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit TokenHUD", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &pin, &pause, &sep1, &auto, &data, &sep2, &quit])?;
            app.manage(Menus { pin: pin.clone() });

            let sh_ev = shared.clone();
            let (pause_c, auto_c) = (pause.clone(), auto.clone());
            TrayIconBuilder::with_id("main")
                .icon(tray_image(level_color("idle")))
                .tooltip("TokenHUD: starting")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "pin" => {
                        let on = app.state::<Menus>().pin.is_checked().unwrap_or(false);
                        set_pinned(app, on);
                    }
                    "pause" => {
                        let on = pause_c.is_checked().unwrap_or(false);
                        http("POST", "/api/pause", &format!("{{\"paused\":{on}}}"));
                    }
                    "auto" => {
                        let al = app.autolaunch();
                        let _ = if auto_c.is_checked().unwrap_or(false) { al.enable() } else { al.disable() };
                    }
                    "data" => {
                        let _ = Command::new("explorer.exe").arg(data_dir()).creation_flags(NO_WINDOW).spawn();
                    }
                    "quit" => {
                        // The data server is the always-on "TokenHUD Server" task; quitting the tray leaves it running.
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |tray, ev| match ev {
                    TrayIconEvent::Enter { rect, .. } | TrayIconEvent::Move { rect, .. } => {
                        let app = tray.app_handle();
                        let sc = app.get_webview_window("mini").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                        let (p, s) = (rect.position.to_physical::<f64>(sc), rect.size.to_physical::<f64>(sc));
                        *sh_ev.icon.lock().unwrap() = Some((p.x, p.y, s.width, s.height));
                    }
                    TrayIconEvent::Click { button, button_state: MouseButtonState::Up, .. } if button == MouseButton::Left => {
                        sh_ev.suppress.store(true, Ordering::Relaxed);
                        toggle_main(tray.app_handle());
                    }
                    TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Down, .. } => {
                        sh_ev.suppress.store(true, Ordering::Relaxed);
                        if let Some(m) = tray.app_handle().get_webview_window("mini") {
                            if !sh_ev.pinned.load(Ordering::Relaxed) {
                                let _ = m.hide();
                            }
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                ensure_server();
                for _ in 0..150 {
                    if health().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                let h2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    build_windows(&h2);
                    if open_at_start {
                        show_main(&h2);
                    }
                });
                let h3 = handle.clone();
                std::thread::spawn(move || hover_loop(h3));
                status_loop(handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TokenHUD tray");
}

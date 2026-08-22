//! omp shell — Tauri desktop host for the headless core engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use omp_shell::project::{AppState, save_window_state, setup_app};
use tauri::Manager;
use tokio::sync::Mutex;

/**
 * Single-instance guard (Windows only): a named mutex owned for the process
 * lifetime. A second instance finds the mutex already held, best-effort
 * activates the existing main window, and returns `false` so the caller can
 * exit immediately. The handle is intentionally never closed — closing it
 * would release the mutex.
 */
#[cfg(target_os = "windows")]
fn ensure_single_instance() -> bool {
	use std::sync::OnceLock;

	use windows_sys::Win32::{
		Foundation::{ERROR_ALREADY_EXISTS, GetLastError},
		System::Threading::CreateMutexW,
		UI::WindowsAndMessaging::{FindWindowW, SW_RESTORE, SetForegroundWindow, ShowWindow},
	};

	// Runtime input (the CreateMutexW result) — OnceLock is the right tool.
	static MUTEX: OnceLock<isize> = OnceLock::new();

	let name: Vec<u16> = "Local\\omp-shell-io.omp.shell\0".encode_utf16().collect();
	// SAFETY: CreateMutexW with a null security descriptor and a unique name.
	let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) } as isize;
	if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
		// Best-effort activation of the already-running window; silent if the
		// window class is not found (e.g. still starting up).
		// SAFETY: FindWindowW/ShowWindow/SetForegroundWindow on the found HWND.
		unsafe {
			let class: Vec<u16> = "WebViewWindowClass\0".encode_utf16().collect();
			let hwnd = FindWindowW(class.as_ptr(), std::ptr::null());
			if !hwnd.is_null() {
				ShowWindow(hwnd, SW_RESTORE);
				SetForegroundWindow(hwnd);
			}
		}
		return false;
	}
	// Keep the handle for the process lifetime; closing it would release the
	// mutex and let a second instance start.
	let _ = MUTEX.set(handle);
	true
}

#[cfg(not(target_os = "windows"))]
fn ensure_single_instance() -> bool {
	true
}

fn main() {
	if !ensure_single_instance() {
		std::process::exit(0);
	}
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			setup_app(app.handle())?;
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			omp_shell::project::project_list,
			omp_shell::project::project_open,
			omp_shell::project::project_switch,
			omp_shell::project::app_info,
			omp_shell::project::window_minimize,
			omp_shell::project::window_is_maximized,
			omp_shell::project::window_start_dragging,
			omp_shell::project::window_toggle_maximize,
			omp_shell::project::window_close
		])
		.build(tauri::generate_context!())
		.expect("error while building omp shell")
		.run(|app: &tauri::AppHandle, event| {
			if let tauri::RunEvent::ExitRequested { .. } = event {
				save_window_state(app);
				let state = app.state::<Mutex<AppState>>();
				let core = tauri::async_runtime::block_on(async {
					let mut guard = state.lock().await;
					guard.core.take()
				});
				if let Some(mut core) = core {
					tauri::async_runtime::block_on(core.stop());
				}
			}
		});
}

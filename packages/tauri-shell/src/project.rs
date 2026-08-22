//! Project selection & switching: folder picker, tray, window state and core
//! lifecycle.

use std::path::{Path, PathBuf};

use tauri::{
	AppHandle, Manager, State, Url,
	menu::{Menu, MenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

use crate::{
	config::{OmpCommand, ShellConfig, load_config, save_config},
	core_engine::{CoreEngine, CoreError, ProjectCore},
};

#[cfg(test)]
struct ProjectRuntime<C> {
	core: Option<C>,
	omp:  OmpCommand,
}

pub struct AppState {
	pub core:   Option<CoreEngine>,
	pub config: ShellConfig,
	pub omp:    OmpCommand,
}

impl AppState {
	async fn switch_core<F, Fut>(&mut self, canonical: &Path, start: F) -> Result<bool, CoreError>
	where
		F: FnOnce(OmpCommand, PathBuf) -> Fut,
		Fut: Future<Output = Result<CoreEngine, CoreError>>,
	{
		switch_core(&mut self.core, &self.omp, canonical, start).await
	}
}

async fn switch_core<C, F, Fut>(
	core: &mut Option<C>,
	omp: &OmpCommand,
	canonical: &Path,
	start: F,
) -> Result<bool, CoreError>
where
	C: ProjectCore,
	F: FnOnce(OmpCommand, PathBuf) -> Fut,
	Fut: Future<Output = Result<C, CoreError>>,
{
	if core
		.as_ref()
		.is_some_and(|core| core.project_dir() == canonical)
	{
		return Ok(false);
	}

	if let Some(mut current) = core.take() {
		current.stop_for_project().await;
	}

	*core = Some(start(omp.clone(), canonical.to_path_buf()).await?);
	Ok(true)
}

const CONFIG_FILE: &str = "config.json";

pub fn config_path(app: &AppHandle) -> PathBuf {
	app.path()
		.app_config_dir()
		.map(|dir| dir.join(CONFIG_FILE))
		.unwrap_or_else(|_| PathBuf::from(CONFIG_FILE))
}

pub fn setup_app(app: &AppHandle) -> tauri::Result<()> {
	let cfg = load_config(&config_path(app));
	let omp = OmpCommand::resolve(&cfg);
	let last_project = cfg.last_project.clone();

	app.manage(Mutex::new(AppState { core: None, config: cfg, omp }));

	restore_window_state(app);

	build_tray(app)?;

	// Close-to-tray: native and custom close requests hide the window. The tray
	// Quit item calls `app.exit(0)` and runs the core shutdown in main.rs.
	if let Some(win) = app.get_webview_window("main") {
		let app = app.clone();
		win.clone().on_window_event(move |event| {
			if let tauri::WindowEvent::CloseRequested { api, .. } = event {
				api.prevent_close();
				save_window_state(&app);
				let _ = win.hide();
			}
		});
	}

	let app = app.clone();
	tauri::async_runtime::spawn(async move {
		if let Some(dir) = last_project {
			if Path::new(&dir).is_dir() {
				let _ = switch_project(&app, Path::new(&dir)).await;
				return;
			}
		}
		pick_project(&app);
	});
	Ok(())
}

pub fn pick_project(app: &AppHandle) {
	let app = app.clone();
	app.dialog().file().pick_folder(move |file_path| {
		if let Some(fp) = file_path {
			if let Ok(path) = fp.into_path() {
				let app = app.clone();
				tauri::async_runtime::spawn(async move {
					let _ = switch_project(&app, &path).await;
				});
			}
		}
	});
}

pub async fn switch_project(app: &AppHandle, new_dir: &Path) -> Result<(), String> {
	let canonical = match new_dir.canonicalize() {
		Ok(path) => path,
		Err(e) => {
			let msg = format!("无法打开项目目录 {new_dir:?}：{e}");
			let _ = app.dialog().message(msg.clone()).show(|_| {});
			return Err(msg);
		},
	};
	if !canonical.is_dir() {
		let msg = format!("{} 不是目录", canonical.display());
		let _ = app.dialog().message(msg.clone()).show(|_| {});
		return Err(msg);
	}
	let canonical_str = canonical.to_string_lossy().into_owned();

	let state = app.state::<Mutex<AppState>>();
	// Hold the state lock through stop + start. Concurrent menu/WebView switch
	// requests then re-check the installed core after the active transition,
	// rather than starting a second process for the same project.
	let mut guard = state.lock().await;
	if guard
		.core
		.as_ref()
		.is_some_and(|c| c.project_dir() == canonical.as_path())
	{
		return Ok(());
	}
	guard.config.record_project(&canonical_str);
	let cfg_snapshot = guard.config.clone();

	if let Err(e) = save_config(&config_path(app), &cfg_snapshot) {
		eprintln!("failed to save shell config: {e}");
	}

	let dir_for_cb = canonical_str.clone();
	let app2 = app.clone();
	let exit_cb = move |code: i32| {
		let _ = app2
			.dialog()
			.message(format!("omp core 已退出（code {code}）"))
			.show(|_| {});
		let app2 = app2.clone();
		tauri::async_runtime::spawn(async move {
			let state = app2.state::<Mutex<AppState>>();
			let mut guard = state.lock().await;
			if guard
				.core
				.as_ref()
				.is_some_and(|c| c.project_dir().to_string_lossy() == dir_for_cb)
			{
				guard.core = None;
			}
		});
	};

	match guard
		.switch_core(&canonical, |omp, project_dir| async move {
			CoreEngine::start(&omp, &project_dir, exit_cb).await
		})
		.await
	{
		Ok(true) => {
			let control = guard
				.core
				.as_ref()
				.expect("a successful switch installs the started core")
				.control_link
				.clone();
			let title = canonical
				.file_name()
				.map(|name| name.to_string_lossy().into_owned())
				.unwrap_or_else(|| canonical_str.clone());
			drop(guard);
			if let Some(win) = app.get_webview_window("main") {
				if let Ok(url) = Url::parse(&control) {
					let _ = win.navigate(url);
				}
				let _ = win.set_title(&title);
			}
			Ok(())
		},
		Ok(false) => Ok(()),
		Err(e) => {
			let msg = format!("无法启动 omp core：{e}");
			let _ = app.dialog().message(msg.clone()).show(|_| {});
			Err(msg)
		},
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Frontend commands (welcome page)
// ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectList {
	pub last_project:    Option<String>,
	pub recent_projects: Vec<String>,
	pub current_project: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppInfo {
	pub version:      String,
	pub product_name: String,
}

#[tauri::command]
pub async fn project_list(state: State<'_, Mutex<AppState>>) -> Result<ProjectList, String> {
	let guard = state.lock().await;
	Ok(project_list_from(&guard.config, guard.core.as_ref().map(CoreEngine::project_dir)))
}

fn project_list_from(config: &ShellConfig, current_project: Option<&Path>) -> ProjectList {
	ProjectList {
		last_project:    config.last_project.clone(),
		recent_projects: config.recent_projects.clone(),
		current_project: current_project.map(|path| path.to_string_lossy().into_owned()),
	}
}

#[tauri::command]
pub fn project_open(app: AppHandle) {
	pick_project(&app);
}

#[tauri::command]
pub async fn project_switch(app: AppHandle, path: String) -> Result<(), String> {
	switch_project(&app, Path::new(&path)).await
}

#[tauri::command]
pub fn app_info() -> AppInfo {
	AppInfo {
		version:      env!("CARGO_PKG_VERSION").to_string(),
		product_name: "omp shell".to_string(),
	}
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
	app.get_webview_window("main")
		.ok_or_else(|| "main window is unavailable".to_string())
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<(), String> {
	main_window(&app)?
		.minimize()
		.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, String> {
	main_window(&app)?
		.is_maximized()
		.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_start_dragging(app: AppHandle) -> Result<(), String> {
	main_window(&app)?
		.start_dragging()
		.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> Result<bool, String> {
	let window = main_window(&app)?;
	if window.is_maximized().map_err(|error| error.to_string())? {
		window.unmaximize().map_err(|error| error.to_string())?;
	} else {
		window.maximize().map_err(|error| error.to_string())?;
	}
	window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), String> {
	main_window(&app)?
		.close()
		.map_err(|error| error.to_string())
}

#[cfg(test)]
mod command_tests {
	use std::sync::{
		Arc, Mutex as StdMutex,
		atomic::{AtomicUsize, Ordering},
	};

	use super::*;

	struct ProbeCore {
		project_dir: PathBuf,
		events:      Arc<StdMutex<Vec<String>>>,
	}

	impl ProjectCore for ProbeCore {
		fn stop_for_project(&mut self) -> impl Future<Output = ()> {
			let events = Arc::clone(&self.events);
			let project_dir = self.project_dir.clone();
			async move {
				events
					.lock()
					.expect("event log lock")
					.push(format!("stop:{}", project_dir.display()));
			}
		}

		fn project_dir(&self) -> &Path {
			&self.project_dir
		}
	}

	#[test]
	fn project_list_serializes_the_active_project_separately_from_last_project() {
		let config = ShellConfig {
			last_project: Some("/work/last".into()),
			recent_projects: vec!["/work/active".into(), "/work/last".into()],
			..Default::default()
		};

		let value = serde_json::to_value(project_list_from(&config, Some(Path::new("/work/active"))))
			.expect("ProjectList should serialize");

		assert_eq!(value["last_project"], "/work/last");
		assert_eq!(value["recent_projects"][0], "/work/active");
		assert_eq!(value["current_project"], "/work/active");
	}

	#[test]
	fn project_list_serializes_no_active_project_as_null() {
		let config = ShellConfig { last_project: Some("/work/last".into()), ..Default::default() };

		let value = serde_json::to_value(project_list_from(&config, None))
			.expect("ProjectList should serialize");

		assert_eq!(value["last_project"], "/work/last");
		assert!(value["current_project"].is_null());
	}

	#[tokio::test]
	async fn concurrent_switches_serialize_to_one_active_start_and_current_project() {
		let original = PathBuf::from("/work/original");
		let target = PathBuf::from("/work/target");
		let events = Arc::new(StdMutex::new(Vec::new()));
		let starts = Arc::new(AtomicUsize::new(0));
		let runtime = Arc::new(Mutex::new(ProjectRuntime {
			core: Some(ProbeCore { project_dir: original.clone(), events: Arc::clone(&events) }),
			omp:  OmpCommand { argv: vec!["probe".into()] },
		}));

		let switch = |runtime: Arc<Mutex<ProjectRuntime<ProbeCore>>>| {
			let target = target.clone();
			let starts = Arc::clone(&starts);
			let events = Arc::clone(&events);
			async move {
				let mut guard = runtime.lock().await;
				let ProjectRuntime { core, omp } = &mut *guard;
				switch_core(core, omp, &target, move |_omp, project_dir| async move {
					starts.fetch_add(1, Ordering::SeqCst);
					events
						.lock()
						.expect("event log lock")
						.push(format!("start:{}", project_dir.display()));
					tokio::task::yield_now().await;
					Ok(ProbeCore { project_dir, events })
				})
				.await
				.expect("switch succeeds")
			}
		};

		let (first_changed, second_changed) =
			tokio::join!(switch(Arc::clone(&runtime)), switch(Arc::clone(&runtime)),);
		let guard = runtime.lock().await;

		assert_eq!(starts.load(Ordering::SeqCst), 1);
		assert_eq!(
			[first_changed, second_changed]
				.into_iter()
				.filter(|changed| *changed)
				.count(),
			1
		);
		let projects = project_list_from(
			&ShellConfig::default(),
			guard.core.as_ref().map(ProjectCore::project_dir),
		);
		assert_eq!(projects.current_project, Some(target.to_string_lossy().into_owned()));
		assert_eq!(*events.lock().expect("event log lock"), vec![
			format!("stop:{}", original.display()),
			format!("start:{}", target.display()),
		]);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Window state persistence
// ───────────────────────────────────────────────────────────────────────────

/** Persist the main window's geometry into the shell config (best-effort per
 * field). */
pub fn save_window_state(app: &AppHandle) {
	let Some(win) = app.get_webview_window("main") else {
		return;
	};
	let mut cfg = tauri::async_runtime::block_on(async {
		let state = app.state::<Mutex<AppState>>();
		state.lock().await.config.clone()
	});
	if let Ok(pos) = win.outer_position() {
		cfg.window_x = Some(pos.x);
		cfg.window_y = Some(pos.y);
	}
	if let Ok(size) = win.inner_size() {
		cfg.window_width = Some(size.width);
		cfg.window_height = Some(size.height);
	}
	if let Ok(maximized) = win.is_maximized() {
		cfg.window_maximized = Some(maximized);
	}
	tauri::async_runtime::block_on(async {
		let state = app.state::<Mutex<AppState>>();
		state.lock().await.config = cfg.clone();
	});
	if let Err(e) = save_config(&config_path(app), &cfg) {
		eprintln!("failed to save shell config: {e}");
	}
}

/** Restore the saved window geometry; missing/absurd values keep the default
 * 1200×800. */
pub fn restore_window_state(app: &AppHandle) {
	let Some(win) = app.get_webview_window("main") else {
		return;
	};
	let cfg = tauri::async_runtime::block_on(async {
		let state = app.state::<Mutex<AppState>>();
		state.lock().await.config.clone()
	});
	let (Some(x), Some(y), Some(width), Some(height)) =
		(cfg.window_x, cfg.window_y, cfg.window_width, cfg.window_height)
	else {
		return;
	};
	if width < 400 || height < 300 {
		return;
	}
	let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
	let _ = win.set_size(tauri::PhysicalSize::new(width, height));
	if cfg.window_maximized == Some(true) {
		let _ = win.maximize();
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Tray
// ───────────────────────────────────────────────────────────────────────────

fn show_main_window(app: &AppHandle) {
	if let Some(win) = app.get_webview_window("main") {
		let _ = win.show();
		let _ = win.set_focus();
	}
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
	let show = MenuItem::with_id(app, "tray-show", "Show", true, None::<&str>)?;
	let open = MenuItem::with_id(app, "tray-open", "Open Project…", true, None::<&str>)?;
	let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
	let tray_menu = Menu::with_items(app, &[&show, &open, &quit])?;
	let icon = app
		.default_window_icon()
		.cloned()
		.ok_or(tauri::Error::AssetNotFound("window icon".into()))?;
	TrayIconBuilder::with_id("main")
		.icon(icon)
		.menu(&tray_menu)
		// Left click shows the window; the menu opens on right click (classic
		// Windows behavior, and the click handler must not fight the menu).
		.show_menu_on_left_click(false)
		.on_menu_event(|app, event| match event.id().as_ref() {
			"tray-show" => show_main_window(app),
			"tray-open" => pick_project(app),
			"tray-quit" => app.exit(0),
			_ => {},
		})
		.on_tray_icon_event(|tray, event| {
			if let TrayIconEvent::Click {
				button: MouseButton::Left,
				button_state: MouseButtonState::Up,
				..
			} = event
			{
				show_main_window(tray.app_handle());
			}
		})
		.build(app)?;
	Ok(())
}

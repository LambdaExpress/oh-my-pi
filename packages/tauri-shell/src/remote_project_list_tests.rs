//! Closest-to-runtime ACL probe supported by Tauri's official test runtime.
//!
//! `MockRuntime` does not instantiate an OS WebView or fetch the loopback
//! document. It does run the same generated application ACL, remote-origin
//! classification, window matching, command dispatch, and response path used
//! by a real WebView IPC request. The dynamic port below is allocated by the
//! OS, so the probe covers the wildcard-port origin that the core actually
//! serves.

use std::{net::TcpListener, sync::Mutex as StdMutex};

use tauri::{WebviewWindowBuilder, ipc::InvokeBody, webview::InvokeRequest};
use tokio::sync::Mutex;

use crate::{
	config::{OmpCommand, ShellConfig},
	project::AppState,
};

static TAURI_MOCK_TEST: StdMutex<()> = StdMutex::new(());

fn assert_acl_rejection(error: &serde_json::Value) {
	let message = error.as_str().unwrap_or_default();
	assert!(
		message.contains("not allowed") || message.contains("denied"),
		"unexpected ACL rejection: {error}"
	);
}

fn mock_webview(
	config: ShellConfig,
	label: &str,
) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
	let app = tauri::test::mock_builder()
		.manage(Mutex::new(AppState {
			core: None,
			config,
			omp: OmpCommand { argv: vec!["unused".into()] },
		}))
		.invoke_handler(tauri::generate_handler![crate::project::project_list])
		.build(tauri::generate_context!("tauri.conf.json", test = true))
		.expect("build mock shell with generated ACL");
	WebviewWindowBuilder::new(&app, label, Default::default())
		.build()
		.expect("build main mock webview")
}

fn invoke_command(
	webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
	command: &str,
	url: tauri::Url,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
	tauri::test::get_ipc_response(webview, InvokeRequest {
		cmd: command.into(),
		callback: tauri::ipc::CallbackFn(0),
		error: tauri::ipc::CallbackFn(1),
		url,
		body: InvokeBody::default(),
		headers: Default::default(),
		invoke_key: tauri::test::INVOKE_KEY.into(),
	})
}

#[test]
fn remote_project_list_probe_allows_dynamic_loopback_main_window() {
	let _serial = TAURI_MOCK_TEST
		.lock()
		.expect("serialize Tauri mock runtime tests");
	let listener = TcpListener::bind("127.0.0.1:0").expect("allocate a dynamic loopback port");
	let origin = format!("http://{}/", listener.local_addr().expect("bound address"))
		.parse()
		.expect("valid loopback URL");

	let webview = mock_webview(
		ShellConfig {
			last_project: Some("/work/recent".into()),
			recent_projects: vec!["/work/recent".into()],
			..Default::default()
		},
		"main",
	);

	let projects = invoke_command(&webview, "project_list", origin)
		.expect("dynamic loopback origin should be authorized for project_list")
		.deserialize::<serde_json::Value>()
		.expect("project_list response should deserialize");
	assert_eq!(projects["last_project"], "/work/recent");
	assert_eq!(projects["recent_projects"], serde_json::json!(["/work/recent"]));
	assert!(projects["current_project"].is_null());
}

#[test]
fn remote_project_list_probe_rejects_unlisted_origin() {
	let _serial = TAURI_MOCK_TEST
		.lock()
		.expect("serialize Tauri mock runtime tests");
	let webview = mock_webview(ShellConfig::default(), "main");

	let error = invoke_command(
		&webview,
		"project_list",
		"http://localhost:43210/".parse().expect("valid remote URL"),
	)
	.expect_err("a remote hostname outside the capability must be rejected");
	assert_acl_rejection(&error);
}

#[test]
fn remote_project_list_probe_rejects_unlisted_command() {
	let _serial = TAURI_MOCK_TEST
		.lock()
		.expect("serialize Tauri mock runtime tests");
	let webview = mock_webview(ShellConfig::default(), "main");

	let error = invoke_command(
		&webview,
		"not_a_shell_command",
		"http://127.0.0.1:43210/"
			.parse()
			.expect("valid loopback URL"),
	)
	.expect_err("loopback capability must not authorize commands outside its command set");
	assert_acl_rejection(&error);
}

#[test]
fn remote_project_list_probe_rejects_non_main_window() {
	let _serial = TAURI_MOCK_TEST
		.lock()
		.expect("serialize Tauri mock runtime tests");
	let webview = mock_webview(ShellConfig::default(), "secondary");

	let error = invoke_command(
		&webview,
		"project_list",
		"http://127.0.0.1:43210/"
			.parse()
			.expect("valid loopback URL"),
	)
	.expect_err("loopback project capability must only apply to the main window");
	assert_acl_rejection(&error);
}

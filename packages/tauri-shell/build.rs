fn main() {
	// Register the app commands so tauri generates the `allow-<command>`
	// permission set the capabilities file references, and point the
	// capabilities parser at `src/capabilities/` (the default pattern
	// `./capabilities/**/*` resolves against the package root and finds
	// nothing, leaving the runtime ACL with zero grants).
	tauri_build::try_build(
		tauri_build::Attributes::new()
			.capabilities_path_pattern("./src/capabilities/**/*")
			.app_manifest(tauri_build::AppManifest::default().commands(&[
				"project_list",
				"project_open",
				"project_switch",
				"app_info",
			])),
	)
	.expect("failed to run tauri-build");
}

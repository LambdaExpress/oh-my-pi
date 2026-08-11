use std::path::PathBuf;

use omp_shell::config::{OmpCommand, ShellConfig, load_config, save_config};

fn temp_dir(name: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!(
		"omp-shell-test-{}-{}-{}",
		std::process::id(),
		name,
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos()
	));
	std::fs::create_dir_all(&dir).unwrap();
	dir
}

#[test]
fn round_trip_preserves_config() {
	let path = temp_dir("round-trip").join("config.json");
	let mut cfg = ShellConfig {
		omp_bin: "omp-custom".into(),
		last_project: Some("D:/project/x".into()),
		..Default::default()
	};
	cfg.record_project("D:/project/a");
	cfg.record_project("D:/project/b");
	cfg.record_project("D:/project/a");

	save_config(&path, &cfg).unwrap();
	let loaded = load_config(&path);

	assert_eq!(loaded, cfg);
	// Dedup keeps the most recent occurrence at the front.
	assert_eq!(loaded.recent_projects, vec!["D:/project/a", "D:/project/b"]);
}

#[test]
fn corrupt_json_resets_and_backs_up() {
	let path = temp_dir("corrupt").join("config.json");
	std::fs::write(&path, "{ not json").unwrap();

	let cfg = load_config(&path);

	assert_eq!(cfg, ShellConfig::default());
	assert!(path.with_extension("json.bak").exists(), "backup file should exist");
}

#[test]
fn missing_file_returns_default() {
	let path = temp_dir("missing").join("config.json");
	assert_eq!(load_config(&path), ShellConfig::default());
}

#[test]
fn recent_caps_at_eight() {
	let mut cfg = ShellConfig::default();
	for i in 0..10 {
		cfg.record_project(&format!("D:/p{i}"));
	}
	assert_eq!(cfg.recent_projects.len(), 8);
	assert_eq!(cfg.recent_projects[0], "D:/p9");
	assert_eq!(cfg.recent_projects[7], "D:/p2");
}

#[test]
fn resolve_priority() {
	// Environment omp bin wins over the config value.
	assert_eq!(OmpCommand::resolve_from(Some("my-omp"), None, &ShellConfig::default()).argv, vec![
		"my-omp"
	]);
	// Config omp bin is used when no environment override is set.
	assert_eq!(
		OmpCommand::resolve_from(None, None, &ShellConfig {
			omp_bin: "cfg-omp".into(),
			..Default::default()
		})
		.argv,
		vec!["cfg-omp"]
	);
	// No overrides: fall back to the default "omp".
	assert_eq!(OmpCommand::resolve_from(None, None, &ShellConfig::default()).argv, vec!["omp"]);
	// A dev repo overrides even an environment omp bin.
	assert_eq!(
		OmpCommand::resolve_from(Some("my-omp"), Some("D:/repo"), &ShellConfig::default()).argv,
		vec!["bun", "--cwd=D:/repo/packages/coding-agent", "src/cli.ts"]
	);
	// Dev repo alone also produces the bun argv.
	assert_eq!(OmpCommand::resolve_from(None, Some("D:/repo"), &ShellConfig::default()).argv, vec![
		"bun",
		"--cwd=D:/repo/packages/coding-agent",
		"src/cli.ts"
	]);
}

//! Shell configuration persistence and omp executable resolution.

use std::{io, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShellConfig {
	// Default "omp" (resolved via PATH).
	pub omp_bin:          String,
	// Some => spawn `bun --cwd=<repo>/packages/coding-agent src/cli.ts`.
	pub dev_repo:         Option<String>,
	pub last_project:     Option<String>,
	// Newest first, deduped, max 8 entries.
	pub recent_projects:  Vec<String>,
	// Window geometry persisted on close/hide; restored on next launch.
	// `Option` so old config.json files deserialize without migration.
	pub window_x:         Option<i32>,
	pub window_y:         Option<i32>,
	pub window_width:     Option<u32>,
	pub window_height:    Option<u32>,
	pub window_maximized: Option<bool>,
}

impl Default for ShellConfig {
	fn default() -> Self {
		Self {
			omp_bin:          "omp".to_string(),
			dev_repo:         None,
			last_project:     None,
			recent_projects:  Vec::new(),
			window_x:         None,
			window_y:         None,
			window_width:     None,
			window_height:    None,
			window_maximized: None,
		}
	}
}

impl ShellConfig {
	pub fn record_project(&mut self, dir: &str) {
		self.last_project = Some(dir.to_string());
		self.recent_projects.retain(|p| p != dir);
		self.recent_projects.insert(0, dir.to_string());
		self.recent_projects.truncate(8);
	}
}

#[derive(Debug, Clone, PartialEq)]
pub struct OmpCommand {
	pub argv: Vec<String>,
}

impl OmpCommand {
	pub fn resolve(config: &ShellConfig) -> OmpCommand {
		Self::resolve_from(
			std::env::var("OMP_SHELL_OMP_BIN").ok().as_deref(),
			std::env::var("OMP_SHELL_DEV_REPO").ok().as_deref(),
			config,
		)
	}

	pub fn resolve_from(
		env_omp_bin: Option<&str>,
		env_dev_repo: Option<&str>,
		config: &ShellConfig,
	) -> OmpCommand {
		let dev_repo = env_dev_repo
			.or(config.dev_repo.as_deref())
			.filter(|s| !s.is_empty());
		if let Some(repo) = dev_repo {
			return OmpCommand {
				argv: vec![
					"bun".to_string(),
					format!("--cwd={repo}/packages/coding-agent"),
					"src/cli.ts".to_string(),
				],
			};
		}
		let bin = env_omp_bin
			.or(Some(config.omp_bin.as_str()))
			.filter(|s| !s.is_empty())
			.unwrap_or("omp");
		OmpCommand { argv: vec![bin.to_string()] }
	}
}

pub fn load_config(path: &Path) -> ShellConfig {
	let Ok(contents) = std::fs::read_to_string(path) else {
		return ShellConfig::default();
	};
	match serde_json::from_str(&contents) {
		Ok(cfg) => cfg,
		Err(_) => {
			let _ = std::fs::copy(path, path.with_extension("json.bak"));
			ShellConfig::default()
		},
	}
}

pub fn save_config(path: &Path, cfg: &ShellConfig) -> io::Result<()> {
	let json = serde_json::to_string_pretty(cfg).expect("serializing ShellConfig cannot fail");
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let tmp = path.with_extension("json.tmp");
	std::fs::write(&tmp, json)?;
	let _ = std::fs::remove_file(path);
	std::fs::rename(&tmp, path)
}

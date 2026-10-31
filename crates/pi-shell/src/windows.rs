use std::{
	collections::HashSet,
	env,
	path::{Path, PathBuf},
};

use anyhow::{Error, Result};
use brush_core::{Shell as BrushShell, ShellValue, ShellVariable};
use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

pub async fn configure_windows_path(shell: &mut BrushShell) -> Result<()> {
	let GitDiscovery { install_roots, paths: git_paths } = discover_git(shell).await;
	if install_roots.is_empty() && git_paths.is_empty() {
		return Ok(());
	}

	let existing_path = shell
		.env()
		.get("PATH")
		.and_then(|(_, var)| match var.value() {
			ShellValue::String(value) => Some(value.clone()),
			_ => None,
		})
		.unwrap_or_default();

	// Translate MSYS2-style entries (e.g. /usr/bin, /mingw64/bin, /c/Users/...)
	// into Windows-native paths so brush-core's std::path-based lookups can
	// resolve executables shipped with Git Bash.
	let mut segments: Vec<String> = Vec::new();
	let mut seen_normalized: HashSet<String> = HashSet::new();
	for raw in env::split_paths(&existing_path) {
		let raw_str = raw.to_string_lossy().into_owned();
		if raw_str.trim().is_empty() {
			continue;
		}
		let translated = translate_msys_segment(&raw_str, &install_roots).unwrap_or(raw_str);
		let normalized = normalize_path(Path::new(&translated));
		if normalized.is_empty() {
			segments.push(translated);
			continue;
		}
		if !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(translated);
	}

	for git_path in &git_paths {
		if !Path::new(git_path).is_dir() {
			continue;
		}
		let normalized = normalize_path(Path::new(git_path));
		if normalized.is_empty() || !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(git_path.clone());
	}

	let updated_path = segments.join(";");
	if updated_path == existing_path {
		return Ok(());
	}

	let mut var = ShellVariable::new(ShellValue::String(updated_path));
	var.export();
	shell
		.env_mut()
		.set_global("PATH", var)
		.map_err(|err| Error::msg(format!("Failed to set PATH: {err}")))?;

	Ok(())
}

fn normalize_path(path: &Path) -> String {
	let path_str = path.to_string_lossy();
	let trimmed = path_str.trim();
	let unquoted = trimmed.trim_matches('"');
	if unquoted.is_empty() {
		return String::new();
	}

	let path = Path::new(unquoted);
	if let Ok(canonical) = path.canonicalize() {
		return canonical.to_string_lossy().into_owned();
	}

	let mut normalized = PathBuf::new();
	for component in path.components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().into_owned()
}

struct GitDiscovery {
	install_roots: Vec<PathBuf>,
	paths:         Vec<String>,
}

async fn discover_git(shell: &BrushShell) -> GitDiscovery {
	// Resolve through the shell's existing PATHEXT-aware filesystem lookup.
	// Running `where git` here used a synchronous, untracked child before the
	// command's pipes/spawn registry existed, so cancellation could not stop
	// startup or even service its deadline while that child was blocked.
	let path_root = shell
		.find_first_executable_in_path("git")
		.await
		.as_deref()
		.and_then(git_install_root_from_path)
		.map(|root| root.to_string_lossy().into_owned());
	discover_git_with(query_git_install_path_from_registry, || path_root)
}

fn discover_git_with<R, P>(registry_query: R, path_query: P) -> GitDiscovery
where
	R: FnOnce() -> Option<String>,
	P: FnOnce() -> Option<String>,
{
	let registry_path = registry_query();
	let path_path = path_query();
	let mut install_roots = Vec::new();
	let mut paths = Vec::new();
	let mut seen_roots = HashSet::new();
	let mut seen_paths = HashSet::new();

	for install_path in [registry_path, path_path].into_iter().flatten() {
		for path in git_paths_for_install_root(&install_path) {
			let normalized_path = normalize_path(Path::new(&path));
			if !normalized_path.is_empty() && seen_paths.insert(normalized_path) {
				paths.push(path);
			}
		}

		let root = PathBuf::from(&install_path);
		let normalized_root = normalize_path(&root);
		if !normalized_root.is_empty() && seen_roots.insert(normalized_root) {
			install_roots.push(root);
		}
	}

	GitDiscovery { install_roots, paths }
}

fn query_git_install_path_from_registry() -> Option<String> {
	let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
	let key_paths = ["SOFTWARE\\GitForWindows", "SOFTWARE\\WOW6432Node\\GitForWindows"];

	for key_path in key_paths {
		if let Ok(key) = hklm.open_subkey(key_path)
			&& let Ok(path) = key.get_value::<String, _>("InstallPath")
			&& !path.is_empty()
		{
			return Some(path);
		}
	}

	None
}

fn git_install_root_from_path(git_path: &Path) -> Option<PathBuf> {
	let parent = git_path.parent()?;
	let parent_name = parent.file_name()?.to_string_lossy();

	if parent_name.eq_ignore_ascii_case("cmd") {
		return parent.parent().map(Path::to_path_buf);
	}

	if parent_name.eq_ignore_ascii_case("bin") {
		let grandparent = parent.parent()?;
		if let Some(grandparent_name) = grandparent.file_name() {
			let grandparent_name = grandparent_name.to_string_lossy();
			if grandparent_name.eq_ignore_ascii_case("usr")
				|| grandparent_name.eq_ignore_ascii_case("mingw64")
				|| grandparent_name.eq_ignore_ascii_case("mingw32")
			{
				return grandparent.parent().map(Path::to_path_buf);
			}
		}
		return Some(grandparent.to_path_buf());
	}

	parent.parent().map(Path::to_path_buf)
}

fn git_paths_for_install_root(install_root: &str) -> Vec<String> {
	let root = Path::new(install_root);
	let mut paths = Vec::new();

	let cmd = root.join("cmd");
	if has_git_command(&cmd) {
		paths.push(cmd.to_string_lossy().into_owned());
	}

	let bin = root.join("bin");
	if has_git_command(&bin) {
		paths.push(bin.to_string_lossy().into_owned());
	}

	let usr_bin = root.join("usr").join("bin");
	if has_git_command(&usr_bin) || usr_bin.join("ls.exe").is_file() {
		paths.push(usr_bin.to_string_lossy().into_owned());
	}

	paths
}

fn has_git_command(dir: &Path) -> bool {
	if !dir.is_dir() {
		return false;
	}

	["git.exe", "git.cmd", "git.bat"]
		.iter()
		.any(|name| dir.join(name).is_file())
}

/// Translate an MSYS2/Git Bash style path entry (e.g. `/usr/bin`,
/// `/mingw64/bin`, `/c/Users/foo`) into a Windows-native path so that
/// `std::path` based executable lookups in brush-core can resolve binaries
/// shipped with Git Bash. Returns `None` when the segment is already a
/// Windows-style path or cannot be translated.
fn translate_msys_segment(segment: &str, install_roots: &[PathBuf]) -> Option<String> {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() || is_windows_style_path(trimmed) {
		return None;
	}

	let forward = trimmed.replace('\\', "/");
	if !forward.starts_with('/') {
		return None;
	}

	// MSYS drive-letter mapping: /c -> C:\, /c/Users/foo -> C:\Users\foo.
	let rest = &forward[1..];
	if let Some((head, tail)) = rest.split_once('/') {
		if is_drive_letter(head) {
			let drive = head.to_ascii_uppercase();
			let windows_tail = tail.replace('/', "\\");
			return Some(format!("{drive}:\\{windows_tail}"));
		}
	} else if is_drive_letter(rest) {
		return Some(format!("{}:\\", rest.to_ascii_uppercase()));
	}

	// Anchor the remainder against any known Git/MSYS install root.
	let relative = rest.replace('/', "\\");
	for root in install_roots {
		let candidate = root.join(&relative);
		if candidate.is_dir() {
			return Some(candidate.to_string_lossy().into_owned());
		}
	}

	None
}

fn is_drive_letter(value: &str) -> bool {
	value.len() == 1
		&& value
			.chars()
			.next()
			.is_some_and(|c| c.is_ascii_alphabetic())
}

fn is_windows_style_path(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		return true;
	}
	value.starts_with("\\\\")
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	fn git_install_fixture() -> tempfile::TempDir {
		let root = tempfile::tempdir().expect("Git installation fixture");
		let cmd = root.path().join("cmd");
		let bin = root.path().join("bin");
		let usr_bin = root.path().join("usr").join("bin");
		for path in [&cmd, &bin, &usr_bin] {
			fs::create_dir_all(path).expect("Git path fixture");
		}
		fs::write(cmd.join("git.exe"), []).expect("cmd Git fixture");
		fs::write(bin.join("git.exe"), []).expect("bin Git fixture");
		fs::write(usr_bin.join("ls.exe"), []).expect("usr/bin fixture");
		root
	}

	#[tokio::test]
	async fn git_discovery_uses_each_sessions_executable_path() {
		let roots = [git_install_fixture(), git_install_fixture()];
		for root in &roots {
			let mut shell = BrushShell::builder()
				.do_not_inherit_env(true)
				.profile(brush_core::ProfileLoadBehavior::Skip)
				.rc(brush_core::RcLoadBehavior::Skip)
				.build()
				.await
				.expect("shell fixture");
			let cmd = root.path().join("cmd");
			let mut var = ShellVariable::new(ShellValue::String(cmd.to_string_lossy().into_owned()));
			var.export();
			shell
				.env_mut()
				.set_global("PATH", var)
				.expect("session PATH");

			configure_windows_path(&mut shell)
				.await
				.expect("configure PATH");

			let configured = shell
				.env()
				.get_str("PATH", &shell)
				.expect("configured PATH");
			let paths: Vec<_> = env::split_paths(configured.as_ref()).collect();
			assert_eq!(paths.first(), Some(&cmd));
			assert!(paths.contains(&root.path().join("usr/bin")));
		}
	}

	#[test]
	fn git_discovery_preserves_provider_and_candidate_order() {
		let registry_root = git_install_fixture();
		let path_root = git_install_fixture();
		let registry_path = registry_root.path().to_string_lossy().into_owned();
		let path_path = path_root.path().to_string_lossy().into_owned();

		let discovery = discover_git_with(|| Some(registry_path), || Some(path_path));

		assert_eq!(discovery.install_roots, vec![
			registry_root.path().to_path_buf(),
			path_root.path().to_path_buf()
		]);
		assert_eq!(discovery.paths, vec![
			registry_root
				.path()
				.join("cmd")
				.to_string_lossy()
				.into_owned(),
			registry_root
				.path()
				.join("bin")
				.to_string_lossy()
				.into_owned(),
			registry_root
				.path()
				.join("usr")
				.join("bin")
				.to_string_lossy()
				.into_owned(),
			path_root.path().join("cmd").to_string_lossy().into_owned(),
			path_root.path().join("bin").to_string_lossy().into_owned(),
			path_root
				.path()
				.join("usr")
				.join("bin")
				.to_string_lossy()
				.into_owned(),
		]);
	}

	#[test]
	fn git_discovery_deduplicates_the_same_installation_from_both_sources() {
		let root = git_install_fixture();
		let registry_path = root.path().to_string_lossy().into_owned();
		let path_path = registry_path.clone();

		let discovery = discover_git_with(|| Some(registry_path), || Some(path_path));

		assert_eq!(discovery.install_roots, vec![root.path().to_path_buf()]);
		assert_eq!(discovery.paths, vec![
			root.path().join("cmd").to_string_lossy().into_owned(),
			root.path().join("bin").to_string_lossy().into_owned(),
			root
				.path()
				.join("usr")
				.join("bin")
				.to_string_lossy()
				.into_owned(),
		]);
	}

	#[test]
	fn git_discovery_keeps_valid_candidates_when_duplicate_root_spellings_differ() {
		let root = git_install_fixture();
		let clean_path = root.path().to_string_lossy().into_owned();
		let decorated_path = format!("  \"{clean_path}\"  ");

		let discovery = discover_git_with(|| Some(decorated_path), || Some(clean_path));

		assert_eq!(discovery.paths, vec![
			root.path().join("cmd").to_string_lossy().into_owned(),
			root.path().join("bin").to_string_lossy().into_owned(),
			root
				.path()
				.join("usr")
				.join("bin")
				.to_string_lossy()
				.into_owned(),
		]);
	}

	#[test]
	fn drive_letter_segments_translate_to_windows_paths() {
		assert_eq!(translate_msys_segment("/c/Users/foo", &[]).as_deref(), Some("C:\\Users\\foo"),);
		assert_eq!(translate_msys_segment("/d", &[]).as_deref(), Some("D:\\"),);
	}

	#[test]
	fn windows_style_segments_are_left_alone() {
		assert_eq!(translate_msys_segment("C:\\Windows\\System32", &[]), None);
		assert_eq!(translate_msys_segment("\\\\server\\share", &[]), None);
		assert_eq!(translate_msys_segment("relative\\path", &[]), None);
	}

	#[test]
	fn is_drive_letter_only_matches_single_alphabetic_chars() {
		assert!(is_drive_letter("c"));
		assert!(is_drive_letter("Z"));
		assert!(!is_drive_letter(""));
		assert!(!is_drive_letter("cc"));
		assert!(!is_drive_letter("1"));
	}
}

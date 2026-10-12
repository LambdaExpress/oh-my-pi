//! `rmdir` builtin: remove empty directories through the shell filesystem.

use std::{ffi::OsString, io::{ErrorKind, Write}, path::Path};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::Parser;
use pi_vfs::{is_virtual_path, parent_path};
use uucore::display::Quotable;

use crate::host::{Host, Utility, util};

/// Parsed `rmdir` invocation.
#[derive(Debug, Parser)]
#[command(
	name = "rmdir",
	version,
	about = "Remove the given empty DIRECTORY(ies)",
	infer_long_args = true
)]
pub(crate) struct Rmdir {
	/// Remove DIRECTORY and its ancestors after each successful removal.
	#[arg(short = 'p', long = "parents")]
	parents: bool,
	/// Print a diagnostic for each directory processed.
	#[arg(short = 'v', long = "verbose")]
	verbose: bool,
	/// Ignore failures caused only by a directory not being empty.
	#[arg(long = "ignore-fail-on-non-empty")]
	ignore_non_empty: bool,
	/// Empty directories to remove.
	#[arg(value_name = "DIRECTORY", required = true)]
	directories: Vec<OsString>,
}

impl Utility for Rmdir {
	const NAME: &'static str = "rmdir";

	fn run(self, host: &mut Host) -> i32 {
		for directory in &self.directories {
			if directory.is_empty() {
				host.error("failed to remove '': No such file or directory", 1);
				continue;
			}
			let mut current = Path::new(directory);
			loop {
				if host.is_cancelled() {
					return 130;
				}
				if self.verbose {
					let _ = writeln!(host.stdout, "rmdir: removing directory, {}", current.quote());
				}
				let resolved = host.resolve(current);
				if let Err(error) = host.fs().remove_dir(&resolved) {
					if !(self.ignore_non_empty
						&& matches!(error.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::AlreadyExists))
					{
						host.error(format!("failed to remove {}: {error}", current.quote()), 1);
					}
					break;
				}
				if !self.parents {
					break;
				}
				let Some(parent) = parent_path(current) else {
					break;
				};
				// A URL mount is not a host ancestor. In particular, Path::parent
				// would turn local://dir into the unrelated native directory local:.
				if parent.as_os_str().is_empty()
					|| (is_virtual_path(parent) && parent_path(parent).is_none())
				{
					break;
				}
				current = parent;
			}
		}
		host.exit_code()
	}
}

/// Creates the `rmdir` builtin registration.
pub(crate) fn rmdir_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rmdir, SE>()
}

#[cfg(test)]
mod tests {
	use super::Rmdir;
	use crate::host::run_util;

	#[test]
	fn parents_removes_nested_empty_directories_but_not_the_working_directory() {
		let cwd = tempfile::tempdir().unwrap();
		std::fs::create_dir_all(cwd.path().join("a/b/c")).unwrap();
		let (code, capture) = run_util::<Rmdir>(&["-p", "a/b/c"], "", cwd.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert!(!cwd.path().join("a").exists());
		assert!(cwd.path().is_dir());
	}

	#[test]
	fn nonempty_failure_preserves_contents_and_does_not_skip_later_operands() {
		let cwd = tempfile::tempdir().unwrap();
		std::fs::create_dir(cwd.path().join("full")).unwrap();
		std::fs::write(cwd.path().join("full/kept"), "kept").unwrap();
		std::fs::create_dir(cwd.path().join("empty")).unwrap();
		let (code, _) = run_util::<Rmdir>(&["full", "empty"], "", cwd.path());
		assert_eq!(code, 1);
		assert_eq!(std::fs::read_to_string(cwd.path().join("full/kept")).unwrap(), "kept");
		assert!(!cwd.path().join("empty").exists());
	}

	#[test]
	fn ignores_only_nonempty_failures() {
		let cwd = tempfile::tempdir().unwrap();
		std::fs::create_dir(cwd.path().join("full")).unwrap();
		std::fs::write(cwd.path().join("full/kept"), "kept").unwrap();
		let (code, capture) = run_util::<Rmdir>(&["--ignore-fail-on-non-empty", "full"], "", cwd.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert!(cwd.path().join("full/kept").is_file());
		let (code, _) = run_util::<Rmdir>(&["--ignore-fail-on-non-empty", "missing"], "", cwd.path());
		assert_eq!(code, 1);
	}

	#[test]
	fn empty_operand_does_not_remove_the_working_directory() {
		let cwd = tempfile::tempdir().unwrap();
		let (code, _) = run_util::<Rmdir>(&[""], "", cwd.path());
		assert_eq!(code, 1);
		assert!(cwd.path().is_dir());
	}
}

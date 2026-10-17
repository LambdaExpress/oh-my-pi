//! `rmdir` builtin: remove empty directories.
//!
//! Diagnostics: `failed to remove directory` for ancestors, the
//! `Symbolic link not followed` hint, permission errors ignored on non-empty
//! directories under `--ignore-fail-on-non-empty`).

use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::{Component, Path},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use pi_vfs::{is_virtual_path, parent_path};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

mod options {
	pub const IGNORE_FAIL_NON_EMPTY: &str = "ignore-fail-on-non-empty";
	pub const PARENTS: &str = "parents";
	pub const VERBOSE: &str = "verbose";
	pub const DIRS: &str = "dirs";
}

/// Parsed `rmdir` invocation.
pub(crate) struct Rmdir {
	matches: ArgMatches,
}

matches_parser!(Rmdir, app);

struct Opts {
	ignore: bool,
	parents: bool,
	verbose: bool,
}

impl Utility for Rmdir {
	const NAME: &'static str = "rmdir";

	fn run(self, host: &mut Host) -> i32 {
		let opts = Opts {
			ignore: self.matches.get_flag(options::IGNORE_FAIL_NON_EMPTY),
			parents: self.matches.get_flag(options::PARENTS),
			verbose: self.matches.get_flag(options::VERBOSE),
		};
		let dirs: Vec<OsString> = self
			.matches
			.get_many::<OsString>(options::DIRS)
			.unwrap_or_default()
			.cloned()
			.collect();
		for dir in &dirs {
			if host.is_cancelled() {
				return 130;
			}
			remove_operand(host, dir, &opts);
		}
		host.exit_code()
	}
}

pub(crate) fn rmdir_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rmdir, SE>()
}

fn app() -> Command {
	Command::new(Rmdir::NAME)
		.version("0.8.0")
		.about("Remove the DIRECTORY(ies), if they are empty.")
		.override_usage(format_usage("rmdir [OPTION]... DIRECTORY..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::IGNORE_FAIL_NON_EMPTY)
				.long(options::IGNORE_FAIL_NON_EMPTY)
				.help("ignore each failure to remove a non-empty directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PARENTS)
				.short('p')
				.long(options::PARENTS)
				.help(
					"remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b' is similar to 'rmdir a/b \
					 a'",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("output a diagnostic for every directory processed")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRS)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::DirPath),
		)
}

/// GNU `errno_rmdir_non_empty`: ENOTEMPTY or EEXIST.
fn is_non_empty_error(error: &io::Error) -> bool {
	matches!(error.kind(), io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists)
}

/// GNU `errno_may_be_non_empty`: EACCES, EPERM, EROFS, EBUSY.
fn may_be_non_empty_error(error: &io::Error) -> bool {
	matches!(
		error.kind(),
		io::ErrorKind::PermissionDenied
			| io::ErrorKind::ReadOnlyFilesystem
			| io::ErrorKind::ResourceBusy
	)
}

/// GNU `ignorable_failure`.
fn ignorable(host: &Host, opts: &Opts, error: &io::Error, dir: &OsStr) -> bool {
	opts.ignore
		&& (is_non_empty_error(error)
			|| (may_be_non_empty_error(error) && directory_non_empty(host, dir)))
}

/// Whether `dir` is a readable directory holding at least one entry.
fn directory_non_empty(host: &Host, dir: &OsStr) -> bool {
	host.fs()
		.read_dir(host.resolve(dir))
		.is_ok_and(|mut entries| entries.next().is_some())
}

fn verbose(host: &mut Host, dir: &OsStr) {
	let _ = writeln!(host.stdout, "rmdir: removing directory, {}", Path::new(dir).quote());
}

fn rmdir(host: &Host, dir: &OsStr) -> io::Result<()> {
	let path = Path::new(dir);
	let bytes = dir.as_encoded_bytes();
	let bytes = match path.components().next() {
		Some(Component::Prefix(prefix)) => &bytes[prefix.as_os_str().len()..],
		_ => bytes,
	};
	let virtual_path = is_virtual_path(path);
	if bytes
		.rsplit(|&byte| byte == b'/' || (!virtual_path && is_path_separator(byte)))
		.find(|component| !component.is_empty())
		== Some(b".".as_slice())
	{
		// Windows normalizes a final `.` before RemoveDirectory sees it.
		// Refuse it lexically for both operands and -p ancestors, before it
		// can remove the containing directory (including the shell's cwd).
		// Still resolve the operand first so missing/non-directory parents
		// retain their errors rather than becoming an invalid-dot error.
		if !host.fs().metadata(host.resolve(dir))?.is_dir() {
			return Err(io::Error::new(io::ErrorKind::NotADirectory, "Not a directory"));
		}
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid argument"));
	}
	host.fs().remove_dir(host.resolve(dir))
}

fn remove_operand(host: &mut Host, dir: &OsStr, opts: &Opts) {
	if dir.is_empty() {
		host.error("failed to remove '': No such file or directory", 1);
		return;
	}
	if opts.verbose {
		verbose(host, dir);
	}
	let Err(error) = rmdir(host, dir) else {
		if opts.parents {
			remove_parents(host, dir, opts);
		}
		return;
	};
	if ignorable(host, opts, &error, dir) {
		return;
	}
	let quoted = Path::new(dir).quote();
	if error.kind() == io::ErrorKind::NotADirectory && symlink_with_trailing_slash(host, dir) {
		host.error(format_args!("failed to remove {quoted}: Symbolic link not followed"), 1);
	} else {
		host.error(format_args!("failed to remove {quoted}: {}", strip_errno(&error)), 1);
	}
}

/// GNU's diagnosis of `rmdir symlink/` failing with ENOTDIR (Linux): the
/// operand ends in `/`, names a directory (or can't be followed for another
/// reason), and its last component is a symlink.
fn symlink_with_trailing_slash(host: &Host, dir: &OsStr) -> bool {
	let bytes = dir.as_encoded_bytes();
	if !bytes.last().is_some_and(|&byte| is_path_separator(byte)) {
		return false;
	}
	match host.fs().metadata(host.resolve(dir)) {
		Ok(meta) if !meta.is_dir() => return false,
		Err(error) if error.kind() == io::ErrorKind::NotADirectory => return false,
		_ => {},
	}
	let stripped = strip_trailing_slashes(bytes);
	// SAFETY: `stripped` ends before an ASCII path separator.
	let stripped = unsafe { OsStr::from_encoded_bytes_unchecked(stripped) };
	host.fs()
		.symlink_metadata(host.resolve(stripped))
		.is_ok_and(|meta| meta.is_symlink())
}

const fn is_path_separator(byte: u8) -> bool {
	byte == b'/' || (cfg!(windows) && byte == b'\\')
}

/// GNU `strip_trailing_slashes`: drops trailing separators but keeps a lone root.
fn strip_trailing_slashes(bytes: &[u8]) -> &[u8] {
	let mut end = bytes.len();
	while end > 1 && is_path_separator(bytes[end - 1]) {
		end -= 1;
	}
	&bytes[..end]
}

/// GNU `remove_parents`: removes each ancestor named in `dir`, stopping at the
/// first failure.
fn remove_parents(host: &mut Host, dir: &OsStr, opts: &Opts) {
	let mut current = Path::new(dir);
	loop {
		if host.is_cancelled() {
			host.fail(130);
			return;
		}
		let parent = if is_virtual_path(current) {
			parent_path(current)
		} else {
			// Keep native operand spelling, including a trailing `/.` ancestor
			// that must fail rather than silently becoming its containing directory.
			let bytes = strip_trailing_slashes(current.as_os_str().as_encoded_bytes());
			bytes
				.iter()
				.rposition(|&byte| is_path_separator(byte))
				.and_then(|mut slash| {
					while slash > 0 && is_path_separator(bytes[slash]) {
						slash -= 1;
					}
					// SAFETY: this prefix ends at an ASCII separator boundary.
					let parent =
						Path::new(unsafe { OsStr::from_encoded_bytes_unchecked(&bytes[..=slash]) });
					if cfg!(windows) && current.has_root() && !parent.has_root() {
						// A drive root stays `C:\`, never the drive-relative `C:`.
						current.parent()
					} else {
						Some(parent)
					}
				})
		};
		let Some(parent) = parent else {
			return;
		};
		// URL mount roots are not host ancestors; in particular, do not walk
		// from local://dir into the unrelated native directory local:.
		if parent.as_os_str().is_empty()
			|| (is_virtual_path(parent) && parent_path(parent).is_none())
		{
			return;
		}
		current = parent;
		let parent = parent.as_os_str();
		if opts.verbose {
			verbose(host, parent);
		}
		if let Err(error) = rmdir(host, parent) {
			if !ignorable(host, opts, &error, parent) {
				host.error(
					format_args!(
						"failed to remove directory {}: {}",
						Path::new(parent).quote(),
						strip_errno(&error)
					),
					1,
				);
			}
			return;
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::*;
	use crate::host::run_util;

	fn run(cwd: &Path, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Rmdir>(args, "", cwd.to_path_buf());
		(code, capture.out(), capture.err())
	}

	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[test]
	fn removes_empty_dir_relative_to_host_cwd() {
		let (_d, root) = tempdir();
		fs::create_dir(root.join("e")).unwrap();
		assert_eq!(run(&root, &["e"]), (0, String::new(), String::new()));
		assert!(!root.join("e").exists());
	}

	#[test]
	fn non_empty_fails_unless_ignored() {
		let (_d, root) = tempdir();
		fs::create_dir_all(root.join("n/x")).unwrap();
		fs::write(root.join("n/kept"), "kept").unwrap();
		let (code, stdout, _) = run(&root, &["n"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(
			run(&root, &["--ignore-fail-on-non-empty", "n"]),
			(0, String::new(), String::new())
		);
		assert!(root.join("n/x").exists());
		assert_eq!(fs::read_to_string(root.join("n/kept")).unwrap(), "kept");
		let (code, _, _) = run(&root, &["--ignore-fail-on-non-empty", "missing"]);
		assert_eq!(code, 1);
	}

	#[test]
	fn parents_removes_every_ancestor() {
		let (_d, root) = tempdir();
		fs::create_dir_all(root.join("a/b/c")).unwrap();
		assert_eq!(run(&root, &["-p", "a//b/c/"]), (0, String::new(), String::new()));
		assert!(!root.join("a").exists());
		assert!(root.is_dir());
	}

	#[test]
	fn parents_verbose_stops_at_non_empty_ancestor() {
		let (_d, root) = tempdir();
		fs::create_dir_all(root.join("p/q/r")).unwrap();
		fs::create_dir(root.join("p/s")).unwrap();
		let (code, stdout, _) = run(&root, &["-pv", "p/q/r"]);
		assert_eq!(code, 1);
		let processed: Vec<_> = stdout
			.lines()
			.map(|line| line.rsplit_once(", ").unwrap().1)
			.collect();
		assert_eq!(processed, ["'p/q/r'", "'p/q'", "'p'"]);
		assert!(!root.join("p/q").exists());
		assert!(root.join("p/s").is_dir());
		fs::create_dir_all(root.join("p/q")).unwrap();
		assert_eq!(
			run(&root, &["-p", "--ignore-fail-on-non-empty", "p/q"]),
			(0, String::new(), String::new())
		);
		assert!(!root.join("p/q").exists());
		assert!(root.join("p/s").is_dir());
	}

	#[test]
	fn missing_and_file_operands_continue() {
		let (_d, root) = tempdir();
		fs::write(root.join("f"), "").unwrap();
		fs::create_dir(root.join("e")).unwrap();
		let (code, stdout, _) = run(&root, &["x", "f", "e"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(fs::read_to_string(root.join("f")).unwrap(), "");
		assert!(!root.join("e").exists());
	}

	#[test]
	fn nonempty_failure_preserves_contents_and_does_not_skip_later_operands() {
		let (_d, root) = tempdir();
		fs::create_dir(root.join("full")).unwrap();
		fs::write(root.join("full/kept"), "kept").unwrap();
		fs::create_dir(root.join("empty")).unwrap();
		let (code, _, _) = run(&root, &["full", "empty"]);
		assert_eq!(code, 1);
		assert_eq!(fs::read_to_string(root.join("full/kept")).unwrap(), "kept");
		assert!(!root.join("empty").exists());
	}

	#[test]
	fn empty_operand_does_not_remove_the_working_directory() {
		let (_d, root) = tempdir();
		let (code, _, _) = run(&root, &[""]);
		assert_eq!(code, 1);
		assert!(root.is_dir());
	}

	#[cfg(unix)]
	#[test]
	fn symlink_without_slash_is_not_a_directory() {
		let (_d, root) = tempdir();
		fs::create_dir(root.join("d")).unwrap();
		std::os::unix::fs::symlink("d", root.join("l")).unwrap();
		let (code, stdout, _) = run(&root, &["l"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(root.join("d").is_dir());
		assert!(fs::symlink_metadata(root.join("l")).unwrap().file_type().is_symlink());
	}

	/// Linux refuses `rmdir("l/")` with ENOTDIR and GNU explains why; macOS
	/// removes the target directory.
	#[cfg(unix)]
	#[test]
	fn symlink_with_trailing_slash_follows_platform() {
		let (_d, root) = tempdir();
		fs::create_dir(root.join("d")).unwrap();
		std::os::unix::fs::symlink("d", root.join("l")).unwrap();
		let result = run(&root, &["l/"]);
		if cfg!(target_os = "linux") {
			assert_eq!(result.0, 1);
			assert_eq!(result.1, "");
			assert!(root.join("d").is_dir());
		} else {
			assert_eq!(result, (0, String::new(), String::new()));
			assert!(!root.join("d").exists());
		}
		assert!(fs::symlink_metadata(root.join("l")).unwrap().file_type().is_symlink());
	}

	#[test]
	fn dot_operand_is_invalid() {
		let (_d, root) = tempdir();
		for operand in [".", "./", ".//"] {
			let (code, stdout, _) = run(&root, &[operand]);
			assert_eq!(code, 1, "{operand}");
			assert_eq!(stdout, "");
			assert!(root.is_dir());
		}
		fs::create_dir(root.join("e")).unwrap();
		for operand in ["e/.", "e//.///"] {
			let (code, stdout, _) = run(&root, &[operand]);
			assert_eq!(code, 1, "{operand}");
			assert_eq!(stdout, "");
			assert!(root.join("e").is_dir());
		}
		#[cfg(windows)]
		for operand in [r".\", r"e\.", r"e\\.\//"] {
			let (code, _, _) = run(&root, &[operand]);
			assert_eq!(code, 1, "{operand}");
			assert!(root.is_dir());
			assert!(root.join("e").is_dir());
		}
		let (code, _, _) = run(&root, &["--ignore-fail-on-non-empty", "."]);
		assert_eq!(code, 1);
		assert!(root.is_dir());

		let (code, _, stderr) = run(&root, &["missing/."]);
		assert_eq!(code, 1);
		assert!(stderr.contains("'missing/.'"));
		fs::write(root.join("file"), "kept").unwrap();
		let (code, _, stderr) = run(&root, &["file/."]);
		assert_eq!(code, 1);
		assert!(stderr.contains("'file/.'"));
		assert_eq!(fs::read_to_string(root.join("file")).unwrap(), "kept");

		fs::create_dir(root.join("e/child")).unwrap();
		let (code, stdout, stderr) = run(&root, &["-pv", "e/./child"]);
		assert_eq!(code, 1);
		let processed: Vec<_> = stdout
			.lines()
			.map(|line| line.rsplit_once(", ").unwrap().1)
			.collect();
		assert_eq!(processed, ["'e/./child'", "'e/.'"]);
		assert!(stderr.contains("'e/.'"));
		assert!(!root.join("e/child").exists());
		assert!(root.join("e").is_dir());

		fs::create_dir(root.join("later")).unwrap();
		let (code, _, _) = run(&root, &[".", "later"]);
		assert_eq!(code, 1);
		assert!(root.is_dir());
		assert!(!root.join("later").exists());
	}
}

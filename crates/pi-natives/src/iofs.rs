//! N-API filesystem DTOs and conversion helpers.
//!
//! `pi-walker` owns traversal and cache policy. This module keeps only the
//! JavaScript-facing shapes plus conversions between walker entries and N-API
//! payloads.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::js;

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File    = 1,
	/// Directory.
	Dir     = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path:      String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files.
	pub size:      Option<f64>,
}

fn walker_error_to_napi<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	match err {
		pi_walker::WalkError::Interrupted(err) => Error::from_reason(err.to_string()),
		pi_walker::WalkError::InvalidData { path, message } => Error::from_reason(format!(
			"Native directory scan failed for {}: {message}",
			path.display()
		)),
	}
}

pub(crate) const fn from_walker_file_type(file_type: pi_walker::FileType) -> FileType {
	match file_type {
		pi_walker::FileType::File => FileType::File,
		pi_walker::FileType::Dir => FileType::Dir,
		pi_walker::FileType::Symlink => FileType::Symlink,
	}
}

impl From<pi_walker::CollectedEntry> for GlobMatch {
	fn from(entry: pi_walker::CollectedEntry) -> Self {
		Self {
			path:      entry.path,
			file_type: from_walker_file_type(entry.file_type),
			mtime:     entry.mtime,
			size:      entry.size,
		}
	}
}

/// Converts a native walker error into an N-API error.
pub(crate) fn map_walker_error<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	walker_error_to_napi(err)
}

/// Invalidate the walker scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations: write, edit, rename, or
/// delete.
#[napi]
pub fn invalidate_fs_scan_cache(path: Option<JsString>) -> Result<()> {
	match path {
		Some(path) => pi_walker::invalidate_path_string(&js::utf8(path)?),
		None => pi_walker::invalidate_all(),
	}
	Ok(())
}

fn staged_commit_error(message: impl Into<String>) -> Error {
	Error::from_reason(message.into())
}

fn validate_staged_paths(
	stage_path: &std::path::Path,
	destination_path: &std::path::Path,
) -> Result<()> {
	let stage_metadata = std::fs::symlink_metadata(stage_path).map_err(|err| {
		staged_commit_error(format!("Cannot inspect staged file {}: {err}", stage_path.display()))
	})?;
	if !stage_metadata.file_type().is_file() {
		return Err(staged_commit_error(format!(
			"Staged path must be a regular file: {}",
			stage_path.display()
		)));
	}
	if stage_path.parent() != destination_path.parent() {
		return Err(staged_commit_error("Staged file and destination must be in the same directory"));
	}
	Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn old_destination_is_replaceable(path: &std::path::Path) -> std::io::Result<bool> {
	let metadata = std::fs::symlink_metadata(path)?;
	Ok(metadata.file_type().is_file() || metadata.file_type().is_symlink())
}

#[cfg(target_os = "linux")]
mod staged_commit_platform {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt, path::Path};

	const RENAME_NOREPLACE: libc::c_uint = 1;
	const RENAME_EXCHANGE: libc::c_uint = 2;

	fn renameat2(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
		let from = CString::new(from.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged path contains NUL"))?;
		let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
			io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
		})?;
		// SAFETY: Both path pointers remain valid for the duration of the syscall.
		let result = unsafe {
			libc::syscall(
				libc::SYS_renameat2,
				libc::AT_FDCWD,
				from.as_ptr(),
				libc::AT_FDCWD,
				to.as_ptr(),
				flags,
			)
		};
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
			return Err(io::Error::new(
				io::ErrorKind::Unsupported,
				format!("renameat2 is unavailable: {error}"),
			));
		}
		Err(error)
	}

	fn exchange_and_validate(stage_path: &Path, destination_path: &Path) -> io::Result<()> {
		renameat2(stage_path, destination_path, RENAME_EXCHANGE)?;
		let replaceable = super::old_destination_is_replaceable(stage_path);
		match replaceable {
			Ok(true) => {
				if let Err(remove_error) = std::fs::remove_file(stage_path) {
					let rollback = renameat2(stage_path, destination_path, RENAME_EXCHANGE);
					return match rollback {
						Ok(()) => Err(io::Error::new(
							remove_error.kind(),
							format!(
								"cannot remove replaced destination; commit rolled back: {remove_error}"
							),
						)),
						Err(rollback_error) => Err(io::Error::other(format!(
							"cannot remove replaced destination ({remove_error}); rollback also failed \
							 ({rollback_error})"
						))),
					};
				}
				Ok(())
			},
			Ok(false) => {
				renameat2(stage_path, destination_path, RENAME_EXCHANGE).map_err(|rollback_error| {
					io::Error::other(format!(
						"destination changed to a directory or special file; rollback failed: \
						 {rollback_error}"
					))
				})?;
				Err(io::Error::other("destination is a directory or special file; commit rolled back"))
			},
			Err(inspect_error) => {
				renameat2(stage_path, destination_path, RENAME_EXCHANGE).map_err(|rollback_error| {
					io::Error::other(format!(
						"cannot inspect replaced destination ({inspect_error}); rollback failed: \
						 {rollback_error}"
					))
				})?;
				Err(io::Error::other(format!(
					"cannot inspect replaced destination; commit rolled back: {inspect_error}"
				)))
			},
		}
	}

	pub(super) fn commit(
		stage_path: &Path,
		destination_path: &Path,
		overwrite: bool,
	) -> io::Result<()> {
		if !overwrite {
			return renameat2(stage_path, destination_path, RENAME_NOREPLACE);
		}
		match std::fs::symlink_metadata(destination_path) {
			Ok(_) => exchange_and_validate(stage_path, destination_path),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				renameat2(stage_path, destination_path, RENAME_NOREPLACE)
			},
			Err(error) => Err(error),
		}
	}
}

#[cfg(target_os = "macos")]
mod staged_commit_platform {
	use std::{
		ffi::{CString, c_char, c_int},
		io,
		os::unix::ffi::OsStrExt,
		path::Path,
	};

	const RENAME_EXCL: u32 = 0x0000_0004;
	const RENAME_SWAP: u32 = 0x0000_0002;

	unsafe extern "C" {
		fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> c_int;
	}

	fn renamex(from: &Path, to: &Path, flags: u32) -> io::Result<()> {
		let from = CString::new(from.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "staged path contains NUL"))?;
		let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
			io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
		})?;
		// SAFETY: Both path pointers remain valid for the duration of renamex_np.
		if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), flags) } == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL)) {
			return Err(io::Error::new(
				io::ErrorKind::Unsupported,
				format!("renamex_np is unavailable: {error}"),
			));
		}
		Err(error)
	}

	fn exchange_and_validate(stage_path: &Path, destination_path: &Path) -> io::Result<()> {
		renamex(stage_path, destination_path, RENAME_SWAP)?;
		let replaceable = super::old_destination_is_replaceable(stage_path);
		match replaceable {
			Ok(true) => {
				if let Err(remove_error) = std::fs::remove_file(stage_path) {
					let rollback = renamex(stage_path, destination_path, RENAME_SWAP);
					return match rollback {
						Ok(()) => Err(io::Error::new(
							remove_error.kind(),
							format!(
								"cannot remove replaced destination; commit rolled back: {remove_error}"
							),
						)),
						Err(rollback_error) => Err(io::Error::other(format!(
							"cannot remove replaced destination ({remove_error}); rollback also failed \
							 ({rollback_error})"
						))),
					};
				}
				Ok(())
			},
			Ok(false) => {
				renamex(stage_path, destination_path, RENAME_SWAP).map_err(|rollback_error| {
					io::Error::other(format!(
						"destination changed to a directory or special file; rollback failed: \
						 {rollback_error}"
					))
				})?;
				Err(io::Error::other("destination is a directory or special file; commit rolled back"))
			},
			Err(inspect_error) => {
				renamex(stage_path, destination_path, RENAME_SWAP).map_err(|rollback_error| {
					io::Error::other(format!(
						"cannot inspect replaced destination ({inspect_error}); rollback failed: \
						 {rollback_error}"
					))
				})?;
				Err(io::Error::other(format!(
					"cannot inspect replaced destination; commit rolled back: {inspect_error}"
				)))
			},
		}
	}

	pub(super) fn commit(
		stage_path: &Path,
		destination_path: &Path,
		overwrite: bool,
	) -> io::Result<()> {
		if !overwrite {
			return renamex(stage_path, destination_path, RENAME_EXCL);
		}
		match std::fs::symlink_metadata(destination_path) {
			Ok(_) => exchange_and_validate(stage_path, destination_path),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				renamex(stage_path, destination_path, RENAME_EXCL)
			},
			Err(error) => Err(error),
		}
	}
}

#[cfg(windows)]
mod staged_commit_platform {
	use std::{
		io,
		os::windows::{ffi::OsStrExt, fs::MetadataExt},
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, MOVEFILE_REPLACE_EXISTING,
		MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
	};

	static BACKUP_COUNTER: AtomicU64 = AtomicU64::new(0);

	fn wide(path: &Path) -> Vec<u16> {
		path
			.as_os_str()
			.encode_wide()
			.chain(std::iter::once(0))
			.collect()
	}

	fn move_file(stage_path: &Path, destination_path: &Path, replace: bool) -> io::Result<()> {
		let flags = MOVEFILE_WRITE_THROUGH
			| if replace {
				MOVEFILE_REPLACE_EXISTING
			} else {
				0
			};
		// SAFETY: The NUL-terminated UTF-16 buffers remain valid for the duration of
		// MoveFileExW.
		if unsafe { MoveFileExW(wide(stage_path).as_ptr(), wide(destination_path).as_ptr(), flags) }
			!= 0
		{
			return Ok(());
		}
		Err(io::Error::last_os_error())
	}

	fn backup_path(stage_path: &Path) -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_nanos();
		let counter = BACKUP_COUNTER.fetch_add(1, Ordering::Relaxed);
		stage_path
			.with_file_name(format!(".omp-transfer-backup-{}-{suffix}-{counter}", std::process::id()))
	}

	fn replace_regular_file(stage_path: &Path, destination_path: &Path) -> io::Result<()> {
		let backup_path = backup_path(stage_path);
		// SAFETY: All NUL-terminated UTF-16 buffers remain valid for the duration of
		// ReplaceFileW.
		if unsafe {
			ReplaceFileW(
				wide(destination_path).as_ptr(),
				wide(stage_path).as_ptr(),
				wide(&backup_path).as_ptr(),
				REPLACEFILE_WRITE_THROUGH,
				std::ptr::null(),
				std::ptr::null(),
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}

		let backup_metadata = std::fs::symlink_metadata(&backup_path);
		let replaceable = backup_metadata.as_ref().is_ok_and(|metadata| {
			let attributes = metadata.file_attributes();
			metadata.file_type().is_file() || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
		});
		if replaceable {
			if let Err(remove_error) = std::fs::remove_file(&backup_path) {
				// Preserve both old destination and staged content by using the staged path as
				// rollback backup. SAFETY: All NUL-terminated UTF-16 buffers remain valid
				// for the duration of ReplaceFileW.
				let rollback = unsafe {
					ReplaceFileW(
						wide(destination_path).as_ptr(),
						wide(&backup_path).as_ptr(),
						wide(stage_path).as_ptr(),
						REPLACEFILE_WRITE_THROUGH,
						std::ptr::null(),
						std::ptr::null(),
					)
				};
				return if rollback != 0 {
					Err(io::Error::new(
						remove_error.kind(),
						format!("cannot remove replacement backup; commit rolled back: {remove_error}"),
					))
				} else {
					Err(io::Error::other(format!(
						"cannot remove replacement backup ({remove_error}); rollback also failed ({})",
						io::Error::last_os_error()
					)))
				};
			}
			return Ok(());
		}

		let inspect_error = backup_metadata.err();
		// SAFETY: All NUL-terminated UTF-16 buffers remain valid for the duration of
		// ReplaceFileW.
		let rollback = unsafe {
			ReplaceFileW(
				wide(destination_path).as_ptr(),
				wide(&backup_path).as_ptr(),
				wide(stage_path).as_ptr(),
				REPLACEFILE_WRITE_THROUGH,
				std::ptr::null(),
				std::ptr::null(),
			)
		};
		if rollback == 0 {
			return Err(io::Error::other(format!(
				"replaced destination is a directory or special file and rollback failed: {}",
				io::Error::last_os_error()
			)));
		}
		Err(io::Error::other(match inspect_error {
			Some(error) => format!("cannot inspect replaced destination; commit rolled back: {error}"),
			None => {
				"replaced destination is a directory or special file; commit rolled back".to_owned()
			},
		}))
	}

	pub(super) fn commit(
		stage_path: &Path,
		destination_path: &Path,
		overwrite: bool,
	) -> io::Result<()> {
		if !overwrite {
			return move_file(stage_path, destination_path, false);
		}
		let metadata = match std::fs::symlink_metadata(destination_path) {
			Ok(metadata) => metadata,
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				return move_file(stage_path, destination_path, false);
			},
			Err(error) => return Err(error),
		};
		let attributes = metadata.file_attributes();
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return move_file(stage_path, destination_path, true);
		}
		if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 || !metadata.file_type().is_file() {
			return Err(io::Error::other(
				"destination is a directory or special file; refusing replacement",
			));
		}
		replace_regular_file(stage_path, destination_path)
	}
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod staged_commit_platform {
	use std::{io, path::Path};

	pub(super) fn commit(
		_stage_path: &Path,
		_destination_path: &Path,
		_overwrite: bool,
	) -> io::Result<()> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"exact staged-file commit is unsupported on this platform",
		))
	}
}

/// Atomically commit a same-directory staged regular file to its destination.
///
/// No-replace mode never clobbers an existing directory entry. Overwrite mode
/// uses the platform's exact exchange/replace primitive and rolls back if the
/// displaced entry is a directory or special file. Unsupported primitives
/// leave both the destination and staged file untouched.
#[napi]
pub fn commit_staged_file_atomic(
	stage_path: String,
	destination_path: String,
	overwrite: bool,
) -> Result<()> {
	let stage_path = std::path::Path::new(&stage_path);
	let destination_path = std::path::Path::new(&destination_path);
	validate_staged_paths(stage_path, destination_path)?;
	staged_commit_platform::commit(stage_path, destination_path, overwrite).map_err(|error| {
		staged_commit_error(format!(
			"Cannot commit staged file {} to {}: {error}",
			stage_path.display(),
			destination_path.display()
		))
	})
}

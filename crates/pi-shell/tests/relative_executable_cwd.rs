//! Regression: a path-qualified command must be resolved against the shell's
//! working directory (`ShellExecuteOptions::cwd`), not the embedding process's
//! current directory.
//!
//! `cwd` is applied to the spawned child only. On Windows, `CreateProcessW`
//! resolves a *relative* executable path against the calling process's working
//! directory, so `./probe.exe` used to be looked up under the omp process's cwd
//! and reported as `command not found` (exit 127) whenever the shell's working
//! directory was a different one — whether it was set by `cwd` or merely by a
//! `cd` earlier on the command line. Unix spawns the child and execs afterwards
//! in the child's cwd, which is why the bug was Windows-only; brush now
//! resolves the path up front so both platforms agree.

use std::path::Path;

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

/// Printed by the probe executable when it runs.
const PROBE_OUTPUT: &str = "pi-relative-probe-ok";

/// A probe executable installed into the shell's working directory, with the
/// command lines that invoke it relative to that directory and absolutely.
struct Probe {
	relative: String,
	absolute: String,
}

#[cfg(unix)]
fn install_probe(dir: &Path, stem: &str) -> Probe {
	use std::os::unix::fs::PermissionsExt as _;

	let path = dir.join(stem);
	std::fs::write(&path, format!("#!/bin/sh\necho {PROBE_OUTPUT}\n")).expect("write probe script");
	std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
		.expect("mark probe executable");
	Probe { relative: format!("./{stem}"), absolute: format!("\"{}\"", path.display()) }
}

#[cfg(windows)]
fn install_probe(dir: &Path, stem: &str) -> Probe {
	// A real native executable: `CreateProcessW` cannot launch a `.cmd` batch
	// file directly. Copying the command processor keeps the probe
	// self-contained and independent of PATH.
	let source = std::env::var_os("COMSPEC")
		.map(std::path::PathBuf::from)
		.filter(|path| path.exists())
		.unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32\cmd.exe"));
	let path = dir.join(format!("{stem}.exe"));
	std::fs::copy(&source, &path).expect("copy probe executable");
	Probe {
		relative: format!("./{stem}.exe /c echo {PROBE_OUTPUT}"),
		absolute: format!("\"{}\" /c echo {PROBE_OUTPUT}", path.display()),
	}
}

/// Runs `command` with `cwd` as the shell's working directory and returns the
/// exit code plus the merged stdout/stderr transcript.
async fn run_in(cwd: &Path, command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");

	let mut output = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		output.push_str(&chunk);
	}
	(result.exit_code, output)
}

/// Creates a fresh temp dir to serve as the shell's working directory and
/// asserts it differs from the host process's cwd — the directory a relative
/// executable path used to resolve against.
///
/// The path is deliberately not canonicalized: on Windows canonicalizing yields
/// a `\\?\`-prefixed verbatim path, whose components the OS does not normalize,
/// and callers pass the logical path they typed rather than a canonical one.
fn isolated_work_dir() -> tempfile::TempDir {
	let dir = tempfile::tempdir().expect("temp dir");
	let host_cwd = std::env::current_dir().expect("host cwd");
	assert_ne!(
		std::fs::canonicalize(&host_cwd).expect("canonical host cwd"),
		std::fs::canonicalize(dir.path()).expect("canonical temp dir"),
		"the shell working directory must differ from the host process cwd",
	);
	dir
}

/// A relative, path-qualified executable living in the shell's working
/// directory must run even though the host process's cwd is elsewhere.
#[tokio::test(flavor = "multi_thread")]
async fn relative_executable_resolves_against_shell_working_dir() {
	let dir = isolated_work_dir();
	let root = dir.path();
	// Unique to this process so the probe cannot accidentally exist relative
	// to the host process's cwd (the pre-fix lookup location).
	let probe = install_probe(root, &format!("pi-relative-probe-{}", std::process::id()));

	let (exit_code, output) = run_in(root, &probe.relative).await;
	assert_eq!(exit_code, Some(0), "relative {:?} failed: {output:?}", probe.relative);
	assert!(output.contains(PROBE_OUTPUT), "missing probe output: {output:?}");
}

/// Absolute paths bypass shell-relative resolution and keep working unchanged.
#[tokio::test(flavor = "multi_thread")]
async fn absolute_executable_path_still_executes() {
	let dir = isolated_work_dir();
	let root = dir.path();
	let probe = install_probe(root, &format!("pi-absolute-probe-{}", std::process::id()));

	let (exit_code, output) = run_in(root, &probe.absolute).await;
	assert_eq!(exit_code, Some(0), "absolute {:?} failed: {output:?}", probe.absolute);
	assert!(output.contains(PROBE_OUTPUT), "missing probe output: {output:?}");
}

/// A path-qualified name that is absent under the shell's working directory
/// must keep the `command not found` diagnostic and exit 127.
#[tokio::test(flavor = "multi_thread")]
async fn missing_relative_executable_reports_command_not_found() {
	let dir = isolated_work_dir();
	let root = dir.path();
	let command = "./pi-relative-missing-probe";

	let (exit_code, output) = run_in(root, command).await;
	assert_eq!(exit_code, Some(127), "unexpected exit for {command:?}: {output:?}");
	assert!(output.contains("command not found"), "missing diagnostic: {output:?}");
}

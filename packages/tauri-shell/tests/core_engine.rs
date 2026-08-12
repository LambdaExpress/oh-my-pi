use std::{
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use omp_shell::{
	config::OmpCommand,
	core_engine::{CoreEngine, CoreError},
};

fn fake_omp(extra: &[&str]) -> OmpCommand {
	let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-omp.ts");
	let mut argv = vec!["bun".to_string(), fixture.to_string_lossy().into_owned()];
	argv.extend(extra.iter().map(|s| s.to_string()));
	OmpCommand { argv }
}

fn project_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn temp_project_dir(name: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!("omp-shell-core-{}-{name}", std::process::id()));
	std::fs::create_dir_all(&dir).expect("create temporary project directory");
	dir.canonicalize()
		.expect("canonicalize temporary project directory")
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
	let out = std::process::Command::new("tasklist")
		.args(["/FI", &format!("PID eq {pid}"), "/NH"])
		.output()
		.unwrap();
	String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
	std::process::Command::new("kill")
		.arg("-0")
		.arg(pid.to_string())
		.status()
		.map(|s| s.success())
		.unwrap_or(false)
}

#[cfg(windows)]
fn kill_process(pid: u32) {
	let _ = std::process::Command::new("taskkill")
		.args(["/PID", &pid.to_string(), "/F"])
		.status();
}

#[cfg(not(windows))]
fn kill_process(pid: u32) {
	let _ = std::process::Command::new("kill")
		.args(["-9", &pid.to_string()])
		.status();
}

#[tokio::test]
async fn parses_links_and_stops() {
	let exit_flag = Arc::new(AtomicBool::new(false));
	let flag = exit_flag.clone();
	let mut core = CoreEngine::start(&fake_omp(&[]), &project_dir(), move |_code| {
		flag.store(true, Ordering::Relaxed);
	})
	.await
	.expect("fake-omp should print the ctrl/session links and keep running");

	assert_eq!(core.control_link, "http://127.0.0.1:0/#ws://127.0.0.1:0/r/ctrl-fake.key");
	assert_eq!(core.session_link, "http://127.0.0.1:0/#ws://127.0.0.1:0/r/room.key");
	assert_eq!(core.project_dir(), project_dir());

	let pid = core.child_id();
	core.stop().await;

	// Give the OS a moment to reap the terminated process.
	tokio::time::sleep(Duration::from_millis(100)).await;
	assert!(!process_alive(pid), "child process {pid} should be gone after stop");
	assert!(!exit_flag.load(Ordering::Relaxed), "exit callback must not fire on explicit stop");
}

async fn assert_explicit_project_cwd(selected: &PathBuf) {
	let fixture = project_dir().join("tests/fixtures/fake-omp.ts");
	#[cfg(windows)]
	let expected_cli_cwd = selected
		.to_string_lossy()
		.strip_prefix(r"\\?\")
		.expect("canonical Windows path should carry the extended-length prefix")
		.to_string();
	#[cfg(not(windows))]
	let expected_cli_cwd = selected.to_string_lossy().into_owned();
	let omp = OmpCommand {
		argv: vec![
			"bun".to_string(),
			format!("--cwd={}", project_dir().display()),
			fixture.to_string_lossy().into_owned(),
			format!("--expect-project-cwd={expected_cli_cwd}"),
		],
	};

	let mut core = CoreEngine::start(&omp, selected, |_code| {})
		.await
		.expect("the selected project cwd must reach omp even when the launcher overrides its cwd");
	assert_eq!(core.project_dir(), selected);
	core.stop().await;
}

#[tokio::test]
async fn explicit_project_cwd_survives_launcher_cwd_override() {
	let first = temp_project_dir("first-project");
	let second = temp_project_dir("second-project");

	assert_explicit_project_cwd(&first).await;
	assert_explicit_project_cwd(&second).await;
}

#[tokio::test]
async fn fail_path_reports_stderr() {
	let err = match CoreEngine::start(&fake_omp(&["--fail"]), &project_dir(), |_code| {}).await {
		Ok(_) => panic!("fake-omp --fail should fail to start"),
		Err(e) => e,
	};
	// Either the ProcessExited or the Eof branch may win the select race;
	// both must surface the captured stderr tail.
	assert!(
		err.to_string().contains("No models available"),
		"error should include the stderr tail: {err}"
	);
}

#[tokio::test]
async fn silent_times_out() {
	let err = match CoreEngine::start_with_timeout(
		&fake_omp(&["--silent"]),
		&project_dir(),
		Duration::from_millis(500),
		|_code| {},
	)
	.await
	{
		Ok(_) => panic!("a silent fake-omp should time out"),
		Err(e) => e,
	};
	assert!(matches!(err, CoreError::Timeout { .. }), "unexpected error: {err}");
}

#[tokio::test]
async fn unexpected_exit_reports() {
	let exit_flag = Arc::new(AtomicBool::new(false));
	let flag = exit_flag.clone();
	let mut core = CoreEngine::start(&fake_omp(&[]), &project_dir(), move |_code| {
		flag.store(true, Ordering::Relaxed);
	})
	.await
	.expect("fake-omp should start and print links");

	kill_process(core.child_id());

	let deadline = std::time::Instant::now() + Duration::from_secs(10);
	while !exit_flag.load(Ordering::Relaxed) {
		if std::time::Instant::now() >= deadline {
			panic!("exit callback not fired");
		}
		tokio::time::sleep(Duration::from_millis(25)).await;
	}

	// stop() is idempotent; the child has already exited.
	core.stop().await;
}

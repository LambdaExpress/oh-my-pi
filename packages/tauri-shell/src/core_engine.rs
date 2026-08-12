//! CoreEngine: spawn, parse and stop the omp core subprocess.

use std::{
	fmt, io,
	path::{Path, PathBuf},
	process::Stdio,
	sync::{
		Arc, Mutex as StdMutex,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use tokio::{
	io::{AsyncBufReadExt, AsyncReadExt, BufReader},
	process::Command,
	sync::oneshot,
	task::JoinHandle,
};

use crate::config::OmpCommand;

const STDERR_TAIL_CHARS: usize = 4096;

/// Convert canonical Win32 `\\?\` drive/UNC paths to the ordinary form Bun
/// and the coding-agent session-path encoder accept. The canonical path stays
/// on `CoreEngine` for identity comparisons; only the child CLI argument uses
/// this representation.
#[cfg(windows)]
fn project_dir_for_cli(project_dir: &Path) -> PathBuf {
	use std::path::{Component, Prefix};

	let mut components = project_dir.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return project_dir.to_path_buf();
	};
	let mut normalized = match prefix.kind() {
		Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
		Prefix::VerbatimUNC(server, share) => {
			let mut root = PathBuf::from(r"\\");
			root.push(server);
			root.push(share);
			root
		},
		_ => return project_dir.to_path_buf(),
	};
	for component in components {
		if !matches!(component, Component::RootDir) {
			normalized.push(component.as_os_str());
		}
	}
	normalized
}

#[cfg(not(windows))]
fn project_dir_for_cli(project_dir: &Path) -> PathBuf {
	project_dir.to_path_buf()
}

#[derive(Debug)]
pub enum CoreError {
	Spawn { command: String, source: io::Error },
	Read { source: io::Error },
	UnexpectedOutput { line: String, stderr_tail: String },
	Timeout { stderr_tail: String },
	ProcessExited { code: Option<i32>, stderr_tail: String },
	Eof { stderr_tail: String },
}

impl CoreError {
	fn with_stderr(self, tail: String) -> CoreError {
		match self {
			CoreError::Spawn { command, source } => CoreError::Spawn { command, source },
			CoreError::Read { source } => CoreError::Read { source },
			CoreError::UnexpectedOutput { line, .. } => {
				CoreError::UnexpectedOutput { line, stderr_tail: tail }
			},
			CoreError::Timeout { .. } => CoreError::Timeout { stderr_tail: tail },
			CoreError::ProcessExited { code, .. } => {
				CoreError::ProcessExited { code, stderr_tail: tail }
			},
			CoreError::Eof { .. } => CoreError::Eof { stderr_tail: tail },
		}
	}
}

impl fmt::Display for CoreError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			CoreError::Spawn { command, source } => {
				write!(f, "无法启动 {command}：{source}")
			},
			CoreError::Read { source } => write!(f, "读取 omp core 输出失败：{source}"),
			CoreError::UnexpectedOutput { line, stderr_tail } => {
				write!(f, "omp core 输出了意外的行：{line:?}")?;
				append_stderr_tail(f, stderr_tail)
			},
			CoreError::Timeout { stderr_tail } => {
				write!(f, "等待 omp core 启动超时")?;
				append_stderr_tail(f, stderr_tail)
			},
			CoreError::ProcessExited { code, stderr_tail } => {
				write!(f, "omp core 提前退出（code {code:?}）")?;
				append_stderr_tail(f, stderr_tail)
			},
			CoreError::Eof { stderr_tail } => {
				write!(f, "omp core 未输出预期链接就结束了 stdout")?;
				append_stderr_tail(f, stderr_tail)
			},
		}
	}
}

fn append_stderr_tail(f: &mut fmt::Formatter<'_>, tail: &str) -> fmt::Result {
	if !tail.is_empty() {
		write!(f, "\nstderr：{tail}")?;
	}
	Ok(())
}

pub struct CoreEngine {
	pub control_link: String,
	pub session_link: String,
	project_dir:      PathBuf,
	child_id:         u32,
	stderr_tail:      Arc<StdMutex<String>>,
	stderr_task:      Option<JoinHandle<()>>,
	stop_flag:        Arc<AtomicBool>,
	stop_tx:          Option<oneshot::Sender<()>>,
	exit_watch:       Option<JoinHandle<()>>,
}

/// Operations needed by project switching. Keeping this small makes the
/// serialized stop/start transition observable without replacing Tauri or a
/// real subprocess in tests.
pub(crate) trait ProjectCore: Sized {
	fn stop_for_project(&mut self) -> impl Future<Output = ()>;
	fn project_dir(&self) -> &Path;
}

impl CoreEngine {
	pub async fn start(
		omp: &OmpCommand,
		project_dir: &Path,
		on_unexpected_exit: impl FnOnce(i32) + Send + 'static,
	) -> Result<CoreEngine, CoreError> {
		Self::start_with_timeout(omp, project_dir, Duration::from_secs(90), on_unexpected_exit).await
	}

	pub async fn start_with_timeout(
		omp: &OmpCommand,
		project_dir: &Path,
		timeout: Duration,
		on_unexpected_exit: impl FnOnce(i32) + Send + 'static,
	) -> Result<CoreEngine, CoreError> {
		let cli_project_dir = project_dir_for_cli(project_dir);
		let mut command = Command::new(&omp.argv[0]);
		command
			.args(&omp.argv[1..])
			.arg("--mode")
			.arg("core")
			.arg("--no-open")
			// Launcher wrappers may set their own working directory (the source
			// launcher uses `bun --cwd=<repo>/packages/coding-agent`). Make the
			// selected project authoritative at the omp CLI boundary as well as at
			// the OS process boundary so wrapper cwd handling cannot replace it.
			.arg("--cwd")
			.arg(&cli_project_dir)
			.current_dir(project_dir)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);
		#[cfg(windows)]
		{
			// The shell is a `windows_subsystem = "windows"` app with no
			// console; without this flag Windows hands the console-subsystem
			// core child (bun/omp) a brand-new terminal window on spawn.
			command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
		}
		let mut child = command
			.spawn()
			.map_err(|source| CoreError::Spawn { command: omp.argv[0].clone(), source })?;

		let child_id = child.id().unwrap_or(0);

		let stdout = child.stdout.take().ok_or_else(|| CoreError::Spawn {
			command: omp.argv[0].clone(),
			source:  io::Error::other("child stdout was already taken"),
		})?;
		let stderr = child.stderr.take().ok_or_else(|| CoreError::Spawn {
			command: omp.argv[0].clone(),
			source:  io::Error::other("child stderr was already taken"),
		})?;

		// Drain stderr in the background so a full pipe can never block the child.
		let stderr_tail = Arc::new(StdMutex::new(String::new()));
		let drain_tail = Arc::clone(&stderr_tail);
		let stderr_task: JoinHandle<()> = tokio::spawn(async move {
			let mut content = String::new();
			let mut reader = BufReader::new(stderr);
			let _ = reader.read_to_string(&mut content).await;
			let tail: String = content
				.chars()
				.rev()
				.take(STDERR_TAIL_CHARS)
				.collect::<String>()
				.chars()
				.rev()
				.collect();
			*drain_tail.lock().unwrap() = tail;
		});

		let tail_now = || stderr_tail.lock().unwrap().clone();

		let outcome = tokio::select! {
			result = read_links(BufReader::new(stdout), &tail_now) => result,
			_ = tokio::time::sleep(timeout) => Err(CoreError::Timeout { stderr_tail: tail_now() }),
			status = child.wait() => Err(CoreError::ProcessExited {
				code: status.ok().and_then(|s| s.code()),
				stderr_tail: tail_now(),
			}),
		};

		let (control_link, session_link) = match outcome {
			Ok(links) => links,
			Err(e) => {
				let _ = child.kill().await;
				let _ = child.wait().await;
				let _ = stderr_task.await;
				return Err(e.with_stderr(tail_now()));
			},
		};

		// Coordinate shutdown: stop() flips the flag and signals the channel, so
		// the watch task kills the child instead of reporting an unexpected exit.
		let stop_flag = Arc::new(AtomicBool::new(false));
		let (stop_tx, stop_rx) = oneshot::channel();

		let watch_stop_flag = Arc::clone(&stop_flag);
		let exit_watch: JoinHandle<()> = tokio::spawn(async move {
			let exit_code = tokio::select! {
				status = child.wait() => {
					if watch_stop_flag.load(Ordering::Relaxed) {
						None
					} else {
						status.ok().and_then(|s| s.code())
					}
				}
				_ = stop_rx => {
					let _ = child.kill().await;
					let _ = child.wait().await;
					None
				}
			};
			if let Some(code) = exit_code {
				on_unexpected_exit(code);
			}
		});

		Ok(CoreEngine {
			control_link,
			session_link,
			project_dir: project_dir.to_path_buf(),
			child_id,
			stderr_tail,
			stderr_task: Some(stderr_task),
			stop_flag,
			stop_tx: Some(stop_tx),
			exit_watch: Some(exit_watch),
		})
	}

	pub async fn stop(&mut self) {
		self.stop_flag.store(true, Ordering::Relaxed);
		if let Some(tx) = self.stop_tx.take() {
			let _ = tx.send(());
		}
		if let Some(watch) = self.exit_watch.take() {
			let _ = watch.await;
		}
		if let Some(task) = self.stderr_task.take() {
			let _ = task.await;
		}
		// Keep the retained stderr tail readable (diagnostics for future use).
		drop(self.stderr_tail.lock());
	}

	pub fn project_dir(&self) -> &Path {
		&self.project_dir
	}

	pub fn child_id(&self) -> u32 {
		self.child_id
	}
}

impl ProjectCore for CoreEngine {
	fn stop_for_project(&mut self) -> impl Future<Output = ()> {
		self.stop()
	}

	fn project_dir(&self) -> &Path {
		CoreEngine::project_dir(self)
	}
}

async fn read_links(
	reader: BufReader<tokio::process::ChildStdout>,
	tail_now: &(dyn Fn() -> String + Sync),
) -> Result<(String, String), CoreError> {
	let mut lines = reader.lines();
	let control = match lines.next_line().await {
		Ok(Some(line)) => match line.strip_prefix("ctrl: ") {
			Some(link) => link.to_string(),
			None => {
				return Err(CoreError::UnexpectedOutput { line, stderr_tail: tail_now() });
			},
		},
		Ok(None) => return Err(CoreError::Eof { stderr_tail: tail_now() }),
		Err(source) => return Err(CoreError::Read { source }),
	};
	let session = match lines.next_line().await {
		Ok(Some(line)) => match line.strip_prefix("session: ") {
			Some(link) => link.to_string(),
			None => {
				return Err(CoreError::UnexpectedOutput { line, stderr_tail: tail_now() });
			},
		},
		Ok(None) => return Err(CoreError::Eof { stderr_tail: tail_now() }),
		Err(source) => return Err(CoreError::Read { source }),
	};
	Ok((control, session))
}

//! The five edit-mode engines.

use crate::engine::{EditMode, ModeEngine};

pub mod apply_patch;
pub mod hashline;
pub mod patch;
pub mod replace;
pub mod sloppy;

/// Engine for `mode`. Engines are stateless; policy arrives per call.
pub fn engine_for(
	mode: EditMode,
	allow_fuzzy: bool,
	fuzzy_threshold: f64,
	enforce_seen_lines: bool,
) -> Box<dyn ModeEngine> {
	match mode {
		EditMode::Replace => Box::new(replace::ReplaceEngine { allow_fuzzy, fuzzy_threshold }),
		EditMode::Patch => {
			Box::new(patch::PatchEngine { allow_fuzzy, fuzzy_threshold, first_match: false })
		},
		EditMode::ApplyPatch => {
			Box::new(apply_patch::ApplyPatchEngine { allow_fuzzy, fuzzy_threshold })
		},
		EditMode::Hashline => Box::new(hashline::HashlineEngine { enforce_seen_lines }),
		EditMode::Sloppy => Box::new(sloppy::SloppyEngine { allow_fuzzy, fuzzy_threshold }),
	}
}

/// TTSR digest of `+` rows joined by `\n`, or `None` when there are no such
/// rows. Unified diffs skip `+++ ` file headers only before the first hunk;
/// payloads such as hashline bodies have no file headers. Callers pick the
/// row splitter because hashline payloads split with `lines()` while diff
/// bodies keep `\r` via `split('\n')`.
pub(crate) fn added_lines<'a>(
	rows: impl Iterator<Item = &'a str>,
	unified_diff: bool,
) -> Option<String> {
	let mut out = None::<String>;
	let mut before_first_hunk = unified_diff;
	for line in rows {
		if before_first_hunk && line.starts_with("@@") {
			before_first_hunk = false;
		}
		let Some(added) = line.strip_prefix('+') else {
			continue;
		};
		if before_first_hunk && line.starts_with("+++ ") {
			continue;
		}
		match &mut out {
			Some(out) => {
				out.push('\n');
				out.push_str(added);
			},
			None => out = Some(added.to_owned()),
		}
	}
	out
}

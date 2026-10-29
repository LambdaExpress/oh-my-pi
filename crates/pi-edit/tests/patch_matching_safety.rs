mod common;

use pi_edit::{ApplyOutcome, EditMode, EditResult};

const OLD_LINE: &str = "    else if (action === \"apply\") { clearTimeout(previewTimer); \
                        state.localError = \"\"; state.pendingCommit = emit(\"apply\", \
                        requestData()); updateControls(); }";
const NEW_LINE: &str = "    else if (action === \"apply\") { state.localError = \"\"; \
                        state.pendingCommit = emit(\"apply\", requestData()); updateControls(); }";

async fn apply_diff(
	workspace: &common::Workspace,
	diff: &str,
	writer: &common::DiskWriter,
) -> EditResult<ApplyOutcome> {
	match workspace.config.mode {
		EditMode::Patch => {
			workspace
				.apply_json(
					&serde_json::json!({
						"path": "source.js",
						"edits": [{ "op": "update", "diff": diff }]
					}),
					writer,
				)
				.await
		},
		EditMode::ApplyPatch => {
			workspace
				.apply_raw(
					&format!("*** Begin Patch\n*** Update File: source.js\n{diff}\n*** End Patch"),
					writer,
				)
				.await
		},
		_ => unreachable!("only line-patch modes use this fixture"),
	}
}

#[tokio::test]
async fn unmatched_structure_rejects_partial_and_fuzzy_hunks_without_writing() {
	let actual = OLD_LINE.replacen("    else", "    } else", 1);
	let misspelled = OLD_LINE.replace("clearTimeout", "clearTimeuot");
	let cases = [
		("reported two-hunk substring", actual.as_str(), OLD_LINE, NEW_LINE, true),
		("single-hunk character fallback", actual.as_str(), OLD_LINE, NEW_LINE, false),
		("two-hunk fuzzy fallback", actual.as_str(), misspelled.as_str(), NEW_LINE, true),
		(
			"single-hunk fuzzy character fallback",
			actual.as_str(),
			misspelled.as_str(),
			NEW_LINE,
			false,
		),
		(
			"trailing brace repeated elsewhere in the replacement",
			"if (ready) { updateControls(); }",
			"if (ready) { updateControls();",
			"if (ready) { emit({});",
			true,
		),
		(
			"internal unmatched delimiter despite high similarity",
			"const result = finalize(requestData())); updateControls();",
			"const result = finalize(requestData()); updateControls();",
			"const result = finalize(nextData()); updateControls();",
			true,
		),
	];
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		for (name, actual, old, new, multi_hunk) in cases {
			let workspace = common::Workspace::new(mode);
			let original = format!("{actual}\nconst version = 1;\n");
			workspace.write("source.js", &original);
			let mut diff = format!("@@\n-{old}\n+{new}");
			if multi_hunk {
				diff.push_str("\n@@\n-const version = 1;\n+const version = 2;");
			}
			let writer = common::DiskWriter::default();
			let error = apply_diff(&workspace, &diff, &writer)
				.await
				.expect_err(name);
			assert!(error.to_string().contains("Refusing"), "{mode:?}: {name}: {error}");
			assert!(writer.requests.lock().is_empty(), "{mode:?}: {name}");
			assert_eq!(workspace.read("source.js").as_deref(), Some(original.as_str()), "{name}");
		}
	}
}

#[tokio::test]
async fn complete_old_lines_keep_exact_and_indentation_tolerance_with_original_context() {
	let actual = OLD_LINE.replacen("    else", "    } else", 1);
	let replacement = NEW_LINE.replacen("    else", "    } else", 1);
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		for old in [actual.clone(), actual.trim_start().to_owned()] {
			let workspace = common::Workspace::new(mode);
			let original = format!("{actual}\nkeepOriginal(value); \t\nconst version = 1;\n");
			workspace.write("source.js", &original);
			let new = if old.starts_with(' ') {
				replacement.clone()
			} else {
				replacement.trim_start().to_owned()
			};
			let diff = format!(
				"@@\n-{old}\n+{new}\n keepOriginal(value));\n@@\n-const version = 1;\n+const version \
				 = 2;"
			);
			apply_diff(&workspace, &diff, &common::DiskWriter::default())
				.await
				.expect("complete old lines may use fuzzy context and indentation tolerance");
			assert_eq!(
				workspace.read("source.js"),
				Some(format!("{replacement}\nkeepOriginal(value); \t\nconst version = 2;\n"))
			);
		}
	}
}

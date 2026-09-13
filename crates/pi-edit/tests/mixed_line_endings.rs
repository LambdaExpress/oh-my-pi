//! Mixed line-ending preservation: a single-line edit must not rewrite the
//! terminators of the lines it did not touch.

mod common;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::json;

/// Two CRLF lines, one isolated LF line, then CRLF again — the reported
/// mixed-ending shape.
const MIXED: &str = "one\r\ntwo\r\nthree\nfour\r\nfive\r\n";

fn applied_bytes(workspace: &Workspace) -> Vec<u8> {
	std::fs::read(workspace.cwd().join("mixed.txt")).expect("read applied file")
}

#[tokio::test]
async fn apply_patch_keeps_untouched_terminators() {
	let workspace = Workspace::new(EditMode::ApplyPatch);
	workspace.write("mixed.txt", MIXED);
	let patch = "*** Begin Patch\n*** Update File: mixed.txt\n@@\n-three\n+THREE\n*** End Patch\n";
	workspace
		.apply_raw(patch, &DiskWriter::default())
		.await
		.expect("applies the single-line patch");
	let expected: &[u8] = b"one\r\ntwo\r\nTHREE\nfour\r\nfive\r\n";
	assert_eq!(
		applied_bytes(&workspace),
		expected,
		"only the edited line changes; its isolated LF and every CRLF survive"
	);
}

#[tokio::test]
async fn apply_patch_inserts_with_the_preceding_line_terminator() {
	let workspace = Workspace::new(EditMode::ApplyPatch);
	workspace.write("mixed.txt", MIXED);
	let patch = "*** Begin Patch\n*** Update File: mixed.txt\n@@\n four\n+TAIL\n*** End Patch\n";
	workspace
		.apply_raw(patch, &DiskWriter::default())
		.await
		.expect("applies the insertion");
	let expected: &[u8] = b"one\r\ntwo\r\nthree\nfour\r\nTAIL\r\nfive\r\n";
	assert_eq!(
		applied_bytes(&workspace),
		expected,
		"the inserted line borrows the preceding original line's terminator"
	);
}

#[tokio::test]
async fn replace_engine_keeps_untouched_terminators() {
	let workspace = Workspace::new(EditMode::Replace);
	workspace.write("mixed.txt", MIXED);
	workspace
		.apply_json(
			&json!({ "path": "mixed.txt", "old_string": "three", "new_string": "THREE" }),
			&DiskWriter::default(),
		)
		.await
		.expect("applies the replacement");
	let expected: &[u8] = b"one\r\ntwo\r\nTHREE\nfour\r\nfive\r\n";
	assert_eq!(
		applied_bytes(&workspace),
		expected,
		"the replace engine lands on the same shared restore point"
	);
}

#[tokio::test]
async fn hashline_engine_keeps_untouched_terminators() {
	let workspace = Workspace::new(EditMode::Hashline);
	workspace.write("mixed.txt", MIXED);
	let tag = workspace.snapshot("mixed.txt", MIXED, None);
	let args = json!({ "input": format!("[mixed.txt#{tag}]\nPUT 3.=3:\n+THREE") });
	workspace
		.apply_json(&args, &DiskWriter::default())
		.await
		.expect("applies the hashline replacement");
	let expected: &[u8] = b"one\r\ntwo\r\nTHREE\nfour\r\nfive\r\n";
	assert_eq!(
		applied_bytes(&workspace),
		expected,
		"the hashline engine lands on the same shared restore point"
	);
}

mod common;

use pi_edit::{EditMode, ModeEngine, modes::patch::PatchEngine, stream_json::ArgSnapshot};

#[tokio::test]
async fn patch_core_fixtures() {
	common::run_fixture("patch/core.json", EditMode::Patch).await;
}

#[test]
fn matcher_digest_uses_added_lines_and_whole_create_content() {
	let engine = PatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let args = ArgSnapshot {
		path: Some("a.txt".into()),
		edits: vec![
			pi_edit::stream_json::EditEntry {
				op: Some("update".into()),
				diff: Some("@@\n-old\n+new".into()),
				closed: true,
				..Default::default()
			},
			pi_edit::stream_json::EditEntry {
				op: Some("create".into()),
				rename: Some("ignored.txt".into()),
				diff: Some("whole content".into()),
				closed: true,
				..Default::default()
			},
		],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	let inspection = engine.inspect(&args);
	assert_eq!(inspection.paths, ["a.txt"]);
	assert_eq!(inspection.entries, [("a.txt".into(), "new\nwhole content".into())]);
	assert!(inspection.file_ops.is_empty());
}

#[tokio::test]
async fn streaming_preview_drops_an_unclosed_first_entry() {
	let workspace = common::Workspace::new(EditMode::Patch);
	workspace.write("a.txt", "old\n");
	let mut session = workspace.session();
	session.push(r#"{"path":"a.txt","edits":[{"op":"update","diff":"@@\n-old\n+new"#);
	let preview = session.preview();
	assert!(preview.streaming);
	assert!(preview.files.is_empty());
}

#[tokio::test]
async fn fuzzy_context_preserves_original_bytes_through_matching_fallbacks() {
	let cases = [
		(
			"internal punctuation, blank whitespace, and mixed terminators",
			"before();\r\nkeepOriginal(value); \t\r\n \t \nafter();\r\n",
			"@@\n-before();\n+beforeUpdated();\n keepOriginal(value));\n \
			 \n-after();\n+afterUpdated();",
			"beforeUpdated();\r\nkeepOriginal(value); \t\r\n \t \nafterUpdated();\r\n",
		),
		(
			"trimming unavailable outer context",
			"before();\nkeepOriginal(value);\nafter();\n",
			"@@\n missing header\n-before();\n+beforeUpdated();\n \
			 keepOriginal(value));\n-after();\n+afterUpdated();\n missing footer",
			"beforeUpdated();\nkeepOriginal(value);\nafterUpdated();\n",
		),
		(
			"trimming a missing trailing blank context",
			"before();\nkeepOriginal(value);\nafter();\n",
			"@@\n-before();\n+beforeUpdated();\n \
			 keepOriginal(value));\n-after();\n+afterUpdated();\n ",
			"beforeUpdated();\nkeepOriginal(value);\nafterUpdated();\n",
		),
		(
			"collapsing duplicated internal context",
			"before();\nkeepOriginal(value);\nafter();\n",
			"@@\n-before();\n+beforeUpdated();\n keepOriginal(value));\n \
			 keepOriginal(value));\n-after();\n+afterUpdated();",
			"beforeUpdated();\nkeepOriginal(value);\nafterUpdated();\n",
		),
		(
			"collapsing repeated internal context blocks",
			"before();\nkeepOriginal(value);\nkeepOther(value);\nafter();\n",
			"@@ line 1\n-before();\n+beforeUpdated();\n keepOriginal(value));\n keepOther(value);\n \
			 keepOriginal(value));\n keepOther(value);\n-after();\n+afterUpdated();",
			"beforeUpdated();\nkeepOriginal(value);\nkeepOther(value);\nafterUpdated();\n",
		),
		(
			"converting only additions from tabs to spaces",
			"    begin(); \t\n        old();\n    // keep – spelling\n",
			"@@\n \tbegin();\n-\t\told();\n+\t\tfresh();\n \t// keep - spelling",
			"    begin(); \t\n        fresh();\n    // keep – spelling\n",
		),
		(
			"converting only additions from spaces to tabs",
			"\tbegin(); \t\n\t\told();\n\t// keep – spelling\n",
			"@@\n     begin();\n-        old();\n+        fresh();\n     // keep - spelling",
			"\tbegin(); \t\n\t\tfresh();\n\t// keep – spelling\n",
		),
	];
	for (name, original, diff, expected) in cases {
		let workspace = common::Workspace::new(EditMode::Patch);
		workspace.write("context.js", original);
		let args = serde_json::json!({
			"path": "context.js",
			"edits": [{ "op": "update", "diff": diff }]
		});
		workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.unwrap_or_else(|error| panic!("{name}: {error}"));
		assert_eq!(
			std::fs::read(workspace.cwd().join("context.js")).expect("read edited bytes"),
			expected.as_bytes(),
			"{name}"
		);
	}
}

#[tokio::test]
async fn missing_explicit_blank_deletion_is_not_trimmed_as_context() {
	let workspace = common::Workspace::new(EditMode::Patch);
	let original = "one\nanchor\n";
	workspace.write("blank.txt", original);
	let args = serde_json::json!({
		"path": "blank.txt",
		"edits": [{ "op": "update", "diff": "@@\n-one\n+ONE\n anchor\n-" }]
	});
	let writer = common::DiskWriter::default();
	assert!(workspace.apply_json(&args, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("blank.txt").as_deref(), Some(original));
}

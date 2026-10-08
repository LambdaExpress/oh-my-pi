mod common;

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
};

use pi_edit::{
	EditMode, ModeEngine,
	modes::apply_patch::{ApplyPatchEngine, parse_apply_patch, parse_apply_patch_streaming},
};

fn files_under(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
	fn visit(root: &Path, current: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
		for entry in std::fs::read_dir(current).expect("read fixture directory") {
			let entry = entry.expect("fixture entry");
			let path = entry.path();
			if path.is_dir() {
				visit(root, &path, files);
			} else {
				files.insert(
					path.strip_prefix(root).unwrap().to_owned(),
					std::fs::read(path).expect("read fixture file"),
				);
			}
		}
	}
	let mut files = BTreeMap::new();
	if root.exists() {
		visit(root, root, &mut files);
	}
	files
}

fn copy_tree(from: &Path, to: &Path) {
	for (relative, bytes) in files_under(from) {
		let target = to.join(relative);
		if let Some(parent) = target.parent() {
			std::fs::create_dir_all(parent).expect("create fixture parent");
		}
		std::fs::write(target, bytes).expect("copy fixture file");
	}
}

#[tokio::test]
async fn core_fixture_cases() {
	common::run_fixture("apply_patch/core.json", EditMode::ApplyPatch).await;
}

#[tokio::test]
async fn applies_all_21_portable_scenarios() {
	let scenarios =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/apply_patch/scenarios");
	let mut directories = std::fs::read_dir(&scenarios)
		.expect("scenario directory")
		.filter_map(Result::ok)
		.filter(|entry| entry.path().is_dir())
		.collect::<Vec<_>>();
	directories.sort_by_key(std::fs::DirEntry::file_name);
	assert_eq!(directories.len(), 21, "portable scenario count changed");

	let error_prefixes = ["005_", "006_", "007_", "008_", "009_", "010_", "011_", "012_", "013_"];
	for scenario in directories {
		let name = scenario.file_name().to_string_lossy().into_owned();
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		copy_tree(&scenario.path().join("input"), workspace.cwd());
		let patch =
			std::fs::read_to_string(scenario.path().join("patch.txt")).expect("scenario patch");
		let result = workspace
			.apply_raw(&patch, &common::DiskWriter::default())
			.await;
		if error_prefixes.iter().any(|prefix| name.starts_with(prefix)) {
			assert!(result.is_err(), "scenario {name} unexpectedly succeeded");
		} else if let Err(error) = result {
			panic!("scenario {name} failed: {error}");
		}
		assert_eq!(
			files_under(workspace.cwd()),
			files_under(&scenario.path().join("expected")),
			"scenario {name} final tree differs"
		);
	}
}

#[test]
fn rejects_invalid_first_line() {
	assert_eq!(
		parse_apply_patch("bad").unwrap_err().to_string(),
		"The first line of the patch must be '*** Begin Patch'"
	);
}

#[test]
fn rejects_missing_end_marker() {
	assert_eq!(
		parse_apply_patch("*** Begin Patch\nbad")
			.unwrap_err()
			.to_string(),
		"The last line of the patch must be '*** End Patch'"
	);
}

#[test]
fn parses_add_file_with_whitespace_padded_markers() {
	let parsed =
		parse_apply_patch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch").unwrap();
	assert_eq!(parsed.len(), 1);
	assert_eq!(parsed[0].path, "foo");
	assert_eq!(parsed[0].diff.as_deref(), Some("hi\n"));
}

#[test]
fn rejects_empty_update_file_hunk() {
	let error =
		parse_apply_patch("*** Begin Patch\n*** Update File: test.py\n*** End Patch").unwrap_err();
	assert_eq!(error.to_string(), "Line 3: Update file hunk for path 'test.py' is empty");
}

#[test]
fn parses_empty_patch() {
	assert!(
		parse_apply_patch("*** Begin Patch\n*** End Patch")
			.unwrap()
			.is_empty()
	);
}

#[test]
fn parses_full_patch_with_all_operations() {
	let parsed = parse_apply_patch(
		"*** Begin Patch\n*** Add File: add.txt\n+new\n*** Update File: old.txt\n*** Move to: \
		 moved.txt\n@@\n-old\n+changed\n*** Delete File: gone.txt\n*** End Patch",
	)
	.unwrap();
	assert_eq!(parsed.len(), 3);
	assert_eq!(parsed[1].rename.as_deref(), Some("moved.txt"));
}

#[test]
fn parses_heredoc_wrapped_patch() {
	let parsed = parse_apply_patch(
		"<<EOF\n*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch\nEOF",
	)
	.unwrap();
	assert_eq!(parsed[0].diff.as_deref(), Some("hello\n"));
}

#[test]
fn streaming_parser_tolerates_an_incomplete_update() {
	let parsed = parse_apply_patch_streaming("*** Begin Patch\n*** Update File: a.txt\n").unwrap();
	assert_eq!(parsed.len(), 1);
	assert_eq!(parsed[0].diff.as_deref(), Some(""));
}

#[test]
fn matcher_paths_entries_and_file_ops_follow_the_envelope() {
	let engine = ApplyPatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let args = pi_edit::stream_json::ArgSnapshot {
		input: Some(
			"*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new\n*** Delete \
			 File: c.txt\n*** End Patch"
				.into(),
		),
		complete: true,
		..Default::default()
	};
	let inspection = engine.inspect(&args);
	assert_eq!(inspection.paths, ["a.txt", "c.txt"]);
	assert_eq!(inspection.entries, [("a.txt".into(), "new".into())]);
	assert_eq!(inspection.file_ops.len(), 2);
}

#[tokio::test]
async fn streaming_preview_keeps_body_rows_in_input_order() {
	let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.config.raw_input = true;
	workspace.write("a.txt", "old one\nold two\n");
	let mut session = workspace.session();
	session.push(
		"*** Begin Patch\n*** Update File: a.txt\n@@\n-old one\n+new one\n-old two\n+new two\n",
	);
	let preview = session.preview();
	assert!(preview.streaming);
	assert_eq!(preview.files.len(), 1);
	assert_eq!(preview.files[0].diff.as_deref(), Some("@@\n-old one\n+new one\n-old two\n+new two"));
}

#[tokio::test]
async fn fuzzy_deletion_does_not_rewrite_context_punctuation() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let original_context = "      requireThat(Object.hasOwn(rpc,'id')&&(typeof \
	                        rpc.id==='string'||Number.isSafeInteger(rpc.id)),'request_id_required'\
	                        );id=rpc.id;";
	workspace.write(
		"server.js",
		&format!(
			"      safeLog('mcp_request',rpc.method.replaceAll('/','_'));\n{original_context}\n"
		),
	);
	let patch = [
		"*** Begin Patch",
		"*** Update File: server.js",
		"@@",
		"-      safeLog('mcp_request',rpc.method.replaceAll('/','_'));",
		"       requireThat(Object.hasOwn(rpc,'id')&&(typeof \
		 rpc.id==='string'||Number.isSafeInteger(rpc.id))),'request_id_required');id=rpc.id;",
		"*** End Patch",
	]
	.join("\n");
	workspace
		.apply_raw(&patch, &common::DiskWriter::default())
		.await
		.expect("the diagnostic deletion matches despite a context-only typo");
	assert_eq!(workspace.read("server.js"), Some(format!("{original_context}\n")));
}

#[tokio::test]
async fn explicit_replacements_are_not_inferred_as_context_when_moving() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("source.js", "// settings\nconst label = \"colour\";\nconst active = false;\n");
	let patch = [
		"*** Begin Patch",
		"*** Update File: source.js",
		"*** Move to: moved.js",
		"@@",
		" // settings",
		"-const label = \"color\";",
		"+const label = \"color\";",
		"-const active = false;",
		"+const active = true;",
		"*** End Patch",
	]
	.join("\n");
	workspace
		.apply_raw(&patch, &common::DiskWriter::default())
		.await
		.expect("explicit +/- lines remain replacements even when their authored text is equal");
	assert_eq!(
		workspace.read("moved.js").as_deref(),
		Some("// settings\nconst label = \"color\";\nconst active = true;\n")
	);
	assert!(!workspace.cwd().join("source.js").exists());
}

#[tokio::test]
async fn strict_matching_rejects_inexact_internal_context_without_writes() {
	let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.config.allow_fuzzy = false;
	let original = "before();\nkeepOriginal(value);\nafter();\n";
	workspace.write("strict.js", original);
	let writer = common::DiskWriter::default();
	let patch = [
		"*** Begin Patch",
		"*** Update File: strict.js",
		"@@",
		"-before();",
		"+beforeUpdated();",
		" keepOriginal(value));",
		"-after();",
		"+afterUpdated();",
		"*** End Patch",
	]
	.join("\n");
	assert!(workspace.apply_raw(&patch, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("strict.js").as_deref(), Some(original));
}

#[tokio::test]
async fn move_only_envelopes_preserve_exact_source_bytes() {
	let cases = [
		(
			"MeowFT/Assets/Editor/RecoveredAvatarProject/ExtraSittingPoseValidation.cs",
			"MeowFT/Assets/Editor/RecoveredAvatarProject/ExtraSittingPoseValidation.cs.pending",
			"\u{feff}using System;\r\n// 保留原文 \t\nclass Validation {}",
			false,
		),
		(
			"MeowFT/Assets/Editor/RecoveredAvatarProject/ExtraSittingPoseAuthoring.cs",
			"MeowFT/Assets/Editor/RecoveredAvatarProject/ExtraSittingPoseAuthoring.cs.pending",
			"using System;\r\nclass Authoring {}\r\n",
			false,
		),
		(
			"tools/photon-dotnet-5.1.20/photon-dotnet-sdk_v5-1-20.zip",
			"tools/photon-dotnet-5.1.20/download-response.html",
			"<!doctype html>\r\n<title>403 - No Access!</title>\r\n",
			true,
		),
		(
			"UnityProject/Assets/Editor/TextureImportRecovery.cs",
			"tools/unity-project-validation/TextureImportRecovery.cs",
			"",
			true,
		),
		(
			"analysis.ipynb",
			"archive/analysis.ipynb.pending",
			"{ \"cells\": [{ \"cell_type\": \"code\", \"metadata\": {}, \"source\": \
			 [\"print(1)\\n\"], \"outputs\": [], \"execution_count\": null }], \"metadata\": {}, \
			 \"nbformat\": 4, \"nbformat_minor\": 5 }\r\n",
			false,
		),
	];
	for (source, destination, original, absolute) in cases {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write(source, original);
		let source_path = workspace.cwd().join(source);
		let destination_path = workspace.cwd().join(destination);
		let authored_source = if absolute {
			source_path.to_string_lossy().into_owned()
		} else {
			source.to_owned()
		};
		let authored_destination = if absolute {
			destination_path.to_string_lossy().into_owned()
		} else {
			destination.to_owned()
		};
		let patch = format!(
			"*** Begin Patch\n*** Update File: {authored_source}\n*** Move to: \
			 {authored_destination}\n*** End Patch"
		);
		workspace
			.apply_raw(&patch, &common::DiskWriter::default())
			.await
			.unwrap_or_else(|error| panic!("{source}: {error}"));
		assert!(!source_path.exists(), "{source}");
		assert_eq!(
			std::fs::read(destination_path).expect("read moved bytes"),
			original.as_bytes(),
			"{source}"
		);
	}
}

#[tokio::test]
async fn streamed_move_only_envelope_commits_without_a_content_hunk() {
	let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.config.raw_input = true;
	let original = "\u{feff}// 保留字节\r\nclass Example {}\n";
	workspace.write("source.cs", original);
	let mut session = workspace.session();
	session.push("*** Begin Patch\n*** Update File: source.cs\n");
	session.push("*** Move to: staged/source.cs.pending\n");
	session.push("*** End Patch\n");
	session.finish();
	session
		.apply(pi_edit::ApplyRequest::default(), &common::DiskWriter::default())
		.await
		.expect("commit a streamed move-only envelope");
	assert!(!workspace.cwd().join("source.cs").exists());
	assert_eq!(
		std::fs::read(workspace.cwd().join("staged/source.cs.pending")).unwrap(),
		original.as_bytes()
	);
}

#[tokio::test]
async fn move_only_sections_share_the_sequential_patch_stage() {
	for move_first in [false, true] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("source.cs", "\u{feff}class Original {}\r\n// unchanged\n");
		let movement = "*** Update File: source.cs\n*** Move to: staged/source.cs.pending";
		let update = "*** Update File: source.cs\n@@\n-class Original {}\n+class Updated {}";
		let sections = if move_first {
			format!("{movement}\n{update}")
		} else {
			format!("{update}\n{movement}")
		};
		workspace
			.apply_raw(
				&format!("*** Begin Patch\n{sections}\n*** End Patch"),
				&common::DiskWriter::default(),
			)
			.await
			.expect("stage move-only and content updates to the same source");
		assert!(!workspace.cwd().join("source.cs").exists());
		assert_eq!(
			std::fs::read(workspace.cwd().join("staged/source.cs.pending")).unwrap(),
			"\u{feff}class Updated {}\r\n// unchanged\n".as_bytes()
		);
	}
}

#[tokio::test]
async fn unique_full_hunks_win_over_weaker_similar_blocks() {
	let declaration = "                    var gogo = \
	                   AssetDatabase.LoadAssetAtPath<VRCExpressionsMenu>(\"Assets/GoGoLocoMenu/\
	                   Menu.asset\");";
	let removed = "                    var goControl = WalkMenus(gogo).SelectMany(m => m.controls)";
	let replacement =
		"                    var goControl = WalkMenus(mergedGoMenu).SelectMany(m => m.controls)";
	let siblings = [
		"                    var control = WalkMenus(gogo).SelectMany(m => m.controls)",
		"                  var goControl = WalkMenus(gogo).SelectMany(m => m.controls)",
		"                    var goControl = WalkMenus(gogo).SelectMany(m => m.controls);",
	];
	for sibling in siblings {
		for target_first in [true, false] {
			let workspace = common::Workspace::new(EditMode::ApplyPatch);
			let target = format!("{declaration}\n{removed}");
			let similar = format!("{declaration}\n{sibling}");
			let blocks = if target_first {
				format!("{target}\n// 保留其他场景 \t\n{similar}")
			} else {
				format!("{similar}\n// 保留其他场景 \t\n{target}")
			};
			let original = format!("const int Version = 1;\n{blocks}\n").replace('\n', "\r\n");
			workspace.write("scenarios.cs", &original);
			let patch = format!(
				"*** Begin Patch\n*** Update File: scenarios.cs\n@@\n-const int Version = 1;\n+const \
				 int Version = 2;\n@@\n-{declaration}\n-{removed}\n+{replacement}\n*** End Patch"
			);
			workspace
				.apply_raw(&patch, &common::DiskWriter::default())
				.await
				.expect("match the entire unique two-line hunk");
			let expected_blocks = if target_first {
				format!("{replacement}\n// 保留其他场景 \t\n{similar}")
			} else {
				format!("{similar}\n// 保留其他场景 \t\n{replacement}")
			};
			let expected =
				format!("const int Version = 2;\n{expected_blocks}\n").replace('\n', "\r\n");
			assert_eq!(
				std::fs::read(workspace.cwd().join("scenarios.cs")).unwrap(),
				expected.as_bytes()
			);
		}
	}
}

#[tokio::test]
async fn ambiguous_anchor_falls_back_to_the_unique_complete_hunk() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let original = "Scenario();\nvar gogo = LoadMenu();\nvar goControl = \
	                WalkMenus(gogo);\nScenario();\nvar gogo = LoadMenu();\nvar control = \
	                WalkMenus(gogo);\n";
	workspace.write("scenarios.cs", original);
	let patch = [
		"*** Begin Patch",
		"*** Update File: scenarios.cs",
		"@@ Scenario();",
		"-var gogo = LoadMenu();",
		"-var goControl = WalkMenus(gogo);",
		"+var goControl = WalkMenus(mergedGoMenu);",
		"*** End Patch",
	]
	.join("\n");
	workspace
		.apply_raw(&patch, &common::DiskWriter::default())
		.await
		.expect("a unique full hunk disambiguates identical anchors");
	assert_eq!(
		workspace.read("scenarios.cs").as_deref(),
		Some(
			"Scenario();\nvar goControl = WalkMenus(mergedGoMenu);\nScenario();\nvar gogo = \
			 LoadMenu();\nvar control = WalkMenus(gogo);\n"
		)
	);
}

#[tokio::test]
async fn identical_full_hunks_reject_the_entire_combined_patch() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let duplicate = "var gogo = LoadMenu();\nvar goControl = WalkMenus(gogo);";
	let ambiguous = format!("version = 1;\n{duplicate}\nseparator();\n{duplicate}\n");
	let original_move = "\u{feff}keep\r\nthese bytes\n";
	workspace.write("source.txt", original_move);
	workspace.write("stable.txt", "old\n");
	workspace.write("ambiguous.cs", &ambiguous);
	let writer = common::DiskWriter::default();
	let patch = [
		"*** Begin Patch",
		"*** Update File: source.txt",
		"*** Move to: destination.txt",
		"*** Update File: stable.txt",
		"@@",
		"-old",
		"+new",
		"*** Update File: ambiguous.cs",
		"@@",
		"-version = 1;",
		"+version = 2;",
		"@@",
		"-var gogo = LoadMenu();",
		"-var goControl = WalkMenus(gogo);",
		"+var goControl = WalkMenus(mergedGoMenu);",
		"*** End Patch",
	]
	.join("\n");
	assert!(workspace.apply_raw(&patch, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert!(!workspace.cwd().join("destination.txt").exists());
	assert_eq!(workspace.read("source.txt").as_deref(), Some(original_move));
	assert_eq!(workspace.read("stable.txt").as_deref(), Some("old\n"));
	assert_eq!(workspace.read("ambiguous.cs").as_deref(), Some(ambiguous.as_str()));
}

#[tokio::test]
async fn move_only_destination_collisions_abort_before_any_write() {
	for destination in ["source.txt", "occupied.txt"] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("stable.txt", "old\n");
		workspace.write("source.txt", "source\r\n");
		workspace.write("occupied.txt", "occupied\n");
		let writer = common::DiskWriter::default();
		let patch = format!(
			"*** Begin Patch\n*** Update File: stable.txt\n@@\n-old\n+new\n*** Update File: \
			 source.txt\n*** Move to: {destination}\n*** End Patch"
		);
		assert!(workspace.apply_raw(&patch, &writer).await.is_err());
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("stable.txt").as_deref(), Some("old\n"));
		assert_eq!(workspace.read("source.txt").as_deref(), Some("source\r\n"));
		assert_eq!(workspace.read("occupied.txt").as_deref(), Some("occupied\n"));
	}
}

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

#[tokio::test]
async fn literal_numeric_paragraphs_take_priority_over_numbered_display_rows() {
	let cases = [
		(
			"7 项均已编码完成。下表每个非空单元格对应该仓库中一个独立提交，共 13 \
			 个代码提交；审核补修已归入各自 Q 的提交，没有遗留混合问卷项的补修提交。",
			"7 项均已编码完成。首次本地交付整理为 13 个代码提交；发布验证发现 Q31 \
			 的类型声明与测试数据问题后，用户明确选择追加修正提交，不重写已推送历史。当前共 14 \
			 个代码提交，每个提交均只对应一个 Q；Q31 在 App 中有原提交及一项独立修正。",
		),
		(
			"14 项用例当前分布：7 项通过、2 项待后台核对、4 项未执行、1 \
			 项部分完成。不能据此宣布全部用例验收通过。",
			"14 项用例当前分布：8 项通过、1 项待返场完结、4 项未执行、1 \
			 项部分完成。不能据此宣布全部用例验收通过。",
		),
	];
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		for (old, new) in cases {
			for multipart in [false, true] {
				let workspace = common::Workspace::new(mode);
				let unnumbered = old.split_once(' ').unwrap().1;
				let original = format!("{unnumbered}\n{old}\nconst version = 1;\n");
				workspace.write("source.js", &original);
				let mut diff = format!("@@\n-{old}\n+{new}");
				if multipart {
					diff.push_str("\n@@\n-const version = 1;\n+const version = 2;");
				}
				apply_diff(&workspace, &diff, &common::DiskWriter::default())
					.await
					.expect("literal full lines must win over a stripped-prefix candidate");
				let version = if multipart { 2 } else { 1 };
				assert_eq!(
					workspace.read("source.js"),
					Some(format!("{unnumbered}\n{new}\nconst version = {version};\n"))
				);
			}
		}
	}
}

#[tokio::test]
async fn numbered_display_rows_remain_a_fallback_when_literal_lines_are_absent() {
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		let workspace = common::Workspace::new(mode);
		workspace.write("source.js", "first paragraph\nsecond paragraph\nthird paragraph\n");
		let diff = "@@\n 1\tfirst paragraph\n- 2\tsecond paragraph\n+ 2\tupdated paragraph\n \
		            3\tthird paragraph";
		apply_diff(&workspace, diff, &common::DiskWriter::default())
			.await
			.expect("copied display prefixes should remain recoverable");
		assert_eq!(
			workspace.read("source.js").as_deref(),
			Some("first paragraph\nupdated paragraph\nthird paragraph\n")
		);
	}
}

#[tokio::test]
async fn fuzzy_removed_lines_keep_whitespace_only_tolerance() {
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		let workspace = common::Workspace::new(mode);
		workspace.write("source.js", "const value = computeTotal(items);\nconst version = 1;\n");
		let diff = "@@\n-const value=computeTotal(items);\n+const value = \
		            calculateTotal(items);\n@@\n-const version = 1;\n+const version = 2;";
		apply_diff(&workspace, diff, &common::DiskWriter::default())
			.await
			.expect("content safety must preserve whitespace-only matching tolerance");
		assert_eq!(
			workspace.read("source.js").as_deref(),
			Some("const value = calculateTotal(items);\nconst version = 2;\n")
		);
	}
}

#[tokio::test]
async fn fuzzy_removed_content_mismatch_rejects_the_whole_patch_before_writing() {
	const OLD: &str = r#"    const handleStart = () => {
        ExpoSpeechRecognitionModule.requestPermissionsAsync().then((result) => {
            if (!result.granted) {
                console.warn("Permissions not granted", result);
                return;
            }
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 300,
                useNativeDriver: false,
            }).start();
            // Start speech recognition
            ExpoSpeechRecognitionModule.start({
                lang: "en-US",
                interimResults: true,
                maxAlternatives: 1,
                continuous: false,
                requiresOnDeviceRecognition: false,
                addsPunctuation: false,
                contextualStrings: ["Carlsen", "Nepomniachtchi", "Grischuk"],
            });
        });
    };"#;
	const NEW: &str = r#"    const handleStart = async () => {
        const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!result.granted) return false;
        ExpoSpeechRecognitionModule.start({
            contextualStrings: ["Carlsen", "Nepomniachtchi", "Grischuk"],
        });
        return true;
    };"#;
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		let workspace = common::Workspace::new(mode);
		let actual = OLD.replace("Grischuk", "Praggnanandhaa");
		let original = format!("const version = 1;\n{actual}\n");
		workspace.write("source.js", &original);
		let mut diff = "@@\n-const version = 1;\n+const version = 2;\n@@\n".to_owned();
		for line in OLD.lines() {
			diff.push('-');
			diff.push_str(line);
			diff.push('\n');
		}
		for line in NEW.lines() {
			diff.push('+');
			diff.push_str(line);
			diff.push('\n');
		}
		let writer = common::DiskWriter::default();
		let error = apply_diff(&workspace, &diff, &writer)
			.await
			.expect_err("high whole-hunk similarity does not authorize a different removed string");
		assert!(error.to_string().contains("Refusing inexact-line match"));
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("source.js").as_deref(), Some(original.as_str()));
	}
}

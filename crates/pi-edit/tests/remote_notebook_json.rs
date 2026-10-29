//! Host-materialized notebooks expose protocol text; local notebooks expose
//! cells.

mod common;

use common::Workspace;
use pi_edit::{
	EditMode,
	files::{FileCache, FileSource},
	path_policy::VirtualResource,
};

const NOTEBOOK: &str = "{\r\n \"cells\": \
                        [{\"cell_type\":\"code\",\"metadata\":{},\"source\":[\"old\\n\"],\"\
                        outputs\":[],\"execution_count\":null}],\n \"metadata\": \
                        {\"number\":9007199254740993,\"escaped\":\"\\u03bb\"},\r\n \
                        \"nbformat\":4,\"nbformat_minor\":5\r\n}\r\n";

#[test]
fn virtual_notebook_preserves_json_bom_and_each_untouched_line_ending() {
	let ws = Workspace::new(EditMode::ApplyPatch);
	let mut policy = ws.config.policy.clone();
	policy.url_schemes.push("ssh".into());
	let mut files = FileCache::new(policy);
	let url = "ssh://notebook-test/root/启动器.ipynb";
	let original = format!("\u{feff}{NOTEBOOK}");
	files
		.preload_virtual_resource(VirtualResource {
			canonical_url: "ssh://notebook-test/root/%E5%90%AF%E5%8A%A8%E5%99%A8.ipynb".into(),
			display_url:   url.into(),
			content:       Some(original.clone()),
		})
		.unwrap();

	let read = files.read(url).unwrap();
	assert!(!read.is_notebook);
	assert!(read.text.contains("\"source\":[\"old\\n\"]"));
	assert!(!read.text.contains("# %%"));
	let persisted = read
		.persist(&read.text.replace("old\\n", "new\\n"))
		.unwrap();
	assert_eq!(persisted.as_bytes(), original.replace("old\\n", "new\\n").as_bytes());
}

#[test]
fn local_notebook_still_reads_and_persists_the_cell_projection() {
	let ws = Workspace::new(EditMode::Replace);
	ws.write("local.ipynb", NOTEBOOK);
	let mut files = FileCache::new(ws.config.policy.clone());

	let read = files.read("local.ipynb").unwrap();
	assert!(read.is_notebook);
	assert_eq!(read.text, "# %% [code] cell:0\nold\n");
	let persisted = read.persist(&read.text.replace("old", "new")).unwrap();
	let notebook: serde_json::Value = serde_json::from_str(&persisted).unwrap();
	assert_eq!(notebook["cells"][0]["source"], serde_json::json!(["new\n"]));
	assert_eq!(notebook["cells"][0]["execution_count"], serde_json::Value::Null);
}

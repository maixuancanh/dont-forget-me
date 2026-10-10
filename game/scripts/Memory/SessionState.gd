extends RefCounted
var token := ""
var refresh_token := ""
var user: Dictionary = {}
var run_id := ""
var runtime_known := false
var runtime_enabled := false
var pending_turn: Dictionary = {}
var mode := "unknown"
var server_day := 1
var run_revision := 0
var next_event: Dictionary = {}
var resume_scene_id := ""
const SAVE_PATH := "user://memory-run.json"
func remember_run() -> void:
	# Tokens and access codes never go to disk.
	var file := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify({"runId": run_id, "userId": user.get("id", ""), "revision": run_revision, "runtimeVersion": 2 if runtime_enabled else 1}))
func previous_run() -> String:
	if not FileAccess.file_exists(SAVE_PATH):
		return ""
	var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(SAVE_PATH))
	if data is Dictionary and int(data.get("runtimeVersion", 1)) == (2 if runtime_enabled else 1) and str(data.get("userId", "")) == str(user.get("id", "")):
		return str(data.get("runId", ""))
	return ""
func clear() -> void:
	token = ""
	refresh_token = ""
	user = {}
	run_id = ""
	server_day = 1
	run_revision = 0
	next_event = {}
	pending_turn = {}
	resume_scene_id = ""

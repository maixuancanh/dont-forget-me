extends Node
signal case_resolved(result: Dictionary)
const Client = preload("res://scripts/Memory/MemoryClient.gd")
const Session = preload("res://scripts/Memory/SessionState.gd")
const Conversation = preload("res://scripts/Memory/ConversationController.gd")
const ChatPanel = preload("res://scripts/UI/NPCChatPanel.gd")
const Journal = preload("res://scripts/UI/CaseJournal.gd")
const Summary = preload("res://scripts/UI/CaseSummary.gd")
var client: Node
var session = Session.new()
var conversation = Conversation.new()
var is_chat_open := false
var panel: PanelContainer
var content: VBoxContainer
var status: Label
var login: VBoxContainer
var name_input: LineEdit
var code_input: LineEdit
var desktop_proof := ""
var handoff_input: LineEdit
var web_auth_callback: JavaScriptObject
var auth_generation := 0
var resume_input: LineEdit
var development_controls: Array[Control] = []
var desktop_controls: Array[Control] = []
var sign_out_button: Button
var refresh_session_button: Button
var browser_sign_in_button: Button
var browser_resume_button: Button
var development_login_enabled := false
var chat: VBoxContainer
var journal: VBoxContainer
var journal_confirmation: ConfirmationDialog
var summary: RichTextLabel
var revisit_dialog: AcceptDialog
var revisit_list: VBoxContainer
var retry_button: Button
var retry_action: Callable
var failed_requests: Array[Dictionary] = []
var pending_witnesses: Array[Dictionary] = []
var scene_revision := 0
var tree_was_paused := false
signal runtime_ready
signal runtime_action_completed(success: bool)
class RuntimeActionResult extends RefCounted:
	signal completed(success: bool)
var last_scene: Node
var active_runtime_actions: Array[RuntimeActionResult] = []
var returning_to_menu := false

func can_play() -> bool:
	return session.runtime_known and not session.token.is_empty() and not session.user.is_empty() and not session.run_id.is_empty()

func _in_gameplay() -> bool:
	return is_instance_valid(get_tree().current_scene) and not get_tree().current_scene.scene_file_path.ends_with("Menu.tscn")

func _return_to_menu() -> void:
	if returning_to_menu: return
	returning_to_menu = true
	get_tree().paused = true
	_cancel_runtime_actions()
	_return_to_menu_deferred.call_deferred()

func _return_to_menu_deferred() -> void:
	get_tree().change_scene_to_file("res://scenes/levels/Menu.tscn")
	get_tree().paused = false
	returning_to_menu = false

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	client = Client.new()
	add_child(client)
	_build_ui()
	client.activity.connect(func(value: String): status.text = value)
	client.session_refreshed.connect(func(_data: Dictionary):
		session.token = client.token
		session.refresh_token = client.refresh_token)
	_negotiate_runtime(func(): runtime_ready.emit())

func _sync_client_session() -> void:
	client.token = session.token
	client.refresh_token = session.refresh_token
	client.user_id = str(session.user.get("id", ""))

func _process(_delta: float) -> void:
	var current := get_tree().current_scene
	if _in_gameplay() and not can_play():
		_return_to_menu()
		return
	if current != last_scene:
		_cancel_runtime_actions()
		last_scene = current
		scene_revision += 1
		_close()
		conversation.set_npc("")

func _build_ui() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 90
	add_child(layer)
	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var theme := Theme.new()
	theme.default_font = load("res://assets/ui/fonts/Charcoal-Regular.ttf")
	theme.default_font_size = 19
	for type in ["Label", "Button", "LineEdit", "RichTextLabel", "CheckBox"]:
		theme.set_color("font_color", type, Color.WHITE)
		theme.set_color("font_hover_color", type, Color.WHITE)
		theme.set_color("font_pressed_color", type, Color.WHITE)
	root.theme = theme
	layer.add_child(root)
	var toolbar := HBoxContainer.new()
	toolbar.position = Vector2(20, 15)
	root.add_child(toolbar)
	_button(toolbar, "Ask", _open_chat)
	_button(toolbar, "Journal", _open_journal)
	_button(toolbar, "Remembered", _open_summary)
	_button(toolbar, "Call a witness", _open_revisits)
	_button(toolbar, "Phuc’s epilogue", _generate_epilogue)
	_button(toolbar, "Account", _open_login)
	panel = PanelContainer.new()
	panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	panel.offset_left = -340
	panel.offset_right = 340
	panel.offset_top = -265
	panel.offset_bottom = 265
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.10, 0.12, 0.13, 0.98)
	style.border_color = Color(0.6, 0.48, 0.32)
	style.set_border_width_all(3)
	style.content_margin_left = 18
	style.content_margin_right = 18
	style.content_margin_top = 14
	style.content_margin_bottom = 14
	panel.add_theme_stylebox_override("panel", style)
	root.add_child(panel)
	content = VBoxContainer.new()
	panel.add_child(content)
	status = Label.new()
	status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	content.add_child(status)
	login = VBoxContainer.new()
	content.add_child(login)
	var note := Label.new()
	note.text = "Development login · local service\nUse your server-issued name and access code."
	login.add_child(note)
	development_controls.append(note)
	name_input = LineEdit.new()
	name_input.placeholder_text = "Name"
	login.add_child(name_input)
	development_controls.append(name_input)
	code_input = LineEdit.new()
	code_input.placeholder_text = "Access code"
	code_input.secret = true
	login.add_child(code_input)
	development_controls.append(code_input)
	resume_input = LineEdit.new()
	resume_input.placeholder_text = "Existing run ID (optional; saved run resumes automatically)"
	login.add_child(resume_input)
	development_controls.append(resume_input)
	development_controls.append(_button(login, "Sign in and resume", _login))
	development_controls.append(_button(login, "Start a separate new run", func(): _login(true)))
	sign_out_button = _button(login, "Sign out", _logout)
	browser_sign_in_button = _button(login, "Sign in with browser", _browser_login)
	handoff_input = LineEdit.new()
	handoff_input.placeholder_text = "One-time desktop code from browser"
	handoff_input.secret = true
	login.add_child(handoff_input)
	desktop_controls.append(handoff_input)
	desktop_controls.append(_button(login, "Finish browser sign-in", _exchange_login))
	browser_resume_button = _button(login, "Resume browser session", _web_login)
	refresh_session_button = _button(login, "Refresh secure session", _refresh_session)
	_update_login_controls()
	chat = ChatPanel.new()
	content.add_child(chat)
	chat.submitted.connect(_ask)
	chat.object_requested.connect(_show_held_object)
	chat.commerce_requested.connect(_open_commerce)
	chat.stock_selected.connect(_pick_scene_object)
	if OS.has_feature("standalone"):
		_button(chat, "Accept Duy’s promise: keep his identity from Hanh", func(): _mutation("promises", {"npcId": "duy", "action": "accept"}))
		_button(chat, "Reassure Duy: Phuc can hear your account; Hanh will not", func(): _mutation("promises", {"npcId": "duy", "action": "reassure"}))
	journal = Journal.new()
	content.add_child(journal)
	journal.action_requested.connect(_journal_action)
	journal.edit_requested.connect(_preview_journal_action)
	journal.search_requested.connect(_journal_search)
	journal.source_requested.connect(func(id: String):
		if session.runtime_enabled: _request(_path("sources") + "/" + id.uri_encode(), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_source(data)))
	journal.graph_requested.connect(func():
		if session.runtime_enabled: _request(_path("graph"), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_graph(data)))
	journal.memory_requested.connect(_preview_memory_operation)
	journal.operation_status_requested.connect(_read_memory_operation)
	journal.lifecycle_requested.connect(_preview_lifecycle)
	journal.lifecycle_status_requested.connect(_read_lifecycle)
	summary = Summary.new()
	summary.custom_minimum_size = Vector2(0, 320)
	content.add_child(summary)
	summary.source_requested.connect(func(id: String):
		_show(journal)
		_request(_path("sources") + "/" + id.uri_encode(), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_source(data)))
	revisit_dialog = AcceptDialog.new()
	revisit_dialog.title = "Call a witness you have met"
	add_child(revisit_dialog)
	var revisit_scroll := ScrollContainer.new()
	revisit_scroll.custom_minimum_size = Vector2(600, 320)
	revisit_dialog.add_child(revisit_scroll)
	revisit_list = VBoxContainer.new()
	revisit_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	revisit_scroll.add_child(revisit_list)
	retry_button = _button(content, "Retry failed request", func():
		var failures := failed_requests.duplicate()
		failed_requests.clear()
		for failure in failures:
			_request(failure.path, failure.method, failure.payload, failure.callback))
	_button(content, "Resume / close", _close)
	_close()

func _button(parent: Node, text: String, callback: Callable) -> Button:
	var button := Button.new()
	button.text = text
	parent.add_child(button)
	button.pressed.connect(callback)
	return button

func _show(which: Node) -> void:
	if which == login: _update_login_controls()
	if not is_chat_open:
		tree_was_paused = get_tree().paused
	get_tree().paused = true
	panel.show()
	is_chat_open = true
	for item in [login, chat, journal, summary]: item.visible = item == which

func _close() -> void:
	if _in_gameplay() and not can_play():
		_open_login()
		return
	if is_instance_valid(revisit_dialog): revisit_dialog.hide()
	if is_instance_valid(journal_confirmation): journal_confirmation.hide()
	if is_instance_valid(journal):
		if is_instance_valid(journal.memory_dialog): journal.memory_dialog.hide()
		if is_instance_valid(journal.task_dialog): journal.task_dialog.hide()
	if is_chat_open:
		get_tree().paused = tree_was_paused
	if panel: panel.hide()
	is_chat_open = false

func _open_login() -> void:
	_show(login)
	status.text = "Your game is saved to your account." if not session.token.is_empty() else "Sign in with your browser, then return here and select Resume browser session." if OS.has_feature("web") else "Sign in in your browser, then enter its one-time desktop code."

func _update_login_controls() -> void:
	var signed_in: bool = not session.token.is_empty() and not session.user.is_empty()
	for control in development_controls: control.visible = development_login_enabled and not OS.has_feature("web")
	for control in desktop_controls: control.visible = not OS.has_feature("web") and not signed_in
	sign_out_button.visible = signed_in
	refresh_session_button.visible = signed_in
	browser_sign_in_button.visible = not signed_in
	browser_resume_button.visible = OS.has_feature("web") and not signed_in

func _browser_login() -> void:
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.open('/account/', '_blank', 'noopener')")
		status.text = "Sign in in the account tab, return here and select Resume browser session."
		return
	var crypto := Crypto.new()
	desktop_proof = Marshalls.raw_to_base64(crypto.generate_random_bytes(32)).replace("+", "-").replace("/", "_").replace("=", "")
	OS.shell_open(client.base_url + "/account/#challenge=" + desktop_proof.sha256_text())
	status.text = "Sign in in your browser, then paste the one-time desktop code here."

func _web_login() -> void:
	if not session.runtime_known:
		_negotiate_runtime(_web_login)
		return
	if not OS.has_feature("web"):
		status.text = "Use the desktop one-time code on this device."
		return
	auth_generation += 1
	web_auth_callback = JavaScriptBridge.create_callback(_web_auth_result.bind(auth_generation))
	var window := JavaScriptBridge.get_interface("window")
	window.dfmAuthCallback = web_auth_callback
	JavaScriptBridge.eval("((callback)=>{(async()=>{try{let r=await fetch('/v1/auth/csrf',{credentials:'same-origin'});let m=await r.json();r=await fetch('/v1/auth/access',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':m.csrfToken},body:'{}'});let s=await r.json();if(!r.ok)throw Error('Sign in in the account tab first.');callback(JSON.stringify(s));}catch(e){callback(JSON.stringify({error:e.message}));}})();})(window.dfmAuthCallback)")

func _web_auth_result(args: Array, requested_generation: int) -> void:
	if requested_generation != auth_generation: return
	var data: Variant = JSON.parse_string(str(args[0]))
	if not data is Dictionary or data.has("error"):
		status.text = str(data.get("error", "Browser login failed.")) if data is Dictionary else "Browser login failed."
		return
	_cancel_runtime_actions()
	client.cancel_all()
	session.clear()
	session.token = str(data.get("accessToken", ""))
	session.user = {"id": str(data.get("userId", ""))}
	_sync_client_session()
	_update_login_controls()
	failed_requests.clear()
	pending_witnesses.clear()
	var previous := session.previous_run()
	if previous.is_empty():
		_resume_account_run()
	else:
		_request(_run_path(previous), HTTPClient.METHOD_GET, {}, _run_ready)

func _exchange_login() -> void:
	if not session.runtime_known:
		_negotiate_runtime(_exchange_login)
		return
	if desktop_proof.is_empty() or handoff_input.text.is_empty():
		status.text = "Open browser sign-in first and paste its one-time code."
		return
	_cancel_runtime_actions()
	client.cancel_all()
	_request("/v1/auth/exchange", HTTPClient.METHOD_POST, {"code": handoff_input.text.strip_edges(), "proof": desktop_proof}, func(data: Dictionary):
		session.clear()
		session.token = str(data.get("accessToken", ""))
		session.refresh_token = str(data.get("refreshToken", ""))
		session.user = {"id": str(data.get("userId", ""))}
		_sync_client_session()
		_update_login_controls()
		handoff_input.clear()
		desktop_proof = ""
		pending_witnesses.clear()
		failed_requests.clear()
		var previous := session.previous_run()
		if previous.is_empty():
			_resume_account_run()
		else:
			_request(_run_path(previous), HTTPClient.METHOD_GET, {}, _run_ready))

func _refresh_session() -> void:
	_cancel_runtime_actions()
	if OS.has_feature("web"):
		_web_login()
		return
	if session.refresh_token.is_empty():
		status.text = "Sign in with browser first."
		return
	_request("/v1/auth/refresh", HTTPClient.METHOD_POST, {"refreshToken": session.refresh_token}, func(data: Dictionary):
		session.token = str(data.get("accessToken", ""))
		session.refresh_token = str(data.get("refreshToken", ""))
		_sync_client_session()
		status.text = "Secure session refreshed.")

func _resume_account_run() -> void:
	if session.runtime_enabled:
		_request(_run_path(), HTTPClient.METHOD_GET, {}, func(data: Dictionary):
			var runs: Array = data.get("runs", [])
			if runs.is_empty():
				_request(_run_path(), HTTPClient.METHOD_POST, {}, _run_ready)
			else:
				_request(_run_path(str(runs.back().id)), HTTPClient.METHOD_GET, {}, _run_ready))
		return
	_request("/v1/auth/runs", HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		var runs: Array = data.get("runs", [])
		if runs.is_empty():
			_request(_run_path(), HTTPClient.METHOD_POST, {}, _run_ready)
		else:
			var latest: Dictionary = runs.back()
			_request(_run_path(str(latest.get("id", ""))), HTTPClient.METHOD_GET, {}, _run_ready))

func _login(new_run: bool = false) -> void:
	if not session.runtime_known:
		_negotiate_runtime(func(): _login(new_run))
		return
	if new_run:
		pending_witnesses.clear()
	if name_input.text.strip_edges().is_empty() or code_input.text.is_empty():
		status.text = "Enter your name and server access code."
		return
	_request("/v1/session", HTTPClient.METHOD_POST, {"name": name_input.text.strip_edges(), "accessCode": code_input.text}, func(data: Dictionary):
		if not data.get("token", "") is String or str(data.get("token", "")).is_empty() or not data.get("user", {}) is Dictionary:
			status.text = "Invalid login response."
			return
		session.token = data.token
		session.user = data.user
		_sync_client_session()
		_update_login_controls()
		code_input.clear()
		var previous := "" if new_run else resume_input.text.strip_edges()
		if previous.is_empty() and not new_run: previous = session.previous_run()
		if previous.is_empty():
			_request(_run_path(), HTTPClient.METHOD_POST, {}, _run_ready)
		else:
			_request(_run_path(previous), HTTPClient.METHOD_GET, {}, _run_ready))

func _run_ready(data: Dictionary) -> void:
	var run: Dictionary = data.get("run", data)
	session.run_id = str(run.get("id", run.get("runId", "")))
	if session.run_id.is_empty():
		status.text = "Invalid run response."
		return
	session.mode = str(data.get("mode", run.get("mode", "unknown")))
	session.server_day = clampi(int(run.get("day", 1)), 1, 6)
	session.run_revision = int(run.get("revision", 0))
	var next: Variant = data.get("nextEvent", run.get("nextEvent", {}))
	session.next_event = next if next is Dictionary else {}
	session.resume_scene_id = str(session.next_event.get("sceneId", ""))
	session.pending_turn = data.get("pendingTurn", {}) if data.get("pendingTurn", {}) is Dictionary else {}
	session.remember_run()
	if run.get("state", {}).get("revisit") is Dictionary:
		set_npc(str(session.next_event.get("npcId", "")))
	status.text = "Run ready · " + session.mode + ". Storage confirmation is shown per source."
	var queued := pending_witnesses.duplicate()
	pending_witnesses.clear()
	for event in queued: witness(event.sceneId, event.stepIndex)

func refresh_run(callback: Callable) -> void:
	if session.run_id.is_empty(): return
	_show(summary)
	summary.text = "Checking your saved story checkpoint…"
	_request(_run_path(session.run_id), HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		_run_ready(data)
		_close()
		callback.call())

func _logout() -> void:
	_cancel_runtime_actions()
	auth_generation += 1
	_cancel_runtime_actions()
	client.cancel_all()
	if session.token.length() == 43:
		# Captures bearer header before clearing local state; callback cannot restore caches.
		client.send("/v1/auth/logout", HTTPClient.METHOD_POST, {}, func(_ok: bool, _data: Dictionary): pass)
	client.token = ""
	client.refresh_token = ""
	client.user_id = ""
	session.clear()
	pending_witnesses.clear()
	conversation.set_npc("")
	retry_action = Callable()
	failed_requests.clear()
	retry_button.hide()
	if _in_gameplay(): _return_to_menu()
	_open_login()

func set_npc(npc_id: String) -> void:
	conversation.set_npc(npc_id.to_lower())

func witness(scene_id: String, step_index: int) -> void:
	if session.runtime_enabled: return
	if session.run_id.is_empty():
		pending_witnesses.append({"sceneId": scene_id, "stepIndex": step_index})
		return
	_mutation("events", {"sceneId": scene_id, "stepIndex": step_index})

func _open_chat() -> void:
	if session.run_id.is_empty():
		_open_login()
		return
	_show(chat)
	_refresh_object_picker()
	status.text = "Ask " + conversation.npc_id.capitalize() if not conversation.npc_id.is_empty() else "Speak with an eligible customer first."

func _ask(message: String, shown_instance: String = "") -> void:
	if conversation.npc_id.is_empty():
		chat.answer("Journal", "Speak with an eligible customer first.", [])
		return
	var npc: String = conversation.npc_id
	var revision: int = conversation.revision
	chat.busy(true)
	if session.runtime_enabled:
		var client_turn := conversation.turn_id()
		var body := {"npcId":npc,"message":message,"clientTurnId":client_turn,"expectedRevision":session.run_revision,"trigger":"player_question","beatId":session.next_event.get("beatId", ""),"presentedRecordIds":[]}
		if not shown_instance.is_empty():
			body.trigger = "object_shown"
			body.heldItemInstanceId = shown_instance
		_request(_path("turns"), HTTPClient.METHOD_POST, body, func(data: Dictionary):
			if revision != conversation.revision: return
			chat.answer(npc, str(data.get("utterance", "")), data.get("citations", []))
			session.run_revision = int(data.runRevision)
			_request(_path("turns") + "/" + str(data.turnId).uri_encode() + "/ack", HTTPClient.METHOD_POST, {"expectedRevision":session.run_revision,"clientActionId":client_turn + "-ack"}, func(ack: Dictionary):
				if not ack.get("acknowledged", false): return
				apply_checkpoint(ack)
				acknowledged_offers(data)))
		return
	_request(_path("chat"), HTTPClient.METHOD_POST, {"npcId": npc, "message": message, "clientTurnId": conversation.turn_id()}, func(data: Dictionary):
		chat.busy(false)
		if revision != conversation.revision: return
		chat.answer(npc, str(data.get("text", "No supported reply returned.")), data.get("sourceIds", data.get("sources", []))))

func _open_journal() -> void:
	if session.run_id.is_empty():
		_open_login()
		return
	_show(journal)
	_journal_search("", "")
	_refresh_journal_offers()
	_refresh_journal_tasks()

func _refresh_journal_tasks() -> void:
	if not session.runtime_enabled or session.run_id.is_empty(): return
	_request(_path("tasks"), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_tasks(data.get("tasks", [])))
	_request(_path("recap"), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_recap(data))

func _read_memory_operation(operation_id: String) -> void:
	if not session.runtime_enabled: return
	_request(_path("memory/operations") + "/" + operation_id.uri_encode(), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_memory_operation(data))

func _preview_memory_operation(action: Dictionary) -> void:
	if not session.runtime_enabled:
		journal.operation_text.text = "Memory operations require the authenticated runtime. No operation was dispatched."
		return
	var frozen: Dictionary = action.duplicate(true)
	frozen["operationId"] = "memory-" + str(Time.get_ticks_usec()) + "-" + str(randi())
	journal.operation_id_input.text = frozen.operationId
	var captured_run: String = session.run_id
	var captured_auth: String = session.token
	_request(_path("memory/preview"), HTTPClient.METHOD_POST, frozen, func(preview: Dictionary):
		if captured_run != session.run_id or captured_auth != session.token: return
		var scope: Dictionary = preview.get("scope", {})
		var revision: Variant = preview.get("revision", scope.get("revision"))
		if not (revision is int or revision is float) or str(preview.get("confirmationHash", "")).is_empty() or str(preview.get("disclosure", "")).is_empty():
			journal.operation_text.text = "Invalid operation preview; nothing dispatched."
			return
		var request: Dictionary = preview.get("request", {})
		if frozen.kind == "analyze" and str(request.get("text", "")).strip_edges().is_empty():
			journal.operation_text.text = "The preview did not include the exact selected note; nothing dispatched."
			return
		var disclosure := str(preview.disclosure)
		if frozen.kind == "analyze": disclosure += "\n\nExact selected note:\n" + str(request.get("text", ""))
		else: disclosure += "\n\nIndex lane: %s · Limit: %s" % [frozen.lane, frozen.limit]
		disclosure += "\n\nConsent hash: " + str(preview.confirmationHash)
		var payload := {"action":frozen.duplicate(true),"expectedRevision":int(revision),"clientActionId":"memory-consent-" + str(Time.get_ticks_usec()) + "-" + str(randi()),"confirmed":true,"confirmationHash":str(preview.confirmationHash)}
		if is_instance_valid(journal_confirmation): journal_confirmation.hide(); journal_confirmation.queue_free()
		journal_confirmation = ConfirmationDialog.new()
		journal_confirmation.title = "Confirm opt-in memory operation"
		journal_confirmation.dialog_autowrap = true
		journal_confirmation.dialog_text = disclosure
		add_child(journal_confirmation)
		journal_confirmation.confirmed.connect(func():
			if captured_run == session.run_id and captured_auth == session.token: _commit_memory_operation(payload.duplicate(true))
			journal_confirmation.hide())
		journal_confirmation.canceled.connect(journal_confirmation.hide)
		journal_confirmation.popup_centered(Vector2i(720, 520)))

func _commit_memory_operation(payload: Dictionary) -> void:
	_request(_path("memory/operations"), HTTPClient.METHOD_POST, payload, func(data: Dictionary):
		if data.get("runRevision") is int or data.get("runRevision") is float: session.run_revision = int(data.runRevision)
		journal.render_memory_operation(data)
		status.text = "Memory operation recorded. Open Memory operations to read its status."
		_read_memory_operation(str(payload.action.operationId)))

func _refresh_journal_offers() -> void:
	if not session.runtime_enabled or session.run_id.is_empty(): return
	_request(_path("offers"), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_offers(data.get("offers", [])))

func acknowledged_offers(turn: Dictionary) -> void:
	# Invoked only after the displayed generated turn ACK succeeds. Never accepts automatically.
	for proposal in turn.get("pendingActions", []):
		if proposal is Dictionary and proposal.get("kind", "") == "offer_commitment":
			_refresh_journal_offers()
			status.text = "An offered promise is ready to review in the Journal."
			return

func _journal_search(query: String, cursor: String) -> void:
	if not session.runtime_enabled and not OS.has_feature("standalone"):
		journal.message("Sign in to the memory runtime to read your journal.")
		return
	var path := _path("journal")
	if session.runtime_enabled:
		path += "?limit=25&query=" + query.uri_encode()
		if not cursor.is_empty(): path += "&cursor=" + cursor.uri_encode()
	_request(path, HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_page(data, not cursor.is_empty()))

func _preview_journal_action(action: Dictionary) -> void:
	if not session.runtime_enabled:
		journal.message("Journal edits require the memory runtime.")
		return
	var frozen_action: Dictionary = action.duplicate(true)
	var captured_run: String = session.run_id
	var captured_auth: String = session.token
	_request(_path("journal/preview"), HTTPClient.METHOD_POST, frozen_action, func(preview: Dictionary):
		if captured_run != session.run_id or captured_auth != session.token: return
		if not (preview.get("revision") is int or preview.get("revision") is float) or str(preview.get("consentHash", "")).is_empty() or not preview.get("quotes") is Array or not preview.get("atRisk") is Array:
			journal.message("Invalid consent preview. Request a new preview.")
			return
		var text := "Action: " + str(frozen_action.get("kind", ""))
		if frozen_action.has("text"): text += "\nYour text:\n" + str(frozen_action.text)
		if frozen_action.has("recipient"): text += "\nRecipient: " + str(frozen_action.recipient).capitalize()
		text += "\n\nExact selected sources:\n"
		for quote in preview.quotes:
			if quote is Dictionary: text += "%s · %s\n%s\n\n" % [quote.get("id", ""), quote.get("actor", ""), quote.get("text", "")]
		if preview.quotes.is_empty(): text += "No sources selected.\n"
		text += "\nAt-risk commitments: " + str(preview.atRisk)
		if preview.has("commitment"): text += "\nProposed commitment:\n" + JSON.stringify(preview.commitment, "  ")
		var payload := {"action":frozen_action.duplicate(true),"expectedRevision":int(preview.revision),"consentHash":str(preview.consentHash),"clientActionId":"journal-" + str(Time.get_ticks_usec()) + "-" + str(randi())}
		var confirmation := ConfirmationDialog.new()
		if is_instance_valid(journal_confirmation):
			journal_confirmation.hide()
			journal_confirmation.queue_free()
		journal_confirmation = confirmation
		confirmation.title = "Confirm journal action"
		confirmation.dialog_autowrap = true
		confirmation.dialog_text = text
		add_child(confirmation)
		confirmation.confirmed.connect(func():
			if captured_run == session.run_id and captured_auth == session.token: _commit_journal_action(payload.duplicate(true))
			confirmation.queue_free())
		confirmation.canceled.connect(confirmation.queue_free)
		confirmation.popup_centered(Vector2i(720, 520)))

func _commit_journal_action(payload: Dictionary) -> void:
	# The common retry queue retains this exact consent hash, revision, action and ID.
	_request(_path("journal/actions"), HTTPClient.METHOD_POST, payload, func(data: Dictionary):
		session.run_revision = int(data.runRevision)
		if str(payload.action.get("kind", "")) == "share":
			journal.message("Recorded disclosure. Ask the recipient a follow-up for a generated response.")
		else: journal.message(str(data.get("text", "Journal action recorded.")))
		if str(payload.action.get("kind", "")) in ["accept_promise", "accept_task"]: _refresh_journal_offers()
		if str(payload.action.get("kind", "")) in ["accept_task", "withdraw_task"]: _refresh_journal_tasks()
		status.text = "Journal action recorded; original sources retained.")

func _open_summary() -> void:
	if session.run_id.is_empty():
		_open_login()
		return
	_show(summary)
	_request(_path("summary"), HTTPClient.METHOD_GET, {}, func(data: Dictionary): summary.render(data))

func _journal_action(action: String, ids: Array) -> void:
	if action in ["accept_promise", "accept_task"]:
		if ids.size() == 2: _preview_journal_action({"kind":action,"turnId":str(ids[0]),"proposalId":str(ids[1])})
		return
	if action == "compare" and ids.size() != 2:
		journal.message("Choose exactly two different sources to compare.")
		return
	if ids.is_empty():
		journal.message("Select source cards first.")
		return
	if action in ["phuc", "hanh"]:
		if session.runtime_enabled:
			_preview_journal_action({"kind":"share","recipient":action,"recordIds":ids.duplicate()})
			return
		if not OS.has_feature("standalone"):
			journal.message("Disclosure requires the memory runtime.")
			return
		if ids.size() != 1:
			journal.message("Select one quote to preview and share with " + action.capitalize() + ".")
			return
		var confirmation := ConfirmationDialog.new()
		confirmation.dialog_autowrap = true
		confirmation.title = "Disclose selected testimony"
		confirmation.dialog_text = "Share this source with %s?\n\n%s\n\nSharing Duy’s identity with Hanh can break your promise." % [action.capitalize(), str(journal.record_quotes.get(ids[0], "Selected testimony"))]
		add_child(confirmation)
		confirmation.confirmed.connect(func(): _mutation("share", {"recordId": ids[0], "recipient": action}); confirmation.queue_free())
		confirmation.canceled.connect(confirmation.queue_free)
		confirmation.popup_centered(Vector2i(640,360))
	else:
		_mutation(action, {"recordIds": ids})

func _mutation(endpoint: String, payload: Dictionary) -> void:
	if session.run_id.is_empty(): return
	if not session.runtime_enabled and not OS.has_feature("standalone"):
		status.text = "This action requires the memory runtime."
		return
	if session.runtime_enabled and endpoint == "confront":
		_preview_journal_action({"kind":"share","recipient":"hanh","recordIds":payload.get("recordIds", []).duplicate()})
		return
	var frozen_payload: Dictionary = payload.duplicate(true)
	if session.runtime_enabled and endpoint == "case":
		frozen_payload["expectedRevision"] = session.run_revision
		frozen_payload["clientActionId"] = "case-" + str(Time.get_ticks_usec()) + "-" + str(randi())
	_request(_path(endpoint), HTTPClient.METHOD_POST, frozen_payload, func(data: Dictionary):
		if endpoint == "case":
			if session.runtime_enabled:
				session.run_revision = int(data.runRevision)
				if str(data.get("outcome", "")) == "pending":
					journal.message("Case sources are still being verified. The ending remains closed; retry after storage confirms.")
					return
			if str(data.get("outcome", "")) == "resolved":
				_close()
				case_resolved.emit(data)
				return
			_show(summary)
			summary.render(data)
			_request(_path("summary"), HTTPClient.METHOD_GET, {}, func(result: Dictionary): summary.render(result))
		elif endpoint == "confront":
			set_npc(str(data.get("npcId", "hanh")))
			_show(chat)
			chat.answer("hanh", str(data.get("text", "No supported response returned.")), data.get("sourceIds", []))
			status.text = "Hanh has seen the sources you explicitly disclosed. Ask a follow-up."
		elif endpoint in ["share", "compare", "promises"]:
			journal.message(str(data.get("text", data.get("message", "Action accepted. Refresh the journal to review its sources."))))
			status.text = "Action accepted. Journal retains the original sources."
			if endpoint == "compare" and data.get("supported", false):
				_confirm_confrontation(frozen_payload.get("recordIds", []), str(data.get("text", "Supported contradiction"))) )

func _confirm_confrontation(ids: Array, explanation: String) -> void:
	if ids.size() != 2: return
	var selected: Array = ids.duplicate()
	if session.runtime_enabled:
		journal.message(explanation)
		_preview_journal_action({"kind":"share","recipient":"hanh","recordIds":selected})
		return
	if not OS.has_feature("standalone"): return
	var confirmation := ConfirmationDialog.new()
	confirmation.dialog_autowrap = true
	confirmation.title = "Show both sources to Hanh?"
	confirmation.dialog_text = "%s\n\nFirst source:\n%s\n\nSecond source:\n%s\n\nConfirming discloses both sources to Hanh. Revealing Duy’s identity can break your promise. Comparing alone does not disclose them." % [explanation, str(journal.record_quotes.get(selected[0], "Selected source")), str(journal.record_quotes.get(selected[1], "Selected source"))]
	add_child(confirmation)
	confirmation.confirmed.connect(func():
		_mutation("confront", {"recordIds": selected})
		confirmation.queue_free())
	confirmation.canceled.connect(confirmation.queue_free)
	confirmation.popup_centered(Vector2i(680,500))

func _path(endpoint: String) -> String:
	return _run_path(session.run_id) + "/" + endpoint

func _request(path: String, method: int, payload: Dictionary, callback: Callable) -> void:
	var identity: String = session.run_id
	var generation_at_send: int = client.generation
	var scene_at_send := scene_revision
	var scene_bound := path.ends_with("/chat") or path.contains("/journal") or path.contains("/memory/") or path.ends_with("/offers") or path.ends_with("/tasks") or path.ends_with("/recap") or path.ends_with("/graph") or path.contains("/sources/") or path.ends_with("/summary") or path.ends_with("/revisits") or path.ends_with("/epilogue") or path.ends_with("/compare") or path.ends_with("/confront")
	scene_bound = scene_bound or path.contains("/objects/") or path.contains("/commerce") or path.ends_with("/tokens") or path.ends_with("/actions") or path.contains("/turns")
	client.send(path, method, payload, func(ok: bool, data: Dictionary):
		# MemoryClient only adopts refreshed credentials for the same user.
		# Cancellation/account replacement increments generation; token rotation does not.
		if generation_at_send != client.generation: return
		if not identity.is_empty() and identity != session.run_id: return
		chat.busy(false)
		if scene_bound and scene_at_send != scene_revision: return
		if ok and path == "/v2/runtime" and not data.get("enabled") is bool:
			ok = false
			data = {"error": "Invalid runtime configuration. Retry; story held."}
		if ok and path.begins_with("/v2/runs/") and path.ends_with("/tokens") and (str(data.get("token", "")).is_empty() or not (data.get("revision") is int or data.get("revision") is float)):
			ok = false
			data = {"error": "Invalid action token. Retry; story held."}
		if ok and path.begins_with("/v2/runs/") and path.ends_with("/actions") and (not (data.get("runRevision") is int or data.get("runRevision") is float) or (not path.ends_with("/journal/actions") and not data.get("nextEvent") is Dictionary)):
			ok = false
			data = {"error": "Invalid action checkpoint. Retry; story held."}
		if ok and path.begins_with("/v2/runs/") and path.ends_with("/case") and (not (data.get("runRevision") is int or data.get("runRevision") is float) or str(data.get("outcome", "")) not in ["pending", "unresolved", "resolved"]):
			ok = false
			data = {"error":"Invalid case result. Retry; ending held."}
		if ok and path.ends_with("/revisits") and method == HTTPClient.METHOD_POST and (not data.get("nextEvent") is Dictionary or str(data.get("nextEvent", {}).get("npcId", "")).is_empty() or not (data.get("runRevision") is int or data.get("runRevision") is float)):
			ok = false
			data = {"error":"Invalid revisit checkpoint. Conversation held."}
		if ok and path.ends_with("/epilogue") and (str(data.get("utterance", "")).strip_edges().is_empty() or not data.get("citations") is Array or str(data.get("outcome", "")) not in ["resolved", "unresolved"] or data.get("generation", "") != "llm" or not (data.get("runRevision") is int or data.get("runRevision") is float)):
			ok = false
			data = {"error":"Invalid generated epilogue. The recorded case outcome is unchanged."}
		if not ok:
			if path.ends_with("/epilogue") and str(data.get("error", "")) == "EPILOGUE_NOT_AVAILABLE":
				status.text = "Phuc's epilogue is not unlocked yet."
				summary.epilogue_locked()
				retry_button.visible = not failed_requests.is_empty()
				return
			if path.ends_with("/epilogue"): summary.operation_failed(str(data.get("error", "Generation unavailable")))
			if path.contains("/memory/lifecycle/") and path.ends_with("/confirm"):
				journal.operation_text.text = "Confirmation outcome unknown. Read status before trying any new operation."
				_read_lifecycle(path.get_slice("/memory/lifecycle/", 1).get_slice("/", 0))
				return
			if path == "/v2/runtime": _show(login)
			status.text = str(data.get("error", "Memory request failed. Retry."))
			if path.contains("/memory/"):
				journal.operation_text.text = status.text + "\nNo fallback was used."
				if path.ends_with("/memory/operations") and method == HTTPClient.METHOD_POST:
					var operation_id := str(payload.get("action", {}).get("operationId", ""))
					journal.render_memory_operation({"operationId":operation_id,"status":"unknown","errorCode":status.text})
					if not operation_id.is_empty(): _read_memory_operation(operation_id)
					return
			failed_requests.append({"path": path, "method": method, "payload": payload.duplicate(true), "callback": callback})
			retry_button.show()
			return
		retry_button.visible = not failed_requests.is_empty()
		var mode := str(data.get("mode", session.mode))
		status.text = "Local service · not Mainnet verified" if mode in ["mock", "local", "unknown"] else mode + " · check journal provenance for confirmation"
		callback.call(data))


func _run_path(run_id: String = "") -> String:
	var prefix := "/v2/runs" if session.runtime_enabled else "/v1/runs"
	return prefix if run_id.is_empty() else prefix + "/" + run_id.uri_encode()

func _negotiate_runtime(callback: Callable) -> void:
	_request("/v2/runtime", HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		if not data.get("enabled") is bool:
			status.text = "Invalid runtime configuration. Story held."
			return
		session.runtime_known = true
		session.runtime_enabled = data.enabled
		development_login_enabled = str(data.get("mode", "")) == "development"
		_update_login_controls()
		callback.call())

func apply_checkpoint(data: Dictionary) -> void:
	session.run_revision = int(data.get("runRevision", session.run_revision))
	if data.get("nextEvent") is Dictionary: session.next_event = data.nextEvent
	session.pending_turn = {}
	session.remember_run()

# Invoked only after the physical task/explicit choice has succeeded locally.
# Server validates sequencing; the client task is not anti-cheat attestation.
func complete_runtime_action(kind: String, intent: String = "") -> bool:
	if not session.runtime_enabled:
		return true
	var action_id := "action-" + str(Time.get_ticks_usec()) + "-" + str(randi())
	var completion := RuntimeActionResult.new()
	active_runtime_actions.append(completion)
	_request(_path("tokens"), HTTPClient.METHOD_POST, {"expectedRevision": session.run_revision, "kind": kind}, func(issued: Dictionary):
		if not active_runtime_actions.has(completion): return
		if str(issued.get("token", "")).is_empty():
			status.text = "Invalid action token. Story held."
			return
		var payload := {"expectedRevision": issued.get("revision", session.run_revision), "token": issued.token, "clientActionId": action_id}
		if not intent.is_empty(): payload.intent = intent
		_request(_path("actions"), HTTPClient.METHOD_POST, payload, func(result: Dictionary):
			if not active_runtime_actions.has(completion): return
			apply_checkpoint(result)
			active_runtime_actions.erase(completion)
			completion.completed.emit(true)))

	return await completion.completed

func _cancel_runtime_actions() -> void:
	var pending := active_runtime_actions.duplicate()
	active_runtime_actions.clear()
	for action in pending: action.completed.emit(false)

func _open_revisits() -> void:
	if session.run_id.is_empty(): _open_login(); return
	if not session.runtime_enabled: status.text = "Witness calls require the authenticated memory runtime."; return
	_show(summary)
	_request(_path("revisits"), HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		for child in revisit_list.get_children(): child.queue_free()
		var options: Array = data.get("options", [])
		for option in options:
			if not option is Dictionary: continue
			var frozen: Dictionary = option.duplicate(true)
			var beat_id := str(frozen.get("beatId", ""))
			var npc_id := str(frozen.get("npcId", ""))
			if beat_id.is_empty() or npc_id.is_empty(): continue
			var button := _button(revisit_list, npc_id.capitalize() + " · " + str(frozen.get("objective", "Follow up")), func(): _select_revisit(frozen))
			button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		if options.is_empty():
			var label := Label.new()
			label.text = "No eligible witnessed conversation is available. Continue the current investigation."
			revisit_list.add_child(label)
		revisit_dialog.popup_centered(Vector2i(650, 400)))

func _select_revisit(option: Dictionary) -> void:
	var frozen := {"beatId":str(option.get("beatId", "")),"expectedRevision":session.run_revision,"clientActionId":"revisit-" + str(Time.get_ticks_usec()) + "-" + str(randi())}
	revisit_dialog.hide()
	_request(_path("revisits"), HTTPClient.METHOD_POST, frozen, func(data: Dictionary):
		apply_checkpoint(data)
		session.resume_scene_id = str(session.next_event.get("sceneId", ""))
		set_npc(str(session.next_event.get("npcId", "")))
		_open_chat()
		status.text = "Calling " + conversation.npc_id.capitalize() + ". Your investigation checkpoint is preserved.")

func _generate_epilogue() -> void:
	if session.run_id.is_empty(): _open_login(); return
	if not session.runtime_enabled: status.text = "Generated epilogue requires the authenticated memory runtime."; return
	_show(summary)
	if session.server_day < 6:
		status.text = "Phuc's epilogue is not unlocked yet."
		summary.epilogue_locked()
		return
	var frozen := {"expectedRevision":session.run_revision,"clientActionId":"epilogue-" + str(Time.get_ticks_usec()) + "-" + str(randi())}
	status.text = "Phuc is reviewing the reported sources…"
	_request(_path("epilogue"), HTTPClient.METHOD_POST, frozen, func(data: Dictionary):
		session.run_revision = int(data.runRevision)
		session.remember_run()
		summary.render(data))

func _read_lifecycle(operation_id: String) -> void:
	if not session.runtime_enabled or operation_id.is_empty(): return
	_request(_path("memory/lifecycle") + "/" + operation_id.uri_encode(), HTTPClient.METHOD_GET, {}, func(data: Dictionary): journal.render_lifecycle(data))

func _preview_lifecycle(action: Dictionary) -> void:
	if not session.runtime_enabled: journal.operation_text.text = "Lifecycle operations require the authenticated runtime. Nothing changed."; return
	var frozen: Dictionary = action.duplicate(true)
	var captured_run: String = session.run_id
	var captured_auth: String = session.token
	_request(_path("memory/lifecycle/preview"), HTTPClient.METHOD_POST, frozen, func(preview: Dictionary):
		if captured_run != session.run_id or captured_auth != session.token: return
		var operation_id := str(preview.get("operationId", ""))
		var consent_hash := str(preview.get("confirmationHash", ""))
		if operation_id.is_empty() or consent_hash.is_empty() or not preview.get("recordIds") is Array or str(preview.get("disclosure", "")).is_empty():
			journal.operation_text.text = "Invalid lifecycle preview. No records changed."; return
		journal.lifecycle_id_input.text = operation_id
		var disclosure := str(preview.disclosure) + "\n\nAffected record IDs, including descendants:\n" + str(preview.recordIds)
		disclosure += "\n\nExternal operation available: " + str(preview.get("supported", false))
		if frozen.kind == "renew": disclosure += "\nAdditional epochs: %s · Maximum WAL: %s\nQuote: %s" % [frozen.epochs, frozen.ceiling, str(preview.get("quote", {}))]
		else: disclosure += "\nThis blocks records locally on confirmation. Unsupported does not mean externally deleted."
		if is_instance_valid(journal_confirmation): journal_confirmation.hide(); journal_confirmation.queue_free()
		journal_confirmation = ConfirmationDialog.new()
		journal_confirmation.title = "Confirm " + str(frozen.kind) + " scope"
		journal_confirmation.dialog_autowrap = true
		journal_confirmation.dialog_text = disclosure
		add_child(journal_confirmation)
		var confirmation := {"confirmed":true,"confirmationHash":consent_hash}
		journal_confirmation.confirmed.connect(func():
			if captured_run != session.run_id or captured_auth != session.token: return
			_request(_path("memory/lifecycle") + "/" + operation_id.uri_encode() + "/confirm", HTTPClient.METHOD_POST, confirmation.duplicate(true), func(result: Dictionary):
				result["preview"] = {"action":frozen.duplicate(true)}
				journal.render_lifecycle(result)
				if result.get("runRevision") is int or result.get("runRevision") is float: session.run_revision = int(result.runRevision)
				_read_lifecycle(operation_id))
			journal_confirmation.hide())
		journal_confirmation.canceled.connect(journal_confirmation.hide)
		journal_confirmation.popup_centered(Vector2i(720, 520)))

# Physical item selection is a separate Show action. It never calls an ItemReceiver.
func _held_object() -> Dictionary:
	for manager in get_tree().get_nodes_in_group("physical_item_managers"):
		var value: Dictionary = manager.held_object_snapshot()
		if not value.is_empty(): return value
	return {}

func _bind_held_object(after: Callable) -> void:
	var snapshot := _held_object()
	if snapshot.is_empty(): status.text = "Pick up an item from the shop first."; return
	if str(snapshot.get("clientSlot", "")).is_empty(): status.text = "This item has no authorized shop stock slot."; return
	if not session.runtime_enabled: status.text = "Showing items requires your saved game session."; return
	var physical: Node = snapshot.node
	var frozen_scene := scene_revision
	var payload := {"expectedRevision":session.run_revision,"clientActionId":conversation.turn_id(),"itemId":snapshot.itemId,"quantity":snapshot.quantity,"clientSlot":snapshot.clientSlot}
	_request(_path("objects/bind"), HTTPClient.METHOD_POST, payload, func(data: Dictionary):
		apply_checkpoint(data)
		if frozen_scene != scene_revision or not is_instance_valid(physical): return
		var current := _held_object()
		if current.is_empty() or current.node != physical:
			_request(_path("objects/hold"), HTTPClient.METHOD_POST, {"expectedRevision":session.run_revision,"clientActionId":conversation.turn_id(),"instanceId":null}, apply_checkpoint)
			return
		var object: Dictionary = data.get("result", {}).get("item", {})
		var instance := str(object.get("instanceId", ""))
		if instance.is_empty(): status.text = "Object binding unavailable."; return
		physical.set_meta("memory_object_instance", instance)
		physical.set_meta("memory_object_run", session.run_id)
		after.call(instance))

func release_shown_object(physical: Node) -> void:
	if not session.runtime_enabled or not physical.has_meta("memory_object_instance"): return
	if str(physical.get_meta("memory_object_run", "")) != session.run_id: return
	_request(_path("objects/hold"), HTTPClient.METHOD_POST, {"expectedRevision":session.run_revision,"clientActionId":conversation.turn_id(),"instanceId":null}, apply_checkpoint)

func _show_held_object(message: String) -> void:
	if conversation.npc_id.is_empty(): status.text = "Speak with a customer first."; return
	_bind_held_object(func(instance: String): _ask(message if not message.is_empty() else "Does this item remind you of something we discussed?", instance))

func _open_commerce() -> void:
	if not session.runtime_enabled: status.text = "Orders and reservations require your saved game session."; return
	_request(_path("commerce"), HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		var dialog := AcceptDialog.new()
		dialog.title = "Order and reservations · " + str(data.get("npcId", "")).capitalize()
		add_child(dialog)
		var controls := VBoxContainer.new()
		dialog.add_child(controls)
		var note := Label.new()
		note.text = "Show keeps stock. Reserve sets it aside. Fulfill gives it to the returning customer."
		controls.add_child(note)
		_button(controls, "Reserve held item", func():
			dialog.hide()
			_bind_held_object(func(instance: String): _commerce_action({"kind":"reserve","instanceId":instance})))
		for reservation in data.get("reservations", []):
			if str(reservation.get("status", "")) != "reserved": continue
			var id := str(reservation.id)
			_button(controls, "Fulfill reserved " + str(reservation.itemId), func(): dialog.hide(); _commerce_action({"kind":"fulfill_reservation","reservationId":id}))
			_button(controls, "Cancel reservation " + str(reservation.itemId), func(): dialog.hide(); _commerce_action({"kind":"cancel_reservation","reservationId":id}))
		if str(data.get("phase", "")) == "order":
			var picker := OptionButton.new()
			var catalog: Array = data.get("catalog", [])
			for item in catalog: picker.add_item(str(item.displayName))
			controls.add_child(picker)
			var quantity := SpinBox.new()
			quantity.min_value = 1
			quantity.max_value = 99
			quantity.value = 1
			controls.add_child(quantity)
			_button(controls, "Change order to selected item", func():
				if picker.selected < 0: return
				dialog.hide()
				_commerce_action({"kind":"change_order","lines":[{"itemId":catalog[picker.selected].itemId,"quantity":int(quantity.value)}]}))
		dialog.confirmed.connect(dialog.queue_free)
		dialog.popup_centered(Vector2i(640, 400)))

func _commerce_action(action: Dictionary) -> void:
	_request(_path("commerce/actions"), HTTPClient.METHOD_POST, {"expectedRevision":session.run_revision,"clientActionId":conversation.turn_id(),"action":action}, func(data: Dictionary):
		apply_checkpoint(data)
		if action.kind == "reserve":
			for manager in get_tree().get_nodes_in_group("physical_item_managers"):
				manager.accept_reserved_object(str(action.instanceId))
		if action.kind == "change_order":
			var managers := get_tree().get_nodes_in_group("authoritative_order_receivers")
			for manager in managers: manager.refresh_authoritative_order()
		status.text = "Order updated." if action.kind == "change_order" else "Reservation " + str(action.kind).replace("_reservation", "") + ".")

func _refresh_object_picker() -> void:
	if not session.runtime_enabled: return
	_request(_path("objects"), HTTPClient.METHOD_GET, {}, func(data: Dictionary):
		chat.render_stock(data.get("slots", [])))

func _pick_scene_object(slot: Dictionary) -> void:
	for manager in get_tree().get_nodes_in_group("physical_item_managers"):
		if manager.select_scene_stock(str(slot.get("nodePath", ""))):
			status.text = "Holding " + str(slot.get("itemId", "item")) + " for Show."
			return
	status.text = "That physical item is unavailable in this scene."

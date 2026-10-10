extends Node
## One held semantic beat. Only an acknowledged displayed turn advances choreography.
signal finished(success: bool)
var client: Node
var session: RefCounted
var dialogue: Node
var bubble: Node
var state := "idle"
var epoch := 0
var identity := ""
var auth := ""
var client_generation := 0
var beat: InteractionDialogueBeat
var npc_id := ""
var draft := ""
var submitted_draft := ""
var request_payload: Dictionary = {}
var can_edit_draft := false
var turn_id := ""
var response: Dictionary = {}
var page_texts: Array[String] = []
var page_index := 0
var controls: VBoxContainer
var resume_button: Button
var scene: Node
var trigger := "arrival"
var checkpoint_choice := false

func configure(request_client: Node, run_session: RefCounted, dialogue_ui: Node) -> void:
	client = request_client
	session = run_session
	dialogue = dialogue_ui
	process_mode = Node.PROCESS_MODE_ALWAYS

func start(value: InteractionDialogueBeat, npc: String) -> void:
	epoch += 1
	_cleanup()
	beat = value.duplicate()
	npc_id = npc.to_lower()
	identity = session.run_id
	auth = session.token
	client_generation = client.generation
	scene = get_tree().current_scene
	turn_id = "beat-" + str(Time.get_ticks_usec()) + "-" + str(randi())
	draft = ""
	submitted_draft = ""
	request_payload = {}
	can_edit_draft = false
	response = {}
	var checkpoint: Dictionary = session.next_event
	trigger = trigger_for_kind(str(checkpoint.get("kind", "greeting")))
	if session.runtime_enabled:
		npc_id = str(checkpoint.get("npcId", npc_id)).to_lower()
		if checkpoint.get("inputLabels") is Array:
			beat.input_labels.clear()
			for label in checkpoint.inputLabels: beat.input_labels.append(str(label))
	checkpoint_choice = session.runtime_enabled and str(checkpoint.get("kind", "")) == "player_input"
	if session.runtime_enabled and str(checkpoint.get("beatId", "")) != beat.beat_id:
		state = "held"
		_status("Story checkpoint does not match this conversation. Resume your run.", true)
		return
	if not session.pending_turn.is_empty():
		var pending: Dictionary = session.pending_turn
		if str(pending.get("request", {}).get("beatId", "")) == beat.beat_id:
			response = pending.duplicate(true)
			turn_id = str(pending.get("request", {}).get("clientTurnId", turn_id))
			page_texts = pages(str(pending.get("utterance", "")))
			page_index = 0
			_show_page()
			return
	if beat.input_labels.is_empty():
		_generate()
	else:
		_show_input()

func _show_input() -> void:
	state = "input"
	_status("Choose a reply or ask in your own words.")
	for label in beat.input_labels:
		_button(label, func(): _submit_draft(label))
	if checkpoint_choice:
		_button("Close", close)
		return
	var entry := LineEdit.new()
	entry.placeholder_text = "Your reply"
	entry.max_length = 1500
	entry.text = draft
	entry.text_changed.connect(func(value_text: String): draft = value_text)
	controls.add_child(entry)
	entry.text_submitted.connect(func(value_text: String):
		if not value_text.strip_edges().is_empty(): _submit_draft(value_text))
	_button("Send", func():
		if not entry.text.strip_edges().is_empty(): _submit_draft(entry.text))
	_button("Close", close)
	entry.grab_focus()
func _submit_draft(value_text: String) -> void:
	if state != "input": return
	draft = value_text.left(1500)
	if checkpoint_choice:
		var index := beat.input_labels.find(value_text)
		var actions: Array = session.next_event.get("actionIntents", [])
		if index < 0 or index >= actions.size():
			state = "held"
			_status("Choice has no authorized intent. Story held.", true)
			return
		state = "acknowledging"
		_status("Saving your choice…")
		var captured := epoch
		if await get_tree().root.get_node("MemoryGame").complete_runtime_action("checkpoint", str(actions[index])):
			if not _valid(captured): return
			state = "done"
			_cleanup()
			finished.emit(true)
		return
	_generate()

func edit_draft() -> void:
	if state != "held" or not response.is_empty() or not can_edit_draft: return
	_show_input()

func _valid(captured: int) -> bool:
	# Same-user access-token rotation preserves this operation. Login/logout and
	# account replacement invalidate client.generation; run replacement has its own guard.
	return captured == epoch and is_inside_tree() and identity == session.run_id and client_generation == client.generation and scene == get_tree().current_scene and state != "closed"

func _generate() -> void:
	if identity.is_empty() or auth.is_empty():
		state = "held"
		_status("Sign in and resume your run to continue this conversation.", true)
		return
	if draft != submitted_draft and (request_payload.is_empty() or can_edit_draft):
		epoch += 1
		turn_id = "beat-" + str(Time.get_ticks_usec()) + "-" + str(randi())
		request_payload = {}
	submitted_draft = draft
	can_edit_draft = false
	state = "generating"
	_status("Waiting for a reply…")
	_button("Close", close)
	var captured := epoch
	if request_payload.is_empty():
		request_payload = {"clientTurnId":turn_id,"expectedRevision":session.run_revision,"npcId":npc_id,"trigger":trigger,"message":draft,"beatId":beat.beat_id,"presentedRecordIds":[]}
	client.send(_path(), HTTPClient.METHOD_POST, request_payload.duplicate(true), func(ok: bool, data: Dictionary):
		if not _valid(captured): return
		if not ok or data.get("generation") != "llm" or str(data.get("modelId", "")).is_empty() or str(data.get("turnId", "")).is_empty() or str(data.get("utterance", "")).strip_edges().is_empty():
			state = "held"
			# These exact server errors occur before the durable turn commit.
			# Transport failures and malformed success responses require replay.
			can_edit_draft = not ok and str(data.get("error", "")) in ["GENERATION_UNAVAILABLE", "INVALID_TURN_REQUEST"]
			_status(str(data.get("error", "Generated dialogue unavailable. Retry this beat.")), true)
			return
		if not data.get("runRevision") is int and not data.get("runRevision") is float:
			state = "held"
			_status("Invalid conversation revision. Retry.", true)
			return
		response = data.duplicate(true)
		session.run_revision = int(data.get("runRevision", session.run_revision))
		page_texts = pages(str(data.utterance))
		page_index = 0
		_show_page())

func _show_page() -> void:
	state = "displayed"
	_status(page_texts[page_index])
	bubble.set_proceed_visible(true)
	bubble.clicked.connect(_clicked)

func _clicked() -> void:
	if state != "displayed": return
	page_index += 1
	if page_index < page_texts.size():
		_show_page()
	else:
		_ack()

func _ack() -> void:
	state = "acknowledging"
	_status("Saving the words you heard…")
	_button("Close", close)
	var captured := epoch
	client.send(_path() + "/" + str(response.turnId).uri_encode() + "/ack", HTTPClient.METHOD_POST, {"expectedRevision":session.run_revision,"clientActionId":turn_id + "-ack"}, func(ok: bool, data: Dictionary):
		if not _valid(captured): return
		if not ok or not data.get("acknowledged", false) or not (data.get("runRevision") is int or data.get("runRevision") is float) or not data.get("nextEvent") is Dictionary:
			state = "held_ack"
			_status(str(data.get("error", "Could not save this conversation. Retry.")), true)
			return
		get_tree().root.get_node("MemoryGame").apply_checkpoint(data)
		get_tree().root.get_node("MemoryGame").acknowledged_offers(response)
		state = "done"
		_cleanup()
		finished.emit(true))

func retry() -> void:
	if state not in ["held", "held_ack", "closed"]: return
	if checkpoint_choice and not get_tree().root.get_node("MemoryGame").active_runtime_actions.is_empty():
		state = "held"
		_status("Your choice is still saving. Retry when it completes.", true)
		return
	if checkpoint_choice and session.runtime_enabled and str(session.next_event.get("beatId", "")) != beat.beat_id and identity == session.run_id and auth == session.token:
		state = "done"
		_cleanup()
		finished.emit(true)
		return
	if state == "closed":
		identity = session.run_id
		auth = session.token
		client_generation = client.generation
		scene = get_tree().current_scene
	if not response.is_empty() and page_index >= page_texts.size():
		_ack()
	elif not response.is_empty():
		_show_page()
	elif not beat.input_labels.is_empty() and draft.is_empty():
		_show_input()
	else:
		_generate()

func close() -> void:
	epoch += 1
	state = "closed"
	_cleanup()
	resume_button = Button.new()
	resume_button.text = "Resume conversation"
	dialogue.add_child(resume_button)
	resume_button.pressed.connect(retry)

func _unhandled_key_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel") and state not in ["idle", "done", "closed", "cancelled"]:
		close()
		get_viewport().set_input_as_handled()

func _process(_delta: float) -> void:
	if state in ["idle", "done", "cancelled"]: return
	if scene != get_tree().current_scene:
		epoch += 1
		state = "cancelled"
		_cleanup()
		finished.emit(false)
	elif identity != session.run_id or client_generation != client.generation:
		response = {}
		request_payload = {}
		can_edit_draft = false
		turn_id = "beat-" + str(Time.get_ticks_usec()) + "-" + str(randi())
		identity = session.run_id
		auth = session.token
		client_generation = client.generation
		close()

func _exit_tree() -> void:
	epoch += 1
	_cleanup()

func _status(words: String, retry_visible: bool = false) -> void:
	_cleanup()
	bubble = dialogue.say("")
	bubble.say_plain(words)
	bubble.set_proceed_visible(false)
	controls = VBoxContainer.new()
	# Real bubbles host controls inside their content, preserving the original panel.
	var host := bubble.get_node_or_null("MarginContainer/VBoxContainer")
	(host if host else bubble).add_child(controls)
	if retry_visible:
		_button("Retry", retry)
		if state == "held" and can_edit_draft: _button("Edit draft", edit_draft)
		_button("Close", close)

func _button(label: String, action: Callable) -> void:
	var button := Button.new()
	button.text = label
	controls.add_child(button)
	button.pressed.connect(action)

func _cleanup() -> void:
	if is_instance_valid(bubble):
		if bubble.clicked.is_connected(_clicked): bubble.clicked.disconnect(_clicked)
		bubble.queue_free()
	bubble = null
	if is_instance_valid(resume_button): resume_button.queue_free()
	resume_button = null

func _path() -> String:
	return "/v2/runs/" + identity.uri_encode() + "/turns"

static func pages(words: String, limit: int = 700) -> Array[String]:
	var result: Array[String] = []
	var remaining := words.strip_edges()
	while remaining.length() > limit:
		var cut := remaining.rfind(" ", limit)
		if cut < limit / 2: cut = limit
		result.append(remaining.substr(0, cut))
		remaining = remaining.substr(cut).strip_edges()
	result.append(remaining)
	return result


static func trigger_for_kind(kind: String) -> String:
	match kind:
		"player_input": return "player_question"
		"order": return "order"
		"payment": return "payment"
		"ending": return "ending"
		"confrontation": return "confrontation"
		"object_shown": return "object_shown"
		"task_return": return "task_return"
	return "arrival"

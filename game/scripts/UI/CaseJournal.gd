extends VBoxContainer
signal action_requested(action: String, ids: Array)
signal edit_requested(action: Dictionary)
signal search_requested(query: String, cursor: String)
signal source_requested(record_id: String)
signal graph_requested
signal memory_requested(action: Dictionary)
signal lifecycle_requested(action: Dictionary)
signal lifecycle_status_requested(operation_id: String)
var lifecycle_id_input: LineEdit
signal operation_status_requested(operation_id: String)
var selected: Array[String] = []
var record_quotes: Dictionary = {}
var list: VBoxContainer
var details: RichTextLabel
var search_input: LineEdit
var edit_input: TextEdit
var next_button: Button
var next_cursor := ""
var active_query := ""
var offers_list: VBoxContainer
var task_dialog: AcceptDialog
var tasks_list: VBoxContainer
var recap_text: RichTextLabel
var memory_dialog: AcceptDialog
var operation_id_input: LineEdit
var operation_text: RichTextLabel
func _ready() -> void:
	offers_list = VBoxContainer.new()
	add_child(offers_list)
	var search_row := HBoxContainer.new()
	add_child(search_row)
	search_input = LineEdit.new()
	search_input.placeholder_text = "Search remembered words, speaker or record type"
	search_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	search_row.add_child(search_input)
	var search_button := Button.new()
	search_button.text = "Search"
	search_row.add_child(search_button)
	search_button.pressed.connect(func(): active_query = search_input.text.strip_edges(); search_requested.emit(active_query, ""))
	search_input.text_submitted.connect(func(_value: String): search_button.pressed.emit())
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(0, 210)
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	add_child(scroll)
	list = VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list)
	details = RichTextLabel.new()
	details.custom_minimum_size = Vector2(0, 70)
	add_child(details)
	var row := HFlowContainer.new()
	add_child(row)
	for pair in [["Tell Phuc", "phuc"], ["Show Hanh", "hanh"], ["Compare two", "compare"], ["Submit case", "case"]]:
		var button := Button.new()
		button.text = pair[0]
		row.add_child(button)
		button.pressed.connect(func(): action_requested.emit(pair[1], selected.duplicate()))
	var source_button := Button.new()
	source_button.text = "Read selected source"
	row.add_child(source_button)
	source_button.pressed.connect(func():
		if selected.size() != 1: message("Select exactly one source to read."); return
		source_requested.emit(selected[0]))
	var graph_button := Button.new()
	graph_button.text = "Source links"
	row.add_child(graph_button)
	graph_button.pressed.connect(func(): graph_requested.emit())
	var tasks_button := Button.new()
	tasks_button.text = "Tasks and recap"
	row.add_child(tasks_button)
	task_dialog = AcceptDialog.new()
	task_dialog.title = "Tasks and return-session recap"
	add_child(task_dialog)
	var task_scroll := ScrollContainer.new()
	task_scroll.custom_minimum_size = Vector2(650, 390)
	task_dialog.add_child(task_scroll)
	var task_content := VBoxContainer.new()
	task_content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	task_scroll.add_child(task_content)
	tasks_list = VBoxContainer.new()
	task_content.add_child(tasks_list)
	recap_text = RichTextLabel.new()
	recap_text.bbcode_enabled = false
	recap_text.fit_content = true
	recap_text.text = "Recap has not loaded yet."
	task_content.add_child(recap_text)
	tasks_button.pressed.connect(func(): task_dialog.popup_centered(Vector2i(700, 460)))
	var memory_button := Button.new()
	memory_button.text = "Memory operations"
	row.add_child(memory_button)
	memory_dialog = AcceptDialog.new()
	memory_dialog.title = "Opt-in memory operations"
	add_child(memory_dialog)
	var memory_scroll := ScrollContainer.new()
	memory_scroll.custom_minimum_size = Vector2(650, 390)
	memory_dialog.add_child(memory_scroll)
	var memory_content := VBoxContainer.new()
	memory_content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	memory_scroll.add_child(memory_content)
	var warning := Label.new()
	warning.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	warning.text = "Analysis sends your selected note to the extractor. Results stay unreviewed candidates. Restore rebuilds an index; it does not prove complete recovery."
	memory_content.add_child(warning)
	var analyze := Button.new()
	analyze.text = "Preview analysis of selected note"
	memory_content.add_child(analyze)
	analyze.pressed.connect(func():
		if selected.size() != 1: operation_text.text = "Select exactly one player note in the Journal first."; return
		memory_dialog.hide()
		memory_requested.emit({"kind":"analyze","rawInputRecordId":selected[0]}))
	var restore_row := HBoxContainer.new()
	memory_content.add_child(restore_row)
	var lane := OptionButton.new()
	lane.add_item("Case index")
	lane.add_item("Manifest index")
	restore_row.add_child(lane)
	var limit := SpinBox.new()
	limit.min_value = 1
	limit.max_value = 100
	limit.value = 10
	restore_row.add_child(limit)
	var restore := Button.new()
	restore.text = "Preview restore"
	restore_row.add_child(restore)
	restore.pressed.connect(func(): memory_dialog.hide(); memory_requested.emit({"kind":"restore","lane":"case" if lane.selected == 0 else "manifests","limit":int(limit.value)}))
	var lifecycle_warning := Label.new()
	lifecycle_warning.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lifecycle_warning.text = "Delete blocks selected sources and descendants in this app. External deletion requires chain proof; copies may remain. Renewal needs an explicit epoch count and WAL ceiling."
	memory_content.add_child(lifecycle_warning)
	var delete_button := Button.new()
	delete_button.text = "Preview delete selected sources"
	memory_content.add_child(delete_button)
	delete_button.pressed.connect(func():
		if selected.is_empty(): operation_text.text = "Select sources in the Journal first."; return
		memory_dialog.hide()
		lifecycle_requested.emit({"kind":"delete","recordIds":selected.duplicate()}))
	var renewal_row := HBoxContainer.new()
	memory_content.add_child(renewal_row)
	var epochs := SpinBox.new()
	epochs.min_value = 1
	epochs.max_value = 100
	epochs.value = 1
	epochs.prefix = "Epochs: "
	renewal_row.add_child(epochs)
	var ceiling := LineEdit.new()
	ceiling.placeholder_text = "Maximum WAL (explicit ceiling)"
	renewal_row.add_child(ceiling)
	var renew_button := Button.new()
	renew_button.text = "Preview renewal"
	renewal_row.add_child(renew_button)
	renew_button.pressed.connect(func():
		if selected.is_empty() or ceiling.text.strip_edges().is_empty(): operation_text.text = "Select sources and enter a maximum WAL amount."; return
		memory_dialog.hide()
		lifecycle_requested.emit({"kind":"renew","recordIds":selected.duplicate(),"epochs":int(epochs.value),"ceiling":ceiling.text.strip_edges()}))
	lifecycle_id_input = LineEdit.new()
	lifecycle_id_input.placeholder_text = "Lifecycle operation ID"
	memory_content.add_child(lifecycle_id_input)
	var lifecycle_status := Button.new()
	lifecycle_status.text = "Read lifecycle status"
	memory_content.add_child(lifecycle_status)
	lifecycle_status.pressed.connect(func(): lifecycle_status_requested.emit(lifecycle_id_input.text.strip_edges()))
	operation_id_input = LineEdit.new()
	operation_id_input.placeholder_text = "Operation ID to read status (no dispatch)"
	memory_content.add_child(operation_id_input)
	var read_status := Button.new()
	read_status.text = "Read operation status"
	memory_content.add_child(read_status)
	read_status.pressed.connect(func():
		if not operation_id_input.text.strip_edges().is_empty(): operation_status_requested.emit(operation_id_input.text.strip_edges()))
	operation_text = RichTextLabel.new()
	operation_text.bbcode_enabled = false
	operation_text.custom_minimum_size = Vector2(0, 190)
	operation_text.size_flags_vertical = Control.SIZE_EXPAND_FILL
	operation_text.text = "No operation dispatched."
	memory_content.add_child(operation_text)
	memory_button.pressed.connect(func(): memory_dialog.popup_centered(Vector2i(700, 460)))
	edit_input = TextEdit.new()
	edit_input.placeholder_text = "Write your note, alias or corrected interpretation. Original testimony stays unchanged."
	edit_input.custom_minimum_size = Vector2(0, 65)
	add_child(edit_input)
	var edit_row := HBoxContainer.new()
	add_child(edit_row)
	for kind in ["note", "alias", "correct"]:
		var button := Button.new()
		button.text = "Preview " + kind
		edit_row.add_child(button)
		button.pressed.connect(func():
			var text := edit_input.text.strip_edges()
			if text.is_empty(): message("Write the text to preview first."); return
			if kind == "correct" and selected.size() != 1: message("Select exactly one source to correct your interpretation."); return
			if kind == "alias" and selected.size() != 1: message("Select exactly one source to name with an alias."); return
			var action := {"kind":kind,"text":text}
			if kind == "correct": action["recordId"] = selected[0]
			else: action["recordIds"] = selected.duplicate()
			edit_requested.emit(action))
	next_button = Button.new()
	next_button.text = "Load more sources"
	next_button.hide()
	add_child(next_button)
	next_button.pressed.connect(func(): search_requested.emit(active_query, next_cursor))
func render(records: Array, append: bool = false) -> void:
	if not append:
		for child in list.get_children(): child.queue_free()
		selected.clear()
		record_quotes.clear()
	if records.is_empty():
		var label := Label.new()
		label.text = "No witnessed sources yet. Continue serving customers."
		list.add_child(label)
	for item in records:
		if not item is Dictionary:
			continue
		var id := str(item.get("id", item.get("eventId", "")))
		if record_quotes.has(id): continue
		record_quotes[id] = str(item.get("quote", item.get("text", "")))
		var button := CheckBox.new()
		button.text = "Day %s · %s · %s\n%s" % [item.get("inGameDay", item.get("day", "?")), str(item.get("speaker", "Unknown")).capitalize(), item.get("claimStatus", item.get("recordType", item.get("type", "claim"))), item.get("quote", "")]
		var storage := str(item.get("status", "pending"))
		button.text += "\n" + ("Local save · not Mainnet verified" if storage == "local" else "Storage: " + storage)
		button.tooltip_text = "Record: %s\nBlob: %s\nJob: %s\n%s" % [id, item.get("blobId", "not confirmed"), item.get("jobId", "none"), item.get("error", "")]
		button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		list.add_child(button)
		button.toggled.connect(func(enabled: bool):
			if enabled:
				selected.append(id)
			else:
				selected.erase(id)
			details.text = "%s source(s) selected. Sharing discloses only your selected source." % selected.size())
func message(value: String) -> void:
	details.text = value
func render_page(data: Dictionary, append: bool = false) -> void:
	render(data.get("records", []), append)
	next_cursor = str(data.get("nextCursor", ""))
	next_button.visible = not next_cursor.is_empty()
func render_source(data: Dictionary) -> void:
	var original: Dictionary = data.get("original", {})
	message("Exact source · %s\n%s\n\nActor: %s · Claim status: %s\nAvailability: %s · Retracted: %s\nProvenance: %s · New remote recall: %s\nSource IDs: %s" % [data.get("id", ""), original.get("text", "Source unavailable"), original.get("actor", "unknown"), original.get("epistemicStatus", "unknown"), data.get("availability", "unknown"), data.get("retracted", false), data.get("provenance", "unknown"), data.get("newRemoteRecall", false), str(original.get("sourceIds", []))])
func render_graph(data: Dictionary) -> void:
	var text := "Visible source links\n"
	for edge in data.get("edges", []):
		text += "%s → %s · %s\n" % [edge.get("fromId", ""), edge.get("toId", ""), edge.get("type", "link")]
	if data.get("edges", []).is_empty(): text += "No recorded links."
	message(text)
func render_offers(offers: Array) -> void:
	for child in offers_list.get_children(): child.queue_free()
	for offer in offers:
		if not offer is Dictionary: continue
		var turn_id := str(offer.get("turnId", ""))
		var proposal_id := str(offer.get("proposalId", ""))
		if turn_id.is_empty() or proposal_id.is_empty(): continue
		var button := Button.new()
		var offer_type := str(offer.get("type", offer.get("commitmentType", "promise")))
		if offer.get("commitment") is Dictionary: offer_type = str(offer.commitment.get("type", offer_type))
		var accept_kind := "accept_task" if offer_type == "task" else "accept_promise"
		button.text = "Review offered " + offer_type + ": " + str(offer.get("label", "Commitment"))
		button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		offers_list.add_child(button)
		button.pressed.connect(func(): action_requested.emit(accept_kind, [turn_id, proposal_id]))
func render_tasks(tasks: Array) -> void:
	for child in tasks_list.get_children(): child.queue_free()
	var heading := Label.new()
	heading.text = "Task status"
	tasks_list.add_child(heading)
	for entry in tasks:
		if not entry is Dictionary: continue
		var task: Dictionary = entry.get("commitment", entry)
		var task_id := str(task.get("id", entry.get("taskId", "")))
		var task_status := str(task.get("status", entry.get("status", "unknown")))
		var label := Label.new()
		label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		label.text = "%s · %s\n%s → %s · %s\nSources: %s" % [str(entry.get("label", task.get("condition", "Task"))).replace("_", " "), task_status, task.get("proposer", "unknown"), task.get("beneficiary", "unknown"), str(task.get("topicEntityIds", [])), str(task.get("sourceIds", []))]
		tasks_list.add_child(label)
		if task_status == "accepted" and not task_id.is_empty():
			var withdraw := Button.new()
			withdraw.text = "Review withdrawal"
			tasks_list.add_child(withdraw)
			withdraw.pressed.connect(func(): task_dialog.hide(); edit_requested.emit({"kind":"withdraw_task","taskId":task_id}))
	if tasks.is_empty():
		var empty := Label.new()
		empty.text = "No recorded tasks."
		tasks_list.add_child(empty)
func render_recap(data: Dictionary) -> void:
	var text := "Remembered statements and observed facts\n"
	for entry in data.get("knownFacts", data.get("known", [])):
		text += _attributed_recap(entry) + "\n"
	text += "\nHypotheses · not established facts\n"
	for entry in data.get("hypotheses", []): text += _attributed_recap(entry) + "\n"
	text += "\nOpen next steps\n"
	for entry in data.get("nextSteps", data.get("openTasks", data.get("openTaskIds", []))):
		if entry is Dictionary: text += str(entry.get("text", entry.get("label", entry.get("condition", "Task")))).replace("_", " ") + "\n"
		else: text += str(entry) + "\n"
	recap_text.text = text
func _attributed_recap(entry: Variant) -> String:
	if not entry is Dictionary: return str(entry)
	return "%s · %s: %s\nSources: %s" % [str(entry.get("actor", entry.get("speaker", "unknown"))).capitalize(), entry.get("epistemicStatus", "attributed"), entry.get("text", entry.get("quote", "")), str(entry.get("sourceIds", [entry.get("id", "")]))]
func render_memory_operation(data: Dictionary) -> void:
	operation_id_input.text = str(data.get("operationId", operation_id_input.text))
	var state := str(data.get("status", "unknown"))
	var text := "Operation: %s\nStatus: %s\n" % [operation_id_input.text, state]
	if data.has("errorCode"): text += "Error: " + str(data.errorCode) + "\n"
	if state == "unknown": text += "Outcome is unknown. Read status; do not dispatch this operation again.\n"
	var result: Dictionary = data.get("result", {}) if data.get("result") is Dictionary else {}
	if result.has("candidates"):
		text += "\nUNREVIEWED CANDIDATES · NOT EVIDENCE\n"
		for candidate in result.candidates:
			if candidate is Dictionary: text += str(candidate.get("text", candidate.get("fact", candidate.get("content", "Candidate")))) + "\n"
		text += "Candidate approval is not available. Original notes remain unchanged.\n"
	elif not result.is_empty():
		text += "\nRead-only index result · recovery completeness unproven\n" + JSON.stringify(result, "  ")
	operation_text.text = text

func render_lifecycle(data: Dictionary) -> void:
	lifecycle_id_input.text = str(data.get("operationId", data.get("id", lifecycle_id_input.text)))
	var state := str(data.get("status", "unknown"))
	var preview: Dictionary = data.get("preview", {}) if data.get("preview") is Dictionary else {}
	var kind := str(preview.get("action", {}).get("kind", "delete"))
	var text := "Lifecycle operation: %s\nStatus: %s\n" % [lifecycle_id_input.text, state]
	if state == "unsupported":
		text += "Selected records and descendants are blocked in this app. External deletion is unsupported and NOT confirmed." if kind == "delete" else "Renewal is unsupported. No extension or charge is confirmed."
	elif state == "confirmed":
		text += "The server verified chain proof for the listed blob objects. Copies and historical caches may remain."
	elif state in ["unknown", "executing", "requested"]:
		text += "External outcome is not confirmed. Read status; do not create a replacement operation."
	else: text += "Preview only. No confirmed external change."
	if data.has("result"): text += "\n" + JSON.stringify(data.result, "  ")
	operation_text.text = text

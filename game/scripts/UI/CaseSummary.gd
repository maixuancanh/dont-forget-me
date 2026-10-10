extends RichTextLabel
signal source_requested(record_id: String)
func _ready() -> void:
	meta_clicked.connect(func(id: Variant): source_requested.emit(str(id)))
func operation_failed(reason: String) -> void:
	bbcode_enabled = false
	text = "Epilogue unavailable: " + reason + ". Retry when the service is available. The recorded case outcome is unchanged.\n"
func epilogue_locked() -> void:
	bbcode_enabled = false
	text = "PHUC'S EPILOGUE\n\nComplete Day 6 and submit your case findings to unlock Phuc's closing account.\n\nReturn to the investigation to continue."
func render(data: Dictionary) -> void:
	bbcode_enabled = false
	text = "WHAT YOU REMEMBERED\n\n"
	text += str(data.get("outcome", "Investigation continues")).replace("_", " ").capitalize() + "\n\n"
	for key in ["utterance", "text", "summary", "missing", "promises", "trust", "decisiveEvidence", "unresolvedQuestions", "observations"]:
		if not data.has(key): continue
		var value: Variant = data[key]
		if value is Array:
			for item in value:
				if item is Dictionary:
					text += str(item.get("text", item.get("quote", ""))) + "\n"
					var sources: Array = item.get("sourceIds", [])
					if not sources.is_empty(): text += "Based on %s journal source(s).\n" % sources.size()
				else:
					text += str(item) + "\n"
		else:
			text += str(value) + "\n"
		text += "\n"

	for citation in data.get("citations", []):
		if not citation is Dictionary: continue
		var id := str(citation.get("recordId", ""))
		if id.is_empty(): continue
		push_meta(id)
		add_text("Open source: " + id + "\n")
		pop()

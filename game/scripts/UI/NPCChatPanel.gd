extends VBoxContainer
signal submitted(message: String)
signal object_requested(message: String)
signal stock_selected(slot: Dictionary)
var stock_controls: VBoxContainer
signal commerce_requested
var show_button: Button
var transcript: RichTextLabel
var input: LineEdit
var send_button: Button
func _ready() -> void:
	transcript = RichTextLabel.new()
	transcript.custom_minimum_size = Vector2(0, 220)
	transcript.size_flags_vertical = Control.SIZE_EXPAND_FILL
	transcript.bbcode_enabled = false
	add_child(transcript)
	stock_controls = VBoxContainer.new()
	add_child(stock_controls)
	input = LineEdit.new()
	input.placeholder_text = "Ask about something you witnessed…"
	input.max_length = 1200
	add_child(input)
	send_button = Button.new()
	send_button.text = "Ask"
	add_child(send_button)
	show_button = Button.new()
	show_button.text = "Show held item"
	show_button.tooltip_text = "Show this object to recall a conversation. Keeps the item in your hand."
	add_child(show_button)
	show_button.pressed.connect(func(): object_requested.emit(input.text.strip_edges()))
	var commerce := Button.new()
	commerce.text = "Order and reservations"
	add_child(commerce)
	commerce.pressed.connect(func(): commerce_requested.emit())
	send_button.pressed.connect(_submit)
	input.text_submitted.connect(func(_value: String): _submit())
func _submit() -> void:
	var message := input.text.strip_edges()
	if message.is_empty() or send_button.disabled:
		return
	transcript.append_text("You: " + message + "\n\n")
	input.clear()
	submitted.emit(message)
func busy(value: bool) -> void:
	send_button.disabled = value
	show_button.disabled = value
func answer(speaker: String, text: String, sources: Array) -> void:
	transcript.append_text(speaker.capitalize() + ": " + text + "\n")
	if not sources.is_empty():
		transcript.append_text("Based on %s journal source(s).\n" % sources.size())
	transcript.append_text("\n")

func render_stock(slots: Array) -> void:
	for child in stock_controls.get_children(): child.queue_free()
	for slot in slots:
		if str(slot.get("origin", "")) != "static_scene_object": continue
		var frozen: Dictionary = slot.duplicate(true)
		var pick := Button.new()
		pick.text = "Pick up " + str(slot.get("itemId", "item")).replace("_", " ")
		stock_controls.add_child(pick)
		pick.pressed.connect(func(): stock_selected.emit(frozen))

extends PanelContainer

signal clicked

@onready var label: RichTextLabel = $MarginContainer / VBoxContainer / MainTextMargin / Label
@onready var proceed_label: Label = $MarginContainer / VBoxContainer / ProceedLabel

func _ready() -> void:
	var panel = StyleBoxTexture.new()
	panel.texture = ArtFit.texture("khung-thoai", Rect2(20,153,1734,618))
	panel.texture_margin_left = 0
	panel.texture_margin_right = 0
	panel.texture_margin_top = 0
	panel.texture_margin_bottom = 0
	panel.content_margin_left = 36
	panel.content_margin_right = 36
	panel.content_margin_top = 24
	panel.content_margin_bottom = 55
	add_theme_stylebox_override("panel", panel)
	label.add_theme_color_override("default_color", Color.BLACK)
	label.add_theme_color_override("font_outline_color", Color(0.16,0.14,0.12))
	label.add_theme_constant_override("outline_size", 0)
	proceed_label.add_theme_color_override("font_color", Color.BLACK)
	proceed_label.add_theme_color_override("font_outline_color", Color(0.16,0.14,0.12))
	proceed_label.add_theme_constant_override("outline_size", 0)

func say(text: String, time_to_decay: float = 20):
	# Presentation owns ink color; preserve authored text and non-color BBCode.
	var colors := RegEx.new()
	colors.compile("(?i)\\[color=[^\\]]*\\]|\\[/color\\]")
	label.text = colors.sub(text, "", true)

func set_proceed_visible(is_visible: bool):
	proceed_label.visible = is_visible

func _gui_input(event: InputEvent) -> void :
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			clicked.emit()


func say_plain(text: String) -> void:
	# Model output is literal text, never executable BBCode or a resource URL.
	label.bbcode_enabled = false
	label.text = text
	label.add_theme_color_override("default_color", Color.BLACK)

func _unhandled_key_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_accept") and proceed_label.visible:
		clicked.emit()
		get_viewport().set_input_as_handled()

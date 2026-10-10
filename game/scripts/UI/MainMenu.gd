extends Node

@export var fade_rect: ColorRect
var starting := false
var fading := false

func _ready() -> void:
	var background = $TextureRect3
	background.offset_transform_enabled = false
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for spec in [["PlayButton", "START"], ["ExitButton", "EXIT"]]:
		var button: TextureButton = $VBoxContainer.get_node(spec[0])
		button.texture_normal = ArtFit.texture("nut-trong", Rect2(350,352,556,547))
		button.texture_pressed = ArtFit.texture("nut-trong-nhan", Rect2(351,351,556,547))
		button.ignore_texture_size = true
		button.stretch_mode = TextureButton.STRETCH_SCALE
		button.custom_minimum_size = Vector2(420,110)
		button.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
		var label = Label.new()
		label.text = spec[1]
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		label.add_theme_color_override("font_color", Color.WHITE)
		label.add_theme_font_size_override("font_size", 40)
		button.add_child(label)
		label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

func fade_out_screen() -> void :
	if fading: return
	fading = true
	if fade_rect:
		fade_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_LINEAR).set_ease(Tween.EASE_OUT)

	tween.tween_property(fade_rect, "modulate:a", 1.0, 1.0)

	tween.finished.connect( func():
		get_tree().change_scene_to_file(
			"res://scenes/levels/Main.tscn"
			)
	)

func _on_play_button_pressed() -> void :
	if starting: return
	if not MemoryGame.can_play():
		MemoryGame._open_login()
		return
	starting = true
	$VBoxContainer/PlayButton.disabled = true
	MemoryGame.refresh_run(func():
		if not MemoryGame.can_play(): return
		DayProgression.day_index = maxi(0, MemoryGame.session.server_day - 1)
		fade_out_screen())

func _on_exit_button_pressed() -> void :
	EscToQuit.request_quit()

func _process(_delta: float) -> void:
	# A cancelled/offline checkpoint dialog must not leave START disabled forever.
	if starting and not fading and not MemoryGame.is_chat_open:
		starting = false
		$VBoxContainer/PlayButton.disabled = false

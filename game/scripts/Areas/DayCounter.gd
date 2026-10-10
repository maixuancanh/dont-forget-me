extends Node2D

signal day_intro_starting
signal day_intro_finished

@onready var color_rect = $Graphics / ColorRect
@onready var label = $Graphics / ColorRect / Label

func _ready() -> void :
	label.text = "DAY " + str(DayProgression.day_index + 1)

	if color_rect:
		color_rect.mouse_filter = Control.MOUSE_FILTER_STOP

	var timer = get_tree().create_timer(4.0)
	await timer.timeout

	fade_out_screen()

func fade_in_screen() -> void :
	if DayProgression.day_index == 5:
		return

	day_intro_starting.emit()


	label.text = "DAY " + str(DayProgression.day_index + 2)

	if color_rect:
		color_rect.mouse_filter = Control.MOUSE_FILTER_STOP

	var tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_LINEAR).set_ease(Tween.EASE_OUT)

	tween.tween_property(color_rect, "modulate:a", 1.0, 1.0)
	tween.tween_property(label, "modulate:a", 1.0, 1.0)

	var timer = get_tree().create_timer(3.0)
	await timer.timeout

	DayProgression.day_index += 1
	if DayProgression.day_index <= 5:
		get_tree().reload_current_scene()

func fade_out_screen() -> void :
	if color_rect:
		color_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_LINEAR).set_ease(Tween.EASE_OUT)

	tween.tween_property(color_rect, "modulate:a", 0.0, 1.0)
	tween.tween_property(label, "modulate:a", 0.0, 1.0)

	tween.chain().tween_callback(_on_fade_completed)

func _on_fade_completed() -> void :
	day_intro_finished.emit()

func _on_scene_player_day_ended() -> void :
	fade_in_screen()

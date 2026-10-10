extends CanvasLayer

signal on_paluwagan_close

@onready var close_button: Button = $ColorRect / Button
@onready var color_rect_panel: ColorRect = $ColorRect

func _ready() -> void :
	close_button.pressed.connect( func():
		close_button.visible = false

		var tween1 = create_tween()

		tween1.tween_property(color_rect_panel, "offset_transform_scale", Vector2(1.1, 1.1), 5)

		await tween1.finished

		on_paluwagan_close.emit()

		var tween2 = create_tween().set_ease(Tween.EASE_IN).set_trans(Tween.TRANS_CUBIC)

		tween2.tween_property(color_rect_panel, "offset_transform_position_ratio:y", 1.0, 0.15)

		await tween2.finished

		visible = false
		queue_free()
	)

	close_button.visible = false
	MusicManager.play_bgm("res://assets/audio/gameplay/interaction/story_audio/horror_bg.mp3", -1.0, 5.0)
	await get_tree().create_timer(3.0).timeout
	close_button.visible = true

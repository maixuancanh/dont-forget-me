extends DroppedItem

class_name CustomDroppedPaluwagan

@onready var paluwagan_popup: = $PaluwaganUI

func _ready() -> void:
	super._ready()
	# Keep the receipt fully above its inherited physical support, with a matching target.
	ArtFit.sprite($Sprite2D, ArtFit.texture("phieu-no", Rect2(121,232,847,1064)), Vector2(0,-90), Vector2(180,180))
	$ClickArea.position = Vector2(0,-90)
	var hitbox := RectangleShape2D.new()
	hitbox.size = Vector2(180,180)
	$ClickArea/CollisionShape2D.shape = hitbox

func _on_click_area_input_event(viewport: Node, event: InputEvent, shape_idx: int) -> void :
	if event is InputEventMouseButton\
	and event.button_index == MOUSE_BUTTON_LEFT\
	and event.pressed:
		paluwagan_popup.visible = true

		var color_rect: ColorRect = paluwagan_popup.get_node("ColorRect")

		color_rect.modulate.a = 0.0

		var tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_LINEAR).set_ease(Tween.EASE_OUT)

		tween.tween_property(color_rect, "modulate:a", 1.0, 1.0)

		tween.finished.connect( func():
			MusicManager.pause_bgm()
			get_tree().change_scene_to_file("res://scenes/levels/EndingCutscene.tscn")
		)

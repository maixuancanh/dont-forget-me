extends Node

class_name ItemDestroyer

func _on_body_shape_entered(body_rid: RID, body: Node2D, body_shape_index: int, local_shape_index: int) -> void :
	if body is DroppedItem:
		if body.is_moving:
			return

		body.queue_free()

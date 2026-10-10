extends Node

func _on_body_entered(body: Node2D) -> void :
	if body is DroppedItem:
		body.inside_suspender = true

		var rBody2d = body.rigid_body_2d
		if rBody2d is RigidBody2D:
			rBody2d.linear_velocity = Vector2.ZERO
			rBody2d.angular_velocity = 0

			rBody2d.freeze_mode = RigidBody2D.FREEZE_MODE_STATIC



			rBody2d.set_deferred("freeze", true)

func _on_body_exited(body: Node2D) -> void :
	body.inside_suspender = false

	if body is DroppedItem:
		if body.is_moving:
			return

		var rBody2d = body.rigid_body_2d
		if rBody2d is RigidBody2D:
			rBody2d.set_deferred("freeze", false)

extends VBoxContainer

@export var speech_bubble_template: PackedScene

func say(text: String, time_to_decay: float = 10) -> Node:
	for child in get_children():
		child.queue_free()

	var bubble = speech_bubble_template.instantiate()
	add_child(bubble)
	bubble.say(text, time_to_decay)

	return bubble

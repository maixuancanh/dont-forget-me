extends Node2D

class_name ItemSpawner

@onready var collision_shape = $CollisionShape2D
@onready var item_manager: ItemManager = %DroppedItemHolder

func random_point_on_shape() -> Vector2:
	var shape: = collision_shape.shape as RectangleShape2D
	var extents: = shape.size / 2.0

	return global_position + Vector2(
		randf_range( - extents.x, extents.x), 
		randf_range( - extents.y, extents.y)
	)

func spawn_items(items: Array[PackedScene]) -> Array[DroppedItem]:
	var spawned_items: Array[DroppedItem] = []
	for item in items:
		if item is PackedScene:
			var spawned_item: DroppedItem = item.instantiate()
			item_manager.add_child(spawned_item)
			spawned_item.global_position = random_point_on_shape()
			spawned_items.append(spawned_item)

			if spawned_item.has_method("get") and spawned_item.item_data and spawned_item.item_data.pickup_sfx:
				_play_item_sfx(spawned_item.item_data.pickup_sfx)
	return spawned_items

func _play_item_sfx(stream: AudioStream, volume_db: float = 0.0):
	var player: = AudioStreamPlayer.new()
	add_child(player)
	player.stream = stream
	player.volume_db = volume_db
	player.finished.connect(player.queue_free)
	player.play()

extends Control

class_name ItemManager

var held_item: RigidBody2D = null

func _ready() -> void:
	add_to_group("physical_item_managers")
var lmb_hold_time: = 0
const LONG_PRESS_TIME: = 500
var pressed_dispenser: ItemDispenser = null
var pressed_dropped_item: RigidBody2D = null

@onready var tooltip: Node2D = $Tooltips
var tooltip_visible_time: float = 99999
var tooltip_delay_ms: float = 500

@onready var hold_progress_bar: TextureProgressBar = $HoldProgress

func get_hovered_collider() -> CollisionObject2D:
	var space = get_world_2d().direct_space_state
	var query = PhysicsPointQueryParameters2D.new()
	query.position = get_global_mouse_position()
	query.collide_with_areas = true
	query.collide_with_bodies = true




	query.collision_mask = (1 << 1) | (1 << 2)

	var results = space.intersect_point(query)
	for result in results:
		if result.collider is ItemDispenser or result.collider is RigidBody2D:

			if result.collider != held_item:
				return result.collider

	return null

func _unhandled_input(event: InputEvent) -> void :
	if not is_instance_valid(held_item): held_item = null

	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_RIGHT:
		if held_item == null:
			return

		if event.pressed:
			held_item.show_cost()
		else:
			held_item.update_qty_label()


	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			lmb_hold_time = Time.get_ticks_msec()

			var hovered = get_hovered_collider()


			pressed_dispenser = null
			pressed_dropped_item = null

			if hovered is ItemDispenser:
				pressed_dispenser = hovered

				if held_item and \
				pressed_dispenser.is_returnable and \
				pressed_dispenser.item_data == held_item.item_data:
					hold_progress_bar.visible = true
			elif hovered is RigidBody2D:
				pressed_dropped_item = hovered


			if pressed_dispenser == null and pressed_dropped_item == null and held_item:
				drop_item()
				get_viewport().set_input_as_handled()

		else:
			hold_progress_bar.visible = false


			if pressed_dropped_item != null:


				if pressed_dropped_item != held_item\
				and held_item != null\
				and "item_data" in pressed_dropped_item\
				and held_item.item_data.item_id == pressed_dropped_item.item_data.item_id\
				and held_item.item_data.item_stackable:

					var amount_to_add = 1
					if "item_qty" in pressed_dropped_item:
						amount_to_add = pressed_dropped_item.item_qty

					for i in range(amount_to_add):
						held_item.add_quantity()

					pressed_dropped_item.queue_free()


				pressed_dropped_item = null
				pressed_dispenser = null
				return


			if pressed_dispenser == null:
				return
			var held_ms = Time.get_ticks_msec() - lmb_hold_time
			if held_ms >= LONG_PRESS_TIME:
				if held_item\
				and pressed_dispenser.is_returnable\
				and held_item.item_data == pressed_dispenser.item_data:
					_play_item_sfx(pressed_dispenser.item_data.pickup_sfx)
					held_item.animate_item_receive()
					drop_item()

			else:
				spawn_item_from_dispenser(pressed_dispenser)

			pressed_dispenser = null

	tooltip.visible = false
	tooltip_visible_time = Time.get_ticks_msec() + tooltip_delay_ms

func _process(delta: float) -> void :
	if hold_progress_bar.visible:
		hold_progress_bar.global_position = get_global_mouse_position()
		hold_progress_bar.value = minf(1.0, float(Time.get_ticks_msec() - lmb_hold_time) / float(LONG_PRESS_TIME))

	if not tooltip.visible and Time.get_ticks_msec() > tooltip_visible_time:

		if pressed_dispenser:
			return

		var hovered = get_hovered_collider()
		if hovered is ItemDispenser:
			tooltip.visible = true
			tooltip.global_position = get_global_mouse_position()

func hold_item(item: RigidBody2D) -> void :
	if held_item == null:
		held_item = item
		held_item.is_moving = true

func spawn_item_from_dispenser(dispenser: ItemDispenser) -> void :
	if held_item == null:
		var item = dispenser.item_prefab.instantiate()
		item.set_meta("memory_stock_slot", "res://scenes/levels/Main.tscn#" + str(get_tree().current_scene.get_path_to(dispenser)))
		add_child(item)
		item.global_position = dispenser.global_position
		call_deferred("hold_item", item)
		_play_item_sfx(dispenser.item_data.pickup_sfx)

	elif held_item.item_data.item_id == dispenser.item_data.item_id:
		if dispenser.item_data.item_stackable:
			held_item.add_quantity()
			_play_item_sfx(dispenser.item_data.pickup_sfx)

func drop_item() -> void :
	if held_item:
		var memory := get_node_or_null("/root/MemoryGame")
		if memory: memory.release_shown_object(held_item)
		held_item.is_moving = false
		held_item.drop_item()

		var item = held_item
		held_item = null

		var space = get_world_2d().direct_space_state
		var query: = PhysicsPointQueryParameters2D.new()
		query.position = item.global_position
		query.collide_with_areas = true

		var results = space.intersect_point(query)

		for result in results:
			if result.collider is ItemReceiver:
				result.collider._on_body_entered(item)

func _play_item_sfx(stream: AudioStream, volume_db: float = -12.0):
	if stream == null:
		return
	var player: = AudioStreamPlayer.new()
	add_child(player)
	player.stream = stream
	player.volume_db = volume_db
	player.finished.connect(player.queue_free)
	player.play()

func held_object_snapshot() -> Dictionary:
	if not is_instance_valid(held_item) or not "item_data" in held_item: return {}
	if held_item.item_data == null: return {}
	if held_item.is_animating_receive: return {}
	return {"node":held_item,"itemId":held_item.item_data.item_id,"quantity":held_item.item_qty,"clientSlot":str(held_item.get_meta("memory_stock_slot", ""))}

func accept_reserved_object(instance_id: String) -> void:
	if not is_instance_valid(held_item): return
	if str(held_item.get_meta("memory_object_instance", "")) != instance_id: return
	var item := held_item
	held_item = null
	item.is_moving = false
	item.animate_item_receive()

func select_scene_stock(node_path: String) -> bool:
	var stock := get_tree().current_scene.get_node_or_null(NodePath(node_path))
	if not is_instance_valid(stock) or not stock is DroppedItem: return false
	if stock.is_animating_receive or not stock.has_meta("memory_stock_slot"): return false
	if is_instance_valid(held_item) and held_item != stock: drop_item()
	stock.visible = true
	stock.freeze = true
	hold_item(stock)
	return held_item == stock

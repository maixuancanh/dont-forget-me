extends Area2D

class_name ItemReceiver

@export var required_items: Dictionary[ItemData, int]
var required_total: int = -1
var mode: = RECEIVE_MODE.ITEMS

@export var placed_items: Dictionary[ItemData, int] = {}

signal on_satisfied

enum RECEIVE_MODE{
	ITEMS, 
	MONEY
}

func _on_body_entered(body: Node2D) -> void :
	if body is DroppedItem:
		if body.is_animating_receive:
			return

		if body.is_moving:
			return

		if mode == RECEIVE_MODE.MONEY:
			if body.item_data is ItemDataMoney:
				if body.item_data.money_worth * body.item_qty <= required_total - total_placed():
					body.animate_item_receive()
					add_item(body.item_data, body.item_qty)

		elif mode == RECEIVE_MODE.ITEMS:
			if body.item_data in required_items:
				var already_has = placed_items.get(body.item_data, 0)
				var required_qty: = required_items[body.item_data]

				if already_has + body.item_qty <= required_qty:
					body.animate_item_receive()
					add_item(body.item_data, body.item_qty)

func setup_requirements_items(requirements: Dictionary[ItemData, int]):
	mode = RECEIVE_MODE.ITEMS
	required_items = requirements
	placed_items = {}
	required_total = -1

	for body in get_overlapping_bodies():
		_on_body_entered(body)

func setup_requirements_money(amount: int):
	mode = RECEIVE_MODE.MONEY
	required_items = {}
	placed_items = {}
	required_total = amount

func total_placed() -> int:
	var total: = 0

	for item in placed_items:
		if item is ItemDataMoney:
			total += item.money_worth * placed_items[item]

	return total

func add_item(item_data: ItemData, qty: int):
	if item_data in placed_items:
		placed_items[item_data] += qty
	else:
		placed_items[item_data] = qty

	if item_data.pickup_sfx:
		_play_item_sfx(item_data.pickup_sfx)

	var is_satisfied = true
	for item in required_items:
		if item not in placed_items:
			is_satisfied = false
			continue
		elif placed_items[item] < required_items[item]:
			is_satisfied = false
			continue

	if mode == RECEIVE_MODE.MONEY:
		if total_placed() >= required_total:
			call_deferred("on_satisfy")
	elif mode == RECEIVE_MODE.ITEMS:
		if is_satisfied:
			call_deferred("on_satisfy")

func on_satisfy():
	required_items = {}
	placed_items = {}
	required_total = -1
	mode = RECEIVE_MODE.ITEMS

	on_satisfied.emit()

func _play_item_sfx(stream: AudioStream, volume_db: float = 0.0):
	var player: = AudioStreamPlayer.new()
	add_child(player)
	player.stream = stream
	player.volume_db = volume_db
	player.finished.connect(player.queue_free)
	player.play()

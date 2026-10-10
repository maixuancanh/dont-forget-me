extends RigidBody2D

class_name DroppedItem

var is_moving = false

@export var item_data: ItemData
@export var item_qty = 1
@export var drag_speed = 16

@onready var manager: ItemManager = get_parent()
@onready var rigid_body_2d = $"."
@onready var qty_label: Label = $QuantityLabel

var inside_suspender: bool = false

var is_animating_receive = false

func _on_click_area_input_event(viewport: Node, event: InputEvent, shape_idx: int) -> void :
	if event is InputEventMouseButton\
	and event.button_index == MOUSE_BUTTON_LEFT\
	and event.pressed:
		if is_animating_receive:
			return

		if manager.held_item == null:
			rigid_body_2d.freeze = true
			manager.hold_item(self)

func _ready() -> void :
	update_qty_label()

func add_quantity(amt: int = 1):
	item_qty += amt
	update_qty_label()

func set_quantity(amt: int):
	item_qty = amt
	update_qty_label()

func show_cost():
	if item_data:
		qty_label.text = "₫" + str(item_data.item_cost)

func update_qty_label():
	if item_qty == 1:
		qty_label.text = ""
	else:
		qty_label.text = str(item_qty) + "x"

func animate_item_receive():
	is_animating_receive = true

	var tween = create_tween()
	tween.set_ease(Tween.EASE_IN)
	tween.set_trans(Tween.TRANS_BACK)

	tween.tween_property(
		self, 
		"scale", 
		Vector2.ZERO, 
		0.25
	)
	await tween.finished

	queue_free()

func drop_item():
	if inside_suspender:
		return

	rigid_body_2d.freeze = false
	rigid_body_2d.linear_velocity = Vector2.ZERO
	rigid_body_2d.angular_velocity = 0

func _process(_delta: float) -> void :
	qty_label.rotation = - rotation

	if is_moving:
		global_position = global_position.lerp(
			get_global_mouse_position(), 
			1.0 - exp(-drag_speed * _delta)
		)

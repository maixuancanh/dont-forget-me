extends Node

@export var active_area: Node2D
@export var cam: Camera2D
@export var default_area: Node2D

signal day_ended2

const EDGE_SIZE = 32
const TRANSITION_TIME: = 0.5

var interlock_active = false
var in_transit = false
var intro_active = true
var transition_tween: Tween


func _ready() -> void :
	if active_area and active_area.ambient_id != "":
		AmbientAudioManager.enter_area(active_area.ambient_id)


func _process(delta: float) -> void :
	if MemoryGame.is_chat_open:
		return
	if in_transit:
		return
	if intro_active:
		return
	if interlock_active:
		return

	var mouse: = get_viewport().get_mouse_position()
	var size: = get_viewport().get_visible_rect().size


	if (mouse.x < EDGE_SIZE or Input.is_action_just_pressed("ui_left") or Input.is_action_just_pressed("pan_left")) and active_area.left_area:
		switch_area(active_area.left_area)

	elif (mouse.x > size.x - EDGE_SIZE or Input.is_action_just_pressed("ui_right") or Input.is_action_just_pressed("pan_right")) and active_area.right_area:
		switch_area(active_area.right_area)

	elif (mouse.y < EDGE_SIZE or Input.is_action_just_pressed("ui_up") or Input.is_action_just_pressed("pan_up")) and active_area.above_area:
		switch_area(active_area.above_area)

	elif (mouse.y > size.y - EDGE_SIZE or Input.is_action_just_pressed("ui_down") or Input.is_action_just_pressed("pan_down")) and active_area.below_area:
		switch_area(active_area.below_area)

func switch_area(next_area):
	if in_transit or not is_instance_valid(next_area):
		return
	in_transit = true

	transition_tween = create_tween()

	transition_tween.tween_property(
		cam, 
		"global_position", 
		next_area.cam_target.global_position, 
		TRANSITION_TIME
	)

	transition_tween.finished.connect( func():
		active_area = next_area
		in_transit = false
	)

	if next_area.ambient_id != "":
		AmbientAudioManager.enter_area(next_area.ambient_id)

func _on_day_counter_day_intro_finished() -> void :
	intro_active = false

func _on_day_counter_day_intro_starting() -> void :
	intro_active = true

func _on_scene_player_day_ended() -> void :
	day_ended2.emit()
	_force_default_area()

func _force_default_area() -> void :
	if transition_tween and transition_tween.is_valid():
		transition_tween.kill()
	in_transit = false
	active_area = default_area
	cam.global_position = default_area.cam_target.global_position
	cam.force_update_scroll()
	if default_area.ambient_id != "":
		AmbientAudioManager.enter_area(default_area.ambient_id)

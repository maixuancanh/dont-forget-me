extends Node2D

signal on_enter_tindahan
signal on_exit_tindahan

@export var npc_name: String
@export var footstep_sfx: AudioStream

@onready var anim_player: = $Animations

var node_2d: Node2D
var footstep_player: AudioStreamPlayer

func _ready() -> void :
	node_2d = get_node(".")
	node_2d.visible = false

	footstep_player = AudioStreamPlayer.new()
	add_child(footstep_player)
	if footstep_sfx:
		footstep_sfx.loop = true
		footstep_player.stream = footstep_sfx

func enter_tindahan_area():
	node_2d.visible = true
	anim_player.play("WalkIn_fromLeft")
	_start_footsteps()

func exit_tindahan_area():
	anim_player.play("WalkOut_toRight")
	_start_footsteps()

func set_npc_name(_npc_name: String):
	npc_name = _npc_name

func anim_on_entry_finished():
	_stop_footsteps()
	on_enter_tindahan.emit()

func anim_on_exit_finished():
	_stop_footsteps()
	on_exit_tindahan.emit()
	queue_free()

func _start_footsteps():
	if footstep_player.stream:
		footstep_player.play()

func _stop_footsteps():
	footstep_player.stop()

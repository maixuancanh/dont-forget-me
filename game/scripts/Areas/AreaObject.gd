extends Node2D

@export var left_area: Node2D
@export var right_area: Node2D
@export var above_area: Node2D
@export var below_area: Node2D
@export var ambient_id: String = ""
@onready var cam_target: = $CameraTarget

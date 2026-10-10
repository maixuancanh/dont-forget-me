extends Node2D


func _ready() -> void :
	if DayProgression.day_index != 0:
		visible = false

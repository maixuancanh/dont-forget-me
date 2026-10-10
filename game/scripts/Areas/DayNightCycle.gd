extends Node2D

@onready var night_panel: Node2D = $Night

@export var scene_player: ScenePlayer
@export var switch_to_night_upon_progress_idx: = 2

@export var transition_time: int = 15


func _ready() -> void :
	scene_player.on_story_progress.connect( func(progress):
		if progress == switch_to_night_upon_progress_idx:
			switch_to_night()
	)

func switch_to_night():
	var tween = create_tween()

	tween.tween_property(night_panel, "modulate:a", 1.0, transition_time)

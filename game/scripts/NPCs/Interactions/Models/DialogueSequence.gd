extends Resource
class_name DialogueSequence

@export var source_scene_id: String
@export var story_version: String = "v1-static"
@export var requires_generated_dialogue: bool = false
@export var character_name: String
@export var character_template: PackedScene
@export var interactions: Array[InteractionStep]

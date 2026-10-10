extends Area2D

class_name ShelfInteractable

@export var sfx_path: String = "res://assets/audio/gameplay/interaction/story_audio/metal_knocking.mp3"
@export var volume_db: float = -6.0
@export var cooldown_sec: float = 0.4

var _on_cooldown: bool = false

func _ready() -> void :
	input_pickable = true
	input_event.connect(_on_input_event)

func _on_input_event(_viewport: Node, event: InputEvent, _shape_idx: int) -> void :
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_play_sfx()

func _play_sfx() -> void :
	if _on_cooldown:
		return
	_on_cooldown = true

	var stream = load(sfx_path)
	if stream is AudioStream:
		var player: = AudioStreamPlayer.new()
		add_child(player)
		player.stream = stream
		player.volume_db = volume_db
		player.finished.connect(player.queue_free)
		player.play()

	await get_tree().create_timer(cooldown_sec).timeout
	_on_cooldown = false

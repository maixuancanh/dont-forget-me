extends Node

var ambient_player_a: AudioStreamPlayer
var ambient_player_b: AudioStreamPlayer
var active_player: AudioStreamPlayer
var current_ambient_id: String = ""

var is_suppressed: bool = false
var fade_tween: Tween

const CROSSFADE_TIME: = 2.0


var ambient_map: Dictionary = {
	"tindahan_interior": {"path": "res://assets/audio/gameplay/interaction/story_audio/bgmusic.mp3", "volume": -14.0}, 
	"horror_zone": {"path": "res://assets/audio/gameplay/interaction/story_audio/horror_bg.mp3", "volume": -10.0}, 
}

func _ready():
	ambient_player_a = AudioStreamPlayer.new()
	ambient_player_b = AudioStreamPlayer.new()
	add_child(ambient_player_a)
	add_child(ambient_player_b)
	active_player = ambient_player_a

func _exit_tree() -> void:
	if fade_tween and fade_tween.is_valid(): fade_tween.kill()
	for player in [ambient_player_a, ambient_player_b]:
		if is_instance_valid(player):
			player.stop()
			player.stream = null

func enter_area(area_id: String):
	if area_id == current_ambient_id or not ambient_map.has(area_id):
		return

	current_ambient_id = area_id

	if is_suppressed:
		return

	var data = ambient_map[area_id]
	var stream = load(data.path)
	if not (stream is AudioStream):
		return

	if stream is AudioStreamOggVorbis or stream is AudioStreamMP3:
		stream.loop = true
	elif stream is AudioStreamWAV:
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD

	var incoming: = ambient_player_b if active_player == ambient_player_a else ambient_player_a
	incoming.stream = stream
	incoming.volume_db = -40.0
	incoming.play()

	var outgoing: = active_player

	if fade_tween and fade_tween.is_valid():
		fade_tween.kill()

	fade_tween = create_tween().set_parallel(true)
	fade_tween.tween_property(outgoing, "volume_db", -40.0, CROSSFADE_TIME)
	fade_tween.tween_property(incoming, "volume_db", data.volume, CROSSFADE_TIME)
	fade_tween.chain().tween_callback( func(): outgoing.stop())

	active_player = incoming

func exit_all():
	if fade_tween and fade_tween.is_valid():
		fade_tween.kill()

	fade_tween = create_tween()
	fade_tween.tween_property(active_player, "volume_db", -40.0, CROSSFADE_TIME)
	fade_tween.tween_callback(active_player.stop)
	current_ambient_id = ""

func suppress(state: bool):
	if is_suppressed == state:
		return

	is_suppressed = state

	if is_suppressed:

		if fade_tween and fade_tween.is_valid():
			fade_tween.kill()

		fade_tween = create_tween()
		fade_tween.tween_property(active_player, "volume_db", -40.0, CROSSFADE_TIME)
		fade_tween.tween_callback(active_player.stop)
	else:

		if current_ambient_id != "":
			var area_id = current_ambient_id
			current_ambient_id = ""
			enter_area(area_id)

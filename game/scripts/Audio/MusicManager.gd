extends Node

var bgm_player_a: AudioStreamPlayer
var bgm_player_b: AudioStreamPlayer
var active_player: AudioStreamPlayer
var current_bgm_path: String = ""

var fade_tween: Tween

const CROSSFADE_TIME: = 1.5

func _ready():

	bgm_player_a = AudioStreamPlayer.new()
	bgm_player_b = AudioStreamPlayer.new()
	add_child(bgm_player_a)
	add_child(bgm_player_b)


	active_player = bgm_player_a

func play_bgm(stream_path: String, volume_db: float = 0.0, fade_time: float = CROSSFADE_TIME):

	if stream_path == current_bgm_path:
		return

	if stream_path == "":
		stop_bgm(fade_time)
		return

	var stream = load(stream_path)
	if not (stream is AudioStream):
		push_error("Failed to load AudioStream at: " + stream_path)
		return


	if AmbientAudioManager:
		AmbientAudioManager.suppress(true)


	if stream is AudioStreamWAV:
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
	elif stream is AudioStreamOggVorbis or stream is AudioStreamMP3:
		stream.loop = true


	var next_player = bgm_player_b if active_player == bgm_player_a else bgm_player_a
	var prev_player = active_player


	next_player.stream = stream
	next_player.stream_paused = false

	if fade_tween and fade_tween.is_valid():
		fade_tween.kill()

	fade_tween = create_tween().set_parallel(true)


	if prev_player.playing:
		fade_tween.tween_property(prev_player, "volume_db", -80.0, fade_time)

		fade_tween.chain().tween_callback(prev_player.stop)


	next_player.volume_db = -80.0
	next_player.play()
	fade_tween.tween_property(next_player, "volume_db", volume_db, fade_time)


	active_player = next_player
	current_bgm_path = stream_path

func pause_bgm():
	if active_player:
		active_player.stream_paused = true

func resume_bgm():
	if active_player:
		active_player.stream_paused = false

func stop_bgm(fade_out_sec: float = CROSSFADE_TIME, unsuppress_ambient: bool = true):
	current_bgm_path = ""


	if AmbientAudioManager and unsuppress_ambient:
		AmbientAudioManager.suppress(false)

	if active_player and active_player.playing:
		if fade_tween and fade_tween.is_valid():
			fade_tween.kill()

		if fade_out_sec > 0.0:
			fade_tween = create_tween()
			fade_tween.tween_property(active_player, "volume_db", -80.0, fade_out_sec)
			fade_tween.tween_callback(active_player.stop)
		else:
			active_player.stop()

extends NPCInteractionManager
class_name FinalCutsceneNPCInteraction

@export var end_credits_music_path: String
@export var ending_cutscene_file: String
@onready var paluwagan_ui = $"../DialogueUI/PaluwaganUI"
@onready var end_credits = $"../DialogueUI/EndCredits"
var resolution_started := false

func _ready() -> void:
	super._ready()
	paluwagan_ui.on_paluwagan_close.connect(play_final_cutscene)
	MemoryGame.case_resolved.connect(_on_case_resolved)

func play_final_cutscene() -> void:
	# Closing the original ledger opens evidence review, never a confession.
	await get_tree().create_timer(0.2).timeout
	if MemoryGame.session.runtime_known and not MemoryGame.session.runtime_enabled and OS.has_feature("standalone"):
		_on_case_resolved({})
		return
	MemoryGame.set_npc("phuc")
	MemoryGame._open_journal()

func _on_case_resolved(_result: Dictionary) -> void:
	if resolution_started: return
	if not MemoryGame.session.runtime_enabled and not OS.has_feature("standalone"):
		push_error("Validated generated ending dialogue is required; ending held.")
		return
	resolution_started = true
	MemoryGame._close()
	var selected_path := ending_cutscene_file
	if not MemoryGame.session.runtime_enabled and OS.has_feature("standalone"):
		selected_path = ending_cutscene_file.replace("/prod/", "/legacy/")
	var ending := DialogueSequenceLoader.load_dialogue(selected_path, generated_dialogue_available())
	if ending == null:
		resolution_started = false
		return
	prepare_dialogue_file(ending)
	begin_dialogue_sequence()
	await current_npc.on_exit_tindahan
	MusicManager.stop_bgm(5.0, false)
	for sfx in active_sfx.values():
		if is_instance_valid(sfx):
			var tween = create_tween()
			tween.tween_property(sfx, "volume_db", -80.0, 5.0)
			tween.tween_callback(sfx.stop)
	await get_tree().create_timer(5.0).timeout
	AmbientAudioManager.enter_area("tindahan_interior")
	AmbientAudioManager.suppress(false)
	end_credits.visible = true
	end_credits.get_node("AnimationPlayer").play("EndCredits")
	await get_tree().create_timer(35.0).timeout
	AmbientAudioManager.exit_all()
	get_tree().change_scene_to_file("res://scenes/levels/Menu.tscn")

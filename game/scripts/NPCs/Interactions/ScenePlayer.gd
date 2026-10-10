extends Node

class_name ScenePlayer

@onready var npc_interaction_manager: NPCInteractionManager = $"../NPC Container"

signal day_ended

var sequences: Array[DialogueSequence] = []
var sequence_index = -1

@export var active_day = 0
@export var story_line: Dictionary[int, StoryDay_File]

signal on_story_progress

func _ready() -> void :
	active_day = DayProgression.day_index

func play_interactions():
	while sequence_index < sequences.size():
		sequence_index += 1

		if sequence_index > sequences.size() - 1:
			day_ended.emit()




			return

		on_story_progress.emit(sequence_index)
		npc_interaction_manager.prepare_dialogue_file(sequences[sequence_index])
		npc_interaction_manager.begin_dialogue_sequence()
		await npc_interaction_manager.current_npc.on_exit_tindahan


func _on_day_counter_day_intro_finished() -> void :
	if not MemoryGame.session.runtime_known:
		await MemoryGame.runtime_ready
	if not MemoryGame.session.runtime_enabled and not OS.has_feature("standalone"):
		push_error("Validated generated dialogue is required; story held.")
		return
	var files_to_load = story_line[active_day].dialogues
	for file_path in files_to_load:
		var selected_path: String = file_path
		if not MemoryGame.session.runtime_enabled and OS.has_feature("standalone"):
			selected_path = file_path.replace("/prod/", "/legacy/")
		var d: = DialogueSequenceLoader.load_dialogue(selected_path, npc_interaction_manager.generated_dialogue_available())
		if d == null:
			push_error("Story sequence unavailable; holding day: " + file_path)
			return
		sequences.append(d)

	# Resume from the beginning of the current NPC, rebuilding its order safely.
	# Already witnessed lines are idempotent server-side; cash transactions are not restored mid-step.
	var target: String = MemoryGame.session.resume_scene_id
	if target == "Ledger":
		MemoryGame.session.resume_scene_id = ""
		get_tree().change_scene_to_file.call_deferred("res://scenes/levels/EndingCutscene.tscn")
		return
	if not target.is_empty():
		var found := false
		for index in range(sequences.size()):
			if sequences[index].source_scene_id == target:
				sequence_index = index - 1
				found = true
				MemoryGame.session.resume_scene_id = ""
				break
		if not found:
			var target_day := int(MemoryGame.session.next_event.get("day", 0))
			if target_day > active_day + 1 or target == "Ledger":
				sequence_index = sequences.size() - 1
	play_interactions()

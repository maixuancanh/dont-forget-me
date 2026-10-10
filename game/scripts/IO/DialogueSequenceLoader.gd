extends Node

class_name DialogueSequenceLoader

static func load_dialogue(path: String, generated_dialogue_available: bool = false) -> DialogueSequence:
	var file: = FileAccess.open(path, FileAccess.READ)

	if file == null:
		push_error("Could not open dialogue file: " + path)
		return null

	var json_txt: = file.get_as_text()

	var parsed = JSON.parse_string(json_txt)

	if not parsed is Dictionary or not parsed.get("interactions") is Array:
		push_error("Invalid JSON in " + path)
		return null

	var sequence: = DialogueSequence.new()
	sequence.story_version = parsed.get("story_version", "v1-static")
	sequence.requires_generated_dialogue = parsed.get("requires_generated_dialogue", false)
	if sequence.requires_generated_dialogue and not generated_dialogue_available:
		push_error("GENERATED_DIALOGUE_RUNNER_REQUIRED: " + path)
		return null

	sequence.source_scene_id = path.get_file().get_basename()
	sequence.character_name = parsed["character_name"]
	sequence.character_template = load(parsed["character_template"])

	var interaction_lookup: = {}

	for step_json in parsed["interactions"]:

		if not step_json is Dictionary:
			push_error("Invalid interaction object in " + path)
			return null
		var step: = _parse_step(step_json, sequence.character_name)

		if step == null:
			push_error("Dialogue rejected at step " + str(sequence.interactions.size()) + " in " + path)
			return null

		sequence.interactions.append(step)

		if step_json.has("id"):
			if interaction_lookup.has(step_json["id"]):
				push_error("Duplicate interaction id in " + path)
				return null
			interaction_lookup[step_json["id"]] = step

	for i in sequence.interactions.size():
		var step = sequence.interactions[i]
		var step_json = parsed["interactions"][i]

		if step is InteractionPay:
			var purchase_id = step_json["purchase"]

			if purchase_id in interaction_lookup and interaction_lookup[purchase_id] is InteractionRequireItems:
				step.purchase_to_pay = interaction_lookup[purchase_id]
			else:
				push_error(
					"Unknown or invalid purchase reference: " + str(purchase_id)
				)
				return null

	return sequence

static func _parse_step(data: Dictionary, char_name: String = "") -> InteractionStep:
	if not data.has("type") or not data["type"] is String:
		push_error("Interaction type must be a string")
		return null
	match data["type"]:
		"dialogue_beat":
			if not data.get("beat_id") is String or not data["beat_id"].begins_with("v2.") or not data.get("legacy_event_id") is String or not data.get("input_labels", []) is Array:
				push_error("Invalid semantic dialogue beat")
				return null
			var step := InteractionDialogueBeat.new()
			step.beat_id = data["beat_id"]
			step.legacy_event_id = data["legacy_event_id"]
			for label in data.get("input_labels", []):
				if not label is String:
					push_error("Beat input label must be a string")
					return null
				step.input_labels.append(label)
			return step
		"say":
			var step: = InteractionSay.new()


			var raw_sentence: String = data["sentence"]


			step.sentence = raw_sentence.format({"name": char_name})
			return step

		"wait":
			var step: = InteractionWait.new()

			step.waitMs = data["waitMs"]

			return step

		"require_items":
			var step: = InteractionRequireItems.new()

			var required: Dictionary[ItemData, int] = {}

			for item_id in data["required_items"]:
				var item_data: ItemData = Engine.get_main_loop().root.get_node("ItemLoadLut").get_item(item_id)

				required[item_data] = data["required_items"][item_id]

			step.required_items = required

			return step

		"require_change":
			var step: = InteractionRequireChange.new()

			return step

		"choice":
			var step: = InteractionChoice.new()

			var choices: Array[String] = []

			for choice in data["response_choices"]:
				choices.append(choice)

			step.response_choices = choices

			return step

		"place_items":
			var step: = InteractionPlaceItems.new()

			var scenes: Array[PackedScene] = []

			for scene_path in data["items_to_place"]:
				scenes.append(load(scene_path))

			step.items_to_place = scenes

			return step

		"pay":
			var step: = InteractionPay.new()

			step.wealth_factor = data.get("wealth_factor", 0.5)

			return step

		"play_sfx":
			var step: = InteractionPlaySFX.new()

			step.sfx_id = data.get("id", "")
			step.audio_path = data["audio_path"]
			step.wait_for_completion = data.get("wait_for_completion", false)
			step.loop = data.get("loop", false)
			step.volume_db = data.get("volume_db", 0.0)

			return step

		"stop_sfx":
			var step: = InteractionStopSFX.new()
			step.target_id = data.get("target_id", "")
			return step

		"control_bgm":
			var step: = InteractionControlBGM.new()
			step.action = data.get("action", "play")
			step.audio_path = data.get("audio_path", "")
			step.volume_db = data.get("volume_db", 0.0)
			step.fade_in_sec = data.get("fade_in_sec", 0.0)
			return step

	push_error("Unknown interaction type: " + data["type"])

	return null



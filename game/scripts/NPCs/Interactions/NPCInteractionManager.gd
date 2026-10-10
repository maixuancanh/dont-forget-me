extends Node

class_name NPCInteractionManager

@onready var dialogue_manager = %SpeechBubbleStack
@onready var response_manager: ResponseUIManager = %ResponseChoicesScreen

@export var test_interaction: DialogueSequence

var current_interaction: DialogueSequence
var current_npc: Sprite2D
var interaction_progress: int = -1

@export var item_receiver: ItemReceiver
@export var item_spawner: ItemSpawner

@export var money_denominations: Dictionary[ItemDataMoney, PackedScene]

var authoritative_order_bubble: Node
var current_purchase_cost: int
var current_amount_paid: int
var current_payment_items: Array[DroppedItem] = []
var resume_phase := ""
var resume_step := -1

var active_sfx: Dictionary[String, AudioStreamPlayer] = {}

const BeatRunner = preload("res://scripts/Memory/DialogueBeatRunner.gd")
var beat_runner: Node

signal abc

func _random_payment_amount(total: int, wealth: int) -> int:
	var candidates: Array[int] = []

	var mag: = pow(
		10, 
		int(floor(log(float(total)) / log(10.0))) + 1
	)

	var comfortable_limit: int

	if wealth < 0.3:
		comfortable_limit = mini(total * 2, mag)
	elif wealth < 0.7:
		comfortable_limit = mag
	else:
		comfortable_limit = mag * 10

	for money: ItemDataMoney in money_denominations.keys():
		if money.money_worth >= total\
		and money.money_worth <= comfortable_limit:
			candidates.append(money.money_worth)

	candidates.sort()

	if candidates.is_empty():
		return total

	if randf() < 0.05:
		return total

	if randf() < 0.8:
		return candidates[0]

	if candidates.size() > 1:
		return candidates[1]

	return candidates[0]

func _bills_from_amt(total: int) -> Array[PackedScene]:
	var result: Array[PackedScene]

	var bills = money_denominations.keys()

	bills.sort_custom(
		func(a, b):
			return a.money_worth > b.money_worth
	)

	while total > 0:
		var valid_bills: Array[ItemDataMoney] = []

		for bill in bills:
			if bill.money_worth <= total:
				valid_bills.append(bill)

		var chosen: ItemDataMoney

		var r: = randf()

		if r < 0.55:
			chosen = valid_bills[0]
		elif r < 0.85 and valid_bills.size() > 1:
			chosen = valid_bills[1]
		else:
			chosen = valid_bills.pick_random()

		result.append(money_denominations[chosen])
		total -= chosen.money_worth

	return result


func _ready() -> void :
	add_to_group("authoritative_order_receivers")
	_ensure_beat_runner()

func _ensure_beat_runner() -> void:
	if is_instance_valid(beat_runner): return
	beat_runner = BeatRunner.new()
	add_child(beat_runner)
	beat_runner.configure(MemoryGame.client, MemoryGame.session, dialogue_manager)

func generated_dialogue_available() -> bool:
	_ensure_beat_runner()
	return MemoryGame.session.runtime_known and MemoryGame.session.runtime_enabled and is_instance_valid(beat_runner)

func prepare_dialogue_file(dialogue: DialogueSequence):
	current_interaction = dialogue
	MemoryGame.set_npc(dialogue.character_name.to_lower())

# Operational player HUD: deliberately outside the NPC speech bubble stack.
func _operational_status(text: String) -> CanvasLayer:
	var layer := CanvasLayer.new()
	layer.layer = 20
	add_child(layer)
	var panel := PanelContainer.new()
	panel.position = Vector2(20, 120)
	var background := StyleBoxFlat.new()
	background.bg_color = Color(0.10, 0.11, 0.10, 0.94)
	background.content_margin_left = 12
	background.content_margin_right = 12
	background.content_margin_top = 8
	background.content_margin_bottom = 8
	panel.add_theme_stylebox_override("panel", background)
	layer.add_child(panel)
	var label := Label.new()
	label.text = "SYSTEM · " + text
	label.add_theme_color_override("font_color", Color.WHITE)
	panel.add_child(label)
	return layer

func begin_dialogue_sequence():
	interaction_progress = -1
	resume_phase = ""
	resume_step = -1
	if MemoryGame.session.runtime_enabled and str(MemoryGame.session.next_event.get("sceneId", "")) == current_interaction.source_scene_id:
		resume_phase = str(MemoryGame.session.next_event.get("phase", ""))
		resume_step = int(MemoryGame.session.next_event.get("stepIndex", -1))

	var npc = current_interaction.character_template.instantiate()

	add_child(npc)
	current_npc = npc
	npc.enter_tindahan_area()

	npc.on_enter_tindahan.connect(dialogue_iterate)
	npc.on_exit_tindahan.connect(on_npc_exit)

func dialogue_iterate():
	while MemoryGame.is_chat_open:
		await get_tree().process_frame
	if not is_instance_valid(self) or current_interaction == null:
		return
	interaction_progress += 1

	if interaction_progress >= current_interaction.interactions.size():
		if current_npc:
			current_npc.exit_tindahan_area()
		return

	var step = current_interaction.interactions[interaction_progress]
	if MemoryGame.session.runtime_enabled and interaction_progress < resume_step:
		if (step is InteractionRequireItems and resume_phase in ["payment", "dialogue"]) or ((step is InteractionPay or step is InteractionRequireChange) and resume_phase == "dialogue"):
			if step is InteractionRequireChange and not await _runtime_payment_speech(): return
			dialogue_iterate()
			return

	if step is InteractionDialogueBeat:
		_ensure_beat_runner()
		if MemoryGame.session.runtime_enabled:
			var expected: Dictionary = MemoryGame.session.next_event
			# Local waits/SFX and already committed earlier beats may be reconstructed.
			var legacy_parts: PackedStringArray = str(step.legacy_event_id).split(":")
			var legacy_step := int(legacy_parts[legacy_parts.size() - 1])
			if str(expected.get("sceneId", "")) != current_interaction.source_scene_id or int(expected.get("stepIndex", -1)) > legacy_step:
				dialogue_iterate()
				return
			if str(expected.get("beatId", "")) != step.beat_id:
				push_error("Runtime checkpoint mismatch; story held.")
				return
		var speaking_npc := current_interaction.character_name
		if MemoryGame.session.runtime_enabled:
			speaking_npc = str(MemoryGame.session.next_event.get("npcId", current_interaction.character_name))
		MemoryGame.set_npc(speaking_npc.to_lower())
		beat_runner.start(step, speaking_npc)
		var acknowledged: bool = await beat_runner.finished
		if acknowledged and is_inside_tree(): dialogue_iterate()
		return

	elif step is InteractionSay:
		if not OS.has_feature("standalone"):
			push_error("Static NPC speech is unavailable in production; story held.")
			return
		MemoryGame.witness(current_interaction.source_scene_id, interaction_progress)
		var bubble = dialogue_manager.say(step.sentence)
		if bubble != null:
			await bubble.clicked
			if is_instance_valid(bubble):
				bubble.queue_free()


		var next_idx = interaction_progress + 1
		if next_idx < current_interaction.interactions.size():
			if current_interaction.interactions[next_idx] is InteractionWait:
				interaction_progress += 1

		dialogue_iterate()

	elif step is InteractionWait:
		await get_tree().create_timer(float(step.waitMs) / float(1000)).timeout
		dialogue_iterate()

	elif step is InteractionRequireChange:
		var change = current_amount_paid - current_purchase_cost

		if change > 0:
			item_receiver.setup_requirements_money(change)
			var text = "Tender received: ₫" + str(current_amount_paid) + "\nOrder total: ₫" + str(current_purchase_cost)
			var bubble = _operational_status(text)

			await item_receiver.on_satisfied

			if is_instance_valid(bubble):
				bubble.queue_free()

		if MemoryGame.session.runtime_enabled and str(MemoryGame.session.next_event.get("phase", "")) == "payment":
			# Exact payment still needs a visible player confirmation.
			if change <= 0:
				var confirmation = dialogue_manager.say("Payment is exact. Confirm payment received.")
				await confirmation.clicked
				if is_instance_valid(confirmation): confirmation.queue_free()
			var captured_scene := get_tree().current_scene
			if not await MemoryGame.complete_runtime_action("payment") or not is_inside_tree() or captured_scene != get_tree().current_scene: return
		if not await _runtime_payment_speech(): return
		dialogue_iterate()

	elif step is InteractionRequireItems:
		var requirements: Dictionary[ItemData, int] = step.required_items
		if MemoryGame.session.runtime_enabled:
			requirements = _authoritative_items()
		item_receiver.setup_requirements_items(requirements)

		var text = "Order items:\n"
		for item in requirements:
			text += item.item_name + " x " + str(requirements[item]) + "\n"
		text += "Place the order in the center of the counter."
		var bubble = _operational_status(text.strip_edges())
		authoritative_order_bubble = bubble

		await item_receiver.on_satisfied
		authoritative_order_bubble = null

		if is_instance_valid(bubble):
			bubble.queue_free()

		if MemoryGame.session.runtime_enabled and str(MemoryGame.session.next_event.get("phase", "")) == "order":
			var captured_scene := get_tree().current_scene
			if not await MemoryGame.complete_runtime_action("order") or not is_inside_tree() or captured_scene != get_tree().current_scene: return
		dialogue_iterate()

	elif step is InteractionPay:
		current_purchase_cost = step._compute_total_cost()
		print("Cost for " + current_interaction.character_name + ": " + str(current_purchase_cost))
		current_amount_paid = _random_payment_amount(current_purchase_cost, step.wealth_factor)
		if MemoryGame.session.runtime_enabled:
			var preview: Dictionary = MemoryGame.session.next_event.get("transactionPreview", {})
			if preview.is_empty() or int(preview.get("total", -1)) < 0:
				push_error("Authoritative payment does not match the physical order. Story held.")
				return
			current_purchase_cost = int(preview.total)
			current_amount_paid = int(preview.get("paidAmount", 0))
			if current_amount_paid < current_purchase_cost or int(preview.get("acceptedChange", -1)) != current_amount_paid - current_purchase_cost:
				push_error("Invalid authoritative payment preview. Story held.")
				return
		var bills_to_use = _bills_from_amt(current_amount_paid)

		current_payment_items = item_spawner.spawn_items(bills_to_use)

		dialogue_iterate()

	elif step is InteractionPlaceItems:
		item_spawner.spawn_items(step.items_to_place)

		dialogue_iterate()

	elif step is InteractionChoice:
		response_manager.display_choices(step.response_choices)

		var area_manager = get_tree().current_scene.get_node_or_null("Areas")
		if area_manager and "interlock_active" in area_manager:
			area_manager.interlock_active = true

		await response_manager.on_response_selected

		if area_manager and "interlock_active" in area_manager:
			area_manager.interlock_active = false

		dialogue_iterate()

	elif step is InteractionPlaySFX:
		var stream = load(step.audio_path)
		if stream is AudioStream:
			if step.loop:
				if stream is AudioStreamWAV:
					stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
				elif stream is AudioStreamOggVorbis or stream is AudioStreamMP3:
					stream.loop = true

			var player: = AudioStreamPlayer.new()
			add_child(player)
			player.stream = stream
			player.volume_db = step.volume_db

			if step.sfx_id != "":
				if active_sfx.has(step.sfx_id):
					var old_player = active_sfx[step.sfx_id]
					if is_instance_valid(old_player):
						old_player.stop()
						old_player.queue_free()
				active_sfx[step.sfx_id] = player

			player.finished.connect(player.queue_free)
			player.play()

			if step.wait_for_completion:
				await player.finished

		dialogue_iterate()

	elif step is InteractionStopSFX:
		if active_sfx.has(step.target_id):
			var player = active_sfx[step.target_id]
			if is_instance_valid(player):
				player.stop()
				player.queue_free()
			active_sfx.erase(step.target_id)

		dialogue_iterate()

	elif step is InteractionControlBGM:
		if step.action == "play":
			MusicManager.play_bgm(step.audio_path, step.volume_db, step.fade_in_sec)
		elif step.action == "pause":
			MusicManager.pause_bgm()
		elif step.action == "resume":
			MusicManager.resume_bgm()
		elif step.action == "stop":
			MusicManager.stop_bgm()
		elif step.action == "suppress_ambient":
			AmbientAudioManager.suppress(true)
		elif step.action == "unsuppress_ambient":
			AmbientAudioManager.suppress(false)

		dialogue_iterate()


func on_npc_exit():
	for payment_item in current_payment_items:
		if is_instance_valid(payment_item):
			var holder = payment_item.manager
			if is_instance_valid(holder):
				if holder.held_item == payment_item:
					holder.held_item = null
				if holder.pressed_dropped_item == payment_item:
					holder.pressed_dropped_item = null
			payment_item.queue_free()
	current_payment_items.clear()
	current_interaction = null
	MemoryGame.set_npc("")


func _runtime_payment_speech() -> bool:
	if not MemoryGame.session.runtime_enabled: return true
	var checkpoint: Dictionary = MemoryGame.session.next_event
	if str(checkpoint.get("kind", "")) != "payment" or str(checkpoint.get("phase", "")) != "dialogue": return true
	var payment_beat := InteractionDialogueBeat.new()
	payment_beat.beat_id = str(checkpoint.get("beatId", ""))
	payment_beat.legacy_event_id = current_interaction.source_scene_id + ":payment:" + str(checkpoint.get("stepIndex", 0))
	_ensure_beat_runner()
	beat_runner.start(payment_beat, current_interaction.character_name)
	return await beat_runner.finished

func _process(delta: float) -> void :
	pass

func _authoritative_items() -> Dictionary[ItemData, int]:
	var requirements: Dictionary[ItemData, int] = {}
	var preview: Dictionary = MemoryGame.session.next_event.get("transactionPreview", {})
	for line in preview.get("items", []):
		var data: ItemData = ItemLoadLut.get_item(str(line.itemId))
		if data == null: push_error("Authoritative order item missing from LUT"); return {}
		requirements[data] = int(line.quantity)
	return requirements

func refresh_authoritative_order() -> void:
	if MemoryGame.session.runtime_enabled and str(MemoryGame.session.next_event.get("phase", "")) == "order":
		var requirements := _authoritative_items()
		if not requirements.is_empty():
			item_receiver.setup_requirements_items(requirements)
			if is_instance_valid(authoritative_order_bubble):
				var words := "Updated order items:\n"
				for item in requirements: words += item.item_name + " x " + str(requirements[item]) + "\n"
				authoritative_order_bubble.say_plain(words.strip_edges())

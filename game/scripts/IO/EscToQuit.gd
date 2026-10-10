extends Node

var quitting := false

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	get_tree().auto_accept_quit = false

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		request_quit()

func _unhandled_input(event: InputEvent) -> void :
	if event.is_action_pressed("ui_cancel"):
		request_quit()

func request_quit(exit_code: int = 0) -> void:
	if quitting: return
	if OS.has_feature("web") and get_tree().current_scene and get_tree().current_scene.scene_file_path.ends_with("Menu.tscn"):
		var notice := AcceptDialog.new()
		notice.dialog_text = "Close this browser tab to exit the game."
		notice.title = "Exit game"
		add_child(notice)
		notice.confirmed.connect(notice.queue_free)
		notice.canceled.connect(notice.queue_free)
		notice.popup_centered()
		return
	quitting = true
	var tree := get_tree()
	tree.paused = false
	var memory = tree.root.get_node_or_null("MemoryGame")
	if memory:
		memory._close()
		memory.client.cancel_all()
		memory.failed_requests.clear()
	for name in ["MusicManager", "AmbientAudioManager"]:
		var manager = tree.root.get_node_or_null(name)
		if manager and manager.fade_tween and manager.fade_tween.is_valid():
			manager.fade_tween.kill()
	_stop_audio(tree.root)
	# Stop requests and players before teardown; AudioServer consumes stops on its mix thread.
	if is_instance_valid(tree.current_scene):
		tree.current_scene.queue_free()
		tree.current_scene = null
	await tree.process_frame
	await tree.create_timer(0.08, true, false, true).timeout
	await tree.process_frame
	if OS.has_feature("web"):
		# Browsers own their tab lifetime. Keep the engine alive for menu/replay.
		MusicManager.current_bgm_path = ""
		AmbientAudioManager.current_ambient_id = ""
		AmbientAudioManager.is_suppressed = false
		tree.change_scene_to_file("res://scenes/levels/Menu.tscn")
		quitting = false
		return
	tree.quit(exit_code)

func _stop_audio(node: Node) -> void:
	if node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D:
		node.stop()
		node.stream = null
	for child in node.get_children(): _stop_audio(child)

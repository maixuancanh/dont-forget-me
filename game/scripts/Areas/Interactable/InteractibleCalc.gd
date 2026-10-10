extends Node2D

@onready var calc_base = $CalculatorBase
@onready var click_area = $CalculatorBase / CalcClickArea
@onready var calculator_screen: Label = $CalculatorBase / CalculatorScreen

var current_input = ""
var stored_value = ""
var active_operator = ""
var is_typing_new_number = false

var is_selected = false
var selection_tween: Tween

var original_position: Vector2
var original_scale: Vector2 = Vector2(0.8, 0.8)
var target_scale: Vector2 = Vector2(1.2, 1.2)
var original_rotation: float

func _ready() -> void :
	_skin()
	original_position = calc_base.position
	calc_base.scale = original_scale
	original_rotation = calc_base.rotation

	set_buttons_enabled(false)

	calculator_screen.text = ""
	for button in get_tree().get_nodes_in_group("calc_buttons"):
		if button is TextureButton:
			button.pressed.connect(_on_calculator_button_pressed.bind(button.name))

func _skin() -> void:
	for child in calc_base.get_children():
		if child.name.begins_with("BlankButton"): child.hide()
	calc_base.texture = ArtFit.texture("may-tinh", Rect2(24,179,991,1181))
	# The visual fits the original coordinate system; transforms remain owned by
	# calculator selection so zooming cannot disconnect buttons from the body.
	calc_base.region_enabled = false
	var img = calc_base.texture
	var visual = Sprite2D.new()
	calc_base.add_child(visual)
	calc_base.move_child(visual, 0)
	visual.texture = img
	visual.scale = Vector2(580,770) / img.get_size()
	calc_base.texture = null
	calculator_screen.position = Vector2(-200,-285)
	calculator_screen.size = Vector2(395,100)
	calculator_screen.add_theme_color_override("font_color", Color.WHITE)
	var keys = ["7","8","9","DivButton","4","5","6","MultButton","1","2","3","MinusButton","C","0","00","AddButton","="]
	for i in keys.size():
		var button = calc_base.get_node(NodePath(keys[i])) as TextureButton
		button.texture_normal = ArtFit.texture("nut-trong", Rect2(350,352,556,547))
		button.texture_pressed = ArtFit.texture("nut-trong-nhan", Rect2(351,351,556,547))
		button.ignore_texture_size = true
		button.stretch_mode = TextureButton.STRETCH_SCALE
		button.position = Vector2(-215 + (i%4)*108, -100 + (i/4)*85)
		button.size = Vector2(96,72)
		if keys[i] == "=": button.size.x = 420
		var label = Label.new()
		button.add_child(label)
		label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		label.add_theme_font_size_override("font_size", 38)
		label.text = {"AddButton":"+","MinusButton":"−","MultButton":"×","DivButton":"÷"}.get(keys[i],keys[i])

func _on_calculator_button_pressed(math_value: String) -> void :
	var button_value = math_value

	if math_value == "AddButton":
		button_value = "+"
	elif math_value == "MinusButton":
		button_value = "-"
	elif math_value == "MultButton":
		button_value = "*"
	elif math_value == "DivButton":
		button_value = "/"

	if button_value == "C":
		clear_calculator()
		return

	if button_value == "=":
		calculate_result()
		return


	if button_value in ["+", "-", "*", "/"]:
		if stored_value != "" and current_input != "" and not is_typing_new_number:
			calculate_result()

		if current_input != "":
			stored_value = current_input
			active_operator = button_value
			is_typing_new_number = true
		elif stored_value != "":
			active_operator = button_value
		return

	if button_value in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "00"]:
		if is_typing_new_number:
			current_input = ""
			is_typing_new_number = false

		if current_input == "0" and (button_value == "00" or button_value == "0"):
			pass
		elif current_input == "0" or current_input == "":
			current_input = button_value
		else:
			current_input += button_value

		calculator_screen.text = current_input


func calculate_result() -> void :
	if stored_value == "" or active_operator == "":
		return

	var second_number = current_input if current_input != "" else stored_value
	var full_expression = stored_value + active_operator + second_number

	var expr = Expression.new()
	var error = expr.parse(full_expression)

	if error == OK:
		var result = expr.execute()
		if not expr.has_execute_failed():
			calculator_screen.text = str(result)
			current_input = str(result)

			stored_value = ""
			active_operator = ""
			is_typing_new_number = false
		else:
			show_error()
	else:
		show_error()

func clear_calculator() -> void :
	current_input = ""
	stored_value = ""
	active_operator = ""
	is_typing_new_number = false
	calculator_screen.text = "0"

func show_error() -> void :
	calculator_screen.text = "ERROR"
	current_input = ""
	stored_value = ""
	active_operator = ""
	is_typing_new_number = false

func _input(event: InputEvent) -> void :
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		var mouse_pos = get_global_mouse_position()
		var query = PhysicsPointQueryParameters2D.new()
		query.position = mouse_pos
		query.collide_with_areas = true

		var space_state = get_world_2d().direct_space_state
		var results = space_state.intersect_point(query)

		var clicked_calc = false
		for result in results:
			if result.collider == click_area:
				clicked_calc = true
				break

		if clicked_calc:
			if not is_selected:
				select_calculator()
		else:
			if is_selected:
				deselect_calculator()

func select_calculator() -> void :
	if is_selected: return
	is_selected = true

	clear_calculator()
	if selection_tween and selection_tween.is_valid(): selection_tween.kill()

	selection_tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	selection_tween.tween_property(calc_base, "position", Vector2(0, 0), 0.4)
	selection_tween.tween_property(calc_base, "scale", target_scale, 0.4)
	selection_tween.tween_property(calc_base, "rotation", 0.0, 0.4)

	set_buttons_enabled(true)

func deselect_calculator() -> void :
	if not is_selected: return
	is_selected = false
	set_buttons_enabled(false)

	calculator_screen.text = ""
	current_input = ""

	if selection_tween and selection_tween.is_valid(): selection_tween.kill()
	selection_tween = create_tween().set_parallel(true).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	selection_tween.tween_property(calc_base, "position", original_position, 0.4)
	selection_tween.tween_property(calc_base, "scale", original_scale, 0.4)
	selection_tween.tween_property(calc_base, "rotation", original_rotation, 0.4)

func set_buttons_enabled(enabled: bool) -> void :
	for child in calc_base.get_children():
		if child is TextureButton:
			child.disabled = !enabled
			child.mouse_filter = Control.MOUSE_FILTER_STOP if enabled else Control.MOUSE_FILTER_PASS

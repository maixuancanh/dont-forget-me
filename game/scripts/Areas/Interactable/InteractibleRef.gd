extends Node2D

@onready var top_open = $RefDoorTop_Open
@onready var top_closed = $RefDoorTop_Closed
@onready var bottom_open = $RefDoorBot_Open
@onready var bottom_closed = $RefDoorBot_Closed

@onready var top_full_shape = $TopDoorArea / FullDoorShape
@onready var top_handle_shape = $TopDoorArea / HandleShape
@onready var bottom_full_shape = $BottomDoorArea / FullDoorShape
@onready var bottom_handle_shape = $BottomDoorArea / HandleShape


func _ready() -> void :
	_layout_art.call_deferred()
	_update_door_collision(top_open.visible, top_full_shape, top_handle_shape)
	_update_door_collision(bottom_open.visible, bottom_full_shape, bottom_handle_shape)

func _layout_art() -> void:
	position = Vector2(-170, 0)
	scale = Vector2.ONE
	ArtFit.sprite($RefInterior, ArtFit.texture("tu-lanh-ruot", Rect2(165,38,692,1465)), Vector2(-330,0), Vector2(490,1000))
	_project_open_door(top_open, true)
	_project_open_door(bottom_open, false)
	ArtFit.sprite(top_closed, ArtFit.texture("tu-lanh-cua-tren", Rect2(68,72,1400,880)), Vector2(-330,-350), Vector2(475,285))
	ArtFit.sprite(bottom_closed, ArtFit.texture("tu-lanh-cua-duoi", Rect2(104,50,819,1450)), Vector2(-330,150), Vector2(475,700))
	top_closed.z_index = 5
	bottom_closed.z_index = 5
	$RefDoorTop_Open/RefDoorTop_Open_Tray.hide()
	$RefDoorBot_Open/RefDoorTop_Bottom_Tray.hide()
	# Keep the existing dispensers and their signals, but give each one a local
	# shelf footprint. Sprite art, click collision, and return target move together.
	_place_goods($RefInterior/Ice_Dispenser, Vector2(-330,-280), Vector2(310,100), 3)
	_place_goods($RefInterior/Coke_Dispenser, Vector2(-330,-58), Vector2(320,140), 4)
	_place_goods($RefInterior/Sprite_Dispenser, Vector2(-430,110), Vector2(145,130), 2)
	_place_goods($RefInterior/Royal_Dispenser, Vector2(-235,110), Vector2(145,130), 2)
	_place_goods($RefInterior/Beer_Dispenser, Vector2(-330,295), Vector2(320,180), 4)
	_place_door_goods($RefDoorBot_Open/ProductContainer/Egg_Dispenser, Vector2(300,560), Vector2(680,650), 5, 42)
	# Bottle feet sit below the front lip, along the pocket floor, not its opening.
	_place_door_goods($RefDoorBot_Open/ProductContainer/WaterBottle_Dispenser, Vector2(320,1190), Vector2(660,1340), 4, 110)
	_hitbox(top_full_shape, Vector2(-330,-350), Vector2(475,285))
	_hitbox(bottom_full_shape, Vector2(-330,150), Vector2(475,700))
	_hitbox(top_handle_shape, Vector2(218,-315), Vector2(38,240))
	_hitbox(bottom_handle_shape, Vector2(218,165), Vector2(38,640))
	_layout_cases()
	_sync_products()

# Both source illustrations have different trapezoids. Rectify their UVs onto
# one shared hinge and slope rather than independently stretching bounding boxes.
func _door_point(p: Vector2, upper: bool) -> Vector2:
	var u := (p.x - (155.0 if upper else 161.0)) / (1249.0 if upper else 764.0)
	var source_top := lerpf(170, 88, u) if upper else lerpf(190, 27, u)
	var source_bottom := lerpf(800, 981, u) if upper else lerpf(1200, 1520, u)
	var v := (p.y - source_top) / (source_bottom - source_top)
	return Vector2(-105 + u * 340, (-460 if upper else -195) + u * 25 + v * (255 if upper else 650))

func _door_patch(parent: Sprite2D, points: PackedVector2Array, upper: bool, front := false) -> void:
	var patch := Polygon2D.new()
	patch.texture = load("res://assets/replacement/tu-lanh-mo-tren-single.png" if upper else "res://assets/replacement/tu-lanh-mo-duoi.png")
	var projected := PackedVector2Array()
	for point in points:
		projected.append(_door_point(point, upper))
	patch.polygon = projected
	patch.uv = points
	patch.z_index = 2 if front else 0
	parent.add_child(patch)

func _project_open_door(node: Sprite2D, upper: bool) -> void:
	node.texture = null
	node.position = Vector2.ZERO
	node.scale = Vector2.ONE
	node.set_meta("replacement_applied", true)
	var rect := Rect2(155,88,1249,893) if upper else Rect2(161,27,764,1493)
	for y in range(16):
		for x in range(12):
			var a := rect.position + rect.size * Vector2(x / 12.0, y / 16.0)
			var b := rect.position + rect.size * Vector2((x + 1) / 12.0, (y + 1) / 16.0)
			_door_patch(node, PackedVector2Array([a, Vector2(b.x,a.y), b, Vector2(a.x,b.y)]), upper)
	if not upper:
		# Repaint the front lips over the product feet; products sit IN the rack.
		_door_patch(node, PackedVector2Array([Vector2(193,545),Vector2(698,659),Vector2(762,608),Vector2(780,742),Vector2(704,790),Vector2(190,651)]), false, true)
		_door_patch(node, PackedVector2Array([Vector2(193,1068),Vector2(700,1270),Vector2(772,1200),Vector2(780,1375),Vector2(704,1420),Vector2(190,1190)]), false, true)

func _place_door_goods(dispenser: Area2D, first: Vector2, last: Vector2, count: int, height: float) -> void:
	var start := _door_point(first, false)
	var end := _door_point(last, false)
	_place_goods(dispenser, (start + end) / 2 - Vector2(0,height / 2), Vector2(end.x-start.x+42,height+absf(end.y-start.y)),count)
	dispenser.z_index = 1
	var i := 0
	for child in dispenser.get_children():
		if child is Sprite2D and child.visible:
			var fit: float = height / child.texture.get_height()
			child.scale = Vector2.ONE * fit
			child.global_position = to_global(start.lerp(end, i / float(count-1)) - Vector2(0,height/2))
			i += 1

func _layout_cases() -> void:
	var cases := get_parent().get_node("Cases")
	cases.position = Vector2.ZERO
	# Two floor rows of three crates, with consistent footprints and depth order.
	var specs := [
		["Sprite2D2","ket-xanh-duong-vang",Vector2(245,290)],
		["Sprite2D6","ket-do-vang",Vector2(510,290)],
		["Sprite2D5","ket-xanh-la",Vector2(775,290)],
		["Sprite2D3","ket-do",Vector2(245,430)],
		["Sprite2D","ket-xanh-duong",Vector2(510,430)],
		["Sprite2D4","ket-xanh-la-khac",Vector2(775,430)]]
	for spec in specs:
		var node: Sprite2D = cases.get_node(spec[0])
		var art: Texture2D = load("res://assets/replacement/"+spec[1]+".png")
		# Use the nontransparent footprint, not inconsistent source canvas margins.
		var bounds := art.get_image().get_used_rect()
		var atlas := AtlasTexture.new()
		atlas.atlas = art
		atlas.region = Rect2(bounds)
		ArtFit.sprite(node,atlas,spec[2],Vector2(240,175))
		node.z_index = 2 + int(spec[2].y / 100)

func _hitbox(node: CollisionShape2D, center: Vector2, extent: Vector2) -> void:
	node.global_position = to_global(center)
	node.global_scale = Vector2.ONE
	node.rotation = 0
	var shape = RectangleShape2D.new()
	shape.size = extent
	node.shape = shape

func _place_goods(dispenser: Area2D, center: Vector2, extent: Vector2, count: int) -> void:
	dispenser.global_position = to_global(center)
	dispenser.global_scale = Vector2.ONE
	var idx = 0
	for child in dispenser.get_children():
		if child is Sprite2D:
			child.visible = idx < count
			if idx < count:
				child.modulate = Color.WHITE
				child.rotation = 0
				child.offset = Vector2.ZERO
				var fit = minf(extent.x / count / child.texture.get_width(), extent.y / child.texture.get_height())
				child.scale = Vector2.ONE * fit
				child.position = Vector2((idx + 0.5) * extent.x / count - extent.x / 2, 0)
			idx += 1
		elif child is CollisionShape2D:
			child.position = Vector2.ZERO
			child.scale = Vector2.ONE
			var shape = RectangleShape2D.new()
			shape.size = extent
			child.shape = shape

func _sync_products() -> void:
	for child in $RefInterior.get_children():
		if child is Area2D:
			var accessible: bool = top_open.visible if child.name == "Ice_Dispenser" else bottom_open.visible
			child.visible = accessible
			for shape in child.get_children():
				if shape is CollisionShape2D:
					shape.set_deferred("disabled", not accessible)
	for child in $RefDoorBot_Open/ProductContainer.get_children():
		for shape in child.get_children():
			if shape is CollisionShape2D:
				shape.set_deferred("disabled", not bottom_open.visible)


func _update_door_collision(is_open: bool, full_shape: CollisionShape2D, handle_shape: CollisionShape2D) -> void :
	full_shape.disabled = is_open
	handle_shape.disabled = not is_open


func _toggle_door(
	open_sprite: Sprite2D, 
	closed_sprite: Sprite2D, 
	full_shape: CollisionShape2D, 
	handle_shape: CollisionShape2D
) -> void :
	open_sprite.visible = !open_sprite.visible
	closed_sprite.visible = !closed_sprite.visible
	_update_door_collision(open_sprite.visible, full_shape, handle_shape)
	_sync_products()


func _on_top_door_area_input_event(viewport, event, shape_idx) -> void :
	if event is InputEventMouseButton\
	and event.button_index == MOUSE_BUTTON_LEFT\
	and event.pressed:
		_toggle_door(top_open, top_closed, top_full_shape, top_handle_shape)


func _on_bottom_door_area_input_event(viewport, event, shape_idx) -> void :
	if event is InputEventMouseButton\
	and event.button_index == MOUSE_BUTTON_LEFT\
	and event.pressed:
		_toggle_door(bottom_open, bottom_closed, bottom_full_shape, bottom_handle_shape)

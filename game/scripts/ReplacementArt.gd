extends Node

# Preserve scene animation and collision nodes; adapt only displayed sprites.
var mapping: Dictionary = {}
var textures: Dictionary = {}

func _ready() -> void:
    var parsed = JSON.parse_string(FileAccess.get_file_as_string("res://assets/replacement/mapping.json"))
    if parsed is Dictionary:
        mapping = parsed
    get_tree().node_added.connect(_on_node_added)
    _walk(get_tree().root)

func _walk(node: Node) -> void:
    _on_node_added(node)
    for child in node.get_children():
        _walk(child)

func _on_node_added(node: Node) -> void:
    if node.name == "Shelf" and node is Sprite2D:
        _shelf_goods.call_deferred(node)
    if node.name == "OverheadArea":
        _hanging_cords.call_deferred(node)
    if node is TextureRect:
        _ui_art.call_deferred(node)
    if node is ItemDispenser or node is DroppedItem:
        _cash.call_deferred(node)
    if node is Sprite2D:
        _replace.call_deferred(node)

func _shelf_goods(shelf: Sprite2D) -> void:
    await get_tree().process_frame
    if not is_instance_valid(shelf): return
    # Slots are measured on the replacement shelf, not inherited old-art positions.
    var slots := {
        "ChipsNova_Dispenser":Vector2i(3,0), "ChipsPiattos_Dispenser2":Vector2i(2,0), "ChipsPiattos_Dispenser3":Vector2i(1,0),
        "CanCornBeef_Dispenser":Vector2i(3,1), "CanSardines_Dispenser2":Vector2i(2,1), "CanSardines_Dispenser3":Vector2i(1,1),
        "Noodles_Soup_Dispenser":Vector2i(2,2), "Noodles_Pancit_Dispenser":Vector2i(3,2),
        "Rebisco1_Dispenser":Vector2i(1,2), "Rebisco_Dispenser":Vector2i(0,1), "Rebisco_Dispenser2":Vector2i(0,0)}
    var size := shelf.texture.get_size()
    var floors := [0.311,0.510,0.720,0.861]
    for dispenser in shelf.get_children():
        if not dispenser is ItemDispenser or not slots.has(str(dispenser.name)): continue
        var slot: Vector2i = slots[str(dispenser.name)]
        var base := Vector2((0.154 + slot.x*0.229)*size.x, floors[slot.y]*size.y) - size/2
        dispenser.position = base - Vector2(0,65)
        dispenser.scale = Vector2.ONE
        dispenser.rotation = 0
        var index := 0
        var bounds := Rect2()
        for product in dispenser.get_children():
            if not product is Sprite2D: continue
            product.visible = index < 2
            if index < 2:
                var art: Texture2D = product.texture
                var crop := Rect2(art.get_image().get_used_rect())
                var atlas := AtlasTexture.new()
                atlas.atlas = art
                atlas.region = crop
                var limit := Vector2(size.x*0.085,size.y*(0.145 if slot.y<3 else 0.10))
                var fit := minf(limit.x/crop.size.x,limit.y/crop.size.y)
                var extent := crop.size*fit
                var center := Vector2((index-0.5)*size.x*0.094,65-extent.y/2)
                ArtFit.sprite(product,atlas,center,extent)
                product.modulate = Color.WHITE
                var rect := Rect2(center-extent/2,extent)
                bounds = rect if index==0 else bounds.merge(rect)
            index += 1
        var shift := bounds.get_center()
        dispenser.position += shift
        for child in dispenser.get_children():
            if child is Sprite2D: child.position -= shift
            if child is CollisionShape2D:
                child.position = Vector2.ZERO
                child.scale = Vector2.ONE
                child.rotation = 0
                var shape := RectangleShape2D.new()
                shape.size = bounds.size
                child.shape = shape

func _hanging_cords(area: Node) -> void:
    # Wait for replacement sprites to receive their final texture and transform.
    await get_tree().process_frame
    if not is_instance_valid(area): return
    var art: Texture2D = load("res://assets/replacement/day-treo.png")
    var atlas := AtlasTexture.new()
    atlas.atlas = art
    atlas.region = Rect2(480, 25, 65, 1480)
    for dispenser in area.get_children():
        if not dispenser is ItemDispenser: continue
        var product: Sprite2D = dispenser.get_node_or_null("Sprite2D")
        if product == null or product.texture == null: continue
        var rect := product.get_rect()
        var pixels := product.texture.get_image()
        var used := pixels.get_used_rect()
        # Ignore faint alpha fringes when locating the actual packet seal.
        var top := used.end.y
        for y in range(used.position.y, used.end.y):
            var found := false
            for x in range(used.position.x, used.end.x):
                if pixels.get_pixel(x,y).a > 0.8:
                    top = y
                    found = true
                    break
            if found: break
        var attach: Vector2 = area.to_local(product.to_global(rect.position + Vector2(product.texture.get_width() * 0.5, top + 18)))
        var anchor := Vector2(attach.x, -135)
        var cord := Sprite2D.new()
        cord.name = str(dispenser.name) + "_Cord"
        area.add_child(cord)
        ArtFit.sprite(cord, atlas, (anchor + attach) * 0.5, Vector2(24, maxf(20, attach.y - anchor.y)))
        cord.z_index = 1

func _ui_art(node: TextureRect) -> void:
    if not is_instance_valid(node) or node.texture == null: return
    var path = node.texture.resource_path
    if mapping.has(path):
        node.texture = load(mapping[path])
        node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
        node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
    elif path.ends_with("full_paluwagan.png"):
        node.texture = ArtFit.texture("so-no", Rect2(42,34,1450,978))
        node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
        node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
        var writing = Control.new()
        writing.set_script(load("res://scripts/UI/LedgerPage.gd"))
        node.add_child(writing)
    elif path.contains("game_title"):
        node.texture = ArtFit.texture("logo", Rect2(95,35,1354,961))
        node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
        node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED

func _cash(node: Node) -> void:
    if not is_instance_valid(node) or not node.item_data is ItemDataMoney:
        return
    var value: int = node.item_data.money_worth
    var extent = Vector2(260,113)
    var stack_step = 8.0
    if node is ItemDispenser:
        # Front pockets and the shallow rear trough have different perspective.
        # Keep the full stack inside the floor, clear of the wooden dividers.
        var slots = {1000: Vector2(-455,185), 5000: Vector2(-168,185),
            10000: Vector2(137,185), 20000: Vector2(440,185),
            50000: Vector2(-380,-25), 100000: Vector2(0,-25), 500000: Vector2(380,-25)}
        if slots.has(value): node.position = slots[value]
        extent = Vector2(210,95) if value < 50000 else Vector2(240,34)
        stack_step = 3.0 if value < 50000 else 1.0
    if value == 1000000:
        node.hide()
        for child in node.get_children():
            if child is CollisionShape2D: child.disabled = true
        return
    var tex = ArtFit.texture("tien-" + str(value), Rect2(71,81,1649,718))
    var idx = 0
    for child in node.get_children():
        if child is Sprite2D:
            ArtFit.sprite(child, tex, Vector2(0, idx*stack_step), extent)
            idx += 1
        elif child is CollisionShape2D:
            child.position = Vector2.ZERO
            var shape = RectangleShape2D.new()
            shape.size = extent + Vector2(4, stack_step*4)
            child.shape = shape
    var click = node.get_node_or_null("ClickArea/CollisionShape2D")
    if click:
        var shape = RectangleShape2D.new()
        shape.size = Vector2(270,125)
        click.shape = shape

func _replace(node: Node) -> void:
    if not is_instance_valid(node) or not node is Sprite2D or node.texture == null:
        return
    var path: String = node.texture.resource_path
    if not mapping.has(path) or node.has_meta("replacement_applied"):
        return
    var old_size: Vector2 = node.texture.get_size()
    var target: String = mapping[path]
    if not textures.has(target):
        textures[target] = load(target)
    var replacement: Texture2D = textures[target]
    if replacement == null:
        push_error("Replacement texture missing: " + target)
        return
    var new_size: Vector2 = replacement.get_size()
    var fit: float = minf(old_size.x / new_size.x, old_size.y / new_size.y)
    if path.contains("/characters/"):
        fit = old_size.y / new_size.y
    node.texture = replacement
    if path.contains("/environment/"):
        var ratio: Vector2 = old_size / new_size
        node.scale *= ratio
        node.offset /= ratio
        # Shelf dispensers inherit this sprite: retain their world placement.
        for child in node.get_children():
            if child is Node2D:
                child.position /= ratio
                child.scale /= ratio
    else:
        node.scale *= fit
        node.offset /= fit
        if path.contains("/characters/"):
            node.position.x += 210.0
    node.set_meta("replacement_applied", target)


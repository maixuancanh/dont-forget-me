extends RefCounted
class_name ArtFit

static func texture(path: String, crop: Rect2) -> AtlasTexture:
	var atlas = AtlasTexture.new()
	atlas.atlas = load("res://assets/replacement/" + path + ".png")
	atlas.region = crop
	return atlas

static func sprite(node: Sprite2D, art: Texture2D, center: Vector2, extent: Vector2) -> void:
	node.texture = art
	node.region_enabled = false
	node.offset = Vector2.ZERO
	node.position = center
	node.rotation = 0
	node.scale = extent / art.get_size()
	node.set_meta("replacement_applied", true)
